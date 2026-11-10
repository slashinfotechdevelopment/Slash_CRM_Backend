import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LeadsService } from './leads.service';
import { CreateLeadFollowUpDto, UpdateLeadFollowUpDto } from './dto';
import { FollowUpStatus, LeadActivityType } from '../../generated/prisma/client';

@Injectable()
export class LeadFollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadsService: LeadsService,
  ) {}

  /**
   * Schedule a new follow-up for a lead
   */
  async createFollowUp(
    leadId: string,
    dto: CreateLeadFollowUpDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.update');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    const scheduledAt = new Date(dto.scheduledAt);
    if (isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid scheduledAt date format.');
    }

    // Default assignedToId to lead's assignedToId or actor
    const assignedToId = dto.assignedToId || lead.assignedToId || actorUserId;

    const followUp = await this.prisma.leadFollowUp.create({
      data: {
        leadId,
        createdById: actorUserId,
        assignedToId,
        scheduledAt,
        note: dto.note || null,
        status: FollowUpStatus.PENDING,
      },
      include: {
        createdBy: { select: { id: true, userCode: true, name: true, email: true } },
        assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    // Create activity timeline entry
    await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: LeadActivityType.NOTE,
        title: 'Follow-up Scheduled',
        description: `Follow-up scheduled for ${scheduledAt.toISOString()}: ${dto.note || 'No note'}`,
        metadata: { followUpId: followUp.id, scheduledAt },
      },
    });

    return followUp;
  }

  /**
   * List follow-ups for a lead or for the assigned user
   */
  async getFollowUps(
    leadId?: string,
    assignedToId?: string,
    status?: FollowUpStatus,
    actorUserId?: string,
    actorUserType?: string,
  ) {
    const where: any = {};
    if (leadId) where.leadId = leadId;
    if (assignedToId) where.assignedToId = assignedToId;
    if (status) where.status = status;

    if (actorUserId && actorUserType) {
      const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.view');
      where.lead = scopeWhere;
    }

    return this.prisma.leadFollowUp.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      include: {
        lead: {
          select: {
            id: true,
            leadCode: true,
            leadName: true,
            phone: true,
            status: true,
            priority: true,
          },
        },
        createdBy: { select: { id: true, userCode: true, name: true, email: true } },
        assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });
  }

  /**
   * Update or Complete follow-up
   */
  async updateFollowUp(
    followUpId: string,
    dto: UpdateLeadFollowUpDto,
    actorUserId: string,
    actorUserType: string,
  ) {
    const followUp = await this.prisma.leadFollowUp.findUnique({
      where: { id: followUpId },
    });

    if (!followUp) {
      throw new NotFoundException(`Follow-up with ID ${followUpId} not found.`);
    }

    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.update');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: followUp.leadId }, scopeWhere] },
    });

    if (!lead || lead.deletedAt) {
      throw new NotFoundException(`Lead for this follow-up not found or access denied.`);
    }

    const data: any = {};
    if (dto.scheduledAt) data.scheduledAt = new Date(dto.scheduledAt);
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.status) {
      data.status = dto.status;
      if (dto.status === FollowUpStatus.COMPLETED) {
        data.completedAt = new Date();
      }
    }

    const updated = await this.prisma.leadFollowUp.update({
      where: { id: followUpId },
      data,
      include: {
        lead: { select: { id: true, leadCode: true, leadName: true } },
        assignedTo: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    if (dto.status === FollowUpStatus.COMPLETED) {
      await this.prisma.leadActivity.create({
        data: {
          leadId: followUp.leadId,
          actorId: actorUserId,
          type: LeadActivityType.NOTE,
          title: 'Follow-up Completed',
          description: `Follow-up completed: ${updated.note || ''}`,
          metadata: { followUpId },
        },
      });
    }

    return updated;
  }
}

