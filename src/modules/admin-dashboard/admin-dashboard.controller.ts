import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { AdminDashboardService } from './admin-dashboard.service';
import {
  QueryDateRangeDto,
  QueryEmployeeActivityDto,
  QueryEmployeeSessionsDto,
  QueryEmployeeTasksDto,
  QueryLeadTrendDto,
} from './dto';

@ApiTags('Admin Dashboard (Super Admin Only)')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminDashboardController {
  constructor(private readonly dashboardService: AdminDashboardService) {}

  // ===========================================================================
  // A) EMPLOYEE ACTIVITY (LOGIN/LOGOUT)
  // ===========================================================================

  @Get('employees/activity')
  @ApiOperation({
    summary: 'Get employee login/logout activity and active duration',
    description:
      'Returns per-employee activity: last login, last logout, current status (online/offline based on active session in last 20 minutes), total sessions, and total active duration in range.',
  })
  @ApiResponse({ status: 200, description: 'Employee activity returned successfully.' })
  @ApiResponse({ status: 403, description: 'Access denied: Super Admin privilege required.' })
  async getEmployeeActivity(@Query() query: QueryEmployeeActivityDto) {
    const data = await this.dashboardService.getEmployeeActivity(query);
    return {
      success: true,
      message: 'Employee activity data retrieved successfully.',
      data,
    };
  }

  @Get('employees/:id/sessions')
  @ApiOperation({
    summary: 'Get employee full session history',
    description:
      'Returns paginated login and logout session history for an employee, including IP, device/user-agent, and computed session duration.',
  })
  @ApiParam({ name: 'id', description: 'Employee User ID' })
  @ApiResponse({ status: 200, description: 'Employee session history returned successfully.' })
  @ApiResponse({ status: 404, description: 'Employee not found.' })
  async getEmployeeSessions(
    @Param('id') id: string,
    @Query() query: QueryEmployeeSessionsDto,
  ) {
    const data = await this.dashboardService.getEmployeeSessions(id, query);
    return {
      success: true,
      message: 'Employee session history retrieved successfully.',
      data,
    };
  }

  // ===========================================================================
  // B) EMPLOYEE TASKS
  // ===========================================================================

  @Get('employees/:id/tasks')
  @ApiOperation({
    summary: 'Get employee tasks with computed status and completion date',
    description:
      'Returns task list with computed status (completed, pending, overdue), start date, due date, and completed date (derived from latest TaskStatusHistory entry).',
  })
  @ApiParam({ name: 'id', description: 'Employee User ID' })
  @ApiResponse({ status: 200, description: 'Employee tasks returned successfully.' })
  @ApiResponse({ status: 404, description: 'Employee not found.' })
  async getEmployeeTasks(
    @Param('id') id: string,
    @Query() query: QueryEmployeeTasksDto,
  ) {
    const data = await this.dashboardService.getEmployeeTasks(id, query);
    return {
      success: true,
      message: 'Employee tasks retrieved successfully.',
      data,
    };
  }

  @Get('tasks/summary')
  @ApiOperation({
    summary: 'Get tasks summary aggregated per employee',
    description:
      'Returns task metrics aggregated per employee: total tasks, completed, pending, overdue, and completion rate %. Excludes cancelled tasks from totals and rate calculations.',
  })
  @ApiResponse({ status: 200, description: 'Tasks summary returned successfully.' })
  async getTasksSummary(@Query() query: QueryDateRangeDto) {
    const data = await this.dashboardService.getTasksSummary(query);
    return {
      success: true,
      message: 'Tasks summary retrieved successfully.',
      data,
    };
  }

  // ===========================================================================
  // C) LEAD MANAGEMENT DASHBOARD (SUPER ADMIN ONLY)
  // ===========================================================================

  @Get('leads/summary')
  @ApiOperation({
    summary: 'Get lead management summary dashboard',
    description:
      'Returns high-level lead metrics: new leads (createdAt in range), converted leads (convertedAt in range), lost leads, conversion rate % (leads created in range that are converted / new leads), and counts by stage and status.',
  })
  @ApiResponse({ status: 200, description: 'Leads summary returned successfully.' })
  async getLeadsSummary(@Query() query: QueryDateRangeDto) {
    const data = await this.dashboardService.getLeadsSummary(query);
    return {
      success: true,
      message: 'Lead summary metrics retrieved successfully.',
      data,
    };
  }

  @Get('leads/by-employee')
  @ApiOperation({
    summary: 'Get lead metrics aggregated per employee',
    description:
      'Returns per-employee metrics: leads assigned, converted, and individual conversion rate %.',
  })
  @ApiResponse({ status: 200, description: 'Leads by employee returned successfully.' })
  async getLeadsByEmployee(@Query() query: QueryDateRangeDto) {
    const data = await this.dashboardService.getLeadsByEmployee(query);
    return {
      success: true,
      message: 'Leads by employee retrieved successfully.',
      data,
    };
  }

  @Get('leads/trend')
  @ApiOperation({
    summary: 'Get lead acquisition vs conversion trend over time',
    description:
      'Returns time-series data comparing new leads (by createdAt) vs converted leads (by convertedAt) grouped by day, week, or month in Asia/Kolkata timezone.',
  })
  @ApiResponse({ status: 200, description: 'Lead trend returned successfully.' })
  async getLeadsTrend(@Query() query: QueryLeadTrendDto) {
    const data = await this.dashboardService.getLeadsTrend(query);
    return {
      success: true,
      message: 'Lead trend retrieved successfully.',
      data,
    };
  }

  @Get('leads/by-source')
  @ApiOperation({
    summary: 'Get lead metrics grouped by source',
    description:
      'Returns lead volume, converted count, and conversion rate % grouped by lead acquisition source.',
  })
  @ApiResponse({ status: 200, description: 'Leads by source returned successfully.' })
  async getLeadsBySource(@Query() query: QueryDateRangeDto) {
    const data = await this.dashboardService.getLeadsBySource(query);
    return {
      success: true,
      message: 'Leads by source retrieved successfully.',
      data,
    };
  }
}

