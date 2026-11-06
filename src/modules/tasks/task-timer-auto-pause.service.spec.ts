import { Test, TestingModule } from '@nestjs/testing';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import { PrismaService } from '../../database/prisma.service';
import { TaskPauseReason, TaskTimerStatus } from '../../generated/prisma/client';

describe('TaskTimerAutoPauseService (Unit Tests)', () => {
  let service: TaskTimerAutoPauseService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      $queryRaw: jest.fn(),
      taskTimeEntry: {
        update: jest.fn(),
      },
      taskTimePause: {
        create: jest.fn(),
      },
      taskActivityLog: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskTimerAutoPauseService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<TaskTimerAutoPauseService>(TaskTimerAutoPauseService);
  });

  it('should auto-pause running task with reason LOGOUT and record activity', async () => {
    const startedAt = new Date(Date.now() - 180000); // 3 minutes ago
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: 'user-1' }]) // lock user
      .mockResolvedValueOnce([
        {
          id: 'entry-active',
          task_id: 'task-1',
          started_at: startedAt,
        },
      ]);

    const res = await service.autoPauseRunningTask('user-1', TaskPauseReason.LOGOUT);

    expect(res.paused).toBe(true);
    expect(res.taskId).toBe('task-1');
    expect(res.entryId).toBe('entry-active');
    expect(res.durationSeconds).toBeGreaterThanOrEqual(180);

    expect(prismaMock.taskTimeEntry.update).toHaveBeenCalledWith({
      where: { id: 'entry-active' },
      data: expect.objectContaining({
        status: TaskTimerStatus.PAUSED,
      }),
    });

    expect(prismaMock.taskTimePause.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task-1',
        userId: 'user-1',
        precedingTimeEntryId: 'entry-active',
        reason: TaskPauseReason.LOGOUT,
      }),
    });

    expect(prismaMock.taskActivityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task-1',
        performedBy: 'user-1',
        action: 'TIMER_PAUSED_LOGOUT',
      }),
    });
  });

  it('should return paused: false cleanly and idempotently if no timer is running', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: 'user-1' }])
      .mockResolvedValueOnce([]); // no running entry

    const res = await service.autoPauseRunningTask('user-1', TaskPauseReason.LOGOUT);

    expect(res.paused).toBe(false);
    expect(prismaMock.taskTimeEntry.update).not.toHaveBeenCalled();
    expect(prismaMock.taskTimePause.create).not.toHaveBeenCalled();
  });

  it('should retry on MySQL deadlock (1213) and succeed on retry', async () => {
    const deadlockError = new Error('Deadlock found when trying to get lock; try restarting transaction: 1213');
    (deadlockError as any).code = '1213';

    const startedAt = new Date(Date.now() - 60000);

    // Attempt 1: Throws deadlock
    // Attempt 2: Succeeds
    prismaMock.$transaction
      .mockRejectedValueOnce(deadlockError)
      .mockImplementationOnce(async (cb: any) => {
        prismaMock.$queryRaw
          .mockResolvedValueOnce([{ id: 'user-1' }])
          .mockResolvedValueOnce([
            { id: 'entry-active', task_id: 'task-1', started_at: startedAt },
          ]);
        return cb(prismaMock);
      });

    const res = await service.autoPauseRunningTask('user-1', TaskPauseReason.LOGOUT);
    expect(res.paused).toBe(true);
  });
});

