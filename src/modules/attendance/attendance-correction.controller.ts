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
import { AttendanceCorrectionService } from './attendance-correction.service';
import { CreateCorrectionRequestDto } from './dto/create-correction-request.dto';
import { ApproveCorrectionRequestDto } from './dto/approve-correction-request.dto';
import { RejectCorrectionRequestDto } from './dto/reject-correction-request.dto';
import { QueryCorrectionRequestsDto } from './dto/query-correction-requests.dto';

@ApiTags('Attendance - Correction Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance/corrections')
export class AttendanceCorrectionController {
  constructor(
    private readonly correctionService: AttendanceCorrectionService,
  ) {}

  @Post()
  @RequirePermissions('attendance.correct_own')
  @ApiOperation({
    summary: 'Submit an attendance correction request',
    description:
      'Creates a new attendance correction request with timestamp and session validation. Never mutates attendance directly.',
  })
  @ApiResponse({ status: 201, description: 'Correction request submitted successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid timestamps or session mismatch.' })
  @ApiResponse({ status: 409, description: 'A pending correction request already exists for this session.' })
  async createRequest(
    @Body() dto: CreateCorrectionRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.createRequest(actor.sub, dto, actor.sub);
  }

  @Get('my-requests')
  @RequirePermissions('attendance.correct_own')
  @ApiOperation({
    summary: 'List own attendance correction requests',
    description:
      'Retrieves the authenticated employee’s own correction requests and dispute history without requiring manager approval permissions.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of own correction requests.' })
  async getMyRequests(
    @Query() query: QueryCorrectionRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.getMyRequests(actor.sub, query);
  }

  @Get()
  @RequirePermissions('attendance.review_correction')
  @ApiOperation({
    summary: 'List correction requests (manager view)',
    description:
      'Retrieves correction requests scoped by the manager’s effective data scope.',
  })
  @ApiResponse({ status: 200, description: 'Paginated correction requests within data scope.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to view requested employee records.' })
  async getScopedRequests(
    @Query() query: QueryCorrectionRequestsDto,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.getScopedRequests(
      actor.sub,
      actor.userType,
      query,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get details of an attendance correction request',
    description:
      'Retrieves full details including original timestamps, requested corrections, manager notes, and evidence verification status.',
  })
  @ApiResponse({ status: 200, description: 'Correction request details.' })
  @ApiResponse({ status: 403, description: 'Forbidden if not request owner or authorized supervisor.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  async getRequestById(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.getRequestById(
      id,
      actor.sub,
      actor.userType,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions('attendance.correct_own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an attendance correction request',
    description: 'Allows an employee to cancel their own pending correction request.',
  })
  @ApiResponse({ status: 200, description: 'Correction request cancelled.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Forbidden if not the submitting employee.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  async cancelRequest(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.cancelRequest(id, actor.sub);
  }

  @Post(':id/approve')
  @RequirePermissions('attendance.approve_correction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve an attendance correction request',
    description:
      'Applies the requested corrections under the 8-level lock hierarchy, records evidence verification, and triggers deterministic recalculation. Disallows self-approval.',
  })
  @ApiResponse({ status: 200, description: 'Correction request approved and applied.' })
  @ApiResponse({ status: 400, description: 'Request no longer pending or causes session overlap.' })
  @ApiResponse({ status: 403, description: 'Self-approval is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  async approveRequest(
    @Param('id') id: string,
    @Body() dto: ApproveCorrectionRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.approveRequest(
      id,
      actor.sub,
      actor.userType,
      dto,
    );
  }

  @Post(':id/reject')
  @RequirePermissions('attendance.approve_correction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject an attendance correction request',
    description:
      'Rejects a pending correction request under Level 4 lock and records evidence verification outcome with mandatory manager justification. Strictly does not modify attendance records.',
  })
  @ApiResponse({ status: 200, description: 'Correction request rejected.' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending.' })
  @ApiResponse({ status: 403, description: 'Self-review is strictly prohibited or outside data scope.' })
  @ApiResponse({ status: 404, description: 'Correction request not found.' })
  async rejectRequest(
    @Param('id') id: string,
    @Body() dto: RejectCorrectionRequestDto,
    @CurrentUser() actor: any,
  ) {
    return this.correctionService.rejectRequest(
      id,
      actor.sub,
      actor.userType,
      dto,
    );
  }
}

