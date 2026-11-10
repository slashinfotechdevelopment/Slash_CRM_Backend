import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuditAction } from '../../generated/prisma/enums';
import { LeadsService } from './leads.service';
import {
  AssignLeadDto,
  QualifyLeadDto,
  ChangeLeadStatusDto,
  ConvertLeadDto,
} from './dto';
import {
  LeadStatus,
  LeadQualificationStatus,
  LeadActivityType,
  RecordStatus,
  Prisma,
} from '../../generated/prisma/client';

@Injectable()
export class LeadPipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly leadsService: LeadsService,
  ) { }

  /**
   * List active pipeline stages ordered by sequence
   */
  async getPipelineStages() {
    return this.prisma.pipelineStage.findMany({
      where: { status: RecordStatus.ACTIVE },
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { leads: { where: { deletedAt: null } } },
        },
      },
    });
  }

  /**
   * Assign lead to employee, department queue, or unassign (Phase 7.2)
   */
  async assignLead(
    leadId: string,
    dto: AssignLeadDto,
    actorUserId: string,
    actorUserType: string,
    actorIp?: string,
    actorUserAgent?: string,
  ) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.assign');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
      include: {
        assignedTo: { select: { id: true, name: true, userCode: true } },
        department: { select: { id: true, name: true, code: true } },
      },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    let targetAssigneeName = 'Unassigned';
    let newAssignedToId: string | null = null;
    let newAssignedById: string | null = null;
    let newAssignedAt: Date | null = null;
    let newDepartmentId: string | null = lead.departmentId;

    if (dto.unassign) {
      newAssignedToId = null;
      newAssignedById = null;
      newAssignedAt = null;
    } else if (dto.assignedToId) {
      const user = await this.prisma.user.findFirst({
        where: { id: dto.assignedToId, status: RecordStatus.ACTIVE, deletedAt: null },
        select: { id: true, name: true, userCode: true },
      });
      if (!user) {
        throw new NotFoundException(`Active assignee user with ID ${dto.assignedToId} not found.`);
      }
      newAssignedToId = user.id;
      newAssignedById = actorUserId;
      newAssignedAt = new Date();
      targetAssigneeName = `${user.name} (${user.userCode})`;
    }

    if (dto.departmentId !== undefined) {
      if (dto.departmentId) {
        const dept = await this.prisma.department.findFirst({
          where: { id: dto.departmentId, status: RecordStatus.ACTIVE },
        });
        if (!dept) {
          throw new NotFoundException(`Active department with ID ${dto.departmentId} not found.`);
        }
        newDepartmentId = dept.id;
      } else {
        newDepartmentId = null;
      }
    }

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        assignedToId: newAssignedToId,
        assignedById: newAssignedById,
        assignedAt: newAssignedAt,
        departmentId: newDepartmentId,
      },
      include: {
        assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
        department: { select: { id: true, code: true, name: true } },
      },
    });

    // Activity log entry
    await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: LeadActivityType.ASSIGNMENT,
        title: 'Lead Assignment Updated',
        description: `Lead assigned to: ${targetAssigneeName}. Note: ${dto.note || 'None'}.`,
        metadata: {
          previousAssigneeId: lead.assignedToId,
          newAssigneeId: newAssignedToId,
          departmentId: newDepartmentId,
        },
      },
    });

    // Audit log
    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leads',
      entityType: 'LEAD',
      entityId: leadId,
      oldValues: { assignedToId: lead.assignedToId, departmentId: lead.departmentId },
      newValues: { assignedToId: newAssignedToId, departmentId: newDepartmentId },
      ipAddress: actorIp,
      userAgent: actorUserAgent,
    });

    return updated;
  }

  /**
   * Qualify or disqualify lead (Phase 7.4)
   */
  async qualifyLead(
    leadId: string,
    dto: QualifyLeadDto,
    actorUserId: string,
    actorUserType: string,
    actorIp?: string,
    actorUserAgent?: string,
  ) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.update');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    if (dto.qualificationStatus === LeadQualificationStatus.UNQUALIFIED && (!dto.unqualifiedReason || !dto.unqualifiedReason.trim())) {
      throw new BadRequestException('unqualifiedReason is required when qualificationStatus is UNQUALIFIED.');
    }

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        qualificationStatus: dto.qualificationStatus,
        ...(dto.qualificationStatus === LeadQualificationStatus.QUALIFIED && {
          status: LeadStatus.QUALIFIED,
        }),
        ...(dto.qualificationStatus === LeadQualificationStatus.UNQUALIFIED && {
          status: LeadStatus.UNQUALIFIED,
          unqualifiedReason: dto.unqualifiedReason || null,
        }),
      },
    });

    await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: LeadActivityType.QUALIFICATION,
        title: `Lead Marked as ${dto.qualificationStatus}`,
        description: `Qualification status changed to ${dto.qualificationStatus}. ${dto.unqualifiedReason ? `Reason: ${dto.unqualifiedReason}.` : ''} Note: ${dto.note || ''}`,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leads',
      entityType: 'LEAD',
      entityId: leadId,
      oldValues: { qualificationStatus: lead.qualificationStatus, status: lead.status },
      newValues: { qualificationStatus: updated.qualificationStatus, status: updated.status },
      ipAddress: actorIp,
      userAgent: actorUserAgent,
    });

    return updated;
  }

  /**
   * Change lead status & pipeline stage (Phase 7.4)
   */
  async changeStatus(
    leadId: string,
    dto: ChangeLeadStatusDto,
    actorUserId: string,
    actorUserType: string,
    actorIp?: string,
    actorUserAgent?: string,
  ) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.update');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    if (lead.status === LeadStatus.CONVERTED && dto.status !== LeadStatus.CONVERTED) {
      throw new BadRequestException('Converted leads cannot have their status reverted.');
    }

    if (dto.status === LeadStatus.LOST && (!dto.lostReason || !dto.lostReason.trim())) {
      throw new BadRequestException('lostReason is required when status is set to LOST.');
    }

    if (dto.status === LeadStatus.UNQUALIFIED && (!dto.unqualifiedReason || !dto.unqualifiedReason.trim())) {
      throw new BadRequestException('unqualifiedReason is required when status is set to UNQUALIFIED.');
    }

    if (dto.pipelineStageId) {
      const stage = await this.prisma.pipelineStage.findFirst({
        where: { id: dto.pipelineStageId, status: RecordStatus.ACTIVE },
      });
      if (!stage) {
        throw new NotFoundException(`Pipeline stage with ID ${dto.pipelineStageId} not found or inactive.`);
      }
    }

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        status: dto.status,
        ...(dto.lostReason !== undefined && { lostReason: dto.lostReason }),
        ...(dto.unqualifiedReason !== undefined && { unqualifiedReason: dto.unqualifiedReason }),
        ...(dto.pipelineStageId && { pipelineStageId: dto.pipelineStageId }),
      },
    });

    await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: LeadActivityType.STATUS_CHANGE,
        title: `Status Changed: ${dto.status}`,
        description: `Status changed from ${lead.status} to ${dto.status}. Note: ${dto.note || 'None'}.`,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leads',
      entityType: 'LEAD',
      entityId: leadId,
      oldValues: { status: lead.status, pipelineStageId: lead.pipelineStageId },
      newValues: { status: updated.status, pipelineStageId: updated.pipelineStageId },
      ipAddress: actorIp,
      userAgent: actorUserAgent,
    });

    return updated;
  }

  /**
   * Convert lead (Phase 7.4)
   * Strictly marks lead as CONVERTED with convertedAt and convertedById.
   * Does NOT auto-create customer or opportunity (Admin handles subsequent steps).
   */
  async convertLead(
    leadId: string,
    dto: ConvertLeadDto,
    actorUserId: string,
    actorUserType: string,
    actorIp?: string,
    actorUserAgent?: string,
  ) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.update');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    // Repeat-conversion protection
    if (lead.status === LeadStatus.CONVERTED) {
      throw new BadRequestException(`Lead ${lead.leadCode} is already converted.`);
    }

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        status: LeadStatus.CONVERTED,
        qualificationStatus: LeadQualificationStatus.QUALIFIED,
        convertedAt: new Date(),
        convertedById: actorUserId,
      },
      include: {
        convertedBy: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: LeadActivityType.STATUS_CHANGE,
        title: 'Lead Converted Successfully',
        description: `Lead converted by admin. Note: ${dto.note || 'Ready for client account creation.'}`,
      },
    });

    await this.auditService.logAudit({
      actorUserId,
      action: AuditAction.UPDATE,
      module: 'leads',
      entityType: 'LEAD',
      entityId: leadId,
      oldValues: { status: lead.status, qualificationStatus: lead.qualificationStatus },
      newValues: {
        status: updated.status,
        qualificationStatus: updated.qualificationStatus,
        convertedAt: updated.convertedAt,
        convertedById: updated.convertedById,
      },
      ipAddress: actorIp,
      userAgent: actorUserAgent,
    });

    return updated;
  }

  /**
   * Summary metrics for lead dashboard with data-scope isolation (Phase 7.4)
   */
  async getMetricsSummary(actorUserId: string, actorUserType: string) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.view');
    const baseWhere: Prisma.LeadWhereInput = { AND: [scopeWhere, { deletedAt: null }] };

    const [
      totalActive,
      newCount,
      contactedCount,
      qualifiedCount,
      unqualifiedCount,
      convertedCount,
      lostCount,
      unassignedCount,
    ] = await Promise.all([
      this.prisma.lead.count({ where: baseWhere }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.NEW }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.CONTACTED }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.QUALIFIED }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.UNQUALIFIED }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.CONVERTED }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { status: LeadStatus.LOST }] } }),
      this.prisma.lead.count({ where: { AND: [baseWhere, { assignedToId: null }] } }),
    ]);

    const estimatedValueSum = await this.prisma.lead.aggregate({
      where: baseWhere,
      _sum: { estimatedValue: true },
    });

    const conversionRate = totalActive > 0 ? Number(((convertedCount / totalActive) * 100).toFixed(2)) : 0;

    return {
      totalActive,
      statusCounts: {
        new: newCount,
        contacted: contactedCount,
        qualified: qualifiedCount,
        unqualified: unqualifiedCount,
        converted: convertedCount,
        lost: lostCount,
      },
      unassignedCount,
      totalPipelineValue: estimatedValueSum._sum.estimatedValue || 0,
      conversionRate,
    };
  }

  /**
   * Pipeline stage breakdown metrics with data-scope isolation (Phase 7.4)
   */
  async getPipelineMetrics(actorUserId: string, actorUserType: string) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.view');
    const stages = await this.prisma.pipelineStage.findMany({
      where: { status: RecordStatus.ACTIVE },
      orderBy: { order: 'asc' },
    });

    const results = [];
    for (const stage of stages) {
      const stageWhere: Prisma.LeadWhereInput = {
        AND: [scopeWhere, { deletedAt: null, pipelineStageId: stage.id }],
      };

      const [count, valSum] = await Promise.all([
        this.prisma.lead.count({ where: stageWhere }),
        this.prisma.lead.aggregate({
          where: stageWhere,
          _sum: { estimatedValue: true },
        }),
      ]);

      results.push({
        stageId: stage.id,
        stageCode: stage.code,
        stageName: stage.name,
        color: stage.color,
        leadCount: count,
        totalValue: valSum._sum.estimatedValue || 0,
      });
    }

    return results;
  }

  /**
   * Export Leads to CSV string with strict data-scope isolation (Phase 7.4)
   */
  async exportLeadsToCsv(actorUserId: string, actorUserType: string): Promise<string> {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.export');
    const leads = await this.prisma.lead.findMany({
      where: { AND: [scopeWhere, { deletedAt: null }] },
      orderBy: { leadDate: 'desc' },
      include: {
        createdBy: { select: { name: true, userCode: true } },
        assignedTo: { select: { name: true, userCode: true } },
        department: { select: { name: true } },
      },
    });

    const headers = [
      'Lead Code',
      'Lead Date',
      'Lead Name',
      'Phone',
      'Alternate Phone',
      'Email',
      'Company Name',
      'Course',
      'Location',
      'Status',
      'Priority',
      'Feedback 1',
      'Feedback 2',
      'Feedback 3',
      'Source',
      'Assigned To',
      'Department',
      'Created By',
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = leads.map((l) => [
      escapeCsv(l.leadCode),
      escapeCsv(l.leadDate.toISOString().split('T')[0]),
      escapeCsv(l.leadName),
      escapeCsv(l.phone),
      escapeCsv(l.alternatePhone),
      escapeCsv(l.email),
      escapeCsv(l.companyName),
      escapeCsv(l.interestedCourse),
      escapeCsv(l.location),
      escapeCsv(l.status),
      escapeCsv(l.priority),
      escapeCsv(l.feedback1),
      escapeCsv(l.feedback2),
      escapeCsv(l.feedback3),
      escapeCsv(l.source),
      escapeCsv(l.assignedTo?.name || 'Unassigned'),
      escapeCsv(l.department?.name || 'None'),
      escapeCsv(l.createdBy.name),
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}
