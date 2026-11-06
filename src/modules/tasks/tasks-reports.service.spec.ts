import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TasksReportsService } from './tasks-reports.service';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TasksTimerService } from './tasks-timer.service';
import { DataScope, TaskPriority, TaskReviewOutcome, TaskStatus, TaskTimerStatus } from '../../generated/prisma/enums';

describe('TasksReportsService (Unit Tests)', () => {
  let service: TasksReportsService;
  let prismaMock: any;
  let usersServiceMock: any;
  let tasksTimerServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      task: {
        groupBy: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      taskTimeEntry: {
        findMany: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
      },
      taskTimePause: {
        findMany: jest.fn(),
        aggregate: jest.fn(),
      },
      taskActivityLog: {
        findMany: jest.fn(),
      },
      taskReview: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
      },
      taskStatusHistory: {
        findMany: jest.fn(),
      },
      department: {
        findMany: jest.fn(),
      },
      user: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      userDepartment: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    usersServiceMock = {
      resolveActorDataScope: jest.fn().mockResolvedValue(DataScope.ALL),
    };

    tasksTimerServiceMock = {
      getActiveTimer: jest.fn().mockResolvedValue({
        hasActiveTimer: false,
        isRunning: false,
        isPaused: false,
        entry: null,
        task: null,
        activePause: null,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksReportsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: TasksTimerService, useValue: tasksTimerServiceMock },
      ],
    }).compile();

    service = module.get<TasksReportsService>(TasksReportsService);
  });

  describe('getEmployeeDashboard', () => {
    it('should reject CLIENT users with ForbiddenException', async () => {
      await expect(
        service.getEmployeeDashboard('client_1', 'CLIENT', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return employee dashboard metrics for authorized employee', async () => {
      prismaMock.task.groupBy.mockResolvedValue([
        { status: TaskStatus.TODO, _count: { id: 2 } },
        { status: TaskStatus.IN_PROGRESS, _count: { id: 3 } },
        { status: TaskStatus.COMPLETED, _count: { id: 5 } },
      ]);
      prismaMock.task.count
        .mockResolvedValueOnce(8) // assignedTasks
        .mockResolvedValueOnce(2) // ownUnassignedDrafts
        .mockResolvedValueOnce(1) // overdue
        .mockResolvedValueOnce(2) // dueToday
        .mockResolvedValueOnce(3); // upcoming

      prismaMock.taskTimeEntry.findMany.mockResolvedValue([
        { startedAt: new Date(), endedAt: new Date(), durationSeconds: 3600, status: TaskTimerStatus.STOPPED },
      ]);
      prismaMock.taskTimePause.findMany.mockResolvedValue([
        { pausedAt: new Date(), resumedAt: new Date(), pauseDurationSeconds: 600 },
      ]);
      prismaMock.taskActivityLog.findMany.mockResolvedValue([]);
      prismaMock.taskReview.findMany.mockResolvedValue([]);

      const result = await service.getEmployeeDashboard('user_1', 'EMPLOYEE', {});
      expect(result.success).toBe(true);
      expect(result.data.totalTasks).toBe(10);
      expect(result.data.statusCounts[TaskStatus.TODO]).toBe(2);
      expect(result.data.statusCounts[TaskStatus.IN_PROGRESS]).toBe(3);
      expect(result.data.statusCounts[TaskStatus.COMPLETED]).toBe(5);
      expect(result.data.timerTelemetry.todayWorkingSeconds).toBe(3600);
      expect(result.data.timerTelemetry.todayPausedSeconds).toBe(600);
    });
  });

  describe('getTeamDashboard', () => {
    it('should reject CLIENT user type', async () => {
      await expect(
        service.getTeamDashboard('client_1', 'CLIENT', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject actor with OWN scope', async () => {
      usersServiceMock.resolveActorDataScope.mockResolvedValue(DataScope.OWN);
      await expect(
        service.getTeamDashboard('user_1', 'EMPLOYEE', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return team dashboard metrics for authorized manager', async () => {
      usersServiceMock.resolveActorDataScope.mockResolvedValue(DataScope.DEPARTMENT);
      prismaMock.userDepartment.findMany.mockResolvedValue([{ departmentId: 'dept_1' }]);

      prismaMock.task.groupBy
        .mockResolvedValueOnce([{ status: TaskStatus.IN_PROGRESS, _count: { id: 5 } }]) // status
        .mockResolvedValueOnce([{ priority: TaskPriority.HIGH, _count: { id: 5 } }]) // priority
        .mockResolvedValueOnce([{ assigneeId: 'emp_1', _count: { id: 5 } }]) // employeeTaskGroups
        .mockResolvedValueOnce([{ assigneeId: 'emp_1', _count: { id: 2 } }]); // completedGroups

      prismaMock.task.count
        .mockResolvedValueOnce(5) // assignedTasks
        .mockResolvedValueOnce(0) // overdue
        .mockResolvedValueOnce(1) // dueToday
        .mockResolvedValueOnce(2); // upcoming

      prismaMock.user.findMany.mockResolvedValue([
        { id: 'emp_1', userCode: 'EMP001', name: 'Developer One', email: 'dev1@example.com' },
      ]);
      prismaMock.taskTimeEntry.findMany.mockResolvedValue([]);
      prismaMock.taskActivityLog.findMany.mockResolvedValue([]);

      const result = await service.getTeamDashboard('manager_1', 'EMPLOYEE', {});
      expect(result.success).toBe(true);
      expect(result.data.totalTasks).toBe(5);
      expect(result.data.employeeDistribution.length).toBe(1);
      expect(result.data.employeeDistribution[0].completedTasks).toBe(2);
      expect(result.data.employeeDistribution[0].activeTasks).toBe(3);
    });
  });

  describe('getOrganizationDashboard', () => {
    it('should reject EMPLOYEE user type', async () => {
      await expect(
        service.getOrganizationDashboard('emp_1', 'EMPLOYEE', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return organization metrics for Admin or Super Admin', async () => {
      prismaMock.task.groupBy
        .mockResolvedValueOnce([{ status: TaskStatus.COMPLETED, _count: { id: 20 } }]) // status
        .mockResolvedValueOnce([{ priority: TaskPriority.HIGH, _count: { id: 20 } }]) // priority
        .mockResolvedValueOnce([{ departmentId: 'dept_1', _count: { id: 20 } }]) // dept
        .mockResolvedValueOnce([{ departmentId: 'dept_1', _count: { id: 18 } }]); // dept completed

      prismaMock.department.findMany.mockResolvedValue([
        { id: 'dept_1', code: 'ENG', name: 'Engineering' },
      ]);
      prismaMock.task.count.mockResolvedValue(0);
      prismaMock.taskStatusHistory.findMany.mockResolvedValue([{ taskId: 'task_1', createdAt: new Date() }]);
      prismaMock.taskTimeEntry.aggregate.mockResolvedValue({ _sum: { durationSeconds: 72000 }, _count: { id: 10 } });
      prismaMock.taskTimePause.aggregate.mockResolvedValue({ _sum: { pauseDurationSeconds: 7200 } });
      prismaMock.taskTimeEntry.count.mockResolvedValue(3);

      const result = await service.getOrganizationDashboard('admin_1', 'ADMIN', {});
      expect(result.success).toBe(true);
      expect(result.data.totalTasks).toBe(20);
      expect(result.data.departmentDistribution[0].completionPercentage).toBe(90);
      expect(result.data.timeTelemetry.totalWorkingHours).toBe(20);
      expect(result.data.timeTelemetry.totalPausedHours).toBe(2);
      expect(result.data.timeTelemetry.liveTimersCount).toBe(3);
    });
  });

  describe('getTaskSummaryReport', () => {
    it('should calculate completion percentage excluding CANCELLED tasks from denominator', async () => {
      prismaMock.task.groupBy
        .mockResolvedValueOnce([
          { status: TaskStatus.COMPLETED, _count: { id: 4 } },
          { status: TaskStatus.IN_PROGRESS, _count: { id: 4 } },
          { status: TaskStatus.CANCELLED, _count: { id: 2 } },
        ])
        .mockResolvedValueOnce([{ priority: TaskPriority.MEDIUM, _count: { id: 10 } }]);

      prismaMock.task.count.mockResolvedValue(1); // overdue

      const result = await service.getTaskSummaryReport('user_1', 'EMPLOYEE', {});
      expect(result.success).toBe(true);
      expect(result.data.totalTasks).toBe(10);
      expect(result.data.completedTasks).toBe(4);
      expect(result.data.pendingTasks).toBe(4);
      // Denominator: 10 total - 2 cancelled = 8 eligible tasks.
      // Completion % = (4 / 8) * 100 = 50.00%
      expect(result.data.completionPercentage).toBe(50);
    });

    it('should count distinct tasks completed in historical interval', async () => {
      prismaMock.task.groupBy
        .mockResolvedValueOnce([{ status: TaskStatus.COMPLETED, _count: { id: 10 } }])
        .mockResolvedValueOnce([{ priority: TaskPriority.HIGH, _count: { id: 10 } }]);

      prismaMock.task.count.mockResolvedValue(0);

      // Return 3 distinct completed tasks even if multiple transitions exist
      prismaMock.taskStatusHistory.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.newStatus === TaskStatus.CANCELLED) return [];
        if (args?.where?.newStatus === TaskStatus.COMPLETED) {
          return [{ taskId: 'task_1' }, { taskId: 'task_2' }, { taskId: 'task_3' }];
        }
        return [];
      });

      const result = await service.getTaskSummaryReport('user_1', 'EMPLOYEE', {
        startDate: '2026-11-01',
        endDate: '2026-11-05',
      });

      expect(result.success).toBe(true);
      expect(result.data.completedTasks).toBe(3);
    });
  });

  describe('getReviewSummaryReport', () => {
    it('should compute average review turnaround duration on finalized reviews', async () => {
      prismaMock.taskReview.groupBy.mockResolvedValue([
        { outcome: TaskReviewOutcome.APPROVED, _count: { id: 2 } },
        { outcome: TaskReviewOutcome.PENDING, _count: { id: 1 } },
      ]);

      prismaMock.taskReview.findMany
        .mockResolvedValueOnce([
          { reviewerId: 'rev_1', reviewer: { id: 'rev_1', name: 'Reviewer One', userCode: 'REV01' } },
        ]) // pending reviews
        .mockResolvedValueOnce([
          { submittedAt: new Date('2026-11-01T10:00:00Z'), reviewedAt: new Date('2026-11-01T11:00:00Z') }, // 3600s
          { submittedAt: new Date('2026-11-02T10:00:00Z'), reviewedAt: new Date('2026-11-02T12:00:00Z') }, // 7200s
        ]); // finalized reviews

      const result = await service.getReviewSummaryReport('pm_1', 'EMPLOYEE', {});
      expect(result.success).toBe(true);
      expect(result.data.approvedCount).toBe(2);
      expect(result.data.awaitingReviewCount).toBe(1);
      // Avg turnaround: (3600 + 7200) / 2 = 5400s (1.5h)
      expect(result.data.turnaroundMetrics.avgTurnaroundSeconds).toBe(5400);
      expect(result.data.turnaroundMetrics.avgTurnaroundHours).toBe(1.5);
    });
  });
});

