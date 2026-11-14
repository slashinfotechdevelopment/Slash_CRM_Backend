import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { SuperAdminGuard } from './guards/super-admin.guard';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService, SuperAdminGuard],
  exports: [AdminDashboardService],
})
export class AdminDashboardModule {}
