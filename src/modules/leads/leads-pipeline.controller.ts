import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { LeadPipelineService } from './lead-pipeline.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

@Controller('leads')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadsPipelineController {
  constructor(private readonly pipelineService: LeadPipelineService) {}

  @Get('pipeline/stages')
  @RequirePermissions('leads.view')
  async getStages() {
    const stages = await this.pipelineService.getPipelineStages();
    return {
      success: true,
      message: 'Pipeline stages retrieved successfully.',
      data: stages,
    };
  }

  @Get('metrics/summary')
  @RequirePermissions('leads.view')
  async getSummaryMetrics(@Req() req: any) {
    const summary = await this.pipelineService.getMetricsSummary(req.user.sub, req.user.userType);
    return {
      success: true,
      message: 'Lead metrics summary retrieved successfully.',
      data: summary,
    };
  }

  @Get('metrics/pipeline')
  @RequirePermissions('leads.view')
  async getPipelineMetrics(@Req() req: any) {
    const pipeline = await this.pipelineService.getPipelineMetrics(req.user.sub, req.user.userType);
    return {
      success: true,
      message: 'Pipeline metrics retrieved successfully.',
      data: pipeline,
    };
  }
}
