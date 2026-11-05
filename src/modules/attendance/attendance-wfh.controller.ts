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
import { AttendanceWfhService } from './attendance-wfh.service';
import { CreateWfhRequestDto } from './dto/create-wfh-request.dto';
import { RejectWfhRequestDto } from './dto/reject-wfh-request.dto';
import { QueryWfhRequestsDto } from './dto/query-wfh-requests.dto';

@ApiTags('Attendance - Work From Home (WFH)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance/wfh')
export class AttendanceWfhController {
  constructor(private readonly wfhService: AttendanceWfhService) {}

  @Post()
  @RequirePermissions('attendance.request_wfh')
  @ApiOperation({
    summary: 'Submit a WFH request',
    description:
      'Creates a new Work-From-Home authorization request for a specified date or date range. Validates date order and prevents overlapping requests.',
  })
  @ApiResponse({ status: 201, description: 'WFH request submitted.' })
  @ApiResponse({ status: 400, description: 'Invalid date range.' })
  @ApiResponse({ status: 409, description: 'Overlapping pending or approved WFH request exists.' })
  async createRequest(
    @Body() dto: CreateWfhRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.wfhService.createRequest(actor.sub, dto, actor.sub);
  }

  @Get('my-requests')
  @RequirePermissions('attendance.request_wfh')
  @ApiOperation({
    summary: 'List own WFH requests',
    description:
      'Retrieves the authenticated employee’s own WFH requests without needing manager approval permissions.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of own WFH requests.' })
  async getMyRequests(
    @Query() query: QueryWfhRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.wfhService.getMyRequests(actor.sub, query);
  }

  @Get()
  @RequirePermissions('attendance.view_wfh')
  @ApiOperation({
    summary: 'List WFH requests (manager view)',
    description:
      'Retrieves WFH requests scoped by the manager’s effective data scope.',
  })
  @ApiResponse({ status: 200, description: 'Paginated WFH requests within data scope.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to view requested employee records.' })
  async getScopedRequests(
    @Query() query: QueryWfhRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.wfhService.getScopedRequests(
      actor.sub,
      actor.userType,
      query,
    );
  }

  @Post(':id/approve')
  @RequirePermissions('attendance.approve_wfh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve WFH request',
    description:
      'Approves a pending WFH request under Level 6 lock. Note: WFH approval authorizes remote work; it does NOT automatically create attendance sessions or mark an employee present.',
  })
  @ApiResponse({ status: 200, description: 'WFH request approved.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Self-approval is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async approveRequest(@Param('id') id: string, @CurrentUser() actor: any) {
    return this.wfhService.approveRequest(id, actor.sub, actor.userType);
  }

  @Post(':id/reject')
  @RequirePermissions('attendance.approve_wfh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject WFH request',
    description:
      'Rejects a pending WFH request under Level 6 lock. Disallows self-review.',
  })
  @ApiResponse({ status: 200, description: 'WFH request rejected.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Self-review is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async rejectRequest(
    @Param('id') id: string,
    @Body() dto: RejectWfhRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.wfhService.rejectRequest(id, actor.sub, actor.userType, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('attendance.request_wfh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel own pending WFH request',
    description:
      'Allows an employee to cancel their own pending WFH request under Level 6 lock.',
  })
  @ApiResponse({ status: 200, description: 'WFH request cancelled.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Cannot cancel another user’s request.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async cancelRequest(@Param('id') id: string, @CurrentUser() actor: any) {
    return this.wfhService.cancelRequest(id, actor.sub);
  }
}

