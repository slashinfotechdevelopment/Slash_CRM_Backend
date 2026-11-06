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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { getTaskAttachmentMulterOptions } from './storage/multer-task-attachment.config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  RequirePermissions,
  RequireAnyPermissions,
} from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { TasksService } from './tasks.service';
import { TasksTimerService } from './tasks-timer.service';
import { TasksWorkflowService } from './tasks-workflow.service';
import { TasksReportsService } from './tasks-reports.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { QueryMyTasksDto } from './dto/query-my-tasks.dto';
import { CreateTaskTagDto } from './dto/create-task-tag.dto';
import { PlayTaskTimerDto } from './dto/play-task-timer.dto';
import { PauseTaskTimerDto } from './dto/pause-task-timer.dto';
import { ResumeTaskTimerDto } from './dto/resume-task-timer.dto';
import { StopTaskTimerDto } from './dto/stop-task-timer.dto';
import { QueryTaskTimeEntriesDto } from './dto/query-task-time-entries.dto';
import { QueryTaskTimeSummaryDto } from './dto/query-task-time-summary.dto';
import { QueryMyTimeSummaryDto } from './dto/query-my-time-summary.dto';
import { SubmitTaskDto } from './dto/submit-task.dto';
import { ApproveTaskReviewDto } from './dto/approve-task-review.dto';
import { RequestChangesDto } from './dto/request-changes.dto';
import { RejectTaskReviewDto } from './dto/reject-task-review.dto';
import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { QueryTaskCommentsDto } from './dto/query-task-comments.dto';
import { CreateTaskAttachmentDto } from './dto/create-task-attachment.dto';
import { QueryTaskDashboardDto } from './dto/query-task-dashboard.dto';
import { QueryTaskSummaryReportDto } from './dto/query-task-summary-report.dto';
import { QueryWorkingHoursReportDto } from './dto/query-working-hours-report.dto';
import { QueryEmployeePerformanceReportDto } from './dto/query-employee-performance-report.dto';
import { QueryOverdueTasksReportDto } from './dto/query-overdue-tasks-report.dto';
import { QueryReviewSummaryReportDto } from './dto/query-review-summary-report.dto';

@ApiTags('Employee Task Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly tasksTimerService: TasksTimerService,
    private readonly tasksWorkflowService: TasksWorkflowService,
    private readonly tasksReportsService: TasksReportsService,
  ) {}

  @Post()
  @RequirePermissions('tasks.create')
  @ApiOperation({
    summary: 'Create a new task',
    description:
      'Creates a new task with an automatically generated atomic task code (e.g. TASK001). For self-assigned tasks, department derives from the creator. For assigned tasks, department derives from the target assignee.',
  })
  @ApiResponse({ status: 201, description: 'Task created successfully.' })
  @ApiResponse({ status: 400, description: 'Validation failure or invalid department/dates.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions to create or assign task.' })
  async createTask(
    @Body() dto: CreateTaskDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.createTask(actor.sub, actor.userType, dto);
  }

  @Get()
  @RequirePermissions('tasks.view')
  @ApiOperation({
    summary: 'List tasks with search, pagination, and multi-dimensional filters',
    description:
      'Retrieves tasks visible to the authenticated user based on role data scope (OWN, ASSIGNED, DEPARTMENT, ALL) and user-type ceilings. Excludes soft-deleted tasks.',
  })
  @ApiResponse({ status: 200, description: 'Paginated task list returned.' })
  @ApiResponse({ status: 403, description: 'Access denied or unsupported data scope.' })
  async findTasks(
    @Query() query: QueryTasksDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.findTasks(actor.sub, actor.userType, query);
  }

  @Get('my-tasks')
  @RequirePermissions('tasks.view_own')
  @ApiOperation({
    summary: 'List personal tasks assigned to the current user',
    description:
      'Convenience endpoint returning tasks where assigneeId matches the authenticated user, supporting search, status filters, and pagination.',
  })
  @ApiResponse({ status: 200, description: 'User personal task list returned.' })
  async findMyTasks(
    @Query() query: QueryMyTasksDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.findMyTasks(actor.sub, actor.userType, query);
  }

  @Get('tags')
  @RequireAnyPermissions('tasks.view', 'tasks.manage_tags')
  @ApiOperation({
    summary: 'List task tags',
    description: 'Retrieves all task taxonomy tags along with task association counts.',
  })
  @ApiResponse({ status: 200, description: 'List of task tags returned.' })
  async listTags() {
    return this.tasksService.listTags();
  }

  @Post('tags')
  @RequirePermissions('tasks.manage_tags')
  @ApiOperation({
    summary: 'Create or update a task tag',
    description: 'Creates a taxonomy tag with a unique name and optional color badge.',
  })
  @ApiResponse({ status: 201, description: 'Tag created successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid tag name.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  async createTag(@Body() dto: CreateTaskTagDto) {
    return this.tasksService.createTag(dto);
  }

  @Delete('tags/:tagId')
  @RequirePermissions('tasks.manage_tags')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a task tag',
    description: 'Deletes a taxonomy tag and cascade-removes associations from tasks.',
  })
  @ApiParam({ name: 'tagId', description: 'Tag ID to delete' })
  @ApiResponse({ status: 200, description: 'Tag deleted successfully.' })
  @ApiResponse({ status: 404, description: 'Tag not found.' })
  async deleteTag(@Param('tagId') tagId: string) {
    return this.tasksService.deleteTag(tagId);
  }

  @Get('timer/active')
  @RequirePermissions('tasks.timer.view_active')
  @ApiOperation({
    summary: 'Get active task timer',
    description:
      'Retrieves the authenticated employee’s currently running task timer or active open pause, with server-computed live elapsed seconds.',
  })
  @ApiResponse({ status: 200, description: 'Active timer status returned.' })
  async getActiveTimer(@CurrentUser() actor: any) {
    return this.tasksTimerService.getActiveTimer(actor.sub, actor.userType);
  }

  @Get('my-time-summary')
  @RequireAnyPermissions('tasks.time.view_own', 'tasks.time.view_summary')
  @ApiOperation({
    summary: 'Get personal working time summary',
    description:
      'Aggregates total actual working time, pause duration, daily breakdown (split across Asia/Kolkata midnight boundaries), and task-wise distribution for the authenticated employee.',
  })
  @ApiResponse({ status: 200, description: 'Personal time summary returned.' })
  async getMyTimeSummary(
    @Query() query: QueryMyTimeSummaryDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.getMyTimeSummary(actor.sub, query, actor.userType);
  }

  // ===========================================================================
  // PHASE 6.3.5: DASHBOARD & REPORTING APIS
  // ===========================================================================

  @Get('dashboard/my')
  @RequireAnyPermissions('dashboard.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'Get employee personal task dashboard',
    description:
      'Retrieves personal status breakdowns across all 7 statuses, deadline counts (overdue, due today, upcoming in Asia/Kolkata), active timer status, today’s working/paused durations, and recent activity.',
  })
  @ApiResponse({ status: 200, description: 'Personal dashboard data returned.' })
  @ApiResponse({ status: 403, description: 'Client users forbidden.' })
  async getEmployeeDashboard(
    @Query() query: QueryTaskDashboardDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getEmployeeDashboard(actor.sub, actor.userType, query);
  }

  @Get('dashboard/team')
  @RequireAnyPermissions('reports.view', 'tasks.view')
  @ApiOperation({
    summary: 'Get manager/department task dashboard',
    description:
      'Aggregates team tasks by status, priority, and deadlines within authorized departments or subordinate hierarchy. Includes live active timer roster.',
  })
  @ApiResponse({ status: 200, description: 'Team dashboard data returned.' })
  @ApiResponse({ status: 403, description: 'Requires departmental or administrative scope.' })
  async getTeamDashboard(
    @Query() query: QueryTaskDashboardDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getTeamDashboard(actor.sub, actor.userType, query);
  }

  @Get('dashboard/organization')
  @RequirePermissions('reports.view')
  @ApiOperation({
    summary: 'Get organization-wide task dashboard',
    description:
      'Provides high-level organizational task metrics, department-wise distribution, overdue SLA tracking, and 30-day completion trends. Restricted to Admins.',
  })
  @ApiResponse({ status: 200, description: 'Organization dashboard data returned.' })
  @ApiResponse({ status: 403, description: 'Requires administrative privileges.' })
  async getOrganizationDashboard(
    @Query() query: QueryTaskDashboardDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getOrganizationDashboard(actor.sub, actor.userType, query);
  }

  @Get('reports/summary')
  @RequireAnyPermissions('reports.view', 'tasks.view')
  @ApiOperation({
    summary: 'Get task volume & status summary report',
    description:
      'Generates task count summaries grouped by status and priority with completion percentage (excluding cancelled tasks from denominator). Supports historical completion tracking via status transition logs.',
  })
  @ApiResponse({ status: 200, description: 'Summary report returned.' })
  async getTaskSummaryReport(
    @Query() query: QueryTaskSummaryReportDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getTaskSummaryReport(actor.sub, actor.userType, query);
  }

  @Get('reports/working-hours')
  @RequireAnyPermissions('tasks.time.view', 'tasks.time.view_summary', 'reports.view')
  @ApiOperation({
    summary: 'Get employee working hours and pauses report',
    description:
      'Detailed report grouped by employee and date. Excludes pause durations, splits intervals at Asia/Kolkata midnight boundaries (18:30 UTC), and provides task-wise breakdowns.',
  })
  @ApiResponse({ status: 200, description: 'Working hours report returned.' })
  @ApiResponse({ status: 403, description: 'Cannot view unauthorized employee hours.' })
  async getWorkingHoursReport(
    @Query() query: QueryWorkingHoursReportDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getWorkingHoursReport(actor.sub, actor.userType, query);
  }

  @Get('reports/employee-performance')
  @RequireAnyPermissions('reports.view', 'tasks.view')
  @ApiOperation({
    summary: 'Get employee task performance report',
    description:
      'Factual throughput report per employee: assigned, completed, pending, overdue counts, completion percentage, and total tracked hours. Zero subjective rankings.',
  })
  @ApiResponse({ status: 200, description: 'Performance report returned.' })
  @ApiResponse({ status: 403, description: 'Requires departmental or administrative scope.' })
  async getEmployeePerformanceReport(
    @Query() query: QueryEmployeePerformanceReportDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getEmployeePerformanceReport(actor.sub, actor.userType, query);
  }

  @Get('reports/overdue')
  @RequireAnyPermissions('reports.view', 'tasks.view')
  @ApiOperation({
    summary: 'Get active overdue tasks report',
    description:
      'Paginated list of active overdue tasks (excluding completed and cancelled), calculating exact days overdue past Asia/Kolkata calendar due dates.',
  })
  @ApiResponse({ status: 200, description: 'Overdue tasks report returned.' })
  async getOverdueTasksReport(
    @Query() query: QueryOverdueTasksReportDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getOverdueTasksReport(actor.sub, actor.userType, query);
  }

  @Get('reports/reviews')
  @RequireAnyPermissions('reports.view', 'tasks.review', 'tasks.approve')
  @ApiOperation({
    summary: 'Get task review summary & turnaround report',
    description:
      'Summarizes review outcomes (pending, approved, changes requested, rejected), reviewer pending counts, and average review turnaround duration.',
  })
  @ApiResponse({ status: 200, description: 'Review summary report returned.' })
  @ApiResponse({ status: 403, description: 'Requires departmental or administrative scope.' })
  async getReviewSummaryReport(
    @Query() query: QueryReviewSummaryReportDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksReportsService.getReviewSummaryReport(actor.sub, actor.userType, query);
  }

  @Get(':id')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'Get task details by ID',
    description:
      'Retrieves complete task details including relations and recent history if the task is within the actor’s permitted visibility.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task details returned.' })
  @ApiResponse({ status: 404, description: 'Task not found or access denied.' })
  async findTaskById(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.findTaskById(id, actor.sub, actor.userType);
  }

  @Post(':id/timer/play')
  @RequirePermissions('tasks.timer.play')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start or resume working on a task',
    description:
      'Starts an immutable work interval on the specified task. Automatically pauses any other running task for this employee with reason TASK_SWITCH. If task is in TODO status, advances to IN_PROGRESS.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Timer started successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot start timer on completed or cancelled task.' })
  @ApiResponse({ status: 403, description: 'You can only operate timers on tasks assigned to you.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  @ApiResponse({ status: 409, description: 'Concurrent timer conflict.' })
  async playTimer(
    @Param('id') id: string,
    @Body() dto: PlayTaskTimerDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.playTimer(id, actor.sub, actor.userType, dto, actor.sessionId);
  }

  @Post(':id/timer/pause')
  @RequirePermissions('tasks.timer.pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause the running task timer with a reason',
    description:
      'Closes the active work interval using server time, calculates elapsed working duration, and creates an open pause record with the specified manual reason.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Timer paused successfully.' })
  @ApiResponse({ status: 400, description: 'No active running timer or invalid pause reason.' })
  @ApiResponse({ status: 403, description: 'You can only operate timers on tasks assigned to you.' })
  async pauseTimer(
    @Param('id') id: string,
    @Body() dto: PauseTaskTimerDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.pauseTimer(id, actor.sub, actor.userType, dto);
  }

  @Post(':id/timer/resume')
  @RequirePermissions('tasks.timer.resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a previously paused task',
    description:
      'Closes the open pause on this task, creates a new immutable work interval, and auto-pauses any other running task if necessary.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Timer resumed successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot resume completed or cancelled task.' })
  @ApiResponse({ status: 403, description: 'You can only operate timers on tasks assigned to you.' })
  async resumeTimer(
    @Param('id') id: string,
    @Body() dto: ResumeTaskTimerDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.resumeTimer(id, actor.sub, actor.userType, dto, actor.sessionId);
  }

  @Post(':id/timer/stop')
  @RequirePermissions('tasks.timer.stop')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Explicitly stop the current task work session',
    description:
      'Ends the active work interval or closes any open pause on this task. Preserves all history without marking the task COMPLETED.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Timer stopped successfully.' })
  @ApiResponse({ status: 400, description: 'No active timer or pause found to stop.' })
  @ApiResponse({ status: 403, description: 'You can only operate timers on tasks assigned to you.' })
  async stopTimer(
    @Param('id') id: string,
    @Body() dto: StopTaskTimerDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.stopTimer(id, actor.sub, actor.userType, dto);
  }

  @Get(':id/time-entries')
  @RequireAnyPermissions('tasks.time.view', 'tasks.time.view_own')
  @ApiOperation({
    summary: 'Get task work intervals and pause history',
    description:
      'Retrieves paginated work intervals and associated pause details for a task. Ordinary employees only see their own time entries; authorized supervisors see entries according to their data scope.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Time entries returned.' })
  @ApiResponse({ status: 404, description: 'Task not found or access denied.' })
  async getTimeEntries(
    @Param('id') id: string,
    @Query() query: QueryTaskTimeEntriesDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.getTimeEntries(id, actor.sub, actor.userType, query);
  }

  @Get(':id/time-summary')
  @RequireAnyPermissions('tasks.time.view_summary', 'tasks.time.view_own')
  @ApiOperation({
    summary: 'Get task-wise working time summary',
    description:
      'Aggregates actual working seconds and pause seconds for a task with daily splits at Asia/Kolkata midnight boundaries.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task time summary returned.' })
  @ApiResponse({ status: 404, description: 'Task not found or access denied.' })
  async getTimeSummary(
    @Param('id') id: string,
    @Query() query: QueryTaskTimeSummaryDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksTimerService.getTimeSummary(id, actor.sub, actor.userType, query);
  }

  @Patch(':id')
  @RequirePermissions('tasks.update')
  @ApiOperation({
    summary: 'Update task fields',
    description:
      'Updates mutable task fields (title, description, priority, category, status, progress, dates, tags). Records status history and activity logs.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task updated successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot update deleted task or invalid input.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async updateTask(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.updateTask(id, actor.sub, actor.userType, dto);
  }

  @Patch(':id/assign')
  @RequirePermissions('tasks.assign')
  @ApiOperation({
    summary: 'Assign or reassign task',
    description:
      'Atomically updates task assignee and department using MySQL Tier 1 user locks in ascending order. Inserts immutable TaskAssignmentHistory and TaskActivityLog.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task reassigned successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot reassign completed/cancelled task or invalid user.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  @ApiResponse({ status: 409, description: 'Concurrent reassignment collision.' })
  async reassignTask(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.reassignTask(id, actor.sub, actor.userType, dto);
  }

  @Delete(':id')
  @RequirePermissions('tasks.delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Soft-delete a task',
    description:
      'Soft-deletes a task by setting deletedAt timestamp. Preserves historical records in task_assignment_histories and task_activity_logs.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task soft-deleted successfully.' })
  @ApiResponse({ status: 400, description: 'Task already deleted.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async deleteTask(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.deleteTask(id, actor.sub, actor.userType);
  }

  @Get(':id/history')
  @RequireAnyPermissions('tasks.view_history', 'tasks.view_own')
  @ApiOperation({
    summary: 'Get complete audit history of a task',
    description:
      'Returns assignment history, status transition history, and activity logs for a specific task.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task history returned.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async getTaskHistory(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksService.getTaskHistory(id, actor.sub, actor.userType);
  }

  // ===========================================================================
  // PHASE 6.3.4: TASK WORKFLOW & REVIEWS
  // ===========================================================================

  @Post(':id/submit')
  @RequirePermissions('tasks.submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit an assigned task for review',
    description:
      'Transitions task from IN_PROGRESS / TODO / ON_HOLD / REOPENED to IN_REVIEW. Auto-pauses running timer if active. Creates a new TaskReview cycle round and records status history.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task submitted for review successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid task status or unassigned task.' })
  @ApiResponse({ status: 403, description: 'You can only submit tasks assigned to you.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async submitTask(
    @Param('id') id: string,
    @Body() dto: SubmitTaskDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.submitTaskForReview(id, actor.sub, actor.userType, dto);
  }

  @Post(':id/approve')
  @RequirePermissions('tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve latest pending task review and complete task',
    description:
      'Approves the pending review, sets task status to COMPLETED and progress to 100%. Enforces strict anti-self-approval so assignees cannot approve their own work.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Review approved and task completed.' })
  @ApiResponse({ status: 400, description: 'Task is not in review or already completed.' })
  @ApiResponse({ status: 403, description: 'Anti-self-approval or insufficient review permissions.' })
  @ApiResponse({ status: 404, description: 'Task or pending review not found.' })
  async approveTask(
    @Param('id') id: string,
    @Body() dto: ApproveTaskReviewDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.approveTaskReview(id, undefined, actor.sub, actor.userType, dto);
  }

  @Post(':id/reviews/:reviewId/approve')
  @RequirePermissions('tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a specific task review round',
    description: 'Approves the specified review round and completes the task.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'reviewId', description: 'Review ID' })
  @ApiResponse({ status: 200, description: 'Review approved and task completed.' })
  @ApiResponse({ status: 403, description: 'Anti-self-approval or insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Task or review not found.' })
  async approveTaskReview(
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: ApproveTaskReviewDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.approveTaskReview(id, reviewId, actor.sub, actor.userType, dto);
  }

  @Post(':id/request-changes')
  @RequireAnyPermissions('tasks.review', 'tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request changes on latest pending review (reopens task)',
    description:
      'Moves task status from IN_REVIEW to REOPENED with required feedback. Preserves review history and enforces anti-self-review.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Changes requested and task reopened.' })
  @ApiResponse({ status: 400, description: 'Task is not in review.' })
  @ApiResponse({ status: 403, description: 'Anti-self-approval or insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Task or pending review not found.' })
  async requestChanges(
    @Param('id') id: string,
    @Body() dto: RequestChangesDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.requestChangesOnReview(id, undefined, actor.sub, actor.userType, dto);
  }

  @Post(':id/reviews/:reviewId/request-changes')
  @RequireAnyPermissions('tasks.review', 'tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request changes on a specific review round',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'reviewId', description: 'Review ID' })
  async requestChangesOnReview(
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: RequestChangesDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.requestChangesOnReview(id, reviewId, actor.sub, actor.userType, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject latest pending task review',
    description: 'Rejects the submitted work deliverable and reopens the task for redesign.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Review rejected successfully.' })
  @ApiResponse({ status: 403, description: 'Anti-self-approval or insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Task or pending review not found.' })
  async rejectTask(
    @Param('id') id: string,
    @Body() dto: RejectTaskReviewDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.rejectTaskReview(id, undefined, actor.sub, actor.userType, dto);
  }

  @Post(':id/reviews/:reviewId/reject')
  @RequirePermissions('tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a specific review round',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'reviewId', description: 'Review ID' })
  async rejectTaskReview(
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: RejectTaskReviewDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.rejectTaskReview(id, reviewId, actor.sub, actor.userType, dto);
  }

  @Get(':id/reviews')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'List review cycles and history for a task',
    description:
      'Returns all review rounds for a task ordered by roundNumber ascending, including submitter, reviewer, outcome, feedback, and timestamps.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task review history returned.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async listReviews(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.listTaskReviews(id, actor.sub, actor.userType);
  }

  @Post(':id/cancel')
  @RequirePermissions('tasks.update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a task explicitly',
    description: 'Marks task CANCELLED and auto-pauses any active timer. Records audit status history.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task cancelled successfully.' })
  @ApiResponse({ status: 400, description: 'Cannot cancel a completed task.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async cancelTask(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.cancelTask(id, actor.sub, actor.userType, reason);
  }

  @Post(':id/reopen')
  @RequirePermissions('tasks.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen a completed or cancelled task',
    description: 'Reopens a COMPLETED or CANCELLED task. Requires supervisor or admin privileges.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task reopened successfully.' })
  @ApiResponse({ status: 400, description: 'Task is not completed or cancelled.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async reopenTask(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.reopenTask(id, actor.sub, actor.userType, reason);
  }

  // ===========================================================================
  // PHASE 6.3.4: COMMENTS & COLLABORATION
  // ===========================================================================

  @Post(':id/comments')
  @RequirePermissions('tasks.comment')
  @ApiOperation({
    summary: 'Add a comment or threaded reply to a task',
    description: 'Adds a collaboration comment. Supports parentId for threaded discussion and isInternal flag.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 201, description: 'Comment added successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid parent comment or client internal comment violation.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async addComment(
    @Param('id') id: string,
    @Body() dto: CreateTaskCommentDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.addComment(id, actor.sub, actor.userType, dto);
  }

  @Get(':id/comments')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'List comments for a task',
    description: 'Retrieves non-deleted comments ordered chronologically. Automatically hides internal comments from client users.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task comments returned.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async listComments(
    @Param('id') id: string,
    @Query() query: QueryTaskCommentsDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.listComments(id, actor.sub, actor.userType, query);
  }

  @Patch(':id/comments/:commentId')
  @RequirePermissions('tasks.comment')
  @ApiOperation({
    summary: 'Update an existing comment',
    description: 'Updates comment text and marks isEdited: true. Only the original author or Super Admin can edit.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment updated successfully.' })
  @ApiResponse({ status: 403, description: 'You can only edit your own comments.' })
  @ApiResponse({ status: 404, description: 'Comment not found.' })
  async updateComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateTaskCommentDto,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.updateComment(id, commentId, actor.sub, actor.userType, dto);
  }

  @Delete(':id/comments/:commentId')
  @RequirePermissions('tasks.comment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a comment',
    description: 'Soft-deletes a comment preserving audit history. Author or authorized admin can delete.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'commentId', description: 'Comment ID' })
  @ApiResponse({ status: 200, description: 'Comment deleted successfully.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Comment not found.' })
  async deleteComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.deleteComment(id, commentId, actor.sub, actor.userType);
  }

  // ===========================================================================
  // PHASE 6.3.6: ATTACHMENTS (BINARY UPLOAD, DOWNLOAD, PREVIEW, RESCAN)
  // ===========================================================================

  @Post(':id/attachments')
  @RequirePermissions('tasks.attachment')
  @UseInterceptors(FileInterceptor('file', getTaskAttachmentMulterOptions()))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({
    summary: 'Upload binary file attachment or attach validated media metadata to a task',
    description:
      'Uploads a physical binary file (multipart/form-data) or attaches metadata (JSON). Validates allowed MIME types, max 25MB file size, magic bytes, and performs ClamAV scanning.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 201, description: 'Attachment created successfully.' })
  @ApiResponse({ status: 400, description: 'Disallowed file type, size exceeded, or path traversal.' })
  @ApiResponse({ status: 403, description: 'Client users cannot attach internal files.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  @ApiResponse({ status: 413, description: 'File size exceeds 25 MB limit.' })
  @ApiResponse({ status: 422, description: 'File contains malware and was quarantined.' })
  async addAttachment(
    @Param('id') id: string,
    @CurrentUser() actor: any,
    @Body() dto?: CreateTaskAttachmentDto,
    @UploadedFile() file?: any,
  ) {
    return this.tasksWorkflowService.addAttachment(id, actor.sub, actor.userType, dto, file);
  }

  @Get(':id/attachments')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'List attachments for a task',
    description: 'Retrieves sanitized attachment metadata. Disallows client account access to internal files.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiResponse({ status: 200, description: 'Task attachments returned.' })
  @ApiResponse({ status: 403, description: 'Client accounts cannot access internal attachments.' })
  @ApiResponse({ status: 404, description: 'Task not found.' })
  async listAttachments(
    @Param('id') id: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.listAttachments(id, actor.sub, actor.userType);
  }

  @Get(':id/attachments/:attachmentId/download')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'Download attachment binary stream',
    description:
      'Downloads the physical file binary for clean scanned attachments. Blocks access for unscanned (PENDING) or malicious files.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, description: 'Binary file stream.' })
  @ApiResponse({ status: 403, description: 'Client accounts or infected files cannot be downloaded.' })
  @ApiResponse({ status: 404, description: 'Attachment or physical file not found.' })
  @ApiResponse({ status: 423, description: 'Attachment is locked pending malware scan.' })
  async downloadAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() actor: any,
    @Res() res: Response,
  ) {
    const fileResult = await this.tasksWorkflowService.downloadAttachment(
      id,
      attachmentId,
      actor.sub,
      actor.userType,
    );

    const safeName = encodeURIComponent(fileResult.originalName);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', fileResult.mimeType);
    res.setHeader('Content-Length', fileResult.fileSizeBytes);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (fileResult.sha256) {
      res.setHeader('X-Checksum-Sha256', fileResult.sha256);
    }

    fileResult.stream.pipe(res);
  }

  @Get(':id/attachments/:attachmentId/preview')
  @RequireAnyPermissions('tasks.view', 'tasks.view_own')
  @ApiOperation({
    summary: 'Preview attachment binary stream with safe sandbox headers',
    description:
      'Renders images or PDF files inline with strict CSP sandboxing. Non-previewable types must be downloaded.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, description: 'Inline file preview stream.' })
  @ApiResponse({ status: 400, description: 'File type does not support inline preview.' })
  @ApiResponse({ status: 403, description: 'Client accounts or infected files cannot be previewed.' })
  @ApiResponse({ status: 404, description: 'Attachment or physical file not found.' })
  @ApiResponse({ status: 423, description: 'Attachment is locked pending malware scan.' })
  async previewAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() actor: any,
    @Res() res: Response,
  ) {
    const previewResult = await this.tasksWorkflowService.previewAttachment(
      id,
      attachmentId,
      actor.sub,
      actor.userType,
    );

    const safeName = encodeURIComponent(previewResult.originalName);
    res.setHeader('Content-Disposition', `${previewResult.contentDisposition}; filename="${safeName}"`);
    res.setHeader('Content-Type', previewResult.mimeType);
    res.setHeader('Content-Length', previewResult.fileSizeBytes);
    res.setHeader('Content-Security-Policy', previewResult.contentSecurityPolicy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (previewResult.sha256) {
      res.setHeader('X-Checksum-Sha256', previewResult.sha256);
    }

    previewResult.stream.pipe(res);
  }

  @Post(':id/attachments/:attachmentId/rescan')
  @RequireAnyPermissions('tasks.approve', 'tasks.review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger an administrative malware rescan',
    description:
      'Performs an authoritative ClamAV rescan of a quarantined or pending attachment. Revalidates SHA-256 integrity and releases file only if ClamAV confirms clean.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, description: 'Rescan completed.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions for rescan.' })
  @ApiResponse({ status: 404, description: 'Attachment not found.' })
  @ApiResponse({ status: 409, description: 'Attachment is currently undergoing a scan or already clean.' })
  async rescanAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.rescanAttachment(id, attachmentId, actor.sub, actor.userType);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermissions('tasks.attachment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a task attachment',
    description: 'Soft-deletes the attachment media and removes mapping. Author or admin can delete.',
  })
  @ApiParam({ name: 'id', description: 'Task ID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment ID' })
  @ApiResponse({ status: 200, description: 'Attachment deleted successfully.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Attachment not found.' })
  async deleteAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() actor: any,
  ) {
    return this.tasksWorkflowService.deleteAttachment(id, attachmentId, actor.sub, actor.userType);
  }
}

