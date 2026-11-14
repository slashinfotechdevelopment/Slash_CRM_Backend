import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { SuperAdminGuard } from './guards/super-admin.guard';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService, SuperAdminGuard],
  exports: [AdminDashboardService],
})
export class AdminDashboardModule {}
