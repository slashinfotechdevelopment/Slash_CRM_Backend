import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { TaskPauseReason, TaskTimerStatus } from '../../generated/prisma/enums';
import { calculateDurationSeconds } from './task-time.utils';

export interface AutoPauseResult {
  paused: boolean;
  taskId?: string;
  entryId?: string;
  durationSeconds?: number;
}

@Injectable()
export class TaskTimerAutoPauseService {
  private readonly logger = new Logger(TaskTimerAutoPauseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Automatically pauses any currently running task timer for the given user.
   * Employs Tier 1 user row locks (SELECT ... FOR UPDATE) and bounded deadlock retries.
   * Safe, idempotent, and reusable for both LOGOUT and TASK_SWITCH operations.
   * When externalTx is provided, joins the caller's transaction atomically.
   */
  async autoPauseRunningTask(
    userId: string,
    reason: TaskPauseReason = TaskPauseReason.LOGOUT,
    customDescription?: string,
    externalTx?: Prisma.TransactionClient,
  ): Promise<AutoPauseResult> {
    if (externalTx) {
      return this.executeAutoPause(externalTx, userId, reason, customDescription);
    }

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            return this.executeAutoPause(tx, userId, reason, customDescription);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000,
          },
        );
      } catch (error: any) {
        const isDeadlock =
          error.code === 'P2034' ||
          error.message?.includes('1213') ||
          error.message?.includes('Deadlock');
        const isLockTimeout =
          error.message?.includes('1205') ||
          error.message?.includes('Lock wait timeout');

        if ((isDeadlock || isLockTimeout) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 50 + Math.floor(Math.random() * 50);
          this.logger.warn(
            `Deadlock/timeout in autoPauseRunningTask for user ${userId}. Retrying (${attempt}/${maxRetries})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        this.logger.error(
          `Failed to auto-pause timer for user ${userId}: ${error.message}`,
          error.stack,
        );
        throw error;
      }
    }

    return { paused: false };
  }

  private async executeAutoPause(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: TaskPauseReason,
    customDescription?: string,
  ): Promise<AutoPauseResult> {
    // TIER 1: Acquire exclusive row lock on the user to prevent concurrent race conditions
    await tx.$queryRaw`
      SELECT id FROM users WHERE id = ${userId} FOR UPDATE
    `;

    // Query active running timer under lock (ended_at IS NULL)
    const activeEntries = await tx.$queryRaw<
      Array<{
        id: string;
        task_id: string;
        started_at: Date;
      }>
    >`
      SELECT id, task_id, started_at 
      FROM task_time_entries 
      WHERE user_id = ${userId} AND ended_at IS NULL 
      LIMIT 1 
      FOR UPDATE
    `;

    if (!activeEntries || activeEntries.length === 0) {
      return { paused: false };
    }

    const activeEntry = activeEntries[0];
    const now = new Date();
    const startedAt = new Date(activeEntry.started_at);
    const durationSeconds = calculateDurationSeconds(startedAt, now);

    // 1. Close active work entry
    await tx.taskTimeEntry.update({
      where: { id: activeEntry.id },
      data: {
        endedAt: now,
        durationSeconds,
        status: TaskTimerStatus.PAUSED,
      },
    });

    // 2. Create immutable pause record associated with this work entry
    await tx.taskTimePause.create({
      data: {
        taskId: activeEntry.task_id,
        userId,
        precedingTimeEntryId: activeEntry.id,
        pausedAt: now,
        reason,
        customDescription:
          customDescription ||
          (reason === TaskPauseReason.LOGOUT
            ? 'Session logout auto-pause'
            : reason === TaskPauseReason.TASK_STATUS_CHANGE
            ? 'Workflow status transition auto-pause'
            : 'Task switch auto-pause'),
      },
    });

    // 3. Record task activity audit
    await tx.taskActivityLog.create({
      data: {
        taskId: activeEntry.task_id,
        performedBy: userId,
        action:
          reason === TaskPauseReason.LOGOUT
            ? 'TIMER_PAUSED_LOGOUT'
            : reason === TaskPauseReason.TASK_STATUS_CHANGE
            ? 'TIMER_PAUSED_STATUS_CHANGE'
            : 'TIMER_PAUSED_TASK_SWITCH',
        metadata: {
          timeEntryId: activeEntry.id,
          durationSeconds,
          reason,
        },
      },
    });

    this.logger.log(
      `User ${userId} active task ${activeEntry.task_id} auto-paused with reason ${reason} (${durationSeconds}s)`,
    );

    return {
      paused: true,
      taskId: activeEntry.task_id,
      entryId: activeEntry.id,
      durationSeconds,
    };
  }
}

