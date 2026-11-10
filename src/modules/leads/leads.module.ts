import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { LeadCodeService } from './lead-code.service';
import { LeadsService } from './leads.service';
import { LeadActivitiesService } from './lead-activities.service';
import { LeadFollowUpsService } from './lead-followups.service';
import { LeadSourcesService } from './lead-sources.service';
import { LeadPipelineService } from './lead-pipeline.service';
import { LeadsController } from './leads.controller';
import { LeadsPublicController } from './leads-public.controller';
import { LeadsActivityController } from './leads-activity.controller';
import { LeadsImportExportController } from './leads-import-export.controller';
import { LeadsPipelineController } from './leads-pipeline.controller';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [
    LeadsPublicController, // Public route first
    LeadsActivityController,
    LeadsImportExportController,
    LeadsPipelineController,
    LeadsController,
  ],
  providers: [
    LeadCodeService,
    LeadsService,
    LeadActivitiesService,
    LeadFollowUpsService,
    LeadSourcesService,
    LeadPipelineService,
  ],
  exports: [
    LeadCodeService,
    LeadsService,
    LeadActivitiesService,
    LeadFollowUpsService,
    LeadSourcesService,
    LeadPipelineService,
  ],
})
export class LeadsModule {}

