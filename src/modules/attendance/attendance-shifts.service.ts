import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuditAction } from '../../generated/prisma/enums';
import { AttendanceAccessService } from './attendance-access.service';
import { CreateShiftDefinitionDto } from './dto/create-shift-definition.dto';
import { UpdateShiftDefinitionDto } from './dto/update-shift-definition.dto';
import {
  AssignShiftDto,
  UpdateShiftAssignmentDto,
} from './dto/assign-shift.dto';
import { QueryShiftsDto } from './dto/query-shifts.dto';
import {
  formatDateOnly,
  intervalsOverlap,
  parseBreakPolicySnapshot,
  parseDateOnly,
  validateAndNormalizeBreakPolicy,
} from './attendance.utils';

function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return NaN;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  return hours * 60 + minutes;
}

@Injectable()
export class AttendanceShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly accessService: AttendanceAccessService,
  ) { }

  /**
   * Creates a new ShiftDefinition with validated timing, thresholds, and break policy snapshot.
   */
  async createShiftDefinition(
    dto: CreateShiftDefinitionDto,
    actorUserId?: string,
  ) {
    const startMins = parseTimeToMinutes(dto.startTime);
    const endMins = parseTimeToMinutes(dto.endTime);
    const isOvernight = Boolean(dto.isOvernight);

    if (isNaN(startMins) || isNaN(endMins)) {
      throw new BadRequestException('Invalid startTime or endTime format. Expected HH:mm.');
    }

    if (!isOvernight && startMins >= endMins) {
      throw new BadRequestException(
        'For regular shifts, startTime must be earlier than endTime. For overnight shifts crossing midnight, specify isOvernight: true.',
      );
    }

    const halfDay = dto.halfDayThresholdMinutes ?? 240;
    const fullDay = dto.fullDayThresholdMinutes ?? 480;
    const overtime = dto.overtimeThresholdMinutes ?? 540;

    if (halfDay >= fullDay) {
      throw new BadRequestException(
        'halfDayThresholdMinutes must be strictly less than fullDayThresholdMinutes.',
      );
    }

    if (fullDay > overtime) {
      throw new BadRequestException(
        'fullDayThresholdMinutes must be less than or equal to overtimeThresholdMinutes.',
      );
    }

    const { normalizedPolicy, snapshotString } = validateAndNormalizeBreakPolicy(
      dto.breakPolicy || dto.breakPolicySnapshot,
    );

    const existingCode = await this.prisma.shiftDefinition.findUnique({
      where: { code: dto.code },
    });
    if (existingCode) {
      throw new ConflictException(
        `A shift definition with code "${dto.code}" already exists.`,
      );
    }

    const shift = await this.prisma.shiftDefinition.create({
      data: {
        code: dto.code.trim().toUpperCase(),
        name: dto.name.trim(),
        startTime: dto.startTime.trim(),
        endTime: dto.endTime.trim(),
        isOvernight,
        gracePeriodMinutes: dto.gracePeriodMinutes ?? 15,
        halfDayThresholdMinutes: halfDay,
        fullDayThresholdMinutes: fullDay,
        overtimeThresholdMinutes: overtime,
        allowMultipleSessions: Boolean(dto.allowMultipleSessions),
        autoCloseGraceMinutes: dto.autoCloseGraceMinutes ?? 30,
        breakPolicySnapshot: snapshotString,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'ATTENDANCE',
      entityType: 'ShiftDefinition',
      entityId: shift.id,
      newValues: {
        code: shift.code,
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isOvernight: shift.isOvernight,
      },
    });

    return {
      ...shift,
      breakPolicy: normalizedPolicy,
    };
  }

  /**
   * Retrieves all shift definitions with optional pagination and search filter.
   */
  async findAllShiftDefinitions(query: QueryShiftsDto = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { code: { contains: query.search } },
        { name: { contains: query.search } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.shiftDefinition.count({ where }),
      this.prisma.shiftDefinition.findMany({
        where,
        skip,
        take: limit,
        orderBy: { code: 'asc' },
      }),
    ]);

    const mapped = items.map((shift) => ({
      ...shift,
      breakPolicy: parseBreakPolicySnapshot(shift.breakPolicySnapshot),
    }));

    return {
      items: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves a single shift definition by ID.
   */
  async findShiftDefinitionById(id: string) {
    const shift = await this.prisma.shiftDefinition.findUnique({
      where: { id },
    });

    if (!shift) {
      throw new NotFoundException(`Shift definition with ID "${id}" not found.`);
    }

    return {
      ...shift,
      breakPolicy: parseBreakPolicySnapshot(shift.breakPolicySnapshot),
    };
  }

  /**
   * Updates an existing shift definition.
   */
  async updateShiftDefinition(
    id: string,
    dto: UpdateShiftDefinitionDto,
    actorUserId?: string,
  ) {
    const current = await this.prisma.shiftDefinition.findUnique({
      where: { id },
    });

    if (!current) {
      throw new NotFoundException(`Shift definition with ID "${id}" not found.`);
    }

    if (dto.code && dto.code !== current.code) {
      const codeExists = await this.prisma.shiftDefinition.findUnique({
        where: { code: dto.code.trim().toUpperCase() },
      });
      if (codeExists) {
        throw new ConflictException(
          `Shift definition with code "${dto.code}" already exists.`,
        );
      }
    }

    const startTime = dto.startTime ?? current.startTime;
    const endTime = dto.endTime ?? current.endTime;
    const isOvernight =
      dto.isOvernight !== undefined ? Boolean(dto.isOvernight) : current.isOvernight;

    const startMins = parseTimeToMinutes(startTime);
    const endMins = parseTimeToMinutes(endTime);

    if (!isOvernight && startMins >= endMins) {
      throw new BadRequestException(
        'For regular shifts, startTime must be earlier than endTime. For overnight shifts crossing midnight, specify isOvernight: true.',
      );
    }

    const halfDay = dto.halfDayThresholdMinutes ?? current.halfDayThresholdMinutes;
    const fullDay = dto.fullDayThresholdMinutes ?? current.fullDayThresholdMinutes;
    const overtime = dto.overtimeThresholdMinutes ?? current.overtimeThresholdMinutes;

    if (halfDay >= fullDay) {
      throw new BadRequestException(
        'halfDayThresholdMinutes must be strictly less than fullDayThresholdMinutes.',
      );
    }

    if (fullDay > overtime) {
      throw new BadRequestException(
        'fullDayThresholdMinutes must be less than or equal to overtimeThresholdMinutes.',
      );
    }

    let snapshotString = current.breakPolicySnapshot;
    let normalizedPolicy = parseBreakPolicySnapshot(current.breakPolicySnapshot);

    if (dto.breakPolicy || dto.breakPolicySnapshot) {
      const parsed = validateAndNormalizeBreakPolicy(
        dto.breakPolicy || dto.breakPolicySnapshot,
      );
      snapshotString = parsed.snapshotString;
      normalizedPolicy = parsed.normalizedPolicy;
    }

    const updated = await this.prisma.shiftDefinition.update({
      where: { id },
      data: {
        code: dto.code ? dto.code.trim().toUpperCase() : undefined,
        name: dto.name ? dto.name.trim() : undefined,
        startTime,
        endTime,
        isOvernight,
        gracePeriodMinutes: dto.gracePeriodMinutes ?? undefined,
        halfDayThresholdMinutes: halfDay,
        fullDayThresholdMinutes: fullDay,
        overtimeThresholdMinutes: overtime,
        allowMultipleSessions:
          dto.allowMultipleSessions !== undefined
            ? Boolean(dto.allowMultipleSessions)
            : undefined,
        autoCloseGraceMinutes: dto.autoCloseGraceMinutes ?? undefined,
        breakPolicySnapshot: snapshotString,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'ShiftDefinition',
      entityId: id,
      oldValues: {
        code: current.code,
        name: current.name,
        startTime: current.startTime,
        endTime: current.endTime,
      },
      newValues: {
        code: updated.code,
        name: updated.name,
        startTime: updated.startTime,
        endTime: updated.endTime,
      },
    });

    return {
      ...updated,
      breakPolicy: normalizedPolicy,
    };
  }

  /**
   * Deletes a shift definition if it is not currently referenced by any shift assignments
   * or historical attendance records.
   */
  async deleteShiftDefinition(id: string, actorUserId?: string) {
    const shift = await this.prisma.shiftDefinition.findUnique({
      where: { id },
      include: {
        assignments: { take: 1 },
        attendanceRecords: { take: 1 },
      },
    });

    if (!shift) {
      throw new NotFoundException(`Shift definition with ID "${id}" not found.`);
    }

    if (shift.assignments.length > 0) {
      throw new BadRequestException(
        'Cannot delete shift definition: It is currently assigned to one or more employees.',
      );
    }

    if (shift.attendanceRecords.length > 0) {
      throw new BadRequestException(
        'Cannot delete shift definition: Historical attendance records are linked to this shift.',
      );
    }

    await this.prisma.shiftDefinition.delete({ where: { id } });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'ATTENDANCE',
      entityType: 'ShiftDefinition',
      entityId: id,
      oldValues: { code: shift.code, name: shift.name },
    });

    return { success: true, message: `Shift definition "${shift.code}" deleted.` };
  }

  /**
   * Assigns a shift to an employee with:
   * 1. Data scope verification via AttendanceAccessService
   * 2. Transactional Level-1 (EmployeeProfile) and Level-2 (EmployeeShiftAssignment) pessimistic locking
   * 3. Zero mathematical interval overlap validation (A_start <= B_end AND A_end >= B_start)
   * 4. Audit logging
   */
  async assignShiftToEmployee(
    dto: AssignShiftDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    // 1. Data scope authorization check
    await this.accessService.assertSupervisorAccess(
      dto.userId,
      actorUserId,
      actorUserType,
      'attendance.manage_shifts',
    );

    // 2. Validate calendar date format and ordering
    const startDate = parseDateOnly(dto.startDate);
    const endDate = dto.endDate ? parseDateOnly(dto.endDate) : null;

    if (endDate && startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('startDate cannot be after endDate.');
    }

    // 3. Execute under transaction with strict Level-1 -> Level-2 lock hierarchy
    const createdAssignment = await this.prisma.$transaction(async (tx) => {
      // Level 1 Lock: EmployeeProfile
      const profiles = await tx.$queryRaw<Array<{ id: string; user_id: string }>>`
        SELECT id, user_id FROM employee_profiles WHERE user_id = ${dto.userId} FOR UPDATE
      `;

      if (!profiles || profiles.length === 0) {
        throw new NotFoundException(
          `Employee profile not found for user ID "${dto.userId}".`,
        );
      }
      const profile = profiles[0];

      // Verify ShiftDefinition exists
      const shiftDef = await tx.shiftDefinition.findUnique({
        where: { id: dto.shiftDefinitionId },
      });
      if (!shiftDef) {
        throw new NotFoundException(
          `Shift definition with ID "${dto.shiftDefinitionId}" not found.`,
        );
      }

      // Level 2 Lock: Existing EmployeeShiftAssignments for this user
      const existingAssignments = await tx.$queryRaw<
        Array<{
          id: string;
          start_date: Date;
          end_date: Date | null;
          shift_definition_id: string;
        }>
      >`
        SELECT id, start_date, end_date, shift_definition_id
        FROM employee_shift_assignments
        WHERE user_id = ${dto.userId}
        ORDER BY start_date ASC
        FOR UPDATE
      `;

      // Mathematical interval overlap verification
      for (const existing of existingAssignments) {
        const existingStart = parseDateOnly(existing.start_date);
        const existingEnd = existing.end_date ? parseDateOnly(existing.end_date) : null;

        if (intervalsOverlap(startDate, endDate, existingStart, existingEnd)) {
          throw new ConflictException(
            `Shift assignment interval [${formatDateOnly(startDate)} to ${endDate ? formatDateOnly(endDate) : 'indefinite'}] overlaps with existing assignment ${existing.id} [${formatDateOnly(existingStart)} to ${existingEnd ? formatDateOnly(existingEnd) : 'indefinite'}].`,
          );
        }
      }

      // Create new assignment
      return tx.employeeShiftAssignment.create({
        data: {
          employeeProfileId: profile.id,
          userId: dto.userId,
          shiftDefinitionId: dto.shiftDefinitionId,
          startDate,
          endDate,
        },
        include: {
          shiftDefinition: true,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.CREATE,
      module: 'ATTENDANCE',
      entityType: 'EmployeeShiftAssignment',
      entityId: createdAssignment.id,
      newValues: {
        userId: dto.userId,
        shiftDefinitionId: dto.shiftDefinitionId,
        startDate: formatDateOnly(startDate),
        endDate: endDate ? formatDateOnly(endDate) : null,
      },
    });

    return {
      ...createdAssignment,
      shiftDefinition: {
        ...createdAssignment.shiftDefinition,
        breakPolicy: parseBreakPolicySnapshot(
          createdAssignment.shiftDefinition.breakPolicySnapshot,
        ),
      },
    };
  }

  /**
   * Updates an existing shift assignment with interval overlap validation against other assignments.
   */
  async updateShiftAssignment(
    assignmentId: string,
    dto: UpdateShiftAssignmentDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const existing = await this.prisma.employeeShiftAssignment.findUnique({
      where: { id: assignmentId },
    });

    if (!existing) {
      throw new NotFoundException(`Shift assignment with ID "${assignmentId}" not found.`);
    }

    await this.accessService.assertSupervisorAccess(
      existing.userId,
      actorUserId,
      actorUserType,
      'attendance.manage_shifts',
    );

    const startDate = dto.startDate ? parseDateOnly(dto.startDate) : parseDateOnly(existing.startDate);
    const endDate =
      dto.endDate !== undefined
        ? dto.endDate
          ? parseDateOnly(dto.endDate)
          : null
        : existing.endDate
          ? parseDateOnly(existing.endDate)
          : null;

    if (endDate && startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('startDate cannot be after endDate.');
    }

    const shiftDefinitionId = dto.shiftDefinitionId ?? existing.shiftDefinitionId;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Level 1 Lock: EmployeeProfile
      await tx.$queryRaw`
        SELECT id FROM employee_profiles WHERE user_id = ${existing.userId} FOR UPDATE
      `;

      if (dto.shiftDefinitionId) {
        const shiftDef = await tx.shiftDefinition.findUnique({
          where: { id: dto.shiftDefinitionId },
        });
        if (!shiftDef) {
          throw new NotFoundException(
            `Shift definition with ID "${dto.shiftDefinitionId}" not found.`,
          );
        }
      }

      // Level 2 Lock: Query all assignments for user
      const otherAssignments = await tx.$queryRaw<
        Array<{
          id: string;
          start_date: Date;
          end_date: Date | null;
        }>
      >`
        SELECT id, start_date, end_date
        FROM employee_shift_assignments
        WHERE user_id = ${existing.userId} AND id != ${assignmentId}
        FOR UPDATE
      `;

      for (const other of otherAssignments) {
        const otherStart = parseDateOnly(other.start_date);
        const otherEnd = other.end_date ? parseDateOnly(other.end_date) : null;

        if (intervalsOverlap(startDate, endDate, otherStart, otherEnd)) {
          throw new ConflictException(
            `Updated interval [${formatDateOnly(startDate)} to ${endDate ? formatDateOnly(endDate) : 'indefinite'}] overlaps with existing assignment ${other.id} [${formatDateOnly(otherStart)} to ${otherEnd ? formatDateOnly(otherEnd) : 'indefinite'}].`,
          );
        }
      }

      return tx.employeeShiftAssignment.update({
        where: { id: assignmentId },
        data: {
          shiftDefinitionId,
          startDate,
          endDate,
        },
        include: {
          shiftDefinition: true,
        },
      });
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'ATTENDANCE',
      entityType: 'EmployeeShiftAssignment',
      entityId: assignmentId,
      oldValues: {
        shiftDefinitionId: existing.shiftDefinitionId,
        startDate: formatDateOnly(existing.startDate),
        endDate: existing.endDate ? formatDateOnly(existing.endDate) : null,
      },
      newValues: {
        shiftDefinitionId: updated.shiftDefinitionId,
        startDate: formatDateOnly(updated.startDate),
        endDate: updated.endDate ? formatDateOnly(updated.endDate) : null,
      },
    });

    return {
      ...updated,
      shiftDefinition: {
        ...updated.shiftDefinition,
        breakPolicy: parseBreakPolicySnapshot(
          updated.shiftDefinition.breakPolicySnapshot,
        ),
      },
    };
  }

  /**
   * Deletes a shift assignment if no attendance records are linked to it.
   */
  async deleteShiftAssignment(
    assignmentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    const assignment = await this.prisma.employeeShiftAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        attendanceRecords: { take: 1 },
      },
    });

    if (!assignment) {
      throw new NotFoundException(`Shift assignment with ID "${assignmentId}" not found.`);
    }

    await this.accessService.assertSupervisorAccess(
      assignment.userId,
      actorUserId,
      actorUserType,
      'attendance.manage_shifts',
    );

    if (assignment.attendanceRecords.length > 0) {
      throw new BadRequestException(
        'Cannot delete shift assignment: Attendance records are linked to this assignment.',
      );
    }

    await this.prisma.employeeShiftAssignment.delete({
      where: { id: assignmentId },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'ATTENDANCE',
      entityType: 'EmployeeShiftAssignment',
      entityId: assignmentId,
      oldValues: {
        userId: assignment.userId,
        shiftDefinitionId: assignment.shiftDefinitionId,
        startDate: formatDateOnly(assignment.startDate),
        endDate: assignment.endDate ? formatDateOnly(assignment.endDate) : null,
      },
    });

    return { success: true, message: 'Shift assignment deleted successfully.' };
  }

  /**
   * Retrieves all shift assignments for a target employee, enforcing data scope permissions.
   */
  async getEmployeeShiftAssignments(
    targetUserId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.accessService.assertSupervisorAccess(
      targetUserId,
      actorUserId,
      actorUserType,
      'attendance.view',
    );

    const assignments = await this.prisma.employeeShiftAssignment.findMany({
      where: { userId: targetUserId },
      include: {
        shiftDefinition: true,
      },
      orderBy: { startDate: 'desc' },
    });

    return assignments.map((assignment) => ({
      ...assignment,
      shiftDefinition: {
        ...assignment.shiftDefinition,
        breakPolicy: parseBreakPolicySnapshot(
          assignment.shiftDefinition.breakPolicySnapshot,
        ),
      },
    }));
  }

  /**
   * Resolves the effective shift assignment and definition for an employee on a specific calendar date.
   * Matches where startDate <= targetDate AND (endDate IS NULL OR endDate >= targetDate).
   */
  async getEffectiveShiftForDate(userId: string, dateInput: string | Date) {
    const targetDate = parseDateOnly(dateInput);

    const assignment = await this.prisma.employeeShiftAssignment.findFirst({
      where: {
        userId,
        startDate: { lte: targetDate },
        OR: [{ endDate: null }, { endDate: { gte: targetDate } }],
      },
      include: {
        shiftDefinition: true,
      },
      orderBy: { startDate: 'desc' },
    });

    if (!assignment) {
      return null;
    }

    return {
      ...assignment,
      shiftDefinition: {
        ...assignment.shiftDefinition,
        breakPolicy: parseBreakPolicySnapshot(
          assignment.shiftDefinition.breakPolicySnapshot,
        ),
      },
    };
  }
}
