import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Response } from 'express';
import { LeadSourcesService } from './lead-sources.service';
import { LeadPipelineService } from './lead-pipeline.service';
import { ImportLeadsDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

@Controller('leads')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadsImportExportController {
  constructor(
    private readonly sourcesService: LeadSourcesService,
    private readonly pipelineService: LeadPipelineService,
  ) {}

  @Post('import')
  @RequirePermissions('leads.import')
  async importLeads(@Body() dto: ImportLeadsDto, @Req() req: any) {
    const result = await this.sourcesService.importLeads(dto, req.user.sub);
    return {
      success: true,
      message: dto.dryRun ? 'Import preview generated.' : 'Leads imported successfully.',
      data: result,
    };
  }

  @Get('export')
  @RequirePermissions('leads.export')
  async exportLeads(@Req() req: any, @Res() res: Response) {
    const csvContent = await this.pipelineService.exportLeadsToCsv(req.user.sub, req.user.userType);
    const filename = `leads_export_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvContent);
  }
}
