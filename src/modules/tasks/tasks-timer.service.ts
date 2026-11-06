import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import {
  DataScope,
  DeviceType,
  Prisma,
  SessionStatus,
  TaskPauseReason,
  TaskStatus,
  TaskTimerStatus,
} from '../../generated/prisma/client';
import {
  calculateDurationSeconds,
  getKolkataDateString,
  parseKolkataDateToUtc,
  splitIntervalByKolkataMidnight,
} from './task-time.utils';
import { buildTaskVisibilityWhere, TaskActorContext } from './tasks-visibility.helper';
import { PlayTaskTimerDto } from './dto/play-task-timer.dto';
import { PauseTaskTimerDto } from './dto/pause-task-timer.dto';
import { ResumeTaskTimerDto } from './dto/resume-task-timer.dto';
import { StopTaskTimerDto } from './dto/stop-task-timer.dto';
import { QueryTaskTimeEntriesDto } from './dto/query-task-time-entries.dto';
import { QueryTaskTimeSummaryDto } from './dto/query-task-time-summary.dto';
import { QueryMyTimeSummaryDto } from './dto/query-my-time-summary.dto';

@Injectable()
export class TasksTimerService {
  private readonly logger = new Logger(TasksTimerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly taskTimerAutoPauseService: TaskTimerAutoPauseService,
  ) {}

  /**
   * Starts or plays a timer on the specified task.
   * If another task is currently running for this employee, it is automatically
   * paused with reason TASK_SWITCH.
   * If the task is currently in TODO status, advances it to IN_PROGRESS.
   * Guaranteed at-most-once running timer per employee via MySQL Tier 1 user locks.
   */
  async playTimer(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: PlayTaskTimerDto,
    sessionId?: string,
  ) {
    return this.executeStartOrResumeTimer(taskId, actorUserId, actorUserType, dto, false, sessionId);
  }

  /**
   * Resumes a paused timer on the specified task.
   * Auto-pauses any other running task if necessary.
   * Closes any open pause on this task and links followingTimeEntryId.
   */
  async resumeTimer(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: ResumeTaskTimerDto,
    sessionId?: string,
  ) {
    return this.executeStartOrResumeTimer(taskId, actorUserId, actorUserType, dto, true, sessionId);
  }

  /**
   * Internal shared implementation for play and resume operations to guarantee
   * identical state invariants, lock acquisition order, and zero code duplication.
   */
  private async executeStartOrResumeTimer(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: PlayTaskTimerDto | ResumeTaskTimerDto,
    isResumeAction: boolean,
    sessionId?: string,
  ) {
    const task = await this.verifyTaskWorkerAccess(taskId, actorUserId, actorUserType);
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) {
      throw new BadRequestException(`Cannot operate timer on a ${task.status} task.`);
    }

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // TIER 1: Exclusive user row lock in clustered index order
            await tx.$queryRaw`
              SELECT id FROM users WHERE id = ${actorUserId} FOR UPDATE
            `;

            // If sessionId is present, verify under Tier 1 lock that session is still ACTIVE
            if (sessionId) {
              const session = await tx.userSession.findUnique({
                where: { id: sessionId },
                select: { status: true },
              });
              if (!session || session.status !== SessionStatus.ACTIVE) {
                throw new UnauthorizedException('Session has been revoked or expired.');
              }
            }

            // TIER 2: Exclusive task row lock
            const lockedTasks = await tx.$queryRaw<
              Array<{ id: string; task_code: string; status: TaskStatus; deleted_at: Date | null }>
            >`
              SELECT id, task_code, status, deleted_at FROM tasks WHERE id = ${taskId} FOR UPDATE
            `;

            if (!lockedTasks || lockedTasks.length === 0 || lockedTasks[0].deleted_at) {
              throw new NotFoundException('Task not found.');
            }

            const lockedTask = lockedTasks[0];
            if (
              lockedTask.status === TaskStatus.COMPLETED ||
              lockedTask.status === TaskStatus.CANCELLED
            ) {
              throw new BadRequestException(
                `Cannot operate timer on a ${lockedTask.status} task.`,
              );
            }

            // Check if employee already has an active running timer (ended_at IS NULL)
            const runningEntries = await tx.$queryRaw<
              Array<{ id: string; task_id: string; started_at: Date; work_date: Date }>
            >`
              SELECT id, task_id, started_at, work_date 
              FROM task_time_entries 
              WHERE user_id = ${actorUserId} AND ended_at IS NULL 
              LIMIT 1 
              FOR UPDATE
            `;

            const now = new Date();

            if (runningEntries && runningEntries.length > 0) {
              const currentRunning = runningEntries[0];

              // Idempotent: If timer is ALREADY running on this exact task, return existing state
              if (currentRunning.task_id === taskId) {
                const elapsedSeconds = calculateDurationSeconds(
                  new Date(currentRunning.started_at),
                  now,
                );
                return {
                  message: 'Timer is already running on this task.',
                  isTaskSwitch: false,
                  entry: {
                    id: currentRunning.id,
                    taskId,
                    userId: actorUserId,
                    startedAt: currentRunning.started_at,
                    workDate: getKolkataDateString(currentRunning.work_date),
                    status: TaskTimerStatus.RUNNING,
                    elapsedSeconds,
                  },
                };
              }

              // Running on a DIFFERENT task: Auto-Pause previous task with TASK_SWITCH
              const switchDuration = calculateDurationSeconds(
                new Date(currentRunning.started_at),
                now,
              );

              await tx.taskTimeEntry.update({
                where: { id: currentRunning.id },
                data: {
                  endedAt: now,
                  durationSeconds: switchDuration,
                  status: TaskTimerStatus.PAUSED,
                },
              });

              await tx.taskTimePause.create({
                data: {
                  taskId: currentRunning.task_id,
                  userId: actorUserId,
                  precedingTimeEntryId: currentRunning.id,
                  pausedAt: now,
                  reason: TaskPauseReason.TASK_SWITCH,
                  customDescription: `Switched to task ${lockedTask.task_code}`,
                },
              });

              await tx.taskActivityLog.create({
                data: {
                  taskId: currentRunning.task_id,
                  performedBy: actorUserId,
                  action: 'TIMER_PAUSED_TASK_SWITCH',
                  metadata: {
                    switchedToTaskId: taskId,
                    durationSeconds: switchDuration,
                  },
                },
              });
            }

            // Find any open pause on THIS task to close and link
            const openPauses = await tx.$queryRaw<
              Array<{ id: string; paused_at: Date }>
            >`
              SELECT id, paused_at 
              FROM task_time_pauses 
              WHERE user_id = ${actorUserId} AND task_id = ${taskId} AND resumed_at IS NULL 
              ORDER BY paused_at DESC 
              LIMIT 1 
              FOR UPDATE
            `;

            // Insert new immutable work entry
            const workDate = parseKolkataDateToUtc(now);
            const newEntry = await tx.taskTimeEntry.create({
              data: {
                taskId,
                userId: actorUserId,
                workDate,
                startedAt: now,
                endedAt: null,
                durationSeconds: 0,
                status: TaskTimerStatus.RUNNING,
                deviceType: dto.deviceType || DeviceType.WEB,
                ipAddress: dto.ipAddress || null,
                userAgent: dto.userAgent || null,
              },
            });

            // Close open pause if one existed
            if (openPauses && openPauses.length > 0) {
              const openPause = openPauses[0];
              const pauseDurationSeconds = calculateDurationSeconds(
                new Date(openPause.paused_at),
                now,
              );

              await tx.taskTimePause.update({
                where: { id: openPause.id },
                data: {
                  resumedAt: now,
                  pauseDurationSeconds,
                  followingTimeEntryId: newEntry.id,
                },
              });
            }

            // If task was in TODO or REOPENED, advance to IN_PROGRESS and record status history
            if (lockedTask.status === TaskStatus.TODO || lockedTask.status === TaskStatus.REOPENED) {
              const prevStatus = lockedTask.status;
              await tx.task.update({
                where: { id: taskId },
                data: { status: TaskStatus.IN_PROGRESS },
              });

              await tx.taskStatusHistory.create({
                data: {
                  taskId,
                  previousStatus: prevStatus,
                  newStatus: TaskStatus.IN_PROGRESS,
                  changedById: actorUserId,
                  comment: isResumeAction ? 'Timer resumed' : 'Timer started',
                },
              });
            }

            // Audit log
            await tx.taskActivityLog.create({
              data: {
                taskId,
                performedBy: actorUserId,
                action: isResumeAction ? 'TIMER_RESUMED' : 'TIMER_STARTED',
                metadata: {
                  timeEntryId: newEntry.id,
                  deviceType: dto.deviceType || DeviceType.WEB,
                },
              },
            });

            return {
              message: isResumeAction
                ? 'Timer resumed successfully.'
                : 'Timer started successfully.',
              isTaskSwitch: runningEntries && runningEntries.length > 0,
              entry: {
                id: newEntry.id,
                taskId: newEntry.taskId,
                userId: newEntry.userId,
                workDate: getKolkataDateString(newEntry.workDate),
                startedAt: newEntry.startedAt,
                status: newEntry.status,
                elapsedSeconds: 0,
              },
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000,
          },
        );
      } catch (error: any) {
        if (
          error.code === 'P2002' ||
          error.message?.includes('uq_one_running_timer_per_user')
        ) {
          throw new ConflictException(
            'Another timer is already running for this user.',
          );
        }

        const isDeadlock =
          error.code === 'P2034' ||
          error.message?.includes('1213') ||
          error.message?.includes('Deadlock');
        const isLockTimeout =
          error.message?.includes('1205') ||
          error.message?.includes('Lock wait timeout');

        if ((isDeadlock || isLockTimeout) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 50 + Math.floor(Math.random() * 50);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Failed to acquire timer lock due to concurrent load. Please retry.',
    );
  }

  /**
   * Pauses the running timer with a mandatory manual pause reason.
   * Closes active work entry, computes server-authoritative duration,
   * and creates an open pause record.
   */
  async pauseTimer(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: PauseTaskTimerDto,
  ) {
    if (
      dto.reason === TaskPauseReason.TASK_SWITCH ||
      dto.reason === TaskPauseReason.LOGOUT ||
      dto.reason === TaskPauseReason.TASK_STATUS_CHANGE
    ) {
      throw new BadRequestException(
        `System-generated pause reason ${dto.reason} cannot be manually submitted.`,
      );
    }

    if (
      dto.reason === TaskPauseReason.OTHER &&
      (!dto.customDescription || !dto.customDescription.trim())
    ) {
      throw new BadRequestException(
        'customDescription is required when pause reason is OTHER.',
      );
    }

    await this.verifyTaskWorkerAccess(taskId, actorUserId, actorUserType);

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // TIER 1: Exclusive user row lock
            await tx.$queryRaw`
              SELECT id FROM users WHERE id = ${actorUserId} FOR UPDATE
            `;

            // Query active running entry for this task
            const runningEntries = await tx.$queryRaw<
              Array<{ id: string; started_at: Date }>
            >`
              SELECT id, started_at 
              FROM task_time_entries 
              WHERE user_id = ${actorUserId} AND task_id = ${taskId} AND ended_at IS NULL 
              LIMIT 1 
              FOR UPDATE
            `;

            if (!runningEntries || runningEntries.length === 0) {
              throw new BadRequestException(
                'No running timer found on this task to pause.',
              );
            }

            const running = runningEntries[0];
            const now = new Date();
            const durationSeconds = calculateDurationSeconds(
              new Date(running.started_at),
              now,
            );

            // 1. Close active work entry
            await tx.taskTimeEntry.update({
              where: { id: running.id },
              data: {
                endedAt: now,
                durationSeconds,
                status: TaskTimerStatus.PAUSED,
              },
            });

            // 2. Create open pause record
            const pause = await tx.taskTimePause.create({
              data: {
                taskId,
                userId: actorUserId,
                precedingTimeEntryId: running.id,
                pausedAt: now,
                reason: dto.reason,
                customDescription: dto.customDescription?.trim() || null,
              },
            });

            // 3. Activity log
            await tx.taskActivityLog.create({
              data: {
                taskId,
                performedBy: actorUserId,
                action: 'TIMER_PAUSED',
                metadata: {
                  timeEntryId: running.id,
                  pauseId: pause.id,
                  reason: dto.reason,
                  durationSeconds,
                },
              },
            });

            return {
              message: 'Timer paused successfully.',
              pause: {
                id: pause.id,
                taskId,
                userId: actorUserId,
                precedingTimeEntryId: running.id,
                pausedAt: pause.pausedAt,
                reason: pause.reason,
                customDescription: pause.customDescription,
              },
              completedEntry: {
                id: running.id,
                durationSeconds,
              },
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000,
          },
        );
      } catch (error: any) {
        if (
          error.code === 'P2002' ||
          error.message?.includes('uq_one_open_pause_per_entry')
        ) {
          throw new ConflictException(
            'An open pause already exists for this work entry.',
          );
        }

        const isDeadlock =
          error.code === 'P2034' ||
          error.message?.includes('1213') ||
          error.message?.includes('Deadlock');
        const isLockTimeout =
          error.message?.includes('1205') ||
          error.message?.includes('Lock wait timeout');

        if ((isDeadlock || isLockTimeout) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 50 + Math.floor(Math.random() * 50);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Failed to pause timer due to concurrent load. Please retry.',
    );
  }

  /**
   * Explicitly stops the current task work session.
   * Closes any running entry or open pause without deleting history.
   * Does NOT alter task status to COMPLETED.
   */
  async stopTimer(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: StopTaskTimerDto,
  ) {
    await this.verifyTaskWorkerAccess(taskId, actorUserId, actorUserType);

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // TIER 1: Exclusive user row lock
            await tx.$queryRaw`
              SELECT id FROM users WHERE id = ${actorUserId} FOR UPDATE
            `;

            // Look for running work entry on this task
            const runningEntries = await tx.$queryRaw<
              Array<{ id: string; started_at: Date }>
            >`
              SELECT id, started_at 
              FROM task_time_entries 
              WHERE user_id = ${actorUserId} AND task_id = ${taskId} AND ended_at IS NULL 
              LIMIT 1 
              FOR UPDATE
            `;

            // Look for open pause on this task
            const openPauses = await tx.$queryRaw<
              Array<{ id: string; preceding_time_entry_id: string | null; paused_at: Date }>
            >`
              SELECT id, preceding_time_entry_id, paused_at 
              FROM task_time_pauses 
              WHERE user_id = ${actorUserId} AND task_id = ${taskId} AND resumed_at IS NULL 
              ORDER BY paused_at DESC 
              LIMIT 1 
              FOR UPDATE
            `;

            if (
              (!runningEntries || runningEntries.length === 0) &&
              (!openPauses || openPauses.length === 0)
            ) {
              throw new BadRequestException(
                'No running timer or open pause found on this task to stop.',
              );
            }

            const now = new Date();
            let stoppedEntryId: string | null = null;
            let sessionDurationSeconds = 0;

            if (runningEntries && runningEntries.length > 0) {
              const running = runningEntries[0];
              stoppedEntryId = running.id;
              sessionDurationSeconds = calculateDurationSeconds(
                new Date(running.started_at),
                now,
              );

              await tx.taskTimeEntry.update({
                where: { id: running.id },
                data: {
                  endedAt: now,
                  durationSeconds: sessionDurationSeconds,
                  status: TaskTimerStatus.STOPPED,
                },
              });
            }

            if (openPauses && openPauses.length > 0) {
              const openPause = openPauses[0];
              const pauseDurationSeconds = calculateDurationSeconds(
                new Date(openPause.paused_at),
                now,
              );

              await tx.taskTimePause.update({
                where: { id: openPause.id },
                data: {
                  resumedAt: now,
                  pauseDurationSeconds,
                },
              });

              if (openPause.preceding_time_entry_id) {
                await tx.taskTimeEntry.update({
                  where: { id: openPause.preceding_time_entry_id },
                  data: {
                    status: TaskTimerStatus.STOPPED,
                  },
                });
                stoppedEntryId = openPause.preceding_time_entry_id;
              }
            }

            await tx.taskActivityLog.create({
              data: {
                taskId,
                performedBy: actorUserId,
                action: 'TIMER_STOPPED',
                metadata: {
                  timeEntryId: stoppedEntryId,
                  finalComment: dto.finalComment?.trim() || null,
                },
              },
            });

            return {
              message: 'Timer stopped successfully.',
              stoppedEntryId,
              durationSeconds: sessionDurationSeconds,
            };
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
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Failed to stop timer due to concurrent load. Please retry.',
    );
  }

  /**
   * Retrieves the employee's currently active timer (running or open pause).
   * Live elapsed seconds are computed strictly on the backend using server time.
   */
  async getActiveTimer(actorUserId: string, actorUserType?: string) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal time records.');
    }

    const running = await this.prisma.taskTimeEntry.findFirst({
      where: {
        userId: actorUserId,
        endedAt: null,
      },
      include: {
        task: {
          select: {
            id: true,
            taskCode: true,
            title: true,
            status: true,
            priority: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
    });

    const now = new Date();

    if (running) {
      const elapsedSeconds = calculateDurationSeconds(running.startedAt, now);
      return {
        hasActiveTimer: true,
        isRunning: true,
        isPaused: false,
        entry: {
          id: running.id,
          taskId: running.taskId,
          workDate: getKolkataDateString(running.workDate),
          startedAt: running.startedAt,
          status: running.status,
          deviceType: running.deviceType,
          elapsedSeconds,
        },
        task: running.task,
        activePause: null,
      };
    }

    const openPause = await this.prisma.taskTimePause.findFirst({
      where: {
        userId: actorUserId,
        resumedAt: null,
      },
      orderBy: { pausedAt: 'desc' },
      include: {
        task: {
          select: {
            id: true,
            taskCode: true,
            title: true,
            status: true,
            priority: true,
            department: { select: { id: true, name: true } },
          },
        },
        precedingEntry: {
          select: {
            id: true,
            startedAt: true,
            endedAt: true,
            durationSeconds: true,
            workDate: true,
          },
        },
      },
    });

    if (openPause) {
      const pauseElapsedSeconds = calculateDurationSeconds(openPause.pausedAt, now);
      return {
        hasActiveTimer: true,
        isRunning: false,
        isPaused: true,
        entry: openPause.precedingEntry
          ? {
              ...openPause.precedingEntry,
              workDate: getKolkataDateString(openPause.precedingEntry.workDate),
            }
          : null,
        task: openPause.task,
        activePause: {
          id: openPause.id,
          taskId: openPause.taskId,
          pausedAt: openPause.pausedAt,
          reason: openPause.reason,
          customDescription: openPause.customDescription,
          pauseElapsedSeconds,
        },
      };
    }

    return {
      hasActiveTimer: false,
      isRunning: false,
      isPaused: false,
      entry: null,
      task: null,
      activePause: null,
    };
  }

  /**
   * Returns paginated work entries and associated pauses for a task,
   * respecting user-type ceilings and supervisory data scopes.
   */
  async getTimeEntries(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskTimeEntriesDto,
  ) {
    await this.verifyTaskViewAccess(taskId, actorUserId, actorUserType);

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    let targetUserId = query.userId;
    if (actorUserType === 'EMPLOYEE') {
      const scope = await this.usersService.resolveActorDataScope(
        actorUserId,
        actorUserType,
        'tasks.time.view',
      );
      if (scope === DataScope.OWN) {
        targetUserId = actorUserId;
      }
    }

    const where: Prisma.TaskTimeEntryWhereInput = {
      taskId,
      ...(targetUserId ? { userId: targetUserId } : {}),
    };

    if (query.startDate || query.endDate) {
      where.workDate = {};
      if (query.startDate) {
        where.workDate.gte = parseKolkataDateToUtc(query.startDate);
      }
      if (query.endDate) {
        where.workDate.lte = parseKolkataDateToUtc(query.endDate);
      }
    }

    const [total, entries] = await Promise.all([
      this.prisma.taskTimeEntry.count({ where }),
      this.prisma.taskTimeEntry.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              userCode: true,
              name: true,
              email: true,
            },
          },
          precedingPauses: {
            orderBy: { pausedAt: 'asc' },
          },
        },
      }),
    ]);

    const now = new Date();
    const data = entries.map((e) => {
      const isRunning = e.endedAt === null;
      const elapsedSeconds = isRunning
        ? calculateDurationSeconds(e.startedAt, now)
        : e.durationSeconds;

      return {
        id: e.id,
        taskId: e.taskId,
        userId: e.userId,
        user: e.user,
        workDate: getKolkataDateString(e.workDate),
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationSeconds: e.durationSeconds,
        elapsedSeconds,
        status: e.status,
        deviceType: e.deviceType,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        isCorrection: e.isCorrection,
        pauses: e.precedingPauses.map((p) => ({
          id: p.id,
          pausedAt: p.pausedAt,
          resumedAt: p.resumedAt,
          pauseDurationSeconds: p.resumedAt
            ? p.pauseDurationSeconds
            : calculateDurationSeconds(p.pausedAt, now),
          reason: p.reason,
          customDescription: p.customDescription,
        })),
      };
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Returns a task-wise working time summary with daily splits across Asia/Kolkata
   * calendar day boundaries.
   */
  async getTimeSummary(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskTimeSummaryDto,
  ) {
    const task = await this.verifyTaskViewAccess(taskId, actorUserId, actorUserType);

    let targetUserId = query.userId;
    if (actorUserType === 'EMPLOYEE') {
      const scope = await this.usersService.resolveActorDataScope(
        actorUserId,
        actorUserType,
        'tasks.time.view_summary',
      );
      if (scope === DataScope.OWN) {
        targetUserId = actorUserId;
      }
    }

    const where: Prisma.TaskTimeEntryWhereInput = {
      taskId,
      ...(targetUserId ? { userId: targetUserId } : {}),
    };

    if (query.startDate || query.endDate) {
      where.workDate = {};
      if (query.startDate) {
        where.workDate.gte = parseKolkataDateToUtc(query.startDate);
      }
      if (query.endDate) {
        where.workDate.lte = parseKolkataDateToUtc(query.endDate);
      }
    }

    const entries = await this.prisma.taskTimeEntry.findMany({
      where,
      orderBy: { startedAt: 'asc' },
      include: {
        precedingPauses: true,
      },
    });

    const now = new Date();
    let totalWorkingSeconds = 0;
    let totalPausedSeconds = 0;
    const dailyMap = new Map<string, { workingSeconds: number; pausedSeconds: number }>();

    for (const entry of entries) {
      const entryEnd = entry.endedAt || now;
      const segments = splitIntervalByKolkataMidnight(entry.startedAt, entryEnd);

      for (const seg of segments) {
        totalWorkingSeconds += seg.durationSeconds;
        const current = dailyMap.get(seg.date) || { workingSeconds: 0, pausedSeconds: 0 };
        current.workingSeconds += seg.durationSeconds;
        dailyMap.set(seg.date, current);
      }

      for (const pause of entry.precedingPauses) {
        const pauseEnd = pause.resumedAt || now;
        const pauseSegments = splitIntervalByKolkataMidnight(pause.pausedAt, pauseEnd);

        for (const seg of pauseSegments) {
          totalPausedSeconds += seg.durationSeconds;
          const current = dailyMap.get(seg.date) || { workingSeconds: 0, pausedSeconds: 0 };
          current.pausedSeconds += seg.durationSeconds;
          dailyMap.set(seg.date, current);
        }
      }
    }

    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort(([d1], [d2]) => d1.localeCompare(d2))
      .map(([date, stats]) => ({
        date,
        workingSeconds: stats.workingSeconds,
        workingMinutes: Math.round((stats.workingSeconds / 60) * 10) / 10,
        workingHours: Math.round((stats.workingSeconds / 3600) * 100) / 100,
        pausedSeconds: stats.pausedSeconds,
        pausedMinutes: Math.round((stats.pausedSeconds / 60) * 10) / 10,
      }));

    return {
      taskId: task.id,
      taskCode: task.taskCode,
      title: task.title,
      status: task.status,
      totalWorkingSeconds,
      totalWorkingMinutes: Math.round((totalWorkingSeconds / 60) * 10) / 10,
      totalWorkingHours: Math.round((totalWorkingSeconds / 3600) * 100) / 100,
      totalPausedSeconds,
      totalPausedMinutes: Math.round((totalPausedSeconds / 60) * 10) / 10,
      dailyBreakdown,
    };
  }

  /**
   * Returns the authenticated employee's personal time summary across all tasks worked.
   */
  async getMyTimeSummary(
    actorUserId: string,
    query: QueryMyTimeSummaryDto,
    actorUserType?: string,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal time records.');
    }

    const where: Prisma.TaskTimeEntryWhereInput = {
      userId: actorUserId,
    };

    if (query.startDate || query.endDate) {
      where.workDate = {};
      if (query.startDate) {
        where.workDate.gte = parseKolkataDateToUtc(query.startDate);
      }
      if (query.endDate) {
        where.workDate.lte = parseKolkataDateToUtc(query.endDate);
      }
    }

    const entries = await this.prisma.taskTimeEntry.findMany({
      where,
      orderBy: { startedAt: 'asc' },
      include: {
        task: {
          select: {
            id: true,
            taskCode: true,
            title: true,
            status: true,
          },
        },
        precedingPauses: true,
      },
    });

    const now = new Date();
    let totalWorkingSeconds = 0;
    let totalPausedSeconds = 0;
    const dailyMap = new Map<string, { workingSeconds: number; pausedSeconds: number }>();
    const taskMap = new Map<
      string,
      {
        taskId: string;
        taskCode: string;
        title: string;
        workingSeconds: number;
        pausedSeconds: number;
      }
    >();

    for (const entry of entries) {
      const entryEnd = entry.endedAt || now;
      const segments = splitIntervalByKolkataMidnight(entry.startedAt, entryEnd);

      let entryWorkSec = 0;
      for (const seg of segments) {
        totalWorkingSeconds += seg.durationSeconds;
        entryWorkSec += seg.durationSeconds;
        const current = dailyMap.get(seg.date) || { workingSeconds: 0, pausedSeconds: 0 };
        current.workingSeconds += seg.durationSeconds;
        dailyMap.set(seg.date, current);
      }

      const tStat = taskMap.get(entry.taskId) || {
        taskId: entry.taskId,
        taskCode: entry.task.taskCode,
        title: entry.task.title,
        workingSeconds: 0,
        pausedSeconds: 0,
      };
      tStat.workingSeconds += entryWorkSec;

      for (const pause of entry.precedingPauses) {
        const pauseEnd = pause.resumedAt || now;
        const pauseSegments = splitIntervalByKolkataMidnight(pause.pausedAt, pauseEnd);

        for (const seg of pauseSegments) {
          totalPausedSeconds += seg.durationSeconds;
          tStat.pausedSeconds += seg.durationSeconds;
          const current = dailyMap.get(seg.date) || { workingSeconds: 0, pausedSeconds: 0 };
          current.pausedSeconds += seg.durationSeconds;
          dailyMap.set(seg.date, current);
        }
      }
      taskMap.set(entry.taskId, tStat);
    }

    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort(([d1], [d2]) => d1.localeCompare(d2))
      .map(([date, stats]) => ({
        date,
        workingSeconds: stats.workingSeconds,
        workingMinutes: Math.round((stats.workingSeconds / 60) * 10) / 10,
        workingHours: Math.round((stats.workingSeconds / 3600) * 100) / 100,
        pausedSeconds: stats.pausedSeconds,
        pausedMinutes: Math.round((stats.pausedSeconds / 60) * 10) / 10,
      }));

    const taskBreakdown = Array.from(taskMap.values()).map((t) => ({
      ...t,
      workingMinutes: Math.round((t.workingSeconds / 60) * 10) / 10,
      workingHours: Math.round((t.workingSeconds / 3600) * 100) / 100,
      pausedMinutes: Math.round((t.pausedSeconds / 60) * 10) / 10,
    }));

    const activeTimer = await this.getActiveTimer(actorUserId);

    return {
      userId: actorUserId,
      totalWorkingSeconds,
      totalWorkingMinutes: Math.round((totalWorkingSeconds / 60) * 10) / 10,
      totalWorkingHours: Math.round((totalWorkingSeconds / 3600) * 100) / 100,
      totalPausedSeconds,
      totalPausedMinutes: Math.round((totalPausedSeconds / 60) * 10) / 10,
      dailyBreakdown,
      taskBreakdown,
      activeTimer,
    };
  }

  /**
   * Builds the actor context containing user type, department IDs, subordinate IDs,
   * and resolved effective data scope for strict visibility evaluation.
   */
  private async buildActorContext(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string,
  ): Promise<TaskActorContext> {
    const effectiveDataScope = await this.usersService.resolveActorDataScope(
      actorUserId,
      actorUserType,
      permissionCode,
    );

    const userDepts =
      (await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      })) || [];
    const departmentIds = userDepts.map((d) => d.departmentId);

    const subordinates =
      (await this.prisma.employeeProfile.findMany({
        where: { reportingToId: actorUserId },
        select: { userId: true },
      })) || [];
    const subordinateUserIds = subordinates.map((s) => s.userId);

    return {
      userId: actorUserId,
      userType: actorUserType,
      departmentIds,
      subordinateUserIds,
      effectiveDataScope,
    };
  }

  /**
   * Verifies that the actor has permissions and data scope to view the task.
   */
  private async verifyTaskViewAccess(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const actorContext = await this.buildActorContext(
      actorUserId,
      actorUserType,
      'tasks.view',
    );

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);

    const task = await this.prisma.task.findFirst({
      where: {
        AND: [{ id: taskId, deletedAt: null }, visibilityWhere],
      },
      include: {
        assignee: { select: { id: true, name: true, userType: { select: { code: true } } } },
        createdByUser: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found.');
    }

    return task;
  }

  /**
   * Verifies that the actor is authorized to work on the task.
   * Mandate:
   * - Unassigned draft tasks cannot be played.
   * - Tasks can only be operated by their assigned employee.
   */
  private async verifyTaskWorkerAccess(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const task = await this.verifyTaskViewAccess(taskId, actorUserId, actorUserType);

    if (!task.assigneeId) {
      throw new BadRequestException(
        'Cannot operate timer on an unassigned task. Please assign the task first.',
      );
    }

    if (task.assigneeId !== actorUserId) {
      throw new ForbiddenException(
        'You can only operate the timer on tasks assigned to you.',
      );
    }

    return task;
  }
}
