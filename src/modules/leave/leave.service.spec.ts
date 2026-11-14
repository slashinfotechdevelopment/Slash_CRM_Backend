import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LeaveService } from './leave.service';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  calculateAvailableBalance,
  computeScopeKey,
  formatDateOnly,
  getDatesInRange,
  parseDateOnly,
} from './leave.utils';
import {
  AttendanceStatus,
  BalanceFieldAffected,
  HalfDayPeriod,
  LeaveApprovalDecision,
  LeaveCancellationStatus,
  LeaveCategory,
  LeaveRequestStatus,
  LeaveTransactionType,
  RecordStatus,
  WorkCalendarScope,
} from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';

describe('Leave Management Subsystem (Phase 9)', () => {
  let service: LeaveService;
  let prisma: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(async (cb) => cb(prisma)),
      $queryRaw: jest.fn(),
      leaveType: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      leavePolicyVersion: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      leaveBalance: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      leaveRequest: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      leaveApproval: {
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      leaveCancellationRequest: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      leaveTransaction: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      holiday: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      weeklyOffPolicy: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      employeeProfile: {
        findUnique: jest.fn(),
      },
      attendanceRecord: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      employeeShiftAssignment: {
        findFirst: jest.fn(),
      },
      shiftDefinition: {
        findFirst: jest.fn(),
      },
    };

    auditService = {
      logAudit: jest.fn().mockResolvedValue(undefined),
      logActivity: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaveService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<LeaveService>(LeaveService);
  });

  // =========================================================================
  // 1. UTILS TESTS
  // =========================================================================
  describe('Leave Utilities', () => {
    it('should correctly calculate available balance using 6-bucket deterministic formula', () => {
      // Available = Allocated (12) + Carried (2) + Adjusted (1) - Used (3) - Pending (2) = 10
      const available = calculateAvailableBalance(12, 2, 1, 3, 2);
      expect(available).toBe(10);
    });

    it('should compute deterministic scopeKey for MySQL unique constraint', () => {
      const globalScope = computeScopeKey(WorkCalendarScope.GLOBAL);
      expect(globalScope).toEqual({ scopeKey: 'GLOBAL', scopeValue: 'GLOBAL' });

      const deptScope = computeScopeKey(WorkCalendarScope.DEPARTMENT, 'dept_eng');
      expect(deptScope).toEqual({ scopeKey: 'DEPT:dept_eng', scopeValue: 'dept_eng' });

      const locScope = computeScopeKey(WorkCalendarScope.LOCATION, null, 'bengaluru');
      expect(locScope).toEqual({ scopeKey: 'LOC:BENGALURU', scopeValue: 'BENGALURU' });

      const userScope = computeScopeKey(WorkCalendarScope.USER_OVERRIDE, null, null, 'usr_123');
      expect(userScope).toEqual({ scopeKey: 'USER:usr_123', scopeValue: 'usr_123' });
    });

    it('should reject invalid dates in parseDateOnly', () => {
      expect(() => parseDateOnly('invalid-date')).toThrow(BadRequestException);
      expect(() => parseDateOnly('2026-13-45')).toThrow(BadRequestException);
    });

    it('should generate all dates in range', () => {
      const dates = getDatesInRange(
        new Date('2026-11-20T00:00:00.000Z'),
        new Date('2026-11-22T00:00:00.000Z'),
      );
      expect(dates).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    });
  });

  // =========================================================================
  // 2. WORKING DAYS CALCULATION
  // =========================================================================
  describe('Working Days Calculation', () => {
    it('should exclude weekly offs (e.g. Sunday) when excludeWeeklyOffs is true', async () => {
      // Mock weekly-off policy returning Sunday (0)
      jest.spyOn(service, 'getEffectiveWeeklyOffDays').mockResolvedValue([0]);
      jest.spyOn(service, 'isDateHoliday').mockResolvedValue(false);

      // 2026-11-20 is Friday, 2026-11-21 is Saturday, 2026-11-22 is Sunday
      const policy = { excludeWeeklyOffs: true, excludeHolidays: true, allowHalfDay: true };
      const result = await service.calculateWorkingDays(
        'user_1',
        policy,
        new Date('2026-11-20T00:00:00.000Z'),
        new Date('2026-11-22T00:00:00.000Z'),
        false,
      );

      // Friday + Saturday = 2 days (Sunday excluded)
      expect(result.totalDays).toBe(2);
      expect(result.dates).toEqual(['2026-11-20', '2026-11-21']);
    });

    it('should return 0.5 for valid half-day request on single date', async () => {
      const policy = { excludeWeeklyOffs: true, excludeHolidays: true, allowHalfDay: true };
      const result = await service.calculateWorkingDays(
        'user_1',
        policy,
        new Date('2026-11-20T00:00:00.000Z'),
        new Date('2026-11-20T00:00:00.000Z'),
        true,
      );

      expect(result.totalDays).toBe(0.5);
    });

    it('should throw BadRequestException if half-day spans multiple days', async () => {
      const policy = { excludeWeeklyOffs: true, excludeHolidays: true, allowHalfDay: true };
      await expect(
        service.calculateWorkingDays(
          'user_1',
          policy,
          new Date('2026-11-20T00:00:00.000Z'),
          new Date('2026-11-21T00:00:00.000Z'),
          true,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // 3. LEAVE APPLICATION & CONCURRENCY
  // =========================================================================
  describe('applyLeaveRequest', () => {
    it('should throw ConflictException if request dates overlap an existing pending or approved request', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({
        id: 'lt_casual',
        status: RecordStatus.ACTIVE,
        policies: [{ id: 'lp_1', version: 1, minNoticeDays: 0, requiresDocument: false }],
      });

      prisma.leaveRequest.findFirst.mockResolvedValue({
        id: 'existing_req_1',
        requestNumber: 'LR-20261120-1234',
        status: LeaveRequestStatus.PENDING,
      });

      await expect(
        service.applyLeaveRequest(
          {
            leaveTypeId: 'lt_casual',
            startDate: '2026-11-20',
            endDate: '2026-11-22',
            reason: 'Vacation',
          },
          'user_1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if paid leave has insufficient balance', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({
        id: 'lt_casual',
        isPaid: true,
        status: RecordStatus.ACTIVE,
        policies: [
          {
            id: 'lp_1',
            version: 1,
            minNoticeDays: 0,
            requiresDocument: false,
            excludeWeeklyOffs: false,
            excludeHolidays: false,
            allowHalfDay: true,
          },
        ],
      });

      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      jest.spyOn(service, 'calculateWorkingDays').mockResolvedValue({
        totalDays: 5,
        dates: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'],
      });

      // Mock balance with only 2 available days
      prisma.leaveBalance.findUnique.mockResolvedValue({
        id: 'lb_1',
        allocated_days: 12,
        carried_forward: 0,
        adjusted_days: 0,
        used_days: 10,
        pending_days: 0,
      });

      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_1',
          allocated_days: 12,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 10,
          pending_days: 0,
        },
      ]);

      await expect(
        service.applyLeaveRequest(
          {
            leaveTypeId: 'lt_casual',
            startDate: '2026-11-20',
            endDate: '2026-11-24',
            reason: 'Vacation',
          },
          'user_1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if application exceeds maxDaysPerMonth limit', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({
        id: 'lt_casual',
        name: 'Casual Leave',
        isPaid: true,
        status: RecordStatus.ACTIVE,
        policies: [
          {
            id: 'lp_1',
            version: 1,
            maxDaysPerMonth: new Prisma.Decimal(2),
            minNoticeDays: 0,
            requiresDocument: false,
            excludeWeeklyOffs: false,
            excludeHolidays: false,
            allowHalfDay: true,
          },
        ],
      });

      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      jest.spyOn(service, 'calculateWorkingDays').mockResolvedValue({
        totalDays: 2,
        dates: ['2026-11-20', '2026-11-21'],
      });

      // User already has 1 day pending in this month (1 + 2 = 3 > 2)
      prisma.leaveRequest.findMany.mockResolvedValue([
        { id: 'req_prev', totalDays: new Prisma.Decimal(1) },
      ]);

      await expect(
        service.applyLeaveRequest(
          {
            leaveTypeId: 'lt_casual',
            startDate: '2026-11-20',
            endDate: '2026-11-21',
            reason: 'Extended break',
          },
          'user_1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should succeed, place pending hold, and log PENDING_HOLD ledger entry for sufficient paid leave balance', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({
        id: 'lt_casual',
        isPaid: true,
        status: RecordStatus.ACTIVE,
        policies: [
          {
            id: 'lp_1',
            version: 1,
            minNoticeDays: 0,
            requiresDocument: false,
            excludeWeeklyOffs: false,
            excludeHolidays: false,
            allowHalfDay: true,
          },
        ],
      });

      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      jest.spyOn(service, 'calculateWorkingDays').mockResolvedValue({
        totalDays: 2,
        dates: ['2026-11-20', '2026-11-21'],
      });

      prisma.leaveBalance.findUnique.mockResolvedValue({
        id: 'lb_1',
        allocated_days: 12,
        carried_forward: 0,
        adjusted_days: 0,
        used_days: 0,
        pending_days: 0,
      });

      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_1',
          allocated_days: 12,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 0,
          pending_days: 0,
        },
      ]);

      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1', pendingDays: 2 });
      prisma.leaveRequest.create.mockResolvedValue({
        id: 'req_123',
        requestNumber: 'LR-20261120-TEST',
        status: LeaveRequestStatus.PENDING,
      });
      prisma.employeeProfile.findUnique.mockResolvedValue({ reportingToId: 'manager_1' });

      const res = await service.applyLeaveRequest(
        {
          leaveTypeId: 'lt_casual',
          startDate: '2026-11-20',
          endDate: '2026-11-21',
          reason: 'Personal errands',
        },
        'user_1',
      );

      expect(res.id).toBe('req_123');
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ pendingDays: new Prisma.Decimal(2) }),
        }),
      );
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.PENDING_HOLD,
            balanceFieldAffected: BalanceFieldAffected.PENDING_HOLD,
          }),
        }),
      );
    });

    it('should allow unpaid leave (LOP) without requiring prior quota balance', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({
        id: 'lt_lop',
        isPaid: false,
        status: RecordStatus.ACTIVE,
        policies: [
          {
            id: 'lp_lop_1',
            version: 1,
            annualAllocation: new Prisma.Decimal(0),
            minNoticeDays: 0,
            requiresDocument: false,
            excludeWeeklyOffs: false,
            excludeHolidays: false,
            allowHalfDay: true,
          },
        ],
      });

      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      jest.spyOn(service, 'calculateWorkingDays').mockResolvedValue({
        totalDays: 3,
        dates: ['2026-11-20', '2026-11-21', '2026-11-22'],
      });

      prisma.leaveBalance.findUnique.mockResolvedValue(null);
      prisma.leaveBalance.create.mockResolvedValue({
        id: 'lb_lop',
        allocated_days: 0,
        carried_forward: 0,
        adjusted_days: 0,
        used_days: 0,
        pending_days: 0,
      });

      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_lop',
          allocated_days: 0,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 0,
          pending_days: 0,
        },
      ]);

      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_lop', pendingDays: 3 });
      prisma.leaveRequest.create.mockResolvedValue({
        id: 'req_lop_123',
        requestNumber: 'LR-LOP-TEST',
        status: LeaveRequestStatus.PENDING,
      });
      prisma.employeeProfile.findUnique.mockResolvedValue({ reportingToId: 'manager_1' });

      const res = await service.applyLeaveRequest(
        {
          leaveTypeId: 'lt_lop',
          startDate: '2026-11-20',
          endDate: '2026-11-22',
          reason: 'Emergency absence',
        },
        'user_1',
      );

      expect(res.id).toBe('req_lop_123');
      expect(prisma.leaveRequest.create).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. APPROVAL WORKFLOW & ANTI-SELF-APPROVAL
  // =========================================================================
  describe('reviewLeaveRequest', () => {
    it('should throw ForbiddenException if approver attempts to self-approve', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'req_123',
          user_id: 'user_1', // Applicant is user_1
          status: LeaveRequestStatus.PENDING,
        },
      ]);

      await expect(
        service.reviewLeaveRequest(
          'req_123',
          { decision: LeaveApprovalDecision.APPROVED },
          'user_1', // Reviewer is also user_1
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should approve leave, decrement pending, increment used, log UTILIZATION, and mark attendance ON_LEAVE', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'req_123',
            request_number: 'LR-123',
            user_id: 'user_1',
            leave_type_id: 'lt_casual',
            total_days: 2,
            start_date: new Date('2026-11-20'),
            end_date: new Date('2026-11-21'),
            status: LeaveRequestStatus.PENDING,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'lb_1',
            allocated_days: 12,
            carried_forward: 0,
            adjusted_days: 0,
            used_days: 0,
            pending_days: 2,
          },
        ]);

      prisma.leaveType.findUnique.mockResolvedValue({ id: 'lt_casual', isPaid: true });
      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1' });
      prisma.leaveTransaction.create.mockResolvedValue({ id: 'tx_1' });
      prisma.leaveApproval.updateMany.mockResolvedValue({ count: 1 });
      prisma.leaveRequest.update.mockResolvedValue({ id: 'req_123', status: LeaveRequestStatus.APPROVED });
      prisma.shiftDefinition.findFirst.mockResolvedValue({
        id: 'shift_1',
        startTime: '09:00',
        endTime: '18:00',
        isOvernight: false,
        halfDayThresholdMinutes: 240,
        fullDayThresholdMinutes: 480,
        overtimeThresholdMinutes: 540,
        allowMultipleSessions: false,
        breakPolicySnapshot: '{}',
      });
      prisma.employeeShiftAssignment.findFirst.mockResolvedValue(null);
      prisma.attendanceRecord.findUnique.mockResolvedValue(null);
      prisma.attendanceRecord.create.mockResolvedValue({ id: 'att_1', status: AttendanceStatus.ON_LEAVE });

      const res = await service.reviewLeaveRequest(
        'req_123',
        { decision: LeaveApprovalDecision.APPROVED, comments: 'Approved' },
        'manager_1',
      );

      expect(res.status).toBe(LeaveRequestStatus.APPROVED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingDays: new Prisma.Decimal(0),
            usedDays: new Prisma.Decimal(2),
          }),
        }),
      );
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.UTILIZATION,
            balanceFieldAffected: BalanceFieldAffected.USED,
          }),
        }),
      );
      expect(prisma.attendanceRecord.create).toHaveBeenCalled();
    });

    it('should release pending hold on rejection without incrementing usedDays', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'req_123',
            request_number: 'LR-123',
            user_id: 'user_1',
            leave_type_id: 'lt_casual',
            total_days: 2,
            start_date: new Date('2026-11-20'),
            end_date: new Date('2026-11-21'),
            status: LeaveRequestStatus.PENDING,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'lb_1',
            allocated_days: 12,
            carried_forward: 0,
            adjusted_days: 0,
            used_days: 0,
            pending_days: 2,
          },
        ]);

      prisma.leaveType.findUnique.mockResolvedValue({ id: 'lt_casual', isPaid: true });
      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1' });
      prisma.leaveRequest.update.mockResolvedValue({ id: 'req_123', status: LeaveRequestStatus.REJECTED });

      const res = await service.reviewLeaveRequest(
        'req_123',
        { decision: LeaveApprovalDecision.REJECTED, comments: 'Project deadline' },
        'manager_1',
      );

      expect(res.status).toBe(LeaveRequestStatus.REJECTED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingDays: new Prisma.Decimal(0),
            usedDays: new Prisma.Decimal(0),
          }),
        }),
      );
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.HOLD_RELEASE_REJECTED,
            balanceFieldAffected: BalanceFieldAffected.PENDING_HOLD,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 5. CANCELLATION WORKFLOW
  // =========================================================================
  describe('cancelLeaveRequest', () => {
    it('should immediately self-cancel pending leave and release hold', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'req_pending',
        requestNumber: 'LR-PENDING-1',
        userId: 'user_1',
        leaveTypeId: 'lt_casual',
        startDate: new Date('2026-11-20'),
        totalDays: new Prisma.Decimal(2),
        status: LeaveRequestStatus.PENDING,
      });

      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_1',
          allocated_days: 12,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 0,
          pending_days: 2,
        },
      ]);

      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1' });
      prisma.leaveRequest.update.mockResolvedValue({
        id: 'req_pending',
        status: LeaveRequestStatus.CANCELLED,
      });

      const res = await service.cancelLeaveRequest(
        'req_pending',
        { reason: 'Plans changed' },
        'user_1',
      );

      expect(res.message).toContain('cancelled successfully');
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.HOLD_RELEASE_CANCELLED,
          }),
        }),
      );
    });

    it('should submit cancellation request for administrative review if leave is approved', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue({
        id: 'req_approved',
        status: LeaveRequestStatus.APPROVED,
      });
      prisma.leaveCancellationRequest.findFirst.mockResolvedValue(null);
      prisma.leaveCancellationRequest.create.mockResolvedValue({
        id: 'canc_req_1',
        status: LeaveCancellationStatus.PENDING,
      });

      const res = await service.cancelLeaveRequest(
        'req_approved',
        { reason: 'Trip cancelled' },
        'user_1',
      );

      expect(res.message).toContain('submitted for administrative review');
      expect(prisma.leaveCancellationRequest.create).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. CANCELLATION REVIEW & BALANCE RESTORATION
  // =========================================================================
  describe('reviewCancellationRequest', () => {
    it('should restore usedDays, log REVERSAL_CANCELLATION, and revert attendance to PENDING_RECONCILIATION', async () => {
      prisma.leaveCancellationRequest.findUnique.mockResolvedValue({
        id: 'canc_1',
        status: LeaveCancellationStatus.PENDING,
        leaveRequest: {
          id: 'req_123',
          userId: 'user_1',
          leaveTypeId: 'lt_casual',
          startDate: new Date('2026-11-20'),
          endDate: new Date('2026-11-20'),
          totalDays: new Prisma.Decimal(1),
        },
      });

      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_1',
          allocated_days: 12,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 1,
          pending_days: 0,
        },
      ]);

      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1' });
      prisma.leaveRequest.update.mockResolvedValue({ id: 'req_123', status: LeaveRequestStatus.CANCELLED });
      prisma.attendanceRecord.findUnique.mockResolvedValue({
        id: 'att_1',
        status: AttendanceStatus.ON_LEAVE,
        sessions: [],
      });
      prisma.attendanceRecord.update.mockResolvedValue({ id: 'att_1' });
      prisma.leaveCancellationRequest.update.mockResolvedValue({
        id: 'canc_1',
        status: LeaveCancellationStatus.APPROVED,
      });

      const res = await service.reviewCancellationRequest(
        'canc_1',
        { decision: LeaveCancellationStatus.APPROVED, reviewerNotes: 'Restored' },
        'manager_1',
      );

      expect(res.status).toBe(LeaveCancellationStatus.APPROVED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usedDays: new Prisma.Decimal(0) }),
        }),
      );
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.REVERSAL_CANCELLATION,
          }),
        }),
      );
      expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: AttendanceStatus.PENDING_RECONCILIATION }),
        }),
      );
    });
  });

  // =========================================================================
  // 7. MANUAL HR BALANCE ADJUSTMENT
  // =========================================================================
  describe('adjustLeaveBalance', () => {
    it('should adjust balance and write MANUAL_ADJUSTMENT_CREDIT ledger entry', async () => {
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'lb_1' });
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'lb_1',
          allocated_days: 12,
          carried_forward: 0,
          adjusted_days: 0,
          used_days: 0,
          pending_days: 0,
        },
      ]);

      prisma.leaveBalance.update.mockResolvedValue({ id: 'lb_1', adjustedDays: 2 });

      await service.adjustLeaveBalance(
        {
          userId: 'user_1',
          leaveTypeId: 'lt_comp_off',
          year: 2026,
          adjustedDays: 2,
          reason: 'Comp-off credit for weekend server maintenance',
        },
        'hr_admin_1',
      );

      expect(prisma.leaveBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ adjustedDays: new Prisma.Decimal(2) }),
        }),
      );
      expect(prisma.leaveTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionType: LeaveTransactionType.MANUAL_ADJUSTMENT_CREDIT,
            balanceFieldAffected: BalanceFieldAffected.ADJUSTED,
            amount: new Prisma.Decimal(2),
          }),
        }),
      );
    });
  });
});

