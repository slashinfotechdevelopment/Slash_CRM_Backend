import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LeadCodeService } from './lead-code.service';
import { normalizePhoneNumber } from './lead-phone.util';
import { parseKolkataDateBoundary } from './lead-date.util';
import { AuditService } from '../../common/audit/audit.service';
import { AuditAction } from '../../generated/prisma/enums';
import {
  CreateLeadDto,
  UpdateLeadDto,
  QueryLeadsDto,
} from './dto';
import {
  Prisma,
  RecordStatus,
  LeadStatus,
  LeadPriority,
  LeadSource,
  LeadQualificationStatus,
  LeadActivityType,
} from '../../generated/prisma/client';
import { DataScope, PermissionEffect } from '../../generated/prisma/enums';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadCodeService: LeadCodeService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Resolves the effective DataScope for an actor for a specific permission code.
   * Follows the 5-tier rank hierarchy:
   * OWN: 0, ASSIGNED: 1, DEPARTMENT: 2, ALL: 3
   */
  async resolveActorDataScope(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string = 'leads.view',
  ): Promise<DataScope> {
    if (actorUserType === 'SUPER_ADMIN') {
      return DataScope.ALL;
    }
    if (actorUserType === 'CLIENT') {
      return DataScope.OWN;
    }

    // 1. Direct permission override
    const directPerm = await this.prisma.userPermission.findFirst({
      where: {
        userId: actorUserId,
        permission: { code: permissionCode, status: RecordStatus.ACTIVE },
      },
    });

    if (
      directPerm &&
      directPerm.effect === PermissionEffect.ALLOW &&
      directPerm.dataScope
    ) {
      return directPerm.dataScope;
    }

    // 2. Role permissions
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId: actorUserId,
        role: { status: RecordStatus.ACTIVE, deletedAt: null },
      },
      include: {
        role: {
          include: {
            permissions: {
              where: {
                permission: { code: permissionCode, status: RecordStatus.ACTIVE },
              },
            },
          },
        },
      },
    });

    const rank: Record<DataScope, number> = {
      OWN: 0,
      ASSIGNED: 1,
      DEPARTMENT: 2,
      ALL: 3,
    };

    let highestScope: DataScope | null = null;
    for (const ur of userRoles) {
      for (const rp of ur.role.permissions) {
        if (!highestScope || rank[rp.dataScope] > rank[highestScope]) {
          highestScope = rp.dataScope;
        }
      }
    }

    if (highestScope) {
      return highestScope;
    }

    // Default fallback if no specific role-permission dataScope is mapped
    return actorUserType === 'ADMIN' ? DataScope.ALL : DataScope.OWN;
  }

  /**
   * Builds the strict Prisma WHERE clause enforcing authorized scopes.
   */
  async buildLeadVisibilityWhere(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string = 'leads.view',
  ): Promise<Prisma.LeadWhereInput> {
    if (actorUserType === 'SUPER_ADMIN') {
      return { deletedAt: null };
    }
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Clients do not have access to CRM Lead Management.');
    }

    const scope = await this.resolveActorDataScope(
      actorUserId,
      actorUserType,
      permissionCode,
    );

    if (scope === DataScope.ALL) {
      return { deletedAt: null };
    }

    if (scope === DataScope.DEPARTMENT) {
      const userDepts = await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      });
      const deptIds = userDepts.map((d) => d.departmentId);

      return {
        deletedAt: null,
        OR: [
          { departmentId: { in: deptIds } },
          { createdById: actorUserId },
          { assignedToId: actorUserId },
        ],
      };
    }

    // Scope === ASSIGNED or OWN
    return {
      deletedAt: null,
      OR: [
        { assignedToId: actorUserId },
        { createdById: actorUserId },
      ],
    };
  }

  /**
   * Create a new Lead with concurrency-safe code generation,
   * E.164 phone normalization, and duplicate-phone prevention.
   */
  async create(dto: CreateLeadDto, actorUserId: string, actorIp?: string, actorUserAgent?: string) {
    if (!dto.leadName || !dto.leadName.trim()) {
      throw new BadRequestException('leadName cannot be empty or only whitespace.');
    }

    const normalizedPhone = normalizePhoneNumber(dto.phone);

    // Pre-flight duplicate check against active leads
    const existingActive = await this.prisma.lead.findFirst({
      where: {
        deletedAt: null,
        normalizedPhone,
      },
    });

    if (existingActive) {
      throw new ConflictException(
        `An active lead with phone number ${normalizedPhone} already exists (${existingActive.leadCode} - ${existingActive.leadName}). Duplicate phone numbers are strictly blocked for active leads.`,
      );
    }

    // Normalize alternate phone if provided
    let normalizedAlternatePhone: string | null = null;
    if (dto.alternatePhone) {
      try {
        normalizedAlternatePhone = normalizePhoneNumber(dto.alternatePhone);
      } catch {
        normalizedAlternatePhone = dto.alternatePhone.trim();
      }
    }

    // Parse leadDate or default to now
    const leadDate = dto.leadDate ? new Date(dto.leadDate) : new Date();
    const expectedClosingDate = dto.expectedClosingDate ? new Date(dto.expectedClosingDate) : null;

    try {
      const createdLead = await this.prisma.$transaction(async (tx) => {
        const leadCode = await this.leadCodeService.generateNextCode(tx);

        let resolvedPipelineStageId = dto.pipelineStageId || null;
        if (!resolvedPipelineStageId) {
          const defaultStage = await tx.pipelineStage.findFirst({
            where: { status: RecordStatus.ACTIVE },
            orderBy: [{ order: 'asc' }],
            select: { id: true },
          });
          if (defaultStage) {
            resolvedPipelineStageId = defaultStage.id;
          }
        }

        const lead = await tx.lead.create({
          data: {
            leadCode,
            leadDate,
            leadName: dto.leadName.trim(),
            phone: dto.phone.trim(),
            normalizedPhone,
            alternatePhone: normalizedAlternatePhone,
            email: dto.email ? dto.email.trim().toLowerCase() : null,
            companyName: dto.companyName ? dto.companyName.trim() : null,
            jobTitle: dto.jobTitle ? dto.jobTitle.trim() : null,
            website: dto.website ? dto.website.trim() : null,
            interestedCourse: dto.interestedCourse ? dto.interestedCourse.trim() : null,
            industry: dto.industry ? dto.industry.trim() : null,
            location: dto.location ? dto.location.trim() : null,
            address: dto.address ? dto.address.trim() : null,
            city: dto.city ? dto.city.trim() : null,
            state: dto.state ? dto.state.trim() : null,
            country: dto.country ? dto.country.trim() : null,
            pincode: dto.pincode ? dto.pincode.trim() : null,
            requirementDescription: dto.requirementDescription ? dto.requirementDescription.trim() : null,
            estimatedValue: dto.estimatedValue !== undefined ? dto.estimatedValue : null,
            currency: dto.currency || 'INR',
            expectedClosingDate,
            feedback1: dto.feedback1 || null,
            feedback2: dto.feedback2 || null,
            feedback3: dto.feedback3 || null,
            source: dto.source || LeadSource.MANUAL,
            sourceDetails: dto.sourceDetails || null,
            campaignName: dto.campaignName || null,
            createdById: actorUserId,
            departmentId: dto.departmentId || null,
            assignedToId: dto.assignedToId || null,
            assignedById: dto.assignedToId ? actorUserId : null,
            assignedAt: dto.assignedToId ? new Date() : null,
            priority: dto.priority || LeadPriority.MEDIUM,
            status: dto.status || LeadStatus.NEW,
            qualificationStatus: dto.qualificationStatus || LeadQualificationStatus.PENDING,
            pipelineStageId: resolvedPipelineStageId,
          },
          include: {
            createdBy: { select: { id: true, userCode: true, name: true, email: true } },
            assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
            department: { select: { id: true, code: true, name: true } },
          },
        });

        // Create initial creation activity log
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            actorId: actorUserId,
            type: LeadActivityType.NOTE,
            title: 'Lead Created',
            description: `Lead created manually with code ${lead.leadCode}.`,
          },
        });

        return lead;
      });

      // Audit log
      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.CREATE,
        module: 'leads',
        entityType: 'LEAD',
        entityId: createdLead.id,
        newValues: createdLead,
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });

      return createdLead;
    } catch (err: any) {
      const isPhoneDuplicate =
        err.code === 'P2002' ||
        (err.message && (err.message.includes('uq_active_lead_normalized_phone') || err.message.includes('normalized_phone')));
      if (isPhoneDuplicate) {
        throw new ConflictException(
          `An active lead with phone number ${normalizedPhone} already exists. Duplicate active phone numbers are prohibited.`,
        );
      }
      throw err;
    }
  }

  /**
   * List leads with pagination, search, multi-field filtering, sorting, and data-scope isolation.
   */
  async findAll(query: QueryLeadsDto, actorUserId: string, actorUserType: string) {
    const visibilityWhere = await this.buildLeadVisibilityWhere(
      actorUserId,
      actorUserType,
      'leads.view',
    );

    const filterAnd: Prisma.LeadWhereInput[] = [visibilityWhere];

    // Search query (case-insensitive across name, phone, normalizedPhone, email, code, company)
    if (query.search) {
      const search = query.search.trim();
      filterAnd.push({
        OR: [
          { leadCode: { contains: search } },
          { leadName: { contains: search } },
          { phone: { contains: search } },
          { normalizedPhone: { contains: search } },
          { email: { contains: search } },
          { companyName: { contains: search } },
          { location: { contains: search } },
        ],
      });
    }

    if (query.status) {
      filterAnd.push({ status: query.status });
    }

    if (query.priority) {
      filterAnd.push({ priority: query.priority });
    }

    if (query.source) {
      filterAnd.push({ source: query.source });
    }

    if (query.qualificationStatus) {
      filterAnd.push({ qualificationStatus: query.qualificationStatus });
    }

    if (query.pipelineStageId) {
      filterAnd.push({ pipelineStageId: query.pipelineStageId });
    }

    if (query.departmentId) {
      filterAnd.push({ departmentId: query.departmentId });
    }

    if (query.assignedToId) {
      filterAnd.push({ assignedToId: query.assignedToId });
    }

    if (query.unassignedOnly) {
      filterAnd.push({ assignedToId: null });
    }

    if (query.startDate) {
      filterAnd.push({ leadDate: { gte: parseKolkataDateBoundary(query.startDate, false) } });
    }

    if (query.endDate) {
      filterAnd.push({ leadDate: { lte: parseKolkataDateBoundary(query.endDate, true) } });
    }

    if (query.createdStartDate) {
      filterAnd.push({ createdAt: { gte: parseKolkataDateBoundary(query.createdStartDate, false) } });
    }

    if (query.createdEndDate) {
      filterAnd.push({ createdAt: { lte: parseKolkataDateBoundary(query.createdEndDate, true) } });
    }

    const where: Prisma.LeadWhereInput = { AND: filterAnd };

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const sortBy = query.sortBy || 'leadDate';
    const sortOrder = query.sortOrder || 'desc';

    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          createdBy: { select: { id: true, userCode: true, name: true, email: true } },
          assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
          department: { select: { id: true, code: true, name: true } },
          pipelineStage: { select: { id: true, code: true, name: true, color: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Find single lead by ID with data-scope verification.
   */
  async findOne(id: string, actorUserId: string, actorUserType: string) {
    const visibilityWhere = await this.buildLeadVisibilityWhere(
      actorUserId,
      actorUserType,
      'leads.view',
    );

    const lead = await this.prisma.lead.findFirst({
      where: {
        id,
        AND: [visibilityWhere],
      },
      include: {
        createdBy: { select: { id: true, userCode: true, name: true, email: true } },
        assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
        assignedBy: { select: { id: true, userCode: true, name: true, email: true } },
        convertedBy: { select: { id: true, userCode: true, name: true, email: true } },
        department: { select: { id: true, code: true, name: true } },
        pipelineStage: { select: { id: true, code: true, name: true, color: true } },
      },
    });

    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found or you lack permission to view it.`);
    }

    return lead;
  }

  /**
   * Update lead fields with validation, system-field protection, and duplicate-phone check.
   */
  async update(
    id: string,
    dto: UpdateLeadDto,
    actorUserId: string,
    actorUserType: string,
    actorIp?: string,
    actorUserAgent?: string,
  ) {
    // 1. Verify existence & scope
    const existing = await this.findOne(id, actorUserId, actorUserType);

    // 2. Check update permission scope
    const updateScopeWhere = await this.buildLeadVisibilityWhere(
      actorUserId,
      actorUserType,
      'leads.update',
    );

    const isUpdateAuthorized = await this.prisma.lead.findFirst({
      where: { id, AND: [updateScopeWhere] },
    });

    if (!isUpdateAuthorized) {
      throw new ForbiddenException(`You do not have permission to update lead ${existing.leadCode}.`);
    }

    // 3. Handle phone change and normalization
    let normalizedPhone = existing.normalizedPhone;
    let phoneToUpdate = existing.phone;
    if (dto.phone && dto.phone.trim() !== existing.phone) {
      normalizedPhone = normalizePhoneNumber(dto.phone);
      phoneToUpdate = dto.phone.trim();

      // Check active duplicate if phone changed
      const duplicate = await this.prisma.lead.findFirst({
        where: {
          id: { not: id },
          deletedAt: null,
          normalizedPhone,
        },
      });

      if (duplicate) {
        throw new ConflictException(
          `Cannot update phone: Another active lead (${duplicate.leadCode} - ${duplicate.leadName}) already uses ${normalizedPhone}.`,
        );
      }
    }

    // Optional alternate phone normalization
    let alternatePhoneToUpdate = existing.alternatePhone;
    if (dto.alternatePhone !== undefined) {
      if (dto.alternatePhone) {
        try {
          alternatePhoneToUpdate = normalizePhoneNumber(dto.alternatePhone);
        } catch {
          alternatePhoneToUpdate = dto.alternatePhone.trim();
        }
      } else {
        alternatePhoneToUpdate = null;
      }
    }

    const data: Prisma.LeadUpdateInput = {
      ...(dto.leadDate && { leadDate: new Date(dto.leadDate) }),
      ...(dto.leadName && { leadName: dto.leadName.trim() }),
      phone: phoneToUpdate,
      normalizedPhone,
      alternatePhone: alternatePhoneToUpdate,
      ...(dto.email !== undefined && { email: dto.email ? dto.email.trim().toLowerCase() : null }),
      ...(dto.companyName !== undefined && { companyName: dto.companyName ? dto.companyName.trim() : null }),
      ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle ? dto.jobTitle.trim() : null }),
      ...(dto.website !== undefined && { website: dto.website ? dto.website.trim() : null }),
      ...(dto.interestedCourse !== undefined && { interestedCourse: dto.interestedCourse ? dto.interestedCourse.trim() : null }),
      ...(dto.industry !== undefined && { industry: dto.industry ? dto.industry.trim() : null }),
      ...(dto.location !== undefined && { location: dto.location ? dto.location.trim() : null }),
      ...(dto.address !== undefined && { address: dto.address ? dto.address.trim() : null }),
      ...(dto.city !== undefined && { city: dto.city ? dto.city.trim() : null }),
      ...(dto.state !== undefined && { state: dto.state ? dto.state.trim() : null }),
      ...(dto.country !== undefined && { country: dto.country ? dto.country.trim() : null }),
      ...(dto.pincode !== undefined && { pincode: dto.pincode ? dto.pincode.trim() : null }),
      ...(dto.requirementDescription !== undefined && { requirementDescription: dto.requirementDescription ? dto.requirementDescription.trim() : null }),
      ...(dto.estimatedValue !== undefined && { estimatedValue: dto.estimatedValue }),
      ...(dto.currency && { currency: dto.currency }),
      ...(dto.expectedClosingDate !== undefined && { expectedClosingDate: dto.expectedClosingDate ? new Date(dto.expectedClosingDate) : null }),
      ...(dto.feedback1 !== undefined && { feedback1: dto.feedback1 }),
      ...(dto.feedback2 !== undefined && { feedback2: dto.feedback2 }),
      ...(dto.feedback3 !== undefined && { feedback3: dto.feedback3 }),
      ...(dto.source && { source: dto.source }),
      ...(dto.sourceDetails !== undefined && { sourceDetails: dto.sourceDetails }),
      ...(dto.campaignName !== undefined && { campaignName: dto.campaignName }),
      ...(dto.priority && { priority: dto.priority }),
      ...(dto.status && { status: dto.status }),
      ...(dto.qualificationStatus && { qualificationStatus: dto.qualificationStatus }),
      ...(dto.pipelineStageId !== undefined && {
        pipelineStage: dto.pipelineStageId
          ? { connect: { id: dto.pipelineStageId } }
          : { disconnect: true },
      }),
      ...(dto.departmentId !== undefined && {
        department: dto.departmentId
          ? { connect: { id: dto.departmentId } }
          : { disconnect: true },
      }),
      ...(dto.assignedToId !== undefined && {
        assignedTo: dto.assignedToId
          ? { connect: { id: dto.assignedToId } }
          : { disconnect: true },
      }),
      ...(dto.unqualifiedReason !== undefined && { unqualifiedReason: dto.unqualifiedReason }),
      ...(dto.lostReason !== undefined && { lostReason: dto.lostReason }),
    };

    try {
      const updated = await this.prisma.lead.update({
        where: { id },
        data,
        include: {
          createdBy: { select: { id: true, userCode: true, name: true, email: true } },
          assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
          assignedBy: { select: { id: true, userCode: true, name: true, email: true } },
          department: { select: { id: true, code: true, name: true } },
          pipelineStage: { select: { id: true, code: true, name: true, color: true } },
        },
      });

      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.UPDATE,
        module: 'leads',
        entityType: 'LEAD',
        entityId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });

      return updated;
    } catch (err: any) {
      const isPhoneDuplicate =
        err.code === 'P2002' ||
        (err.message && (err.message.includes('uq_active_lead_normalized_phone') || err.message.includes('normalized_phone')));
      if (isPhoneDuplicate) {
        throw new ConflictException(
          `Cannot update: An active lead with phone number ${normalizedPhone} already exists.`,
        );
      }
      throw err;
    }
  }

  /**
   * Soft-delete lead. Automatically sets deletedAt and deletedById.
   * Virtual active_normalized_phone transitions to NULL.
   */
  async remove(id: string, actorUserId: string, actorUserType: string, actorIp?: string, actorUserAgent?: string) {
    const lead = await this.findOne(id, actorUserId, actorUserType);

    const deleted = await this.prisma.lead.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedById: actorUserId,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.DELETE,
      module: 'leads',
      entityType: 'LEAD',
      entityId: id,
      oldValues: lead,
      newValues: deleted,
      ipAddress: actorIp,
      userAgent: actorUserAgent,
    });

    return { success: true, message: `Lead ${lead.leadCode} deleted successfully.` };
  }

  /**
   * Restore soft-deleted lead.
   * Strictly re-verifies active phone uniqueness before restoring.
   */
  async restore(id: string, actorUserId: string, actorIp?: string, actorUserAgent?: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
    });

    if (!lead) {
      throw new NotFoundException(`Lead with ID ${id} not found.`);
    }

    if (!lead.deletedAt) {
      throw new BadRequestException(`Lead ${lead.leadCode} is not deleted.`);
    }

    // Verify no active lead currently has this phone
    const activeDuplicate = await this.prisma.lead.findFirst({
      where: {
        id: { not: id },
        deletedAt: null,
        normalizedPhone: lead.normalizedPhone,
      },
    });

    if (activeDuplicate) {
      throw new ConflictException(
        `Cannot restore lead ${lead.leadCode}: An active lead (${activeDuplicate.leadCode} - ${activeDuplicate.leadName}) already exists with normalized phone ${lead.normalizedPhone}.`,
      );
    }

    try {
      const restored = await this.prisma.lead.update({
        where: { id },
        data: {
          deletedAt: null,
          deletedById: null,
        },
        include: {
          createdBy: { select: { id: true, userCode: true, name: true, email: true } },
          assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
          department: { select: { id: true, code: true, name: true } },
        },
      });

      await this.auditService.logAudit({
        actorUserId,
        action: AuditAction.RESTORE,
        module: 'leads',
        entityType: 'LEAD',
        entityId: id,
        oldValues: lead,
        newValues: restored,
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });

      return restored;
    } catch (err: any) {
      if (err.code === 'P2002' && err.meta?.target?.includes('active_normalized_phone')) {
        throw new ConflictException(
          `Cannot restore: An active lead with phone number ${lead.normalizedPhone} already exists.`,
        );
      }
      throw err;
    }
  }
}
