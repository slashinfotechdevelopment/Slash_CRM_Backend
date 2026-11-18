import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { LeaveService } from './leave.service';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { CreatePolicyVersionDto } from './dto/create-policy-version.dto';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { SyncGoogleHolidaysDto } from './dto/sync-google-holidays.dto';
import { CreateWeeklyOffPolicyDto } from './dto/create-weekly-off-policy.dto';
import { ApplyLeaveRequestDto } from './dto/apply-leave-request.dto';
import { ReviewLeaveRequestDto } from './dto/review-leave-request.dto';
import { CreateCancellationRequestDto } from './dto/create-cancellation-request.dto';
import { ReviewCancellationRequestDto } from './dto/review-cancellation-request.dto';
import { AdjustLeaveBalanceDto } from './dto/adjust-leave-balance.dto';
import {
  QueryHolidaysDto,
  QueryLeaveBalancesDto,
  QueryLeaveCalendarDto,
  QueryLeaveReportDto,
  QueryLeaveRequestsDto,
  QueryLeaveTransactionsDto,
  QueryWeeklyOffPoliciesDto,
} from './dto/query-leave.dto';

@ApiTags('Leave Management')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('leave')
export class LeaveController {
  constructor(private readonly leaveService: LeaveService) {}

  // =========================================================================
  // LEAVE TYPES & POLICIES
  // =========================================================================

  @Post('types')
  @RequirePermissions('leave.manage_types')
  @ApiOperation({ summary: 'Create a new leave type with initial policy version' })
  @ApiResponse({ status: 201, description: 'Leave type created successfully.' })
  async createLeaveType(
    @Body() dto: CreateLeaveTypeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.createLeaveType(dto, user.sub);
    return {
      success: true,
      message: 'Leave type created successfully.',
      data,
    };
  }

  @Get('types')
  @ApiOperation({ summary: 'List all leave types with current active policy version' })
  @ApiResponse({ status: 200, description: 'Leave types retrieved successfully.' })
  async getLeaveTypes(@Query('includeInactive') includeInactive?: boolean) {
    const data = await this.leaveService.getLeaveTypes(includeInactive);
    return {
      success: true,
      message: 'Leave types retrieved successfully.',
      data,
    };
  }

  @Get('types/:id')
  @ApiOperation({ summary: 'Get single leave type by ID with all policy versions' })
  @ApiResponse({ status: 200, description: 'Leave type retrieved successfully.' })
  async getLeaveTypeById(@Param('id') id: string) {
    const data = await this.leaveService.getLeaveTypeById(id);
    return {
      success: true,
      message: 'Leave type retrieved successfully.',
      data,
    };
  }

  @Patch('types/:id')
  @RequirePermissions('leave.manage_types')
  @ApiOperation({ summary: 'Update leave type metadata' })
  @ApiResponse({ status: 200, description: 'Leave type updated successfully.' })
  async updateLeaveType(
    @Param('id') id: string,
    @Body() dto: UpdateLeaveTypeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.updateLeaveType(id, dto, user.sub);
    return {
      success: true,
      message: 'Leave type updated successfully.',
      data,
    };
  }

  @Post('types/:id/versions')
  @RequirePermissions('leave.manage_policies')
  @ApiOperation({ summary: 'Create a new policy version for an existing leave type' })
  @ApiResponse({ status: 201, description: 'Policy version created successfully.' })
  async createPolicyVersion(
    @Param('id') id: string,
    @Body() dto: CreatePolicyVersionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.createPolicyVersion(id, dto, user.sub);
    return {
      success: true,
      message: 'Policy version created successfully.',
      data,
    };
  }

  // =========================================================================
  // HOLIDAYS & WEEKLY-OFF POLICIES
  // =========================================================================

  @Post('holidays')
  @RequirePermissions('leave.manage_holidays')
  @ApiOperation({ summary: 'Create a holiday with deterministic scope' })
  @ApiResponse({ status: 201, description: 'Holiday created successfully.' })
  async createHoliday(
    @Body() dto: CreateHolidayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.createHoliday(dto, user.sub);
    return {
      success: true,
      message: 'Holiday created successfully.',
      data,
    };
  }

  @Get('holidays')
  @ApiOperation({ summary: 'List holidays filtered by year and scope with 1-click Google Calendar links' })
  @ApiResponse({ status: 200, description: 'Holidays retrieved successfully.' })
  async getHolidays(@Query() query: QueryHolidaysDto) {
    const data = await this.leaveService.getHolidays(query);
    return {
      success: true,
      message: 'Holidays retrieved successfully.',
      data,
    };
  }

  @Get('holidays/calendar.ics')
  @ApiOperation({ summary: 'Export public company holidays as iCalendar (.ics) for Google Calendar synchronization' })
  @ApiResponse({ status: 200, description: 'iCalendar feed returned for Google Calendar subscription.' })
  async getHolidaysIcsFeed(
    @Query('year') year: string,
    @Res() res: Response,
  ) {
    const parsedYear = year ? parseInt(year, 10) : undefined;
    const icsContent = await this.leaveService.getHolidaysIcsFeed(parsedYear);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="company-holidays.ics"');
    res.send(icsContent);
  }

  @Post('holidays/sync-google-calendar')
  @RequirePermissions('leave.manage_holidays')
  @ApiOperation({ summary: 'Synchronize / populate standard government gazetted holidays for a year' })
  @ApiResponse({ status: 200, description: 'Government holidays synchronized successfully.' })
  async syncGoogleCalendarHolidays(
    @Body() dto: SyncGoogleHolidaysDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.leaveService.syncGoogleCalendarHolidays(dto, user.sub);
    return {
      success: true,
      message: result.message,
      data: result,
    };
  }

  @Patch('holidays/:id')
  @RequirePermissions('leave.manage_holidays')
  @ApiOperation({ summary: 'Customize, update, or pass/toggle status of an existing holiday' })
  @ApiResponse({ status: 200, description: 'Holiday updated successfully.' })
  @ApiResponse({ status: 404, description: 'Holiday not found.' })
  async updateHoliday(
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.updateHoliday(id, dto, user.sub);
    return {
      success: true,
      message: `Holiday "${data.name}" updated successfully.`,
      data,
    };
  }

  @Delete('holidays/:id')
  @RequirePermissions('leave.manage_holidays')
  @ApiOperation({ summary: 'Delete a holiday' })
  @ApiResponse({ status: 200, description: 'Holiday deleted successfully.' })
  async deleteHoliday(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.deleteHoliday(id, user.sub);
    return {
      success: true,
      message: data.message,
      data: null,
    };
  }

  @Post('weekly-off-policies')
  @RequirePermissions('leave.manage_weekly_offs')
  @ApiOperation({ summary: 'Create a weekly-off policy' })
  @ApiResponse({ status: 201, description: 'Weekly-off policy created successfully.' })
  async createWeeklyOffPolicy(
    @Body() dto: CreateWeeklyOffPolicyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.createWeeklyOffPolicy(dto, user.sub);
    return {
      success: true,
      message: 'Weekly-off policy created successfully.',
      data,
    };
  }

  @Get('weekly-off-policies')
  @ApiOperation({ summary: 'List weekly-off policies' })
  @ApiResponse({ status: 200, description: 'Weekly-off policies retrieved successfully.' })
  async getWeeklyOffPolicies(@Query() query: QueryWeeklyOffPoliciesDto) {
    const data = await this.leaveService.getWeeklyOffPolicies(query);
    return {
      success: true,
      message: 'Weekly-off policies retrieved successfully.',
      data,
    };
  }

  // =========================================================================
  // LEAVE APPLICATIONS & WORKFLOW
  // =========================================================================

  @Post('requests')
  @RequirePermissions('leave.apply')
  @ApiOperation({ summary: 'Apply for leave with pessimistic locking and ledger logging' })
  @ApiResponse({ status: 201, description: 'Leave request submitted successfully.' })
  async applyLeaveRequest(
    @Body() dto: ApplyLeaveRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.applyLeaveRequest(dto, user.sub);
    return {
      success: true,
      message: 'Leave request submitted successfully.',
      data,
    };
  }

  @Get('requests/my')
  @ApiOperation({ summary: 'List current user leave requests' })
  @ApiResponse({ status: 200, description: 'User leave requests retrieved successfully.' })
  async getMyLeaveRequests(
    @Query() query: QueryLeaveRequestsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    query.userId = user.sub;
    const data = await this.leaveService.getLeaveRequests(query);
    return {
      success: true,
      message: 'My leave requests retrieved successfully.',
      data,
    };
  }

  @Get('requests')
  @RequirePermissions('leave.view_requests')
  @ApiOperation({ summary: 'List all leave requests with filters (HR / Manager)' })
  @ApiResponse({ status: 200, description: 'Leave requests retrieved successfully.' })
  async getLeaveRequests(@Query() query: QueryLeaveRequestsDto) {
    const data = await this.leaveService.getLeaveRequests(query);
    return {
      success: true,
      message: 'Leave requests retrieved successfully.',
      data,
    };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'Get single leave request details, approvals, and transactions' })
  @ApiResponse({ status: 200, description: 'Leave request details retrieved successfully.' })
  async getLeaveRequestById(@Param('id') id: string) {
    const data = await this.leaveService.getLeaveRequestById(id);
    return {
      success: true,
      message: 'Leave request retrieved successfully.',
      data,
    };
  }

  @Post('requests/:id/review')
  @RequirePermissions('leave.approve')
  @ApiOperation({ summary: 'Approve or reject a pending leave request' })
  @ApiResponse({ status: 200, description: 'Leave request decision recorded successfully.' })
  async reviewLeaveRequest(
    @Param('id') id: string,
    @Body() dto: ReviewLeaveRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.reviewLeaveRequest(id, dto, user.sub);
    return {
      success: true,
      message: `Leave request ${dto.decision.toLowerCase()} successfully.`,
      data,
    };
  }

  @Post('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel pending leave or request cancellation for approved leave' })
  @ApiResponse({ status: 200, description: 'Leave cancellation processed.' })
  async cancelLeaveRequest(
    @Param('id') id: string,
    @Body() dto: CreateCancellationRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.cancelLeaveRequest(id, dto, user.sub);
    return {
      success: true,
      message: data.message,
      data,
    };
  }

  @Post('cancellations/:id/review')
  @RequirePermissions('leave.approve')
  @ApiOperation({ summary: 'Review and approve/reject cancellation of an approved leave' })
  @ApiResponse({ status: 200, description: 'Cancellation review recorded.' })
  async reviewCancellationRequest(
    @Param('id') id: string,
    @Body() dto: ReviewCancellationRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.reviewCancellationRequest(id, dto, user.sub);
    return {
      success: true,
      message: `Cancellation request ${dto.decision.toLowerCase()} successfully.`,
      data,
    };
  }

  // =========================================================================
  // LEAVE BALANCES & AUDIT LEDGER
  // =========================================================================

  @Get('balances/my')
  @ApiOperation({ summary: 'Get current user leave balances for fiscal year' })
  @ApiResponse({ status: 200, description: 'Leave balances retrieved successfully.' })
  async getMyBalances(
    @Query('year') yearStr: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
    const data = await this.leaveService.getEmployeeBalances(user.sub, year);
    return {
      success: true,
      message: 'My leave balances retrieved successfully.',
      data,
    };
  }

  @Get('balances')
  @RequirePermissions('leave.view_balances')
  @ApiOperation({ summary: 'Get leave balances for any employee (HR / Manager)' })
  @ApiResponse({ status: 200, description: 'Employee balances retrieved successfully.' })
  async getEmployeeBalances(@Query() query: QueryLeaveBalancesDto) {
    if (!query.userId) {
      const summary = await this.leaveService.getLeaveReportSummary({ year: query.year });
      return {
        success: true,
        message: 'Leave balances retrieved successfully.',
        data: summary,
      };
    }
    const data = await this.leaveService.getEmployeeBalances(query.userId, query.year);
    return {
      success: true,
      message: 'Employee leave balances retrieved successfully.',
      data,
    };
  }

  @Post('balances/adjust')
  @RequirePermissions('leave.adjust_balances')
  @ApiOperation({ summary: 'Manual leave balance adjustment with full 6-bucket audit ledger' })
  @ApiResponse({ status: 200, description: 'Leave balance adjusted successfully.' })
  async adjustLeaveBalance(
    @Body() dto: AdjustLeaveBalanceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = await this.leaveService.adjustLeaveBalance(dto, user.sub);
    return {
      success: true,
      message: 'Leave balance adjusted successfully.',
      data,
    };
  }

  @Get('transactions')
  @RequirePermissions('leave.view_balances')
  @ApiOperation({ summary: 'Query immutable 6-bucket leave transaction audit ledger' })
  @ApiResponse({ status: 200, description: 'Leave transactions retrieved successfully.' })
  async getTransactions(@Query() query: QueryLeaveTransactionsDto) {
    const data = await this.leaveService.getTransactions(query);
    return {
      success: true,
      message: 'Leave transactions retrieved successfully.',
      data,
    };
  }

  // =========================================================================
  // CALENDAR & REPORTS
  // =========================================================================

  @Get('calendar')
  @ApiOperation({ summary: 'Leave calendar view: see who is on leave on any date' })
  @ApiResponse({ status: 200, description: 'Leave calendar retrieved successfully.' })
  async getLeaveCalendar(@Query() query: QueryLeaveCalendarDto) {
    const data = await this.leaveService.getLeaveCalendar(query);
    return {
      success: true,
      message: 'Leave calendar retrieved successfully.',
      data,
    };
  }

  @Get('reports/summary')
  @RequirePermissions('leave.view_reports')
  @ApiOperation({ summary: 'Leave consumption and balance reports across organization' })
  @ApiResponse({ status: 200, description: 'Leave report summary retrieved successfully.' })
  async getLeaveReportSummary(@Query() query: QueryLeaveReportDto) {
    const data = await this.leaveService.getLeaveReportSummary(query);
    return {
      success: true,
      message: 'Leave report summary retrieved successfully.',
      data,
    };
  }
}

