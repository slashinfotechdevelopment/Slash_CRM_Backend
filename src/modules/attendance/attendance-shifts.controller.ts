import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AttendanceShiftsService } from './attendance-shifts.service';
import { AttendanceAccessService } from './attendance-access.service';
import { CreateShiftDefinitionDto } from './dto/create-shift-definition.dto';
import { UpdateShiftDefinitionDto } from './dto/update-shift-definition.dto';
import {
  AssignShiftDto,
  UpdateShiftAssignmentDto,
} from './dto/assign-shift.dto';
import { QueryShiftsDto } from './dto/query-shifts.dto';
import { formatDateOnly } from './attendance.utils';

@ApiTags('Attendance - Shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('attendance/shifts')
export class AttendanceShiftsController {
  constructor(
    private readonly shiftsService: AttendanceShiftsService,
    private readonly accessService: AttendanceAccessService,
  ) {}

  @Post()
  @RequirePermissions('attendance.manage_shifts')
  @ApiOperation({
    summary: 'Create shift definition',
    description:
      'Creates a new shift definition with timing, overnight flag, grace periods, thresholds, and break policy snapshot.',
  })
  @ApiResponse({ status: 201, description: 'Shift definition successfully created.' })
  @ApiResponse({ status: 400, description: 'Invalid shift parameters or break policy configuration.' })
  @ApiResponse({ status: 409, description: 'Shift code already exists.' })
  async createShift(
    @Body() dto: CreateShiftDefinitionDto,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.createShiftDefinition(dto, actor?.sub);
  }

  @Get()
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'List shift definitions',
    description: 'Retrieves a paginated list of shift definitions with search filter.',
  })
  @ApiResponse({ status: 200, description: 'List of shift definitions.' })
  async listShifts(@Query() query: QueryShiftsDto) {
    return this.shiftsService.findAllShiftDefinitions(query);
  }

  @Get('my-assignments')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get own shift assignments',
    description: 'Returns the logged-in employee’s own shift assignments.',
  })
  @ApiResponse({ status: 200, description: 'List of own shift assignments.' })
  async getMyAssignments(@CurrentUser() actor: any) {
    return this.shiftsService.getEmployeeShiftAssignments(
      actor.sub,
      actor.sub,
      actor.userType,
    );
  }

  @Get('effective/:userId')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get effective shift for date',
    description:
      'Resolves the active shift assignment and definition for an employee on a specified calendar date (defaults to today).',
  })
  @ApiParam({ name: 'userId', description: 'Employee user ID' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Target calendar date in YYYY-MM-DD format (defaults to current date)',
  })
  @ApiResponse({ status: 200, description: 'Effective shift or null if unassigned.' })
  async getEffectiveShift(
    @Param('userId') userId: string,
    @Query('date') date?: string,
    @CurrentUser() actor?: any,
  ) {
    await this.accessService.assertSupervisorAccess(
      userId,
      actor?.sub,
      actor?.userType,
      'attendance.view',
    );
    const targetDate = date ? date : formatDateOnly(new Date());
    return this.shiftsService.getEffectiveShiftForDate(userId, targetDate);
  }

  @Get('assignments/:userId')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get employee shift assignments',
    description:
      'Retrieves all shift assignments for a specific employee, enforcing supervisor data scopes.',
  })
  @ApiParam({ name: 'userId', description: 'Target employee user ID' })
  @ApiResponse({ status: 200, description: 'List of employee shift assignments.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to view employee shifts.' })
  async getEmployeeAssignments(
    @Param('userId') userId: string,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.getEmployeeShiftAssignments(
      userId,
      actor.sub,
      actor.userType,
    );
  }

  @Post('assign')
  @RequirePermissions('attendance.manage_shifts')
  @ApiOperation({
    summary: 'Assign shift to employee',
    description:
      'Assigns a shift definition to an employee for a date range with mathematical non-overlap validation and pessimistic lock hierarchy.',
  })
  @ApiResponse({ status: 201, description: 'Shift successfully assigned.' })
  @ApiResponse({ status: 409, description: 'Shift assignment date range overlaps with an existing assignment.' })
  @ApiResponse({ status: 403, description: 'Insufficient data scope to manage shifts for target employee.' })
  async assignShift(
    @Body() dto: AssignShiftDto,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.assignShiftToEmployee(
      dto,
      actor.sub,
      actor.userType,
    );
  }

  @Patch('assignments/:assignmentId')
  @RequirePermissions('attendance.manage_shifts')
  @ApiOperation({
    summary: 'Update shift assignment',
    description:
      'Updates date range or shift definition of an existing assignment with non-overlap validation.',
  })
  @ApiParam({ name: 'assignmentId', description: 'Shift assignment ID' })
  @ApiResponse({ status: 200, description: 'Shift assignment successfully updated.' })
  @ApiResponse({ status: 409, description: 'Updated interval overlaps with another assignment.' })
  async updateAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateShiftAssignmentDto,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.updateShiftAssignment(
      assignmentId,
      dto,
      actor.sub,
      actor.userType,
    );
  }

  @Delete('assignments/:assignmentId')
  @RequirePermissions('attendance.manage_shifts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete shift assignment',
    description:
      'Deletes a shift assignment if no historical attendance records are linked to it.',
  })
  @ApiParam({ name: 'assignmentId', description: 'Shift assignment ID' })
  @ApiResponse({ status: 200, description: 'Shift assignment deleted.' })
  @ApiResponse({ status: 400, description: 'Cannot delete assignment linked to attendance records.' })
  async deleteAssignment(
    @Param('assignmentId') assignmentId: string,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.deleteShiftAssignment(
      assignmentId,
      actor.sub,
      actor.userType,
    );
  }

  @Get(':id')
  @RequirePermissions('attendance.view')
  @ApiOperation({
    summary: 'Get shift definition by ID',
    description: 'Retrieves a single shift definition with parsed break policy.',
  })
  @ApiParam({ name: 'id', description: 'Shift definition ID' })
  @ApiResponse({ status: 200, description: 'Shift definition details.' })
  @ApiResponse({ status: 404, description: 'Shift definition not found.' })
  async getShiftById(@Param('id') id: string) {
    return this.shiftsService.findShiftDefinitionById(id);
  }

  @Patch(':id')
  @RequirePermissions('attendance.manage_shifts')
  @ApiOperation({
    summary: 'Update shift definition',
    description: 'Partially updates permitted fields of a shift definition.',
  })
  @ApiParam({ name: 'id', description: 'Shift definition ID' })
  @ApiResponse({ status: 200, description: 'Updated shift definition.' })
  @ApiResponse({ status: 404, description: 'Shift definition not found.' })
  async updateShift(
    @Param('id') id: string,
    @Body() dto: UpdateShiftDefinitionDto,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.updateShiftDefinition(id, dto, actor?.sub);
  }

  @Delete(':id')
  @RequirePermissions('attendance.manage_shifts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete shift definition',
    description:
      'Deletes a shift definition if it is not currently assigned or referenced by attendance records.',
  })
  @ApiParam({ name: 'id', description: 'Shift definition ID' })
  @ApiResponse({ status: 200, description: 'Shift definition deleted.' })
  @ApiResponse({ status: 400, description: 'Cannot delete referenced shift definition.' })
  async deleteShift(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.shiftsService.deleteShiftDefinition(id, actor?.sub);
  }
}
