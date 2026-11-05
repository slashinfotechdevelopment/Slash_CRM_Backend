import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { AttendanceService } from './attendance.service';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { EndBreakDto, StartBreakDto } from './dto/start-break.dto';
import { QueryAttendanceHistoryDto } from './dto/query-attendance-history.dto';
import { RecalculateAttendanceDto } from './dto/recalculate-attendance.dto';

@ApiTags('Attendance - Lifecycle')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('check-in')
  @RequirePermissions('attendance.check_in')
  @ApiOperation({
    summary: 'Employee check-in',
    description:
      'Creates a new active attendance session using server-authoritative UTC timestamps and Asia/Kolkata date boundaries. Enforces single active session per employee and shift multi-session rules.',
  })
  @ApiResponse({ status: 201, description: 'Check-in successful.' })
  @ApiResponse({ status: 400, description: 'No active shift assigned or invalid parameters.' })
  @ApiResponse({ status: 409, description: 'Active session already exists or multi-session disallowed.' })
  async checkIn(@Body() dto: CheckInDto, @CurrentUser() actor: any) {
    return this.attendanceService.checkIn(actor.sub, dto, actor.sub);
  }

  @Post('check-out')
  @RequirePermissions('attendance.check_out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Employee check-out',
    description:
      'Concludes the active attendance session, calculates gross and net duration, and updates daily attendance record totals.',
  })
  @ApiResponse({ status: 200, description: 'Check-out successful.' })
  @ApiResponse({ status: 400, description: 'No active session found or active break ongoing.' })
  async checkOut(@Body() dto: CheckOutDto, @CurrentUser() actor: any) {
    return this.attendanceService.checkOut(actor.sub, dto, actor.sub);
  }

  @Post('breaks/start')
  @RequirePermissions('attendance.break_manage')
  @ApiOperation({
    summary: 'Start break',
    description:
      'Initiates an employee break during an active session, validating break type against shift policy snapshot.',
  })
  @ApiResponse({ status: 201, description: 'Break started.' })
  @ApiResponse({ status: 400, description: 'No active session or invalid break type.' })
  @ApiResponse({ status: 409, description: 'Another break is already active.' })
  async startBreak(@Body() dto: StartBreakDto, @CurrentUser() actor: any) {
    return this.attendanceService.startBreak(actor.sub, dto, actor.sub);
  }

  @Post('breaks/end')
  @RequirePermissions('attendance.break_manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End break',
    description:
      'Concludes the active break and chronologically allocates paid and unpaid seconds based on daily allowance.',
  })
  @ApiResponse({ status: 200, description: 'Break ended.' })
  @ApiResponse({ status: 400, description: 'No active break found to end.' })
  async endBreak(@Body() dto: EndBreakDto, @CurrentUser() actor: any) {
    return this.attendanceService.endBreak(actor.sub, dto, actor.sub);
  }

  @Get('today')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get today’s attendance status',
    description:
      'Retrieves the current employee’s live attendance status, active session, active break, and shift details for today.',
  })
  @ApiResponse({ status: 200, description: 'Today’s attendance status.' })
  async getToday(@CurrentUser() actor: any) {
    return this.attendanceService.getTodayAttendance(actor.sub);
  }

  @Get('history')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get attendance history',
    description:
      'Retrieves paginated attendance history. Employees view their own records; supervisors and administrators view records according to their data scope.',
  })
  @ApiResponse({ status: 200, description: 'Paginated attendance history.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to view requested employee history.' })
  async getHistory(
    @Query() query: QueryAttendanceHistoryDto,
    @CurrentUser() actor: any,
  ) {
    return this.attendanceService.getAttendanceHistory(
      query,
      actor.sub,
      actor.userType,
    );
  }

  @Post('records/:recordId/recalculate')
  @RequirePermissions('attendance.manage_shifts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recalculate attendance record',
    description:
      'Triggers deterministic recalculation of gross work, breaks, overtime, and final attendance status using immutable policy snapshots.',
  })
  @ApiResponse({ status: 200, description: 'Recalculation successful.' })
  @ApiResponse({ status: 403, description: 'Forbidden by data scope or permissions.' })
  @ApiResponse({ status: 404, description: 'Attendance record not found.' })
  async recalculate(
    @Param('recordId') recordId: string,
    @Body() dto: RecalculateAttendanceDto,
    @CurrentUser() actor: any,
  ) {
    return this.attendanceService.recalculateRecord(
      recordId,
      actor.sub,
      actor.userType,
      dto,
    );
  }
}

