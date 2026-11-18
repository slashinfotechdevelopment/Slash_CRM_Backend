import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AuditAction,
  BalanceFieldAffected,
  HalfDayPeriod,
  LeaveAccrualFrequency,
  LeaveApprovalDecision,
  LeaveCancellationStatus,
  LeaveCategory,
  LeaveRequestStatus,
  LeaveTransactionType,
  RecordStatus,
  WorkCalendarScope,
  AttendanceStatus,
} from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { CreatePolicyVersionDto } from './dto/create-policy-version.dto';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { SyncGoogleHolidaysDto } from './dto/sync-google-holidays.dto';
import { CreateWeeklyOffPolicyDto } from './dto/create-weekly-off-policy.dto';
import { ApplyLeaveRequestDto } from './dto/apply-leave-request.dto';
import { ReviewLeaveRequestDto } from './dto/review-leave-request.dto';
import { CreateCancellationRequestDto } from './dto/create-cancellation-request.dto';
import { ReviewCancellationRequestDto } from './dto/review-cancellation-request.dto';
import { AdjustLeaveBalanceDto } from './dto/adjust-leave-balance.dto';
import {
  QueryHolidaysDto,
  QueryLeaveBalancesDto,
  QueryLeaveCalendarDto,
  QueryLeaveReportDto,
  QueryLeaveRequestsDto,
  QueryLeaveTransactionsDto,
  QueryWeeklyOffPoliciesDto,
} from './dto/query-leave.dto';
import {
  calculateAvailableBalance,
  computeScopeKey,
  formatDateOnly,
  generateLeaveRequestNumber,
  getDatesInRange,
  parseDateOnly,
} from './leave.utils';

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // =========================================================================
  // 1. LEAVE TYPES & POLICIES (Phase 9.1)
  // =========================================================================

  /**
   * Creates a new LeaveType with its initial policy version (Version 1).
   */
  async createLeaveType(dto: CreateLeaveTypeDto, actorUserId: string) {
    const existing = await this.prisma.leaveType.findUnique({
      where: { code: dto.code.trim().toUpperCase() },
    });
    if (existing) {
      throw new ConflictException(`Leave type with code '${dto.code}' already exists.`);
    }

    const code = dto.code.trim().toUpperCase();
    const effectiveFrom = new Date();
    effectiveFrom.setUTCHours(0, 0, 0, 0);

    const result = await this.prisma.$transaction(async (tx) => {
      const leaveType = await tx.leaveType.create({
        data: {
          code,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          category: dto.category ?? LeaveCategory.PAID,
          isPaid: dto.isPaid !== undefined ? dto.isPaid : true,
          status: RecordStatus.ACTIVE,
        },
      });

      const policyVersion = await tx.leavePolicyVersion.create({
        data: {
          leaveTypeId: leaveType.id,
          version: 1,
          effectiveFrom,
          effectiveTo: null,
          accrualFrequency: dto.accrualFrequency ?? LeaveAccrualFrequency.ANNUAL,
          annualAllocation: new Prisma.Decimal(dto.annualAllocation ?? 12.0),
          monthlyAllocation: dto.monthlyAllocation ? new Prisma.Decimal(dto.monthlyAllocation) : null,
          maxDaysPerMonth: dto.maxDaysPerMonth ? new Prisma.Decimal(dto.maxDaysPerMonth) : null,
          carryForwardExpiryMonths: dto.carryForwardExpiryMonths ?? null,
          maxConsecutiveDays: dto.maxConsecutiveDays ?? null,
          allowHalfDay: dto.allowHalfDay ?? true,
          requiresDocument: dto.requiresDocument ?? false,
          minNoticeDays: dto.minNoticeDays ?? 0,
          carryForwardLimit: new Prisma.Decimal(dto.carryForwardLimit ?? 0.0),
          excludeWeeklyOffs: dto.excludeWeeklyOffs ?? true,
          excludeHolidays: dto.excludeHolidays ?? true,
          applicableEmploymentType: dto.applicableEmploymentType ?? null,
          departmentId: dto.departmentId ?? null,
          status: RecordStatus.ACTIVE,
        },
      });

      return { leaveType, policyVersion };
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'LeaveType',
      entityId: result.leaveType.id,
      newValues: result,
    });

    return result;
  }

  /**
   * Retrieves all leave types with their current active policy version.
   */
  async getLeaveTypes(includeInactive = false) {
    const where: Prisma.LeaveTypeWhereInput = {};
    if (!includeInactive) {
      where.status = RecordStatus.ACTIVE;
    }

    const types = await this.prisma.leaveType.findMany({
      where,
      include: {
        policies: {
          where: { status: RecordStatus.ACTIVE },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });

    return types.map((t) => ({
      ...t,
      currentPolicy: t.policies[0] ?? null,
    }));
  }

  /**
   * Retrieves a single leave type by ID with all historical policy versions.
   */
  async getLeaveTypeById(id: string) {
    const leaveType = await this.prisma.leaveType.findUnique({
      where: { id },
      include: {
        policies: {
          orderBy: { version: 'desc' },
          include: { department: true },
        },
      },
    });

    if (!leaveType) {
      throw new NotFoundException('The requested leave type could not be found or has been deactivated.');
    }

    return leaveType;
  }

  /**
   * Updates leave type metadata.
   */
  async updateLeaveType(id: string, dto: UpdateLeaveTypeDto, actorUserId: string) {
    const existing = await this.prisma.leaveType.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('The requested leave type could not be found or has been deactivated.');
    }

    const updated = await this.prisma.leaveType.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? dto.description.trim() : undefined,
        category: dto.category,
        isPaid: dto.isPaid,
        status: dto.status,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leave',
      entityType: 'LeaveType',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  /**
   * Adds a new immutable policy version for a leave type, preserving previous versions.
   */
  async createPolicyVersion(leaveTypeId: string, dto: CreatePolicyVersionDto, actorUserId: string) {
    const leaveType = await this.prisma.leaveType.findUnique({
      where: { id: leaveTypeId },
      include: {
        policies: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (!leaveType) {
      throw new NotFoundException('The selected leave type could not be found.');
    }

    const nextVersion = (leaveType.policies[0]?.version ?? 0) + 1;
    const effectiveFrom = parseDateOnly(dto.effectiveFrom);
    const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo) : null;

    if (effectiveTo && effectiveFrom.getTime() >= effectiveTo.getTime()) {
      throw new BadRequestException('effectiveFrom must be strictly before effectiveTo.');
    }

    const newPolicy = await this.prisma.$transaction(async (tx) => {
      // If previous policy had open effectiveTo, close it to previous day
      if (leaveType.policies[0] && !leaveType.policies[0].effectiveTo) {
        const prevEnd = new Date(effectiveFrom.getTime() - 24 * 60 * 60 * 1000);
        await tx.leavePolicyVersion.update({
          where: { id: leaveType.policies[0].id },
          data: { effectiveTo: prevEnd },
        });
      }

      return tx.leavePolicyVersion.create({
        data: {
          leaveTypeId,
          version: nextVersion,
          effectiveFrom,
          effectiveTo,
          accrualFrequency: dto.accrualFrequency ?? LeaveAccrualFrequency.ANNUAL,
          annualAllocation: new Prisma.Decimal(dto.annualAllocation),
          monthlyAllocation: dto.monthlyAllocation ? new Prisma.Decimal(dto.monthlyAllocation) : null,
          maxDaysPerMonth: dto.maxDaysPerMonth ? new Prisma.Decimal(dto.maxDaysPerMonth) : null,
          carryForwardExpiryMonths: dto.carryForwardExpiryMonths ?? null,
          maxConsecutiveDays: dto.maxConsecutiveDays ?? null,
          allowHalfDay: dto.allowHalfDay ?? true,
          requiresDocument: dto.requiresDocument ?? false,
          minNoticeDays: dto.minNoticeDays ?? 0,
          carryForwardLimit: new Prisma.Decimal(dto.carryForwardLimit ?? 0.0),
          excludeWeeklyOffs: dto.excludeWeeklyOffs ?? true,
          excludeHolidays: dto.excludeHolidays ?? true,
          applicableEmploymentType: dto.applicableEmploymentType ?? null,
          departmentId: dto.departmentId ?? null,
          status: RecordStatus.ACTIVE,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'LeavePolicyVersion',
      entityId: newPolicy.id,
      newValues: newPolicy,
    });

    return newPolicy;
  }

  // =========================================================================
  // 2. HOLIDAYS & WEEKLY-OFF CALENDARS (Deterministic MySQL Unique Scope)
  // =========================================================================

  /**
   * Creates a calendar holiday with deterministic scopeKey.
   */
  async createHoliday(dto: CreateHolidayDto, actorUserId: string) {
    const holidayDate = parseDateOnly(dto.date);
    const year = dto.year ?? holidayDate.getUTCFullYear();
    const scopeType = dto.scopeType ?? WorkCalendarScope.GLOBAL;
    const { scopeKey, scopeValue } = computeScopeKey(
      scopeType,
      dto.departmentId,
      dto.location,
    );

    const existing = await this.prisma.holiday.findUnique({
      where: {
        unique_holiday_date_scope: {
          date: holidayDate,
          scopeKey,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `A holiday named "${existing.name}" is already scheduled on ${dto.date}.`,
      );
    }

    const holiday = await this.prisma.holiday.create({
      data: {
        name: dto.name.trim(),
        date: holidayDate,
        year,
        description: dto.description?.trim() || null,
        isOptional: dto.isOptional ?? false,
        status: RecordStatus.ACTIVE,
        scopeType,
        scopeValue,
        scopeKey,
        departmentId: dto.departmentId ?? null,
        location: dto.location?.trim() || null,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'Holiday',
      entityId: holiday.id,
      newValues: holiday,
    });

    return holiday;
  }

  /**
   * Retrieves holidays filtered by year and scope, including 1-click Google Calendar add links.
   */
  async getHolidays(query: QueryHolidaysDto) {
    const where: Prisma.HolidayWhereInput = {
      status: RecordStatus.ACTIVE,
    };

    if (query.year) {
      where.year = query.year;
    }
    if (query.scopeType) {
      where.scopeType = query.scopeType;
    }
    if (query.departmentId) {
      where.departmentId = query.departmentId;
    }
    if (query.location) {
      where.location = query.location;
    }

    const holidays = await this.prisma.holiday.findMany({
      where,
      orderBy: { date: 'asc' },
      include: { department: true },
    });

    return holidays.map((h) => {
      const ymd = formatDateOnly(h.date);
      const cleanDate = ymd.replace(/-/g, '');
      const nextDay = new Date(h.date);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextYmd = formatDateOnly(nextDay).replace(/-/g, '');

      // Official Google Calendar 1-click event link
      const googleCalendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
        h.name,
      )}&dates=${cleanDate}/${nextYmd}&details=${encodeURIComponent(
        h.description || 'Public Company Holiday',
      )}&location=${encodeURIComponent(h.location || 'Company Wide')}`;

      return {
        ...h,
        dateFormatted: ymd,
        googleCalendarUrl,
      };
    });
  }

  /**
   * Updates an existing holiday (e.g. adjust date, description, or pass/toggle active status).
   */
  async updateHoliday(id: string, dto: UpdateHolidayDto, actorUserId: string) {
    const existing = await this.prisma.holiday.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(
        'The specified holiday could not be found or has already been removed.',
      );
    }

    const updateData: Prisma.HolidayUpdateInput = {};

    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.description !== undefined) updateData.description = dto.description?.trim() || null;
    if (dto.isOptional !== undefined) updateData.isOptional = dto.isOptional;
    if (dto.status !== undefined) updateData.status = dto.status;

    let targetDate = existing.date;
    if (dto.date !== undefined) {
      targetDate = parseDateOnly(dto.date);
      updateData.date = targetDate;
      updateData.year = dto.year ?? targetDate.getUTCFullYear();
    } else if (dto.year !== undefined) {
      updateData.year = dto.year;
    }

    if (
      dto.scopeType !== undefined ||
      dto.departmentId !== undefined ||
      dto.location !== undefined ||
      dto.date !== undefined
    ) {
      const scopeType = dto.scopeType ?? existing.scopeType;
      const deptId = dto.departmentId !== undefined ? dto.departmentId : existing.departmentId;
      const loc = dto.location !== undefined ? dto.location : existing.location;
      const { scopeKey, scopeValue } = computeScopeKey(scopeType, deptId || undefined, loc || undefined);

      // Check collision if date/scope changed
      if (scopeKey !== existing.scopeKey || targetDate.getTime() !== existing.date.getTime()) {
        const collision = await this.prisma.holiday.findUnique({
          where: {
            unique_holiday_date_scope: {
              date: targetDate,
              scopeKey,
            },
          },
        });
        if (collision && collision.id !== id) {
          throw new ConflictException(
            `Another holiday named "${collision.name}" already exists on ${formatDateOnly(targetDate)} for this scope.`,
          );
        }
      }

      updateData.scopeType = scopeType;
      updateData.scopeKey = scopeKey;
      updateData.scopeValue = scopeValue;
      updateData.department = deptId ? { connect: { id: deptId } } : { disconnect: true };
      updateData.location = loc ? loc.trim() : null;
    }

    const updated = await this.prisma.holiday.update({
      where: { id },
      data: updateData,
      include: { department: true },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leave',
      entityType: 'Holiday',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  /**
   * Generates an RFC 5545 iCalendar (.ics) feed of holidays for Google Calendar subscription or import.
   */
  async getHolidaysIcsFeed(year?: number): Promise<string> {
    const holidays = await this.prisma.holiday.findMany({
      where: {
        status: RecordStatus.ACTIVE,
        ...(year ? { year } : {}),
      },
      orderBy: { date: 'asc' },
    });

    const nowStr = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Slash Infotech CRM//Leave Management//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Slash Infotech Public Holidays',
      'X-WR-TIMEZONE:Asia/Kolkata',
    ];

    for (const h of holidays) {
      const dateStr = formatDateOnly(h.date).replace(/-/g, '');
      const nextDay = new Date(h.date);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDateStr = formatDateOnly(nextDay).replace(/-/g, '');

      icsLines.push(
        'BEGIN:VEVENT',
        `UID:holiday-${h.id}@slashinfotech.com`,
        `DTSTAMP:${nowStr}`,
        `DTSTART;VALUE=DATE:${dateStr}`,
        `DTEND;VALUE=DATE:${nextDateStr}`,
        `SUMMARY:${h.name}`,
        `DESCRIPTION:${h.description || 'Public Company Holiday'}`,
        'STATUS:CONFIRMED',
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }

    icsLines.push('END:VCALENDAR');
    return icsLines.join('\r\n');
  }

  /**
   * Automatically populates standard government gazetted holidays for the specified year.
   */
  async syncGoogleCalendarHolidays(dto: SyncGoogleHolidaysDto, actorUserId: string) {
    const targetYear = dto.year;
    const presets = this.getGazettedHolidaysPreset(targetYear);

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const item of presets) {
      const holidayDate = parseDateOnly(item.date);
      const { scopeKey, scopeValue } = computeScopeKey(WorkCalendarScope.GLOBAL);

      const existing = await this.prisma.holiday.findUnique({
        where: {
          unique_holiday_date_scope: {
            date: holidayDate,
            scopeKey,
          },
        },
      });

      if (!existing) {
        await this.prisma.holiday.create({
          data: {
            name: item.name,
            date: holidayDate,
            year: targetYear,
            description: item.description,
            isOptional: item.isOptional ?? false,
            status: RecordStatus.ACTIVE,
            scopeType: WorkCalendarScope.GLOBAL,
            scopeValue,
            scopeKey,
          },
        });
        createdCount++;
      } else if (dto.overwriteExisting) {
        await this.prisma.holiday.update({
          where: { id: existing.id },
          data: {
            name: item.name,
            description: item.description,
            isOptional: item.isOptional ?? false,
            status: RecordStatus.ACTIVE,
          },
        });
        updatedCount++;
      } else {
        skippedCount++;
      }
    }

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'HolidaySync',
      entityId: `sync-${targetYear}`,
      newValues: { targetYear, createdCount, updatedCount, skippedCount },
    });

    return {
      year: targetYear,
      totalPresets: presets.length,
      createdCount,
      updatedCount,
      skippedCount,
      message: `Successfully synchronized ${createdCount} new government holidays for ${targetYear} (${skippedCount} already existed).`,
    };
  }

  private getGazettedHolidaysPreset(year: number) {
    return [
      { name: "New Year's Day", date: `${year}-01-01`, description: 'New Year celebration', isOptional: false },
      { name: 'Pongal / Makar Sankranti', date: `${year}-01-14`, description: 'Harvest Festival', isOptional: false },
      { name: 'Thiruvalluvar Day', date: `${year}-01-15`, description: 'Tamil Heritage Day', isOptional: false },
      { name: 'Uzhavar Thirunal', date: `${year}-01-16`, description: "Farmers' Festival", isOptional: false },
      { name: 'Republic Day', date: `${year}-01-26`, description: 'Indian Republic Day', isOptional: false },
      { name: 'Maha Shivaratri', date: `${year}-02-15`, description: 'Religious Festival', isOptional: true },
      { name: 'Holi', date: `${year}-03-04`, description: 'Festival of Colors', isOptional: false },
      { name: 'Telugu New Year (Ugadi)', date: `${year}-03-19`, description: 'Regional New Year', isOptional: true },
      { name: 'Eid ul-Fitr (Ramzan)', date: `${year}-03-20`, description: 'Islamic Festival', isOptional: false },
      { name: 'Good Friday', date: `${year}-04-03`, description: 'Christian Holiday', isOptional: false },
      { name: 'Tamil New Year / Dr. B.R. Ambedkar Jayanti', date: `${year}-04-14`, description: 'National and State Holiday', isOptional: false },
      { name: 'May Day (International Workers Day)', date: `${year}-05-01`, description: 'Labor Day', isOptional: false },
      { name: 'Bakrid / Eid al-Adha', date: `${year}-05-27`, description: 'Feast of the Sacrifice', isOptional: false },
      { name: 'Muharram', date: `${year}-06-25`, description: 'Islamic New Year Observance', isOptional: false },
      { name: 'Independence Day', date: `${year}-08-15`, description: 'Indian Independence Day', isOptional: false },
      { name: 'Milad-un-Nabi', date: `${year}-08-25`, description: "Prophet's Birthday", isOptional: true },
      { name: 'Vinayakar Chathurthi / Ganesh Chaturthi', date: `${year}-09-14`, description: 'Ganesh Chaturthi', isOptional: false },
      { name: 'Mahatma Gandhi Jayanti', date: `${year}-10-02`, description: 'Birth of Mahatma Gandhi', isOptional: false },
      { name: 'Ayutha Pooja', date: `${year}-10-19`, description: 'Worship of Tools and Crafts', isOptional: false },
      { name: 'Vijaya Dasami (Dussehra)', date: `${year}-10-20`, description: 'Victory of Good over Evil', isOptional: false },
      { name: 'Deepavali / Diwali', date: `${year}-11-08`, description: 'Festival of Lights', isOptional: false },
      { name: 'Christmas Day', date: `${year}-12-25`, description: 'Christmas Celebration', isOptional: false },
    ];
  }

  /**
   * Soft-deletes / removes a holiday.
   */
  async deleteHoliday(id: string, actorUserId: string) {
    const holiday = await this.prisma.holiday.findUnique({ where: { id } });
    if (!holiday) {
      throw new NotFoundException(
        'The specified holiday could not be found or has already been removed.',
      );
    }

    await this.prisma.holiday.delete({ where: { id } });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'leave',
      entityType: 'Holiday',
      entityId: id,
      oldValues: holiday,
    });

    return { message: `Holiday "${holiday.name}" has been successfully removed.` };
  }

  /**
   * Creates a weekly-off policy with deterministic scopeKey.
   */
  async createWeeklyOffPolicy(dto: CreateWeeklyOffPolicyDto, actorUserId: string) {
    const effectiveFrom = parseDateOnly(dto.effectiveFrom);
    const effectiveTo = dto.effectiveTo ? parseDateOnly(dto.effectiveTo) : null;
    const scopeType = dto.scopeType ?? WorkCalendarScope.GLOBAL;
    const { scopeKey, scopeValue } = computeScopeKey(
      scopeType,
      dto.departmentId,
      dto.location,
      dto.userId,
    );

    const existing = await this.prisma.weeklyOffPolicy.findUnique({
      where: {
        unique_weekly_off_scope_effective: {
          scopeKey,
          effectiveFrom,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Weekly-off policy already exists for scope '${scopeKey}' effective from ${dto.effectiveFrom}.`,
      );
    }

    const policy = await this.prisma.weeklyOffPolicy.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        daysOfWeek: dto.daysOfWeek,
        pattern: dto.pattern ?? 'ALL',
        effectiveFrom,
        effectiveTo,
        scopeType,
        scopeValue,
        scopeKey,
        departmentId: dto.departmentId ?? null,
        location: dto.location?.trim() || null,
        userId: dto.userId ?? null,
        status: RecordStatus.ACTIVE,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'WeeklyOffPolicy',
      entityId: policy.id,
      newValues: policy,
    });

    return policy;
  }

  /**
   * Retrieves active weekly-off policies.
   */
  async getWeeklyOffPolicies(query: QueryWeeklyOffPoliciesDto) {
    const where: Prisma.WeeklyOffPolicyWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.scopeType) {
      where.scopeType = query.scopeType;
    }

    return this.prisma.weeklyOffPolicy.findMany({
      where,
      orderBy: { effectiveFrom: 'desc' },
      include: { department: true, user: { select: { id: true, name: true, userCode: true } } },
    });
  }

  /**
   * Resolves applicable weekly-off days for a user on a specific date.
   * Priority: USER_OVERRIDE > DEPARTMENT > LOCATION > GLOBAL (fallback: [0] Sunday)
   */
  async getEffectiveWeeklyOffDays(userId: string, date: Date): Promise<number[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        departments: true,
        employeeProfile: true,
      },
    });

    const userDeptId = user?.departments[0]?.departmentId;

    const policies = await this.prisma.weeklyOffPolicy.findMany({
      where: {
        status: RecordStatus.ACTIVE,
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    // 1. User Override
    const userPolicy = policies.find((p) => p.scopeType === WorkCalendarScope.USER_OVERRIDE && p.userId === userId);
    if (userPolicy && Array.isArray(userPolicy.daysOfWeek)) {
      return userPolicy.daysOfWeek as number[];
    }

    // 2. Department Scope
    if (userDeptId) {
      const deptPolicy = policies.find(
        (p) => p.scopeType === WorkCalendarScope.DEPARTMENT && p.departmentId === userDeptId,
      );
      if (deptPolicy && Array.isArray(deptPolicy.daysOfWeek)) {
        return deptPolicy.daysOfWeek as number[];
      }
    }

    // 3. Location Scope
    const userLocStr: string | null = (user?.employeeProfile?.notes as string) || null;
    if (userLocStr) {
      const locPolicy = policies.find(
        (p) => p.scopeType === WorkCalendarScope.LOCATION && p.location?.toUpperCase() === userLocStr.toUpperCase(),
      );
      if (locPolicy && Array.isArray(locPolicy.daysOfWeek)) {
        return locPolicy.daysOfWeek as number[];
      }
    }

    // 4. Global Scope
    const globalPolicy = policies.find((p) => p.scopeType === WorkCalendarScope.GLOBAL);
    if (globalPolicy && Array.isArray(globalPolicy.daysOfWeek)) {
      return globalPolicy.daysOfWeek as number[];
    }

    // Default: Sunday (0)
    return [0];
  }

  /**
   * Checks whether a specific date is a recognized holiday for the given user.
   */
  async isDateHoliday(userId: string, date: Date): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { departments: true },
    });
    const userDeptId = user?.departments[0]?.departmentId;

    const holidays = await this.prisma.holiday.findMany({
      where: {
        date,
        status: RecordStatus.ACTIVE,
      },
    });

    if (holidays.length === 0) return false;

    // Matches if global or matching user department
    return holidays.some(
      (h) =>
        h.scopeType === WorkCalendarScope.GLOBAL ||
        (h.scopeType === WorkCalendarScope.DEPARTMENT && h.departmentId === userDeptId),
    );
  }

  /**
   * Helper to calculate working leave days excluding weekly offs and holidays.
   */
  async calculateWorkingDays(
    userId: string,
    policy: { excludeWeeklyOffs: boolean; excludeHolidays: boolean; allowHalfDay: boolean },
    startDate: Date,
    endDate: Date,
    isHalfDay: boolean,
  ): Promise<{ totalDays: number; dates: string[] }> {
    if (isHalfDay) {
      if (!policy.allowHalfDay) {
        throw new BadRequestException('Half-day leave is not permitted under this policy.');
      }
      if (startDate.getTime() !== endDate.getTime()) {
        throw new BadRequestException('startDate and endDate must be identical for half-day leave.');
      }
      return { totalDays: 0.5, dates: [formatDateOnly(startDate)] };
    }

    const allDates = getDatesInRange(startDate, endDate);
    const applicableDates: string[] = [];
    const weeklyOffs = await this.getEffectiveWeeklyOffDays(userId, startDate);

    for (const dStr of allDates) {
      const d = parseDateOnly(dStr);
      const dayOfWeek = d.getUTCDay();

      if (policy.excludeWeeklyOffs && weeklyOffs.includes(dayOfWeek)) {
        continue;
      }

      if (policy.excludeHolidays && (await this.isDateHoliday(userId, d))) {
        continue;
      }

      applicableDates.push(dStr);
    }

    return { totalDays: applicableDates.length, dates: applicableDates };
  }

  // =========================================================================
  // 3. LEAVE APPLICATIONS & CONCURRENCY-SAFE BALANCES (Phase 9.2 & 9.3)
  // =========================================================================

  /**
   * Applies for a leave request with pessimistic row-locking and immutable ledger logging.
   */
  async applyLeaveRequest(dto: ApplyLeaveRequestDto, actorUserId: string) {
    const targetUserId = dto.forUserId ?? actorUserId;
    const startDate = parseDateOnly(dto.startDate);
    const endDate = parseDateOnly(dto.endDate);

    if (startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('startDate cannot be after endDate.');
    }

    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    const year = startDate.getUTCFullYear();

    // Verify leave type
    const leaveType = await this.prisma.leaveType.findUnique({
      where: { id: dto.leaveTypeId },
      include: {
        policies: {
          where: {
            status: RecordStatus.ACTIVE,
            effectiveFrom: { lte: startDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }],
          },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });

    if (!leaveType || leaveType.status !== RecordStatus.ACTIVE) {
      throw new BadRequestException('Invalid or inactive leave type selected.');
    }

    const activePolicy = leaveType.policies[0];
    if (!activePolicy) {
      throw new BadRequestException('No active policy version found for this leave type.');
    }

    // Minimum notice period check
    if (activePolicy.minNoticeDays > 0) {
      const diffMs = startDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays < activePolicy.minNoticeDays) {
        throw new BadRequestException(
          `This leave policy requires at least ${activePolicy.minNoticeDays} days advance notice.`,
        );
      }
    }

    // Supporting document check
    if (activePolicy.requiresDocument && !dto.attachmentMediaId) {
      throw new BadRequestException(
        'Supporting document / medical certificate is required for this leave type.',
      );
    }

    // Half day validation
    const isHalfDay = Boolean(dto.isHalfDay);
    if (isHalfDay && !dto.halfDayPeriod) {
      throw new BadRequestException('halfDayPeriod (FIRST_HALF or SECOND_HALF) is required for half-day leave.');
    }

    // Anti-overlap check: Check for existing PENDING or APPROVED requests
    const overlapping = await this.prisma.leaveRequest.findFirst({
      where: {
        userId: targetUserId,
        status: { in: [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
    });

    if (overlapping) {
      throw new ConflictException(
        `Leave request already exists for dates overlapping ${formatDateOnly(startDate)} to ${formatDateOnly(endDate)} (Request #${overlapping.requestNumber}, Status: ${overlapping.status}).`,
      );
    }

    // Calculate requested working days
    const { totalDays } = await this.calculateWorkingDays(
      targetUserId,
      activePolicy,
      startDate,
      endDate,
      isHalfDay,
    );

    if (totalDays <= 0) {
      throw new BadRequestException(
        'Selected leave date range contains 0 working days (all dates are holidays or weekly offs).',
      );
    }

    if (activePolicy.maxConsecutiveDays && totalDays > activePolicy.maxConsecutiveDays) {
      throw new BadRequestException(
        `Application exceeds maximum consecutive days permitted (${activePolicy.maxConsecutiveDays} days).`,
      );
    }

    // Monthly leave allowance cap validation (e.g. max 2 days per calendar month)
    if (activePolicy.maxDaysPerMonth) {
      const startOfMonth = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
      const endOfMonth = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0, 23, 59, 59));

      const existingMonthRequests = await this.prisma.leaveRequest.findMany({
        where: {
          userId: targetUserId,
          leaveTypeId: leaveType.id,
          status: { in: [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED] },
          startDate: { gte: startOfMonth, lte: endOfMonth },
        },
      });

      const monthAlreadyTaken = existingMonthRequests.reduce((sum, r) => sum + Number(r.totalDays), 0);
      const maxMonthly = Number(activePolicy.maxDaysPerMonth);

      if (monthAlreadyTaken + totalDays > maxMonthly) {
        throw new BadRequestException(
          `Monthly leave limit exceeded for ${leaveType.name}. Policy allows a maximum of ${maxMonthly} days per calendar month. You already have ${monthAlreadyTaken} days pending or approved this month.`,
        );
      }
    }

    // Concurrency-Safe Transaction: Lock LeaveBalance row & persist ledger
    const createdRequest = await this.prisma.$transaction(async (tx) => {
      // 1. Lock or initialize LeaveBalance
      let balance = await tx.leaveBalance.findUnique({
        where: {
          unique_user_leave_year: {
            userId: targetUserId,
            leaveTypeId: leaveType.id,
            year,
          },
        },
      });

      if (!balance) {
        // If not exists, provision zero balance
        balance = await tx.leaveBalance.create({
          data: {
            userId: targetUserId,
            leaveTypeId: leaveType.id,
            year,
            allocatedDays: leaveType.isPaid ? activePolicy.annualAllocation : new Prisma.Decimal(0),
            carriedForward: new Prisma.Decimal(0),
            adjustedDays: new Prisma.Decimal(0),
            usedDays: new Prisma.Decimal(0),
            pendingDays: new Prisma.Decimal(0),
          },
        });
      }

      // Re-read with raw pessimistic lock if MySQL/MariaDB
      const lockedBalances = await tx.$queryRaw<any[]>`
        SELECT * FROM leave_balances
        WHERE user_id = ${targetUserId} AND leave_type_id = ${leaveType.id} AND year = ${year}
        FOR UPDATE
      `;
      const currentBalance = lockedBalances[0] ?? balance;

      const allocated = Number(currentBalance.allocated_days ?? currentBalance.allocatedDays);
      const carried = Number(currentBalance.carried_forward ?? currentBalance.carriedForward);
      const adjusted = Number(currentBalance.adjusted_days ?? currentBalance.adjustedDays);
      const used = Number(currentBalance.used_days ?? currentBalance.usedDays);
      const pending = Number(currentBalance.pending_days ?? currentBalance.pendingDays);

      const available = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

      // 2. Validate quota for paid leaves
      if (leaveType.isPaid && available < totalDays) {
        throw new BadRequestException(
          `Insufficient leave balance. Available: ${available} days, Requested: ${totalDays} days.`,
        );
      }

      // 3. Increment pending hold on balance
      const newPending = pending + totalDays;
      const newAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, newPending);

      await tx.leaveBalance.update({
        where: { id: currentBalance.id },
        data: {
          pendingDays: new Prisma.Decimal(newPending),
          version: { increment: 1 },
        },
      });

      // 4. Create LeaveRequest
      const requestNumber = generateLeaveRequestNumber();
      const leaveRequest = await tx.leaveRequest.create({
        data: {
          requestNumber,
          userId: targetUserId,
          leaveTypeId: leaveType.id,
          leavePolicyVersionId: activePolicy.id,
          startDate,
          endDate,
          isHalfDay,
          halfDayPeriod: isHalfDay ? dto.halfDayPeriod : null,
          totalDays: new Prisma.Decimal(totalDays),
          reason: dto.reason.trim(),
          attachmentMediaId: dto.attachmentMediaId ?? null,
          status: LeaveRequestStatus.PENDING,
          policySnapshot: JSON.parse(JSON.stringify(activePolicy)),
        },
      });

      // 5. Append immutable 6-bucket transaction ledger
      await tx.leaveTransaction.create({
        data: {
          userId: targetUserId,
          leaveTypeId: leaveType.id,
          leaveRequestId: leaveRequest.id,
          transactionType: LeaveTransactionType.PENDING_HOLD,
          balanceFieldAffected: BalanceFieldAffected.PENDING_HOLD,
          amount: new Prisma.Decimal(totalDays),
          previousAllocated: new Prisma.Decimal(allocated),
          newAllocated: new Prisma.Decimal(allocated),
          previousCarriedForward: new Prisma.Decimal(carried),
          newCarriedForward: new Prisma.Decimal(carried),
          previousAdjusted: new Prisma.Decimal(adjusted),
          newAdjusted: new Prisma.Decimal(adjusted),
          previousUsed: new Prisma.Decimal(used),
          newUsed: new Prisma.Decimal(used),
          previousPending: new Prisma.Decimal(pending),
          newPending: new Prisma.Decimal(newPending),
          previousAvailable: new Prisma.Decimal(available),
          newAvailable: new Prisma.Decimal(newAvailable),
          reason: `Pending hold placed for request ${requestNumber}`,
          createdById: actorUserId,
        },
      });

      // 6. Multi-level approval setup: Find reporting manager or fallback to HR/Admin
      const employeeProfile = await tx.employeeProfile.findUnique({
        where: { userId: targetUserId },
      });

      let approverUserId = employeeProfile?.reportingToId;
      // Anti-self-approval rule: Manager cannot be their own approver
      if (!approverUserId || approverUserId === targetUserId) {
        // Fallback to HR or Super Admin
        const hrUser = await tx.user.findFirst({
          where: {
            id: { not: targetUserId },
            userType: { code: { in: ['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'] } },
            status: RecordStatus.ACTIVE,
            userRoles: {
              some: {
                role: {
                  code: { in: ['HR', 'SUPER_ADMIN', 'ADMIN'] },
                },
              },
            },
          },
        });
        approverUserId = hrUser?.id ?? actorUserId;
      }

      await tx.leaveApproval.create({
        data: {
          leaveRequestId: leaveRequest.id,
          approverUserId,
          level: 1,
          decision: LeaveApprovalDecision.PENDING,
        },
      });

      return leaveRequest;
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'leave',
      entityType: 'LeaveRequest',
      entityId: createdRequest.id,
      newValues: createdRequest,
    });

    return createdRequest;
  }

  /**
   * Approves or rejects a pending leave request with attendance integration.
   */
  async reviewLeaveRequest(requestId: string, dto: ReviewLeaveRequestDto, actorUserId: string) {
    const isApproved = dto.decision === LeaveApprovalDecision.APPROVED;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Lock leave request
      const lockedReq = await tx.$queryRaw<any[]>`
        SELECT * FROM leave_requests WHERE id = ${requestId} FOR UPDATE
      `;
      if (!lockedReq || lockedReq.length === 0) {
        throw new NotFoundException('The requested leave application could not be found.');
      }

      const req = lockedReq[0];
      if (req.status !== LeaveRequestStatus.PENDING) {
        throw new BadRequestException(
          `Leave request is no longer pending (current status: ${req.status}).`,
        );
      }

      // Anti-self-approval validation
      if (req.user_id === actorUserId) {
        throw new ForbiddenException(
          'Anti-self-approval violation: You cannot approve or reject your own leave request.',
        );
      }

      const targetUserId = req.user_id;
      const leaveTypeId = req.leave_type_id;
      const totalDays = Number(req.total_days);
      const year = new Date(req.start_date).getUTCFullYear();

      // Fetch leave type
      const leaveType = await tx.leaveType.findUnique({ where: { id: leaveTypeId } });
      const isPaid = leaveType?.isPaid ?? true;

      // 2. Lock LeaveBalance
      const lockedBalances = await tx.$queryRaw<any[]>`
        SELECT * FROM leave_balances
        WHERE user_id = ${targetUserId} AND leave_type_id = ${leaveTypeId} AND year = ${year}
        FOR UPDATE
      `;
      const currentBalance = lockedBalances[0];
      if (!currentBalance) {
        throw new NotFoundException('Associated leave balance record not found.');
      }

      const allocated = Number(currentBalance.allocated_days);
      const carried = Number(currentBalance.carried_forward);
      const adjusted = Number(currentBalance.adjusted_days);
      const used = Number(currentBalance.used_days);
      const pending = Number(currentBalance.pending_days);

      let newPending = pending;
      let newUsed = used;
      let transactionType: LeaveTransactionType = LeaveTransactionType.UTILIZATION;
      let fieldAffected: BalanceFieldAffected = BalanceFieldAffected.USED;

      if (isApproved) {
        // Decrement pending hold, increment used days
        newPending = Math.max(0, pending - totalDays);
        newUsed = used + totalDays;
        transactionType = isPaid
          ? LeaveTransactionType.UTILIZATION
          : LeaveTransactionType.UNPAID_UTILIZATION;
      } else {
        // Rejection releases pending hold
        newPending = Math.max(0, pending - totalDays);
        transactionType = LeaveTransactionType.HOLD_RELEASE_REJECTED;
        fieldAffected = BalanceFieldAffected.PENDING_HOLD;
      }

      const newAvailable = calculateAvailableBalance(allocated, carried, adjusted, newUsed, newPending);
      const previousAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

      // 3. Update Balance
      await tx.leaveBalance.update({
        where: { id: currentBalance.id },
        data: {
          pendingDays: new Prisma.Decimal(newPending),
          usedDays: new Prisma.Decimal(newUsed),
          version: { increment: 1 },
        },
      });

      // 4. Append Transaction Ledger
      await tx.leaveTransaction.create({
        data: {
          userId: targetUserId,
          leaveTypeId,
          leaveRequestId: req.id,
          transactionType,
          balanceFieldAffected: fieldAffected,
          amount: new Prisma.Decimal(totalDays),
          previousAllocated: new Prisma.Decimal(allocated),
          newAllocated: new Prisma.Decimal(allocated),
          previousCarriedForward: new Prisma.Decimal(carried),
          newCarriedForward: new Prisma.Decimal(carried),
          previousAdjusted: new Prisma.Decimal(adjusted),
          newAdjusted: new Prisma.Decimal(adjusted),
          previousUsed: new Prisma.Decimal(used),
          newUsed: new Prisma.Decimal(newUsed),
          previousPending: new Prisma.Decimal(pending),
          newPending: new Prisma.Decimal(newPending),
          previousAvailable: new Prisma.Decimal(previousAvailable),
          newAvailable: new Prisma.Decimal(newAvailable),
          reason: isApproved
            ? `Approved leave request ${req.request_number}`
            : `Rejected leave request ${req.request_number}: ${dto.comments || 'No comment'}`,
          createdById: actorUserId,
        },
      });

      // 5. Update LeaveApproval decision
      await tx.leaveApproval.updateMany({
        where: { leaveRequestId: req.id, level: 1 },
        data: {
          decision: dto.decision,
          comments: dto.comments?.trim() || null,
          decidedAt: new Date(),
        },
      });

      // 6. Update LeaveRequest status
      const updatedReq = await tx.leaveRequest.update({
        where: { id: req.id },
        data: {
          status: isApproved ? LeaveRequestStatus.APPROVED : LeaveRequestStatus.REJECTED,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          managerNotes: dto.comments?.trim() || null,
        },
      });

      // 7. ATTENDANCE INTEGRATION (Phase 9.4)
      if (isApproved) {
        const leaveDates = getDatesInRange(new Date(req.start_date), new Date(req.end_date));
        const defaultShift = await tx.shiftDefinition.findFirst();

        for (const dateStr of leaveDates) {
          const attDate = parseDateOnly(dateStr);

          // Find active shift assignment or default
          const assignment = await tx.employeeShiftAssignment.findFirst({
            where: {
              userId: targetUserId,
              startDate: { lte: attDate },
              OR: [{ endDate: null }, { endDate: { gte: attDate } }],
            },
            include: { shiftDefinition: true },
            orderBy: { startDate: 'desc' },
          });

          const activeShiftDef = assignment?.shiftDefinition ?? defaultShift;

          const existingRecord = await tx.attendanceRecord.findUnique({
            where: {
              unique_user_daily_attendance: {
                userId: targetUserId,
                attendanceDate: attDate,
              },
            },
          });

          if (existingRecord) {
            // Update status to ON_LEAVE without deleting any prior punches or breaks
            await tx.attendanceRecord.update({
              where: { id: existingRecord.id },
              data: {
                status: AttendanceStatus.ON_LEAVE,
                version: { increment: 1 },
              },
            });
          } else if (activeShiftDef) {
            // Create attendance record placeholder marking ON_LEAVE
            const shiftStart = new Date(`${dateStr}T${activeShiftDef.startTime}:00.000Z`);
            const shiftEnd = new Date(`${dateStr}T${activeShiftDef.endTime}:00.000Z`);

            await tx.attendanceRecord.create({
              data: {
                userId: targetUserId,
                shiftDefinitionId: activeShiftDef.id,
                attendanceDate: attDate,
                status: AttendanceStatus.ON_LEAVE,
                shiftStartTimeSnapshot: shiftStart,
                shiftEndTimeSnapshot: shiftEnd,
                isOvernightSnapshot: activeShiftDef.isOvernight,
                halfDayThresholdSecondsSnapshot: activeShiftDef.halfDayThresholdMinutes * 60,
                fullDayThresholdSecondsSnapshot: activeShiftDef.fullDayThresholdMinutes * 60,
                overtimeThresholdSecondsSnapshot: activeShiftDef.overtimeThresholdMinutes * 60,
                allowMultipleSessionsSnapshot: activeShiftDef.allowMultipleSessions,
                breakPolicySnapshot: activeShiftDef.breakPolicySnapshot || '{}',
              },
            });
          }
        }
      }

      return updatedReq;
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.STATUS_CHANGE,
      module: 'leave',
      entityType: 'LeaveRequest',
      entityId: requestId,
      newValues: result,
    });

    return result;
  }

  /**
   * Cancels a pending request immediately (releasing holds) or initiates cancellation for an approved leave.
   */
  async cancelLeaveRequest(requestId: string, dto: CreateCancellationRequestDto, actorUserId: string) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id: requestId },
      include: { leaveType: true },
    });

    if (!request) {
      throw new NotFoundException('The requested leave application could not be found.');
    }

    if (request.status === LeaveRequestStatus.CANCELLED) {
      throw new BadRequestException('Leave request is already cancelled.');
    }

    // PENDING LEAVE: Instant Self-Cancel by requester or admin
    if (request.status === LeaveRequestStatus.PENDING) {
      const result = await this.prisma.$transaction(async (tx) => {
        const year = request.startDate.getUTCFullYear();
        const totalDays = Number(request.totalDays);

        // Lock balance
        const lockedBalances = await tx.$queryRaw<any[]>`
          SELECT * FROM leave_balances
          WHERE user_id = ${request.userId} AND leave_type_id = ${request.leaveTypeId} AND year = ${year}
          FOR UPDATE
        `;
        const currentBalance = lockedBalances[0];

        if (currentBalance) {
          const allocated = Number(currentBalance.allocated_days);
          const carried = Number(currentBalance.carried_forward);
          const adjusted = Number(currentBalance.adjusted_days);
          const used = Number(currentBalance.used_days);
          const pending = Number(currentBalance.pending_days);

          const newPending = Math.max(0, pending - totalDays);
          const newAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, newPending);
          const prevAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

          await tx.leaveBalance.update({
            where: { id: currentBalance.id },
            data: {
              pendingDays: new Prisma.Decimal(newPending),
              version: { increment: 1 },
            },
          });

          await tx.leaveTransaction.create({
            data: {
              userId: request.userId,
              leaveTypeId: request.leaveTypeId,
              leaveRequestId: request.id,
              transactionType: LeaveTransactionType.HOLD_RELEASE_CANCELLED,
              balanceFieldAffected: BalanceFieldAffected.PENDING_HOLD,
              amount: new Prisma.Decimal(totalDays),
              previousAllocated: new Prisma.Decimal(allocated),
              newAllocated: new Prisma.Decimal(allocated),
              previousCarriedForward: new Prisma.Decimal(carried),
              newCarriedForward: new Prisma.Decimal(carried),
              previousAdjusted: new Prisma.Decimal(adjusted),
              newAdjusted: new Prisma.Decimal(adjusted),
              previousUsed: new Prisma.Decimal(used),
              newUsed: new Prisma.Decimal(used),
              previousPending: new Prisma.Decimal(pending),
              newPending: new Prisma.Decimal(newPending),
              previousAvailable: new Prisma.Decimal(prevAvailable),
              newAvailable: new Prisma.Decimal(newAvailable),
              reason: `Self-cancelled pending request ${request.requestNumber}`,
              createdById: actorUserId,
            },
          });
        }

        return tx.leaveRequest.update({
          where: { id: request.id },
          data: {
            status: LeaveRequestStatus.CANCELLED,
            cancelledByUserId: actorUserId,
            cancelledAt: new Date(),
          },
        });
      });

      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.UPDATE,
        module: 'leave',
        entityType: 'LeaveRequest',
        entityId: requestId,
        newValues: { status: LeaveRequestStatus.CANCELLED },
      });

      return { message: 'Pending leave request cancelled successfully.', request: result };
    }

    // APPROVED LEAVE: Submit Cancellation Request for manager review
    if (request.status === LeaveRequestStatus.APPROVED) {
      const existingReq = await this.prisma.leaveCancellationRequest.findFirst({
        where: {
          leaveRequestId: requestId,
          status: LeaveCancellationStatus.PENDING,
        },
      });

      if (existingReq) {
        throw new ConflictException('A cancellation request is already pending review for this leave.');
      }

      const cancellation = await this.prisma.leaveCancellationRequest.create({
        data: {
          leaveRequestId: requestId,
          requestedByUserId: actorUserId,
          reason: dto.reason.trim(),
          status: LeaveCancellationStatus.PENDING,
        },
      });

      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.CREATE,
        module: 'leave',
        entityType: 'LeaveCancellationRequest',
        entityId: cancellation.id,
        newValues: cancellation,
      });

      return {
        message: 'Leave cancellation request submitted for administrative review.',
        cancellation,
      };
    }

    throw new BadRequestException(`Cannot cancel leave request with status: ${request.status}`);
  }

  /**
   * Approves or rejects cancellation of an approved leave with balance restoration & attendance reversion.
   */
  async reviewCancellationRequest(
    cancellationId: string,
    dto: ReviewCancellationRequestDto,
    actorUserId: string,
  ) {
    const isApproved = dto.decision === LeaveCancellationStatus.APPROVED;

    const result = await this.prisma.$transaction(async (tx) => {
      const cancellation = await tx.leaveCancellationRequest.findUnique({
        where: { id: cancellationId },
        include: { leaveRequest: true },
      });

      if (!cancellation) {
        throw new NotFoundException('The requested cancellation request could not be found.');
      }

      if (cancellation.status !== LeaveCancellationStatus.PENDING) {
        throw new BadRequestException('Cancellation request has already been reviewed.');
      }

      // Anti-self-approval rule
      if (cancellation.leaveRequest.userId === actorUserId) {
        throw new ForbiddenException(
          'Anti-self-approval violation: You cannot review your own leave cancellation request.',
        );
      }

      const req = cancellation.leaveRequest;
      const totalDays = Number(req.totalDays);
      const year = req.startDate.getUTCFullYear();

      if (isApproved) {
        // 1. Lock LeaveBalance and restore quota
        const lockedBalances = await tx.$queryRaw<any[]>`
          SELECT * FROM leave_balances
          WHERE user_id = ${req.userId} AND leave_type_id = ${req.leaveTypeId} AND year = ${year}
          FOR UPDATE
        `;
        const currentBalance = lockedBalances[0];

        if (currentBalance) {
          const allocated = Number(currentBalance.allocated_days);
          const carried = Number(currentBalance.carried_forward);
          const adjusted = Number(currentBalance.adjusted_days);
          const used = Number(currentBalance.used_days);
          const pending = Number(currentBalance.pending_days);

          const newUsed = Math.max(0, used - totalDays);
          const newAvailable = calculateAvailableBalance(allocated, carried, adjusted, newUsed, pending);
          const prevAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

          await tx.leaveBalance.update({
            where: { id: currentBalance.id },
            data: {
              usedDays: new Prisma.Decimal(newUsed),
              version: { increment: 1 },
            },
          });

          // 2. Append Transaction Ledger (CANCELLATION_REVERSAL)
          await tx.leaveTransaction.create({
            data: {
              userId: req.userId,
              leaveTypeId: req.leaveTypeId,
              leaveRequestId: req.id,
              transactionType: LeaveTransactionType.REVERSAL_CANCELLATION,
              balanceFieldAffected: BalanceFieldAffected.USED,
              amount: new Prisma.Decimal(-totalDays),
              previousAllocated: new Prisma.Decimal(allocated),
              newAllocated: new Prisma.Decimal(allocated),
              previousCarriedForward: new Prisma.Decimal(carried),
              newCarriedForward: new Prisma.Decimal(carried),
              previousAdjusted: new Prisma.Decimal(adjusted),
              newAdjusted: new Prisma.Decimal(adjusted),
              previousUsed: new Prisma.Decimal(used),
              newUsed: new Prisma.Decimal(newUsed),
              previousPending: new Prisma.Decimal(pending),
              newPending: new Prisma.Decimal(pending),
              previousAvailable: new Prisma.Decimal(prevAvailable),
              newAvailable: new Prisma.Decimal(newAvailable),
              reason: `Cancellation reversal approved: ${dto.reviewerNotes || 'Approved by reviewer'}`,
              createdById: actorUserId,
            },
          });
        }

        // 3. Mark LeaveRequest as CANCELLED
        await tx.leaveRequest.update({
          where: { id: req.id },
          data: {
            status: LeaveRequestStatus.CANCELLED,
            cancelledByUserId: actorUserId,
            cancelledAt: new Date(),
          },
        });

        // 4. ATTENDANCE RESTORATION (Revert ON_LEAVE)
        const leaveDates = getDatesInRange(new Date(req.startDate), new Date(req.endDate));
        for (const dateStr of leaveDates) {
          const attDate = parseDateOnly(dateStr);
          const rec = await tx.attendanceRecord.findUnique({
            where: {
              unique_user_daily_attendance: {
                userId: req.userId,
                attendanceDate: attDate,
              },
            },
            include: { sessions: true },
          });

          if (rec && rec.status === AttendanceStatus.ON_LEAVE) {
            // If sessions exist, return to PENDING_RECONCILIATION for recalculation; else PENDING_RECONCILIATION
            await tx.attendanceRecord.update({
              where: { id: rec.id },
              data: {
                status: AttendanceStatus.PENDING_RECONCILIATION,
                version: { increment: 1 },
              },
            });
          }
        }
      }

      // Update cancellation request record
      return tx.leaveCancellationRequest.update({
        where: { id: cancellationId },
        data: {
          status: dto.decision,
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          reviewerNotes: dto.reviewerNotes?.trim() || null,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.STATUS_CHANGE,
      module: 'leave',
      entityType: 'LeaveCancellationRequest',
      entityId: cancellationId,
      newValues: result,
    });

    return result;
  }

  // =========================================================================
  // 4. BALANCE ADJUSTMENTS & REPORTING (Phase 9.3 & 9.4)
  // =========================================================================

  /**
   * Manual balance adjustment by HR / Super Admin with full 6-bucket audit ledger.
   */
  async adjustLeaveBalance(dto: AdjustLeaveBalanceDto, actorUserId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      let balance = await tx.leaveBalance.findUnique({
        where: {
          unique_user_leave_year: {
            userId: dto.userId,
            leaveTypeId: dto.leaveTypeId,
            year: dto.year,
          },
        },
      });

      if (!balance) {
        balance = await tx.leaveBalance.create({
          data: {
            userId: dto.userId,
            leaveTypeId: dto.leaveTypeId,
            year: dto.year,
            allocatedDays: new Prisma.Decimal(0),
            carriedForward: new Prisma.Decimal(0),
            adjustedDays: new Prisma.Decimal(0),
            usedDays: new Prisma.Decimal(0),
            pendingDays: new Prisma.Decimal(0),
          },
        });
      }

      // Lock row
      const lockedBalances = await tx.$queryRaw<any[]>`
        SELECT * FROM leave_balances
        WHERE user_id = ${dto.userId} AND leave_type_id = ${dto.leaveTypeId} AND year = ${dto.year}
        FOR UPDATE
      `;
      const current = lockedBalances[0] ?? balance;

      const allocated = Number(current.allocated_days ?? current.allocatedDays);
      const carried = Number(current.carried_forward ?? current.carriedForward);
      const adjusted = Number(current.adjusted_days ?? current.adjustedDays);
      const used = Number(current.used_days ?? current.usedDays);
      const pending = Number(current.pending_days ?? current.pendingDays);

      const delta = dto.adjustedDays;
      const newAdjusted = adjusted + delta;
      const newAvailable = calculateAvailableBalance(allocated, carried, newAdjusted, used, pending);
      const prevAvailable = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

      const updated = await tx.leaveBalance.update({
        where: { id: current.id },
        data: {
          adjustedDays: new Prisma.Decimal(newAdjusted),
          version: { increment: 1 },
        },
      });

      await tx.leaveTransaction.create({
        data: {
          userId: dto.userId,
          leaveTypeId: dto.leaveTypeId,
          transactionType:
            delta >= 0
              ? LeaveTransactionType.MANUAL_ADJUSTMENT_CREDIT
              : LeaveTransactionType.MANUAL_ADJUSTMENT_DEBIT,
          balanceFieldAffected: BalanceFieldAffected.ADJUSTED,
          amount: new Prisma.Decimal(delta),
          previousAllocated: new Prisma.Decimal(allocated),
          newAllocated: new Prisma.Decimal(allocated),
          previousCarriedForward: new Prisma.Decimal(carried),
          newCarriedForward: new Prisma.Decimal(carried),
          previousAdjusted: new Prisma.Decimal(adjusted),
          newAdjusted: new Prisma.Decimal(newAdjusted),
          previousUsed: new Prisma.Decimal(used),
          newUsed: new Prisma.Decimal(used),
          previousPending: new Prisma.Decimal(pending),
          newPending: new Prisma.Decimal(pending),
          previousAvailable: new Prisma.Decimal(prevAvailable),
          newAvailable: new Prisma.Decimal(newAvailable),
          reason: dto.reason.trim(),
          createdById: actorUserId,
        },
      });

      return updated;
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leave',
      entityType: 'LeaveBalance',
      entityId: result.id,
      newValues: result,
    });

    return result;
  }

  /**
   * Retrieves balances for an employee in a given fiscal year.
   */
  async getEmployeeBalances(userId: string, year = new Date().getFullYear()) {
    const balances = await this.prisma.leaveBalance.findMany({
      where: { userId, year },
      include: { leaveType: true },
      orderBy: { leaveType: { name: 'asc' } },
    });

    return balances.map((b) => {
      const allocated = Number(b.allocatedDays);
      const carried = Number(b.carriedForward);
      const adjusted = Number(b.adjustedDays);
      const used = Number(b.usedDays);
      const pending = Number(b.pendingDays);
      const available = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

      return {
        ...b,
        availableDays: available,
      };
    });
  }

  /**
   * Retrieves all leave requests matching filter criteria.
   */
  async getLeaveRequests(query: QueryLeaveRequestsDto) {
    const { userId, status, leaveTypeId, startDate, endDate, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.LeaveRequestWhereInput = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (startDate || endDate) {
      where.startDate = {};
      if (startDate) where.startDate.gte = parseDateOnly(startDate);
      if (endDate) where.startDate.lte = parseDateOnly(endDate);
    }

    const [items, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true, userCode: true } },
          reviewer: { select: { id: true, name: true, userCode: true } },
          canceller: { select: { id: true, name: true, userCode: true } },
          leaveType: true,
          approvals: { include: { approver: { select: { id: true, name: true, userCode: true } } } },
          cancellationRequests: true,
        },
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves a single leave request by ID with complete audit & approval details.
   */
  async getLeaveRequestById(id: string) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            userCode: true,
            departments: { include: { department: true } },
          },
        },
        reviewer: { select: { id: true, name: true, userCode: true } },
        canceller: { select: { id: true, name: true, userCode: true } },
        leaveType: true,
        policyVersion: true,
        attachmentMedia: true,
        approvals: {
          orderBy: { level: 'asc' },
          include: { approver: { select: { id: true, name: true, userCode: true } } },
        },
        cancellationRequests: {
          orderBy: { createdAt: 'desc' },
          include: {
            requestedBy: { select: { id: true, name: true, userCode: true } },
            reviewer: { select: { id: true, name: true, userCode: true } },
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { id: true, name: true, userCode: true } } },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('The requested leave application could not be found.');
    }

    return request;
  }

  /**
   * Retrieves leave transaction audit ledger history.
   */
  async getTransactions(query: QueryLeaveTransactionsDto) {
    const { userId, leaveTypeId, leaveRequestId, page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.LeaveTransactionWhereInput = {};
    if (userId) where.userId = userId;
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (leaveRequestId) where.leaveRequestId = leaveRequestId;

    const [items, total] = await Promise.all([
      this.prisma.leaveTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true, userCode: true } },
          createdBy: { select: { id: true, name: true, userCode: true } },
          leaveType: true,
        },
      }),
      this.prisma.leaveTransaction.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Leave Calendar: Returns all approved and pending leaves within the date range.
   */
  async getLeaveCalendar(query: QueryLeaveCalendarDto) {
    const startDate = query.startDate ? parseDateOnly(query.startDate) : new Date();
    const endDate = query.endDate
      ? parseDateOnly(query.endDate)
      : new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    const where: Prisma.LeaveRequestWhereInput = {
      status: { in: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    };

    if (query.departmentId) {
      where.user = {
        departments: {
          some: { departmentId: query.departmentId },
        },
      };
    }

    return this.prisma.leaveRequest.findMany({
      where,
      orderBy: { startDate: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            userCode: true,
            departments: { include: { department: true } },
          },
        },
        leaveType: true,
      },
    });
  }

  /**
   * Leave Reports: Summarizes leave balance and usage metrics.
   */
  async getLeaveReportSummary(query: QueryLeaveReportDto) {
    const year = query.year ?? new Date().getFullYear();
    const where: Prisma.LeaveBalanceWhereInput = { year };

    if (query.departmentId) {
      where.user = {
        departments: {
          some: { departmentId: query.departmentId },
        },
      };
    }

    const balances = await this.prisma.leaveBalance.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            userCode: true,
            departments: { include: { department: true } },
          },
        },
        leaveType: true,
      },
      orderBy: [{ user: { name: 'asc' } }, { leaveType: { name: 'asc' } }],
    });

    return balances.map((b) => {
      const allocated = Number(b.allocatedDays);
      const carried = Number(b.carriedForward);
      const adjusted = Number(b.adjustedDays);
      const used = Number(b.usedDays);
      const pending = Number(b.pendingDays);
      const available = calculateAvailableBalance(allocated, carried, adjusted, used, pending);

      return {
        userId: b.userId,
        userName: b.user.name,
        userCode: b.user.userCode,
        departments: b.user.departments.map((d) => d.department.name),
        leaveTypeId: b.leaveTypeId,
        leaveTypeName: b.leaveType.name,
        leaveTypeCode: b.leaveType.code,
        year: b.year,
        allocatedDays: allocated,
        carriedForward: carried,
        adjustedDays: adjusted,
        usedDays: used,
        pendingDays: pending,
        availableDays: available,
      };
    });
  }
}

