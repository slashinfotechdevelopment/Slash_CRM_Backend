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
import { AttendanceOvertimeService } from './attendance-overtime.service';
import { CreateOvertimeRequestDto } from './dto/create-overtime-request.dto';
import { ApproveOvertimeRequestDto } from './dto/approve-overtime-request.dto';
import { RejectOvertimeRequestDto } from './dto/reject-overtime-request.dto';
import { QueryOvertimeRequestsDto } from './dto/query-overtime-requests.dto';

@ApiTags('Attendance - Overtime Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance/overtime')
export class AttendanceOvertimeController {
  constructor(
    private readonly overtimeService: AttendanceOvertimeService,
  ) {}

  @Post()
  @RequirePermissions('attendance.request_overtime')
  @ApiOperation({
    summary: 'Submit an overtime request',
    description:
      'Creates a new overtime authorization request with interval validation and overtime limit enforcement.',
  })
  @ApiResponse({ status: 201, description: 'Overtime request submitted.' })
  @ApiResponse({ status: 400, description: 'Invalid intervals or exceeds limit without override permission.' })
  @ApiResponse({ status: 409, description: 'Overlapping pending or approved request exists.' })
  async createRequest(
    @Body() dto: CreateOvertimeRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.overtimeService.createRequest(
      actor.sub,
      dto,
      actor.sub,
      actor.userType,
    );
  }

  @Get('my-requests')
  @RequirePermissions('attendance.request_overtime')
  @ApiOperation({
    summary: 'List own overtime requests',
    description:
      'Retrieves the authenticated employee’s own overtime requests without needing manager approval permissions.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of own overtime requests.' })
  async getMyRequests(
    @Query() query: QueryOvertimeRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.overtimeService.getMyRequests(actor.sub, query);
  }

  @Get()
  @RequirePermissions('attendance.view_overtime')
  @ApiOperation({
    summary: 'List overtime requests (manager view)',
    description:
      'Retrieves overtime requests filtered by the manager’s effective data scope.',
  })
  @ApiResponse({ status: 200, description: 'Paginated overtime requests within data scope.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to view requested employee records.' })
  async getScopedRequests(
    @Query() query: QueryOvertimeRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.overtimeService.getScopedRequests(
      actor.sub,
      actor.userType,
      query,
    );
  }

  @Post(':id/approve')
  @RequirePermissions('attendance.approve_overtime')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve overtime request',
    description:
      'Authorizes an overtime window under Level 5 locks and triggers deterministic recalculation if an attendance record exists. Disallows self-approval.',
  })
  @ApiResponse({ status: 200, description: 'Overtime request approved.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Self-approval is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async approveRequest(
    @Param('id') id: string,
    @Body() dto: ApproveOvertimeRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.overtimeService.approveRequest(
      id,
      actor.sub,
      actor.userType,
      dto,
    );
  }

  @Post(':id/reject')
  @RequirePermissions('attendance.approve_overtime')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject overtime request',
    description:
      'Rejects a pending overtime request under Level 5 locks. Disallows self-review.',
  })
  @ApiResponse({ status: 200, description: 'Overtime request rejected.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Self-review is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async rejectRequest(
    @Param('id') id: string,
    @Body() dto: RejectOvertimeRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.overtimeService.rejectRequest(
      id,
      actor.sub,
      actor.userType,
      dto,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('attendance.request_overtime')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel own pending overtime request',
    description:
      'Allows an employee to cancel their own pending overtime request under Level 5 lock.',
  })
  @ApiResponse({ status: 200, description: 'Overtime request cancelled.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Cannot cancel another user’s request.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async cancelRequest(@Param('id') id: string, @CurrentUser() actor: any) {
    return this.overtimeService.cancelRequest(id, actor.sub);
  }
}

