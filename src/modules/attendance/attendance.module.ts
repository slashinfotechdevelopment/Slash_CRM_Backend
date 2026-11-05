import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RolesModule } from '../roles/roles.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttendanceShiftsController } from './attendance-shifts.controller';
import { AttendanceShiftsService } from './attendance-shifts.service';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceCalculationService } from './attendance-calculation.service';
import { AttendanceOvertimeController } from './attendance-overtime.controller';
import { AttendanceOvertimeService } from './attendance-overtime.service';
import { AttendanceWfhController } from './attendance-wfh.controller';
import { AttendanceWfhService } from './attendance-wfh.service';
import { AttendanceCorrectionController } from './attendance-correction.controller';
import { AttendanceCorrectionService } from './attendance-correction.service';
import { AttendanceReconciliationController } from './attendance-reconciliation.controller';
import { AttendanceReconciliationService } from './attendance-reconciliation.service';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PermissionsModule,
  ],
  controllers: [
    AttendanceShiftsController,
    AttendanceController,
    AttendanceOvertimeController,
    AttendanceWfhController,
    AttendanceCorrectionController,
    AttendanceReconciliationController,
  ],
  providers: [
    AttendanceShiftsService,
    AttendanceAccessService,
    AttendanceService,
    AttendanceCalculationService,
    AttendanceOvertimeService,
    AttendanceWfhService,
    AttendanceCorrectionService,
    AttendanceReconciliationService,
  ],
  exports: [
    AttendanceShiftsService,
    AttendanceAccessService,
    AttendanceService,
    AttendanceCalculationService,
    AttendanceOvertimeService,
    AttendanceWfhService,
    AttendanceCorrectionService,
    AttendanceReconciliationService,
  ],
})
export class AttendanceModule {}
