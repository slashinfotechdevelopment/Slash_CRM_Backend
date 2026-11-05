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
import { AttendanceReconciliationService } from './attendance-reconciliation.service';
import { TriggerReconciliationDto } from './dto/trigger-reconciliation.dto';
import { QueryReconciliationRunsDto } from './dto/query-reconciliation-runs.dto';
import { QueryAnomaliesDto } from './dto/query-anomalies.dto';
import { ResolveAnomalyDto } from './dto/resolve-anomaly.dto';
import { QueryReconciliationStatusDto } from './dto/query-reconciliation-status.dto';

@ApiTags('Attendance - EOD Reconciliation & Anomaly Quarantine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance')
export class AttendanceReconciliationController {
  constructor(
    private readonly reconciliationService: AttendanceReconciliationService,
  ) {}

  @Post('reconciliation/run')
  @RequirePermissions('attendance.reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger or execute authorized attendance reconciliation',
    description:
      'Performs EOD attendance reconciliation for target date respecting shift end time + grace period cutoffs and quarantine rules.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation run completed or recorded.',
  })
  @ApiResponse({
    status: 400,
    description: 'Before-cutoff trigger rejected or invalid date format.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden: actor lacks attendance.reconcile permission.',
  })
  async triggerReconciliation(
    @Body() dto: TriggerReconciliationDto,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.executeReconciliation(
      dto,
      actor.sub,
      actor.userType,
    );
  }

  @Get('reconciliation/runs')
  @RequirePermissions('attendance.reconcile')
  @ApiOperation({
    summary: 'List reconciliation runs with pagination and filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of reconciliation runs.',
  })
  async listRuns(
    @Query() query: QueryReconciliationRunsDto,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.listRuns(
      query,
      actor.sub,
      actor.userType,
    );
  }

  @Get('reconciliation/runs/:id')
  @RequirePermissions('attendance.reconcile')
  @ApiOperation({
    summary: 'View reconciliation run details and processed record summary',
  })
  @ApiResponse({
    status: 200,
    description: 'Detailed reconciliation run metadata and records.',
  })
  @ApiResponse({ status: 404, description: 'Reconciliation run not found.' })
  async getRunDetails(
    @Param('id') runId: string,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.getRunDetails(
      runId,
      actor.sub,
      actor.userType,
    );
  }

  @Get('reconciliation/status')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Query reconciliation and anomaly status for employee and date',
  })
  @ApiResponse({
    status: 200,
    description: 'Current reconciliation status for employee and date.',
  })
  async getReconciliationStatus(
    @Query() query: QueryReconciliationStatusDto,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.getReconciliationStatus(
      query.userId,
      query.date,
      actor.sub,
      actor.userType,
    );
  }

  @Get('anomalies')
  @RequirePermissions('attendance.view_anomalies')
  @ApiOperation({
    summary: 'List quarantined attendance anomalies with filters and pagination',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of quarantined anomalies within data scope.',
  })
  async listAnomalies(
    @Query() query: QueryAnomaliesDto,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.listAnomalies(
      query,
      actor.sub,
      actor.userType,
    );
  }

  @Get('anomalies/:recordId')
  @RequirePermissions('attendance.view_anomalies')
  @ApiOperation({
    summary: 'View detailed anomaly information for a single attendance record',
  })
  @ApiResponse({
    status: 200,
    description: 'Detailed anomaly breakdown, sessions, breaks, and shifts.',
  })
  @ApiResponse({
    status: 404,
    description: 'Attendance record or anomaly not found.',
  })
  async getAnomalyDetails(
    @Param('recordId') recordId: string,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.getAnomalyDetails(
      recordId,
      actor.sub,
      actor.userType,
    );
  }

  @Post('anomalies/:recordId/resolve')
  @RequirePermissions('attendance.resolve_incident')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve or dismiss a quarantined attendance anomaly',
    description:
      'Resolves or dismisses an anomaly with mandatory justification notes, Anti-Self-Resolution check, and audit trail.',
  })
  @ApiResponse({
    status: 200,
    description: 'Anomaly successfully resolved or dismissed.',
  })
  @ApiResponse({
    status: 400,
    description: 'Record does not have an active anomaly or invalid notes.',
  })
  @ApiResponse({
    status: 403,
    description: 'Anti-Self-Resolution violation or out-of-scope employee.',
  })
  @ApiResponse({
    status: 404,
    description: 'Attendance record not found.',
  })
  async resolveAnomaly(
    @Param('recordId') recordId: string,
    @Body() dto: ResolveAnomalyDto,
    @CurrentUser() actor: any,
  ) {
    return this.reconciliationService.resolveAnomaly(
      recordId,
      dto,
      actor.sub,
      actor.userType,
    );
  }
}
