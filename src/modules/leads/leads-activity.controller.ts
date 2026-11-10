import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { LeadActivitiesService } from './lead-activities.service';
import { LeadFollowUpsService } from './lead-followups.service';
import {
  CreateLeadActivityDto,
  CreateLeadFollowUpDto,
  UpdateLeadFollowUpDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { FollowUpStatus } from '../../generated/prisma/client';

@Controller('leads')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadsActivityController {
  constructor(
    private readonly activitiesService: LeadActivitiesService,
    private readonly followUpsService: LeadFollowUpsService,
  ) {}

  @Post(':id/activities')
  @RequirePermissions('leads.update')
  async createActivity(
    @Param('id') leadId: string,
    @Body() dto: CreateLeadActivityDto,
    @Req() req: any,
  ) {
    const activity = await this.activitiesService.createActivity(
      leadId,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Lead activity logged successfully.',
      data: activity,
    };
  }

  @Get(':id/timeline')
  @RequirePermissions('leads.view')
  async getTimeline(@Param('id') leadId: string, @Req() req: any) {
    const timeline = await this.activitiesService.getLeadTimeline(leadId, req.user.sub, req.user.userType);
    return {
      success: true,
      message: 'Lead activity timeline retrieved successfully.',
      data: timeline,
    };
  }

  @Post(':id/follow-ups')
  @RequirePermissions('leads.update')
  async createFollowUp(
    @Param('id') leadId: string,
    @Body() dto: CreateLeadFollowUpDto,
    @Req() req: any,
  ) {
    const followUp = await this.followUpsService.createFollowUp(
      leadId,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Follow-up scheduled successfully.',
      data: followUp,
    };
  }

  @Get('follow-ups/my')
  @RequirePermissions('leads.view')
  async getMyFollowUps(
    @Query('status') status?: FollowUpStatus,
    @Req() req?: any,
  ) {
    const followUps = await this.followUpsService.getFollowUps(
      undefined,
      req.user.sub,
      status,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'My follow-ups retrieved successfully.',
      data: followUps,
    };
  }

  @Put('follow-ups/:id')
  @RequirePermissions('leads.update')
  async updateFollowUp(
    @Param('id') followUpId: string,
    @Body() dto: UpdateLeadFollowUpDto,
    @Req() req: any,
  ) {
    const updated = await this.followUpsService.updateFollowUp(
      followUpId,
      dto,
      req.user.sub,
      req.user.userType,
    );
    return {
      success: true,
      message: 'Follow-up updated successfully.',
      data: updated,
    };
  }
}
