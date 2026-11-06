import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TasksTimerService } from './tasks-timer.service';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import {
  DataScope,
  DeviceType,
  TaskPauseReason,
  TaskPriority,
  TaskStatus,
  TaskTimerStatus,
} from '../../generated/prisma/client';

describe('TasksTimerService (Unit Tests)', () => {
  let service: TasksTimerService;
  let prismaMock: any;
  let usersServiceMock: any;
  let autoPauseServiceMock: any;

  const mockEmployeeId = 'emp-001';
  const mockOtherEmployeeId = 'emp-002';
  const mockTaskId = 'task-100';
  const mockOtherTaskId = 'task-200';

  const baseMockTask = {
    id: mockTaskId,
    taskCode: 'TASK100',
    title: 'Test Task 100',
    status: TaskStatus.TODO,
    priority: TaskPriority.MEDIUM,
    assigneeId: mockEmployeeId,
    createdById: mockEmployeeId,
    departmentId: 'dept-1',
    deletedAt: null,
    assignee: { id: mockEmployeeId, name: 'Alice', userType: { code: 'EMPLOYEE' } },
    createdByUser: { id: mockEmployeeId, name: 'Alice' },
    department: { id: 'dept-1', name: 'Engineering' },
  };

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      $queryRaw: jest.fn(),
      task: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      taskTimeEntry: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      taskTimePause: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      taskStatusHistory: {
        create: jest.fn(),
      },
      taskActivityLog: {
        create: jest.fn(),
      },
      userDepartment: {
        findMany: jest.fn().mockResolvedValue([{ departmentId: 'dept-1' }]),
      },
      employeeProfile: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    usersServiceMock = {
      resolveActorDataScope: jest.fn().mockResolvedValue(DataScope.OWN),
    };

    autoPauseServiceMock = {
      autoPauseRunningTask: jest.fn().mockResolvedValue({ paused: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksTimerService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: TaskTimerAutoPauseService, useValue: autoPauseServiceMock },
      ],
    }).compile();

    service = module.get<TasksTimerService>(TasksTimerService);
  });

  describe('playTimer', () => {
    it('should start timer on TODO task, advance status to IN_PROGRESS, and record status history', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      // Query raw responses:
      // 1. Lock user
      // 2. Lock task
      // 3. Find running entries (none)
      // 4. Find open pauses (none)
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: mockTaskId, task_code: 'TASK100', status: TaskStatus.TODO, deleted_at: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const mockEntry = {
        id: 'entry-1',
        taskId: mockTaskId,
        userId: mockEmployeeId,
        workDate: new Date('2026-11-05T00:00:00.000Z'),
        startedAt: new Date(),
        status: TaskTimerStatus.RUNNING,
      };
      prismaMock.taskTimeEntry.create.mockResolvedValue(mockEntry);

      const result = await service.playTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {});

      expect(result.message).toContain('Timer started successfully');
      expect(result.isTaskSwitch).toBe(false);
      expect(prismaMock.task.update).toHaveBeenCalledWith({
        where: { id: mockTaskId },
        data: { status: TaskStatus.IN_PROGRESS },
      });
      expect(prismaMock.taskStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: mockTaskId,
          previousStatus: TaskStatus.TODO,
          newStatus: TaskStatus.IN_PROGRESS,
          changedById: mockEmployeeId,
        }),
      });
      expect(prismaMock.taskActivityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: mockTaskId,
          performedBy: mockEmployeeId,
          action: 'TIMER_STARTED',
        }),
      });
    });

    it('should return existing timer idempotently if already running on the same task', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        ...baseMockTask,
        status: TaskStatus.IN_PROGRESS,
      });

      const startedAt = new Date(Date.now() - 60000); // 1 minute ago
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: mockTaskId, task_code: 'TASK100', status: TaskStatus.IN_PROGRESS, deleted_at: null }])
        .mockResolvedValueOnce([
          {
            id: 'entry-1',
            task_id: mockTaskId,
            started_at: startedAt,
            work_date: new Date('2026-11-05T00:00:00.000Z'),
          },
        ]);

      const result = await service.playTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {});

      expect(result.message).toContain('already running');
      expect(result.isTaskSwitch).toBe(false);
      expect(result.entry.elapsedSeconds).toBeGreaterThanOrEqual(60);
      expect(prismaMock.taskTimeEntry.create).not.toHaveBeenCalled();
    });

    it('should auto-pause running Task A with reason TASK_SWITCH when playing Task B', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        ...baseMockTask,
        id: mockOtherTaskId,
        taskCode: 'TASK200',
        status: TaskStatus.IN_PROGRESS,
      });

      const startedAt = new Date(Date.now() - 120000); // 2 minutes ago on Task A
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: mockOtherTaskId, task_code: 'TASK200', status: TaskStatus.IN_PROGRESS, deleted_at: null }])
        .mockResolvedValueOnce([
          {
            id: 'entry-task-A',
            task_id: mockTaskId, // running on task A
            started_at: startedAt,
            work_date: new Date('2026-11-05T00:00:00.000Z'),
          },
        ])
        .mockResolvedValueOnce([]); // no open pause on Task B

      prismaMock.taskTimeEntry.create.mockResolvedValue({
        id: 'entry-task-B',
        taskId: mockOtherTaskId,
        userId: mockEmployeeId,
        workDate: new Date('2026-11-05T00:00:00.000Z'),
        startedAt: new Date(),
        status: TaskTimerStatus.RUNNING,
      });

      const result = await service.playTimer(mockOtherTaskId, mockEmployeeId, 'EMPLOYEE', {});

      expect(result.isTaskSwitch).toBe(true);
      // Verify Task A was closed with PAUSED and pause record created
      expect(prismaMock.taskTimeEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-task-A' },
        data: expect.objectContaining({
          status: TaskTimerStatus.PAUSED,
        }),
      });
      expect(prismaMock.taskTimePause.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: mockTaskId,
          userId: mockEmployeeId,
          precedingTimeEntryId: 'entry-task-A',
          reason: TaskPauseReason.TASK_SWITCH,
        }),
      });
      expect(prismaMock.taskTimeEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: mockOtherTaskId,
          userId: mockEmployeeId,
          status: TaskTimerStatus.RUNNING,
        }),
      });
    });

    it('should reject play on COMPLETED or CANCELLED task with BadRequestException', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        ...baseMockTask,
        status: TaskStatus.COMPLETED,
      });

      await expect(
        service.playTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject play on task assigned to someone else with ForbiddenException', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        ...baseMockTask,
        assigneeId: mockOtherEmployeeId,
      });

      await expect(
        service.playTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {}),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('pauseTimer', () => {
    it('should reject system-generated pause reasons TASK_SWITCH, LOGOUT, and TASK_STATUS_CHANGE', async () => {
      await expect(
        service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason: TaskPauseReason.TASK_SWITCH,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason: TaskPauseReason.LOGOUT,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason: TaskPauseReason.TASK_STATUS_CHANGE,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject OTHER pause reason if customDescription is omitted', async () => {
      await expect(
        service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason: TaskPauseReason.OTHER,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept all supported manual pause reasons and close running entry', async () => {
      const validReasons = [
        TaskPauseReason.TEA_BREAK,
        TaskPauseReason.LUNCH,
        TaskPauseReason.PERSONAL_WORK,
        TaskPauseReason.MEETING,
        TaskPauseReason.WAITING,
        TaskPauseReason.TECHNICAL_ISSUE,
      ];

      for (const reason of validReasons) {
        prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
        const startedAt = new Date(Date.now() - 300000); // 5 min ago
        prismaMock.$queryRaw
          .mockResolvedValueOnce([{ id: mockEmployeeId }])
          .mockResolvedValueOnce([{ id: 'entry-running', started_at: startedAt }]);

        prismaMock.taskTimePause.create.mockResolvedValue({
          id: 'pause-1',
          taskId: mockTaskId,
          userId: mockEmployeeId,
          precedingTimeEntryId: 'entry-running',
          pausedAt: new Date(),
          reason,
          customDescription: null,
        });

        const res = await service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason,
        });

        expect(res.message).toContain('Timer paused successfully');
        expect(res.pause.reason).toBe(reason);
        expect(prismaMock.taskTimeEntry.update).toHaveBeenCalledWith({
          where: { id: 'entry-running' },
          data: expect.objectContaining({
            status: TaskTimerStatus.PAUSED,
          }),
        });
      }
    });

    it('should accept OTHER with valid customDescription', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: 'entry-running', started_at: new Date() }]);

      prismaMock.taskTimePause.create.mockResolvedValue({
        id: 'pause-other',
        taskId: mockTaskId,
        userId: mockEmployeeId,
        precedingTimeEntryId: 'entry-running',
        pausedAt: new Date(),
        reason: TaskPauseReason.OTHER,
        customDescription: 'Doctor visit',
      });

      const res = await service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
        reason: TaskPauseReason.OTHER,
        customDescription: 'Doctor visit',
      });

      expect(res.pause.customDescription).toBe('Doctor visit');
    });

    it('should throw BadRequestException if no timer is running to pause', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([]); // no running entry

      await expect(
        service.pauseTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
          reason: TaskPauseReason.TEA_BREAK,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resumeTimer', () => {
    it('should resume paused task, close open pause, and start new work entry', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      const pausedAt = new Date(Date.now() - 900000); // 15 min ago

      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: mockTaskId, task_code: 'TASK100', status: TaskStatus.IN_PROGRESS, deleted_at: null }])
        .mockResolvedValueOnce([]) // no running timer currently
        .mockResolvedValueOnce([{ id: 'pause-open', paused_at: pausedAt }]);

      prismaMock.taskTimeEntry.create.mockResolvedValue({
        id: 'entry-resumed',
        taskId: mockTaskId,
        userId: mockEmployeeId,
        workDate: new Date('2026-11-05T00:00:00.000Z'),
        startedAt: new Date(),
        status: TaskTimerStatus.RUNNING,
      });

      const res = await service.resumeTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {});

      expect(res.message).toContain('Timer resumed successfully');
      expect(prismaMock.taskTimePause.update).toHaveBeenCalledWith({
        where: { id: 'pause-open' },
        data: expect.objectContaining({
          followingTimeEntryId: 'entry-resumed',
        }),
      });
      expect(prismaMock.taskTimeEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: mockTaskId,
          userId: mockEmployeeId,
          status: TaskTimerStatus.RUNNING,
        }),
      });
    });
  });

  describe('stopTimer', () => {
    it('should stop running timer, update status to STOPPED, without marking task COMPLETED', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([{ id: 'entry-to-stop', started_at: new Date(Date.now() - 60000) }])
        .mockResolvedValueOnce([]);

      const res = await service.stopTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {
        finalComment: 'Finished morning session',
      });

      expect(res.message).toContain('Timer stopped successfully');
      expect(prismaMock.taskTimeEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-to-stop' },
        data: expect.objectContaining({
          status: TaskTimerStatus.STOPPED,
        }),
      });
      // Ensure task status was NOT touched to COMPLETED
      expect(prismaMock.task.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if neither running entry nor open pause exists', async () => {
      prismaMock.task.findFirst.mockResolvedValue(baseMockTask);
      prismaMock.$queryRaw
        .mockResolvedValueOnce([{ id: mockEmployeeId }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        service.stopTimer(mockTaskId, mockEmployeeId, 'EMPLOYEE', {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getActiveTimer', () => {
    it('should return running timer with live elapsed seconds', async () => {
      const startedAt = new Date(Date.now() - 45000); // 45s ago
      prismaMock.taskTimeEntry.findFirst.mockResolvedValue({
        id: 'running-entry',
        taskId: mockTaskId,
        workDate: new Date('2026-11-05T00:00:00.000Z'),
        startedAt,
        status: TaskTimerStatus.RUNNING,
        deviceType: DeviceType.WEB,
        task: baseMockTask,
      });

      const res = await service.getActiveTimer(mockEmployeeId);
      expect(res.hasActiveTimer).toBe(true);
      expect(res.isRunning).toBe(true);
      expect(res.isPaused).toBe(false);
      expect(res.entry?.elapsedSeconds).toBeGreaterThanOrEqual(45);
      expect(res.task?.taskCode).toBe('TASK100');
    });

    it('should return open pause details when timer is paused', async () => {
      prismaMock.taskTimeEntry.findFirst.mockResolvedValue(null);
      const pausedAt = new Date(Date.now() - 90000); // 90s ago
      prismaMock.taskTimePause.findFirst.mockResolvedValue({
        id: 'open-pause',
        taskId: mockTaskId,
        pausedAt,
        reason: TaskPauseReason.TEA_BREAK,
        customDescription: null,
        task: baseMockTask,
        precedingEntry: {
          id: 'preceding-entry',
          startedAt: new Date(Date.now() - 600000),
          endedAt: pausedAt,
          durationSeconds: 510,
          workDate: new Date('2026-11-05T00:00:00.000Z'),
        },
      });

      const res = await service.getActiveTimer(mockEmployeeId);
      expect(res.hasActiveTimer).toBe(true);
      expect(res.isRunning).toBe(false);
      expect(res.isPaused).toBe(true);
      expect(res.activePause?.reason).toBe(TaskPauseReason.TEA_BREAK);
      expect(res.activePause?.pauseElapsedSeconds).toBeGreaterThanOrEqual(90);
    });

    it('should return idle when neither running nor paused', async () => {
      prismaMock.taskTimeEntry.findFirst.mockResolvedValue(null);
      prismaMock.taskTimePause.findFirst.mockResolvedValue(null);

      const res = await service.getActiveTimer(mockEmployeeId);
      expect(res.hasActiveTimer).toBe(false);
      expect(res.isRunning).toBe(false);
      expect(res.isPaused).toBe(false);
      expect(res.entry).toBeNull();
    });
  });
});

