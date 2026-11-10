import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LeadsService } from './leads.service';
import { CreateLeadActivityDto } from './dto';
import { LeadActivityType } from '../../generated/prisma/client';

@Injectable()
export class LeadActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadsService: LeadsService,
  ) {}

  /**
   * Log an activity (Call, Note, Meeting, Email, Status change, etc.)
   */
  async createActivity(
    leadId: string,
    dto: CreateLeadActivityDto,
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

    const activity = await this.prisma.leadActivity.create({
      data: {
        leadId,
        actorId: actorUserId,
        type: dto.type,
        title: dto.title,
        description: dto.description || null,
        metadata: dto.metadata || null,
      },
      include: {
        actor: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    // Update last activity timestamp on the lead
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        lastActivityAt: new Date(),
        ...(dto.type === LeadActivityType.CALL && { lastContactedAt: new Date() }),
      },
    });

    return activity;
  }

  /**
   * Get chronological activity timeline for a lead
   */
  async getLeadTimeline(leadId: string, actorUserId: string, actorUserType: string) {
    const scopeWhere = await this.leadsService.buildLeadVisibilityWhere(actorUserId, actorUserType, 'leads.view');
    const lead = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, scopeWhere] },
      select: { id: true, leadCode: true, leadName: true },
    });

    if (!lead) {
      throw new NotFoundException(`Lead with ID ${leadId} not found.`);
    }

    const activities = await this.prisma.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    return {
      lead,
      total: activities.length,
      activities,
    };
  }
}

