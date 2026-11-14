import { Test, TestingModule } from '@nestjs/testing';
import { AdminDashboardService } from './admin-dashboard.service';
import { PrismaService } from '../../database/prisma.service';
import {
  calculateCompletionRate,
  calculateConversionRate,
  calculateSessionDurationSeconds,
  computeIsOnline,
  computeIsOverdue,
  formatDurationHuman,
  ONLINE_THRESHOLD_MS,
} from './admin-dashboard.utils';
import { SessionStatus, TaskStatus } from '../../generated/prisma/client';

describe('AdminDashboardService & Utils', () => {
  let service: AdminDashboardService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      userSession: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      task: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      lead: {
        count: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn(),
      },
      pipelineStage: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminDashboardService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminDashboardService>(AdminDashboardService);
  });

  describe('Utility: calculateSessionDurationSeconds', () => {
    it('should calculate duration using revokedAt when present', () => {
      const createdAt = new Date('2026-11-14T10:00:00.000Z');
      const revokedAt = new Date('2026-11-14T11:30:00.000Z');
      const lastUsedAt = new Date('2026-11-14T11:25:00.000Z');

      const duration = calculateSessionDurationSeconds({
        createdAt,
        revokedAt,
        lastUsedAt,
        status: SessionStatus.REVOKED,
      });

      expect(duration).toBe(5400); // 90 minutes = 5400 seconds
    });

    it('should calculate duration using lastUsedAt for EXPIRED sessions (when revokedAt is null)', () => {
      const createdAt = new Date('2026-11-14T10:00:00.000Z');
      const lastUsedAt = new Date('2026-11-14T10:45:00.000Z');

      const duration = calculateSessionDurationSeconds({
        createdAt,
        revokedAt: null,
        lastUsedAt,
        status: SessionStatus.EXPIRED,
      });

      expect(duration).toBe(2700); // 45 minutes = 2700 seconds
    });

    it('should return 0 when neither revokedAt nor lastUsedAt is available', () => {
      const createdAt = new Date('2026-11-14T10:00:00.000Z');

      const duration = calculateSessionDurationSeconds({
        createdAt,
        revokedAt: null,
        lastUsedAt: null,
        status: SessionStatus.ACTIVE,
      });

      expect(duration).toBe(0);
    });

    it('should format duration into human-readable string', () => {
      expect(formatDurationHuman(5400)).toBe('1h 30m');
      expect(formatDurationHuman(1200)).toBe('20m');
      expect(formatDurationHuman(0)).toBe('0m');
    });
  });

  describe('Utility: computeIsOnline', () => {
    const fixedNow = new Date('2026-11-14T12:00:00.000Z');

    it('should return true for ACTIVE session with lastUsedAt within the last 20 minutes', () => {
      const sessions = [
        {
          status: 'ACTIVE',
          createdAt: new Date('2026-11-14T11:00:00.000Z'),
          lastUsedAt: new Date(fixedNow.getTime() - 10 * 60 * 1000), // 10 mins ago
        },
      ];

      expect(computeIsOnline(sessions, fixedNow)).toBe(true);
    });

    it('should return false for ACTIVE session with lastUsedAt older than 20 minutes', () => {
      const sessions = [
        {
          status: 'ACTIVE',
          createdAt: new Date('2026-11-14T11:00:00.000Z'),
          lastUsedAt: new Date(fixedNow.getTime() - 25 * 60 * 1000), // 25 mins ago
        },
      ];

      expect(computeIsOnline(sessions, fixedNow)).toBe(false);
    });

    it('should return true if lastUsedAt is null but createdAt is within 20 minutes', () => {
      const sessions = [
        {
          status: 'ACTIVE',
          createdAt: new Date(fixedNow.getTime() - 5 * 60 * 1000), // 5 mins ago
          lastUsedAt: null,
        },
      ];

      expect(computeIsOnline(sessions, fixedNow)).toBe(true);
    });

    it('should return false if session is REVOKED or EXPIRED even if recent', () => {
      const sessions = [
        {
          status: 'REVOKED',
          createdAt: new Date(fixedNow.getTime() - 5 * 60 * 1000),
          lastUsedAt: new Date(fixedNow.getTime() - 2 * 60 * 1000),
        },
      ];

      expect(computeIsOnline(sessions, fixedNow)).toBe(false);
    });
  });

  describe('Utility: computeIsOverdue', () => {
    const fixedNow = new Date('2026-11-14T12:00:00.000Z');

    it('should return true when dueDate < now and status is TODO or IN_PROGRESS', () => {
      const pastDue = new Date('2026-11-14T10:00:00.000Z');
      expect(computeIsOverdue({ dueDate: pastDue, status: TaskStatus.TODO }, fixedNow)).toBe(true);
      expect(computeIsOverdue({ dueDate: pastDue, status: TaskStatus.IN_PROGRESS }, fixedNow)).toBe(true);
    });

    it('should return false when status is COMPLETED even if past dueDate', () => {
      const pastDue = new Date('2026-11-14T10:00:00.000Z');
      expect(computeIsOverdue({ dueDate: pastDue, status: TaskStatus.COMPLETED }, fixedNow)).toBe(false);
    });

    it('should return false when status is CANCELLED even if past dueDate', () => {
      const pastDue = new Date('2026-11-14T10:00:00.000Z');
      expect(computeIsOverdue({ dueDate: pastDue, status: TaskStatus.CANCELLED }, fixedNow)).toBe(false);
    });

    it('should return false when dueDate >= now', () => {
      const futureDue = new Date('2026-11-14T15:00:00.000Z');
      expect(computeIsOverdue({ dueDate: futureDue, status: TaskStatus.TODO }, fixedNow)).toBe(false);
    });

    it('should return false when task has no dueDate', () => {
      expect(computeIsOverdue({ dueDate: null, status: TaskStatus.TODO }, fixedNow)).toBe(false);
    });
  });

  describe('Utility: calculateCompletionRate & calculateConversionRate', () => {
    it('should calculate completion rate percentage correctly', () => {
      expect(calculateCompletionRate(8, 10)).toBe(80.0);
      expect(calculateCompletionRate(1, 3)).toBe(33.33);
      expect(calculateCompletionRate(0, 0)).toBe(0);
      expect(calculateCompletionRate(5, 0)).toBe(0);
    });

    it('should calculate conversion rate percentage correctly', () => {
      expect(calculateConversionRate(5, 20)).toBe(25.0);
      expect(calculateConversionRate(0, 50)).toBe(0);
      expect(calculateConversionRate(10, 0)).toBe(0);
    });
  });

  describe('Service: Lead & Tasks Aggregations', () => {
    it('should compute lead summary metrics and conversion rate', async () => {
      prisma.lead.count
        .mockResolvedValueOnce(100) // newLeads
        .mockResolvedValueOnce(30)  // convertedLeads
        .mockResolvedValueOnce(10)  // lostLeads
        .mockResolvedValueOnce(25); // createdAndConvertedCount

      prisma.pipelineStage.findMany.mockResolvedValue([
        { id: 'stg-1', code: 'NEW', name: 'New Stage', color: '#fff', _count: { leads: 50 } },
      ]);

      prisma.lead.groupBy.mockResolvedValue([
        { status: 'NEW', _count: { _all: 50 } },
        { status: 'WON', _count: { _all: 25 } },
      ]);

      const result = await service.getLeadsSummary({});

      expect(result.newLeads).toBe(100);
      expect(result.convertedLeads).toBe(30);
      expect(result.lostLeads).toBe(10);
      expect(result.conversionRatePercentage).toBe(25.0); // 25 / 100 * 100
      expect(result.countByStage).toHaveLength(1);
      expect(result.countByStatus.NEW).toBe(50);
    });

    it('should compute tasks summary per employee excluding cancelled tasks', async () => {
      prisma.task.findMany.mockResolvedValue([
        {
          id: 't-1',
          assigneeId: 'u-1',
          status: TaskStatus.COMPLETED,
          dueDate: new Date('2026-11-10'),
          assignee: {
            id: 'u-1',
            name: 'John Doe',
            email: 'john@example.com',
            userCode: 'EMP001',
            employeeProfile: { employeeCode: 'EMP001' },
            departments: [{ department: { name: 'Tech' } }],
          },
        },
        {
          id: 't-2',
          assigneeId: 'u-1',
          status: TaskStatus.CANCELLED, // should be excluded from totals & rate
          dueDate: new Date('2026-11-10'),
          assignee: {
            id: 'u-1',
            name: 'John Doe',
            email: 'john@example.com',
            userCode: 'EMP001',
            employeeProfile: { employeeCode: 'EMP001' },
            departments: [{ department: { name: 'Tech' } }],
          },
        },
        {
          id: 't-3',
          assigneeId: 'u-1',
          status: TaskStatus.TODO,
          dueDate: new Date('2026-11-01'), // overdue
          assignee: {
            id: 'u-1',
            name: 'John Doe',
            email: 'john@example.com',
            userCode: 'EMP001',
            employeeProfile: { employeeCode: 'EMP001' },
            departments: [{ department: { name: 'Tech' } }],
          },
        },
      ]);

      const result = await service.getTasksSummary({});

      expect(result.summary).toHaveLength(1);
      const emp = result.summary[0];
      expect(emp.totalTasks).toBe(2); // 3 total - 1 cancelled = 2
      expect(emp.completedTasks).toBe(1);
      expect(emp.cancelledTasks).toBe(1);
      expect(emp.overdueTasks).toBe(1);
      expect(emp.pendingTasks).toBe(1);
      expect(emp.completionRatePercentage).toBe(50.0); // 1 / 2 * 100
    });
  });
});
