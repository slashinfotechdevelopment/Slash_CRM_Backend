import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../../common/audit/audit.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskCodeService } from './task-code.service';
import { TasksTimerService } from './tasks-timer.service';
import { TasksWorkflowService } from './tasks-workflow.service';
import { TasksReportsService } from './tasks-reports.service';
import { TaskTimerAutoPauseModule } from './task-timer-auto-pause.module';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { ClamAvScannerService } from './storage/clamav-scanner.service';
import { MediaStorageService } from './storage/media-storage.service';
import { TasksStorageReconciliationService } from './storage/tasks-storage-reconciliation.service';

@Module({
  imports: [
    DatabaseModule,
    UsersModule,
    AuthModule,
    AuditModule,
    TaskTimerAutoPauseModule,
  ],
  controllers: [TasksController],
  providers: [
    TasksService,
    TaskCodeService,
    TasksTimerService,
    TasksWorkflowService,
    TasksReportsService,
    LocalStorageProvider,
    ClamAvScannerService,
    MediaStorageService,
    TasksStorageReconciliationService,
  ],
  exports: [
    TasksService,
    TaskCodeService,
    TasksTimerService,
    TasksWorkflowService,
    TasksReportsService,
    LocalStorageProvider,
    ClamAvScannerService,
    MediaStorageService,
    TasksStorageReconciliationService,
  ],
})
export class TasksModule {}
