import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TasksTimerService } from './tasks-timer.service';
import {
  buildTaskVisibilityWhere,
  resolveActorTaskContext,
  TaskActorContext,
} from './tasks-visibility.helper';
import {
  calculateDurationSeconds,
  getKolkataDateString,
  IST_OFFSET_MS,
  parseKolkataDateToUtc,
  splitIntervalByKolkataMidnight,
} from './task-time.utils';
import {
  DataScope,
  TaskPriority,
  TaskReviewOutcome,
  TaskStatus,
  TaskTimerStatus,
} from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { QueryTaskDashboardDto } from './dto/query-task-dashboard.dto';
import { QueryTaskSummaryReportDto } from './dto/query-task-summary-report.dto';
import { QueryWorkingHoursReportDto } from './dto/query-working-hours-report.dto';
import { QueryEmployeePerformanceReportDto } from './dto/query-employee-performance-report.dto';
import {
  OverdueSortBy,
  QueryOverdueTasksReportDto,
  ReportSortOrder,
} from './dto/query-overdue-tasks-report.dto';
import { QueryReviewSummaryReportDto } from './dto/query-review-summary-report.dto';

@Injectable()
export class TasksReportsService {
  private readonly logger = new Logger(TasksReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly tasksTimerService: TasksTimerService,
  ) {}

  /**
   * Helper to calculate distinct completed tasks and eligible tasks for completion percentage.
   * Approved Rule:
   * - Numerator: distinct eligible tasks with a transition to COMPLETED during the requested reporting period.
   * - Denominator: eligible tasks that were active, due, or completed during the reporting period.
   * - Exclude CANCELLED tasks (strictly).
   * - A task completed multiple times after reopening must count only once in the same reporting period.
   * - Return 0 when denominator is 0.
   */
  private async calculateCompletionMetrics(
    baseTaskWhere: Prisma.TaskWhereInput,
    startDateStr?: string,
    endDateStr?: string,
  ): Promise<{
    numerator: number;
    denominator: number;
    completionPercentage: number;
    eligibleTaskIds: Set<string>;
    completedTaskIds: Set<string>;
  }> {
    if (!startDateStr && !endDateStr) {
      const totalEligible =
        (await this.prisma.task.count({
          where: {
            AND: [baseTaskWhere, { status: { not: TaskStatus.CANCELLED } }],
          },
        })) || 0;
      const totalCompleted =
        (await this.prisma.task.count({
          where: {
            AND: [baseTaskWhere, { status: TaskStatus.COMPLETED }],
          },
        })) || 0;
      const completionPercentage =
        totalEligible > 0 ? Number(((totalCompleted / totalEligible) * 100).toFixed(2)) : 0;
      return {
        numerator: totalCompleted,
        denominator: totalEligible,
        completionPercentage,
        eligibleTaskIds: new Set<string>(),
        completedTaskIds: new Set<string>(),
      };
    }

    const startUtc = startDateStr
      ? parseKolkataDateToUtc(startDateStr)
      : new Date('1970-01-01T00:00:00.000Z');
    const endUtc = endDateStr
      ? new Date(parseKolkataDateToUtc(endDateStr).getTime() + 24 * 60 * 60 * 1000 - 1)
      : new Date('2099-12-31T23:59:59.999Z');

    // 1. Identify all CANCELLED task IDs up to endUtc or currently cancelled
    const cancelledHistories =
      (await this.prisma.taskStatusHistory.findMany({
        where: {
          newStatus: TaskStatus.CANCELLED,
          createdAt: { lte: endUtc },
          task: baseTaskWhere,
        },
        select: { taskId: true },
        distinct: ['taskId'],
      })) || [];
    const cancelledTaskIds = new Set<string>(cancelledHistories.map((h) => h.taskId));

    const currentlyCancelled =
      (await this.prisma.task.findMany({
        where: {
          AND: [baseTaskWhere, { status: TaskStatus.CANCELLED }],
        },
        select: { id: true },
      })) || [];
    for (const t of currentlyCancelled) {
      cancelledTaskIds.add(t.id);
    }

    // 2. Identify Numerator: distinct tasks with a transition to COMPLETED in [startUtc, endUtc]
    const completedHistories =
      (await this.prisma.taskStatusHistory.findMany({
        where: {
          newStatus: TaskStatus.COMPLETED,
          createdAt: { gte: startUtc, lte: endUtc },
          task: baseTaskWhere,
        },
        select: { taskId: true },
        distinct: ['taskId'],
      })) || [];

    const completedTaskIds = new Set<string>();
    for (const h of completedHistories) {
      if (!cancelledTaskIds.has(h.taskId)) {
        completedTaskIds.add(h.taskId);
      }
    }
    const numerator = completedTaskIds.size;

    // 3. Identify Denominator: eligible tasks active, due, or completed in [startUtc, endUtc]
    // A. Completed in period (already in completedTaskIds)
    // B. Due in period
    const dueTasks =
      (await this.prisma.task.findMany({
        where: {
          AND: [baseTaskWhere, { dueDate: { gte: startUtc, lte: endUtc } }],
        },
        select: { id: true },
      })) || [];

    // C. Created in period
    const createdInPeriodTasks =
      (await this.prisma.task.findMany({
        where: {
          AND: [baseTaskWhere, { createdAt: { gte: startUtc, lte: endUtc } }],
        },
        select: { id: true },
      })) || [];

    // D. Timer activity in period
    const activeTimeEntries =
      (await this.prisma.taskTimeEntry.findMany({
        where: {
          isSuperseded: false,
          startedAt: { lte: endUtc },
          OR: [{ endedAt: { gte: startUtc } }, { endedAt: null }],
          task: baseTaskWhere,
        },
        select: { taskId: true },
        distinct: ['taskId'],
      })) || [];

    // E. Status history in period
    const activeStatusChanges =
      (await this.prisma.taskStatusHistory.findMany({
        where: {
          createdAt: { gte: startUtc, lte: endUtc },
          task: baseTaskWhere,
        },
        select: { taskId: true },
        distinct: ['taskId'],
      })) || [];

    // F. Created before period and active going into period (not completed prior to startUtc)
    const tasksCreatedBefore =
      (await this.prisma.task.findMany({
        where: {
          AND: [baseTaskWhere, { createdAt: { lt: startUtc } }],
        },
        select: {
          id: true,
          status: true,
          statusHistory: {
            where: {
              newStatus: TaskStatus.COMPLETED,
              createdAt: { lt: startUtc },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      })) || [];

    const eligibleTaskIds = new Set<string>();
    for (const id of completedTaskIds) {
      eligibleTaskIds.add(id);
    }
    for (const t of dueTasks) {
      eligibleTaskIds.add(t.id);
    }
    for (const t of createdInPeriodTasks) {
      eligibleTaskIds.add(t.id);
    }
    for (const e of activeTimeEntries) {
      eligibleTaskIds.add(e.taskId);
    }
    for (const s of activeStatusChanges) {
      eligibleTaskIds.add(s.taskId);
    }
    for (const t of tasksCreatedBefore) {
      if (!t.statusHistory || t.statusHistory.length === 0) {
        eligibleTaskIds.add(t.id);
      }
    }

    // Strictly exclude CANCELLED tasks
    for (const cid of cancelledTaskIds) {
      eligibleTaskIds.delete(cid);
    }

    const denominator = eligibleTaskIds.size;
    const completionPercentage =
      denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;

    return {
      numerator,
      denominator,
      completionPercentage,
      eligibleTaskIds,
      completedTaskIds,
    };
  }

  // ===========================================================================
  // DASHBOARD APIS
  // ===========================================================================

  /**
   * 1. Employee Dashboard (GET /api/tasks/dashboard/my)
   * Strictly personal authorized data. Never exposes peer metrics or hours.
   */
  async getEmployeeDashboard(
    actorUserId: string,
    actorUserType: string,
    _query: QueryTaskDashboardDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access internal task dashboards.');
    }

    const actorContext: TaskActorContext = {
      userId: actorUserId,
      userType: actorUserType,
      departmentIds: [],
      subordinateUserIds: [],
      effectiveDataScope: DataScope.OWN,
    };

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);

    // 1. Status breakdown across all 7 approved statuses
    const statusGroups = await this.prisma.task.groupBy({
      by: ['status'],
      where: visibilityWhere,
      _count: { id: true },
    });

    const statusCounts: Record<TaskStatus, number> = {
      [TaskStatus.TODO]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.ON_HOLD]: 0,
      [TaskStatus.IN_REVIEW]: 0,
      [TaskStatus.REOPENED]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };

    for (const group of statusGroups) {
      statusCounts[group.status] = group._count.id;
    }

    // 2. Assignment metrics (Deduplication: a task created by & assigned to actor is counted once)
    const totalTasks = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const assignedTasks = await this.prisma.task.count({
      where: {
        assigneeId: actorUserId,
        deletedAt: null,
      },
    });
    const ownUnassignedDrafts = await this.prisma.task.count({
      where: {
        createdById: actorUserId,
        assigneeId: null,
        deletedAt: null,
      },
    });

    // 3. Deadline tracking in Asia/Kolkata
    const now = new Date();
    const todayKolkata = getKolkataDateString(now);
    const todayStartUtc = parseKolkataDateToUtc(todayKolkata);
    const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000 - 1);

    const overdueTasks = await this.prisma.task.count({
      where: {
        AND: [
          visibilityWhere,
          { dueDate: { lt: todayStartUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const dueTodayTasks = await this.prisma.task.count({
      where: {
        AND: [
          visibilityWhere,
          { dueDate: { gte: todayStartUtc, lte: todayEndUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const upcomingTasks = await this.prisma.task.count({
      where: {
        AND: [
          visibilityWhere,
          { dueDate: { gt: todayEndUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    // 4. Timer Telemetry (Live active timer, today's tracked work and pause durations)
    const activeTimerResult = await this.tasksTimerService.getActiveTimer(
      actorUserId,
      actorUserType,
    );

    // Sum durations for today using Asia/Kolkata midnight split
    const todayStartUtcReal = new Date(todayStartUtc.getTime() - IST_OFFSET_MS);
    const todayEndUtcReal = new Date(todayStartUtcReal.getTime() + 24 * 60 * 60 * 1000);

    const todayEntries = await this.prisma.taskTimeEntry.findMany({
      where: {
        userId: actorUserId,
        isSuperseded: false,
        startedAt: { lt: todayEndUtcReal },
        OR: [{ endedAt: { gte: todayStartUtcReal } }, { endedAt: null }],
      },
      select: {
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        status: true,
      },
    });

    let todayWorkingSeconds = 0;
    for (const entry of todayEntries) {
      const isFinalized = entry.endedAt != null;
      const effectiveEnd = entry.endedAt || now;
      let segments = splitIntervalByKolkataMidnight(entry.startedAt, effectiveEnd);

      if (segments.length === 0) {
        const dStr = getKolkataDateString(entry.startedAt);
        const dSec = isFinalized
          ? entry.durationSeconds
          : calculateDurationSeconds(entry.startedAt, now);
        segments = [{ date: dStr, durationSeconds: dSec }];
      } else if (isFinalized && entry.durationSeconds > 0) {
        const totalSec = segments.reduce((s, seg) => s + seg.durationSeconds, 0);
        if (totalSec > 0) {
          let allocated = 0;
          for (let i = 0; i < segments.length - 1; i++) {
            const scaled = Math.round(
              (segments[i].durationSeconds / totalSec) * entry.durationSeconds,
            );
            segments[i].durationSeconds = scaled;
            allocated += scaled;
          }
          segments[segments.length - 1].durationSeconds = entry.durationSeconds - allocated;
        }
      }

      for (const seg of segments) {
        if (seg.date === todayKolkata) {
          todayWorkingSeconds += seg.durationSeconds;
        }
      }
    }

    const todayPauses = await this.prisma.taskTimePause.findMany({
      where: {
        userId: actorUserId,
        pausedAt: { lt: todayEndUtcReal },
        OR: [{ resumedAt: { gte: todayStartUtcReal } }, { resumedAt: null }],
      },
      select: {
        pausedAt: true,
        resumedAt: true,
        pauseDurationSeconds: true,
      },
    });

    let todayPausedSeconds = 0;
    for (const pause of todayPauses) {
      const isFinalized = pause.resumedAt != null;
      const effectiveEnd = pause.resumedAt || now;
      let segments = splitIntervalByKolkataMidnight(pause.pausedAt, effectiveEnd);

      if (segments.length === 0) {
        const dStr = getKolkataDateString(pause.pausedAt);
        const dSec = isFinalized
          ? pause.pauseDurationSeconds
          : calculateDurationSeconds(pause.pausedAt, now);
        segments = [{ date: dStr, durationSeconds: dSec }];
      } else if (isFinalized && pause.pauseDurationSeconds > 0) {
        const totalSec = segments.reduce((s, seg) => s + seg.durationSeconds, 0);
        if (totalSec > 0) {
          let allocated = 0;
          for (let i = 0; i < segments.length - 1; i++) {
            const scaled = Math.round(
              (segments[i].durationSeconds / totalSec) * pause.pauseDurationSeconds,
            );
            segments[i].durationSeconds = scaled;
            allocated += scaled;
          }
          segments[segments.length - 1].durationSeconds = pause.pauseDurationSeconds - allocated;
        }
      }

      for (const seg of segments) {
        if (seg.date === todayKolkata) {
          todayPausedSeconds += seg.durationSeconds;
        }
      }
    }

    // 5. Recent task activities (last 5)
    const recentActivity = await this.prisma.taskActivityLog.findMany({
      where: {
        task: visibilityWhere,
      },
      include: {
        task: { select: { id: true, taskCode: true, title: true } },
        actor: { select: { id: true, userCode: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // 6. Recent reviews & pending feedback (last 5)
    const recentReviews = await this.prisma.taskReview.findMany({
      where: {
        OR: [
          { submitterId: actorUserId },
          { task: { assigneeId: actorUserId } },
        ],
      },
      include: {
        task: { select: { id: true, taskCode: true, title: true, status: true } },
        reviewer: { select: { id: true, userCode: true, name: true } },
        submitter: { select: { id: true, userCode: true, name: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 5,
    });

    return {
      success: true,
      message: 'Employee dashboard retrieved successfully.',
      data: {
        totalTasks,
        assignedTasks,
        ownUnassignedDrafts,
        statusCounts,
        deadlines: {
          overdueTasks,
          dueTodayTasks,
          upcomingTasks,
        },
        timerTelemetry: {
          activeTimer: activeTimerResult,
          todayWorkingSeconds,
          todayWorkingHours: Number((todayWorkingSeconds / 3600).toFixed(2)),
          todayPausedSeconds,
          todayPausedHours: Number((todayPausedSeconds / 3600).toFixed(2)),
        },
        recentActivity: recentActivity.map((a) => ({
          id: a.id,
          taskId: a.taskId,
          taskCode: a.task.taskCode,
          taskTitle: a.task.title,
          action: a.action,
          performedBy: a.actor
            ? { id: a.actor.id, name: a.actor.name, userCode: a.actor.userCode }
            : null,
          metadata: a.metadata,
          createdAt: a.createdAt,
        })),
        recentReviews: recentReviews.map((r) => ({
          id: r.id,
          taskId: r.taskId,
          taskCode: r.task.taskCode,
          taskTitle: r.task.title,
          roundNumber: r.roundNumber,
          outcome: r.outcome,
          feedback: r.feedback,
          submittedAt: r.submittedAt,
          reviewedAt: r.reviewedAt,
          reviewer: r.reviewer ? { id: r.reviewer.id, name: r.reviewer.name } : null,
          submitter: { id: r.submitter.id, name: r.submitter.name },
        })),
      },
    };
  }

  /**
   * 2. Manager / Department Dashboard (GET /api/tasks/dashboard/team)
   * Restricts aggregation strictly to authorized departments and subordinates.
   */
  async getTeamDashboard(
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskDashboardDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access team dashboards.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    if (actorContext.effectiveDataScope === DataScope.OWN) {
      throw new ForbiddenException('Team dashboard requires DEPARTMENT, ASSIGNED, or ALL scope.');
    }

    if (
      query.departmentId &&
      actorContext.effectiveDataScope === DataScope.DEPARTMENT &&
      !actorContext.departmentIds.includes(query.departmentId)
    ) {
      throw new ForbiddenException('Access denied to the specified department.');
    }

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);
    const filterAnd: Prisma.TaskWhereInput[] = [visibilityWhere];

    if (query.departmentId) {
      filterAnd.push({ departmentId: query.departmentId });
    }

    const teamWhere: Prisma.TaskWhereInput = { AND: filterAnd };

    // 1. Team task status breakdown
    const statusGroups = await this.prisma.task.groupBy({
      by: ['status'],
      where: teamWhere,
      _count: { id: true },
    });

    const statusCounts: Record<TaskStatus, number> = {
      [TaskStatus.TODO]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.ON_HOLD]: 0,
      [TaskStatus.IN_REVIEW]: 0,
      [TaskStatus.REOPENED]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count.id;
    }

    // 2. Team task priority breakdown
    const priorityGroups = await this.prisma.task.groupBy({
      by: ['priority'],
      where: teamWhere,
      _count: { id: true },
    });

    const priorityCounts: Record<TaskPriority, number> = {
      [TaskPriority.LOW]: 0,
      [TaskPriority.MEDIUM]: 0,
      [TaskPriority.HIGH]: 0,
      [TaskPriority.URGENT]: 0,
    };
    for (const group of priorityGroups) {
      priorityCounts[group.priority] = group._count.id;
    }

    const totalTasks = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const assignedTasks = await this.prisma.task.count({
      where: { AND: [...filterAnd, { assigneeId: { not: null } }] },
    });
    const unassignedTasks = totalTasks - assignedTasks;

    // 3. Deadlines & Review Pipeline
    const now = new Date();
    const todayKolkata = getKolkataDateString(now);
    const todayStartUtc = parseKolkataDateToUtc(todayKolkata);
    const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000 - 1);

    const overdueTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { lt: todayStartUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const dueTodayTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { gte: todayStartUtc, lte: todayEndUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const upcomingTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { gt: todayEndUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const tasksAwaitingReview = statusCounts[TaskStatus.IN_REVIEW];
    const tasksRequiringChanges = statusCounts[TaskStatus.REOPENED];

    // 4. Employee-wise Task Distribution
    const employeeTaskGroups = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { AND: [...filterAnd, { assigneeId: { not: null } }] },
      _count: { id: true },
    });

    const assigneeIds = employeeTaskGroups.map((g) => g.assigneeId).filter(Boolean) as string[];
    const employees = await this.prisma.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, userCode: true, name: true, email: true },
    });
    const employeeMap = new Map(employees.map((e) => [e.id, e]));

    // Completed counts per employee
    const completedGroups = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: {
        AND: [...filterAnd, { assigneeId: { in: assigneeIds }, status: TaskStatus.COMPLETED }],
      },
      _count: { id: true },
    });
    const completedMap = new Map(completedGroups.map((g) => [g.assigneeId, g._count.id]));

    const employeeDistribution = employeeTaskGroups.map((g) => {
      const emp = employeeMap.get(g.assigneeId!);
      const total = g._count.id;
      const completed = completedMap.get(g.assigneeId!) || 0;
      return {
        employeeId: g.assigneeId!,
        userCode: emp?.userCode || '',
        name: emp?.name || 'Unknown',
        totalTasks: total,
        completedTasks: completed,
        activeTasks: total - completed,
      };
    });

    // 5. Live active timers across team
    const liveTimers = await this.prisma.taskTimeEntry.findMany({
      where: {
        status: TaskTimerStatus.RUNNING,
        endedAt: null,
        task: teamWhere,
      },
      include: {
        user: { select: { id: true, userCode: true, name: true } },
        task: { select: { id: true, taskCode: true, title: true } },
      },
    });

    const activeTimersRoster = liveTimers.map((t) => ({
      timeEntryId: t.id,
      employeeId: t.userId,
      employeeName: t.user.name,
      employeeCode: t.user.userCode,
      taskId: t.taskId,
      taskCode: t.task.taskCode,
      taskTitle: t.task.title,
      startedAt: t.startedAt,
      elapsedSeconds: calculateDurationSeconds(t.startedAt, now),
    }));

    // 6. Recent team activity (last 10)
    const recentActivity = await this.prisma.taskActivityLog.findMany({
      where: { task: teamWhere },
      include: {
        task: { select: { id: true, taskCode: true, title: true } },
        actor: { select: { id: true, userCode: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return {
      success: true,
      message: 'Team dashboard retrieved successfully.',
      data: {
        totalTasks,
        assignedTasks,
        unassignedTasks,
        statusCounts,
        priorityCounts,
        deadlines: {
          overdueTasks,
          dueTodayTasks,
          upcomingTasks,
        },
        reviewPipeline: {
          tasksAwaitingReview,
          tasksRequiringChanges,
        },
        employeeDistribution,
        activeTimersRoster,
        recentActivity: recentActivity.map((a) => ({
          id: a.id,
          taskId: a.taskId,
          taskCode: a.task.taskCode,
          taskTitle: a.task.title,
          action: a.action,
          performedBy: a.actor
            ? { id: a.actor.id, name: a.actor.name, userCode: a.actor.userCode }
            : null,
          metadata: a.metadata,
          createdAt: a.createdAt,
        })),
      },
    };
  }

  /**
   * 3. Organization Dashboard (GET /api/tasks/dashboard/organization)
   * System-wide metrics for Super Admin; user-type ceiling and assigned scope for Admin.
   */
  async getOrganizationDashboard(
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskDashboardDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access organization dashboards.');
    }
    if (actorUserType === 'EMPLOYEE') {
      throw new ForbiddenException('Organization dashboard requires Administrative privileges.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);
    const filterAnd: Prisma.TaskWhereInput[] = [visibilityWhere];

    if (query.departmentId) {
      filterAnd.push({ departmentId: query.departmentId });
    }

    const orgWhere: Prisma.TaskWhereInput = { AND: filterAnd };

    // 1. Status and Priority breakdowns
    const statusGroups = await this.prisma.task.groupBy({
      by: ['status'],
      where: orgWhere,
      _count: { id: true },
    });

    const statusCounts: Record<TaskStatus, number> = {
      [TaskStatus.TODO]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.ON_HOLD]: 0,
      [TaskStatus.IN_REVIEW]: 0,
      [TaskStatus.REOPENED]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count.id;
    }

    const priorityGroups = await this.prisma.task.groupBy({
      by: ['priority'],
      where: orgWhere,
      _count: { id: true },
    });

    const priorityCounts: Record<TaskPriority, number> = {
      [TaskPriority.LOW]: 0,
      [TaskPriority.MEDIUM]: 0,
      [TaskPriority.HIGH]: 0,
      [TaskPriority.URGENT]: 0,
    };
    for (const group of priorityGroups) {
      priorityCounts[group.priority] = group._count.id;
    }

    const totalTasks = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    // 2. Department-wise breakdown
    const departmentGroups = await this.prisma.task.groupBy({
      by: ['departmentId'],
      where: orgWhere,
      _count: { id: true },
    });

    const departmentIds = departmentGroups.map((g) => g.departmentId);
    const departments = await this.prisma.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true, code: true, name: true },
    });
    const deptMap = new Map(departments.map((d) => [d.id, d]));

    const deptCompletedGroups = await this.prisma.task.groupBy({
      by: ['departmentId'],
      where: { AND: [...filterAnd, { status: TaskStatus.COMPLETED }] },
      _count: { id: true },
    });
    const deptCompletedMap = new Map(deptCompletedGroups.map((g) => [g.departmentId, g._count.id]));

    const departmentDistribution = departmentGroups.map((g) => {
      const dept = deptMap.get(g.departmentId);
      const total = g._count.id;
      const completed = deptCompletedMap.get(g.departmentId) || 0;
      const completionPercentage = total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0;
      return {
        departmentId: g.departmentId,
        departmentCode: dept?.code || '',
        departmentName: dept?.name || 'Unknown',
        totalTasks: total,
        completedTasks: completed,
        completionPercentage,
      };
    });

    // 3. Organization SLA and review queues
    const now = new Date();
    const todayKolkata = getKolkataDateString(now);
    const todayStartUtc = parseKolkataDateToUtc(todayKolkata);
    const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000 - 1);

    const overdueTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { lt: todayStartUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const dueTodayTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { gte: todayStartUtc, lte: todayEndUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    const awaitingReviewCount = statusCounts[TaskStatus.IN_REVIEW];

    // 4. Completed task throughput trends over last 30 days (distinct tasks from status history)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentCompletions = await this.prisma.taskStatusHistory.findMany({
      where: {
        newStatus: TaskStatus.COMPLETED,
        createdAt: { gte: thirtyDaysAgo },
        task: orgWhere,
      },
      select: { taskId: true, createdAt: true },
      distinct: ['taskId'],
    });

    // 5. Total Tracked Time Telemetry
    const timeAggregation = await this.prisma.taskTimeEntry.aggregate({
      where: {
        isSuperseded: false,
        task: orgWhere,
      },
      _sum: { durationSeconds: true },
      _count: { id: true },
    });

    const pauseAggregation = await this.prisma.taskTimePause.aggregate({
      where: {
        task: orgWhere,
      },
      _sum: { pauseDurationSeconds: true },
    });

    const totalWorkingSeconds = timeAggregation._sum.durationSeconds || 0;
    const totalPausedSeconds = pauseAggregation._sum.pauseDurationSeconds || 0;

    // 6. Live Active Timers
    const liveTimersCount = await this.prisma.taskTimeEntry.count({
      where: {
        status: TaskTimerStatus.RUNNING,
        endedAt: null,
        task: orgWhere,
      },
    });

    return {
      success: true,
      message: 'Organization dashboard retrieved successfully.',
      data: {
        totalTasks,
        statusCounts,
        priorityCounts,
        departmentDistribution,
        slaMetrics: {
          overdueTasks,
          dueTodayTasks,
          awaitingReviewCount,
        },
        trends: {
          completionsLast30Days: recentCompletions.length,
        },
        timeTelemetry: {
          totalWorkingSeconds,
          totalWorkingHours: Number((totalWorkingSeconds / 3600).toFixed(2)),
          totalPausedSeconds,
          totalPausedHours: Number((totalPausedSeconds / 3600).toFixed(2)),
          liveTimersCount,
        },
      },
    };
  }

  // ===========================================================================
  // REPORTING APIS
  // ===========================================================================

  /**
   * 4. Task Summary Report (GET /api/tasks/reports/summary)
   */
  async getTaskSummaryReport(
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskSummaryReportDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access task reports.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    if (
      query.departmentId &&
      actorContext.effectiveDataScope === DataScope.DEPARTMENT &&
      !actorContext.departmentIds.includes(query.departmentId)
    ) {
      throw new ForbiddenException('Access denied to specified department.');
    }

    if (
      query.assigneeId &&
      actorContext.effectiveDataScope === DataScope.OWN &&
      query.assigneeId !== actorUserId
    ) {
      throw new ForbiddenException('You can only view summary reports for your own tasks.');
    }

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);
    const filterAnd: Prisma.TaskWhereInput[] = [visibilityWhere];

    if (query.departmentId) filterAnd.push({ departmentId: query.departmentId });
    if (query.assigneeId) filterAnd.push({ assigneeId: query.assigneeId });
    if (query.createdById) filterAnd.push({ createdById: query.createdById });
    if (query.status) filterAnd.push({ status: query.status });
    if (query.priority) filterAnd.push({ priority: query.priority });
    if (query.category) filterAnd.push({ category: query.category });

    const now = new Date();
    const todayKolkata = getKolkataDateString(now);
    const todayStartUtc = parseKolkataDateToUtc(todayKolkata);

    if (query.isOverdue) {
      filterAnd.push({
        dueDate: { lt: todayStartUtc },
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      });
    }

    // Timestamp semantics: createdAt for creation date filtering
    if (query.startDate || query.endDate) {
      filterAnd.push({
        createdAt: {
          gte: query.startDate ? parseKolkataDateToUtc(query.startDate) : undefined,
          lte: query.endDate
            ? new Date(parseKolkataDateToUtc(query.endDate).getTime() + 24 * 60 * 60 * 1000 - 1)
            : undefined,
        },
      });
    }

    const reportWhere: Prisma.TaskWhereInput = { AND: filterAnd };

    // Grouping by Status
    const statusGroups = await this.prisma.task.groupBy({
      by: ['status'],
      where: reportWhere,
      _count: { id: true },
    });

    const statusCounts: Record<TaskStatus, number> = {
      [TaskStatus.TODO]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.ON_HOLD]: 0,
      [TaskStatus.IN_REVIEW]: 0,
      [TaskStatus.REOPENED]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count.id;
    }

    // Grouping by Priority
    const priorityGroups = await this.prisma.task.groupBy({
      by: ['priority'],
      where: reportWhere,
      _count: { id: true },
    });

    const priorityCounts: Record<TaskPriority, number> = {
      [TaskPriority.LOW]: 0,
      [TaskPriority.MEDIUM]: 0,
      [TaskPriority.HIGH]: 0,
      [TaskPriority.URGENT]: 0,
    };
    for (const group of priorityGroups) {
      priorityCounts[group.priority] = group._count.id;
    }

    const totalTasks = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    // Overdue tasks count within filter (dueDate < todayStartUtc)
    const overdueTasks = await this.prisma.task.count({
      where: {
        AND: [
          ...filterAnd,
          { dueDate: { lt: todayStartUtc } },
          { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        ],
      },
    });

    let completedTasks = statusCounts[TaskStatus.COMPLETED];
    let pendingTasks =
      totalTasks - (statusCounts[TaskStatus.COMPLETED] + statusCounts[TaskStatus.CANCELLED]);
    let eligibleTasks = totalTasks - statusCounts[TaskStatus.CANCELLED];
    let completionPercentage =
      eligibleTasks > 0 ? Number(((completedTasks / eligibleTasks) * 100).toFixed(2)) : 0;

    if (query.startDate || query.endDate) {
      // Base task filter for completion calculation (excluding creation date restriction)
      const baseCompletionFilter: Prisma.TaskWhereInput[] = [visibilityWhere];
      if (query.departmentId) baseCompletionFilter.push({ departmentId: query.departmentId });
      if (query.assigneeId) baseCompletionFilter.push({ assigneeId: query.assigneeId });
      if (query.createdById) baseCompletionFilter.push({ createdById: query.createdById });
      if (query.priority) baseCompletionFilter.push({ priority: query.priority });
      if (query.category) baseCompletionFilter.push({ category: query.category });

      const completionMetrics = await this.calculateCompletionMetrics(
        { AND: baseCompletionFilter },
        query.startDate,
        query.endDate,
      );

      completedTasks = completionMetrics.numerator;
      eligibleTasks = completionMetrics.denominator;
      completionPercentage = completionMetrics.completionPercentage;
      pendingTasks = Math.max(0, eligibleTasks - completedTasks);
    }

    return {
      success: true,
      message: 'Task summary report retrieved successfully.',
      data: {
        totalTasks,
        completedTasks,
        pendingTasks,
        overdueTasks,
        completionPercentage,
        statusCounts,
        priorityCounts,
      },
    };
  }

  /**
   * 5. Employee Working Hours Report (GET /api/tasks/reports/working-hours)
   * Daily breakdown split at Asia/Kolkata midnight (18:30 UTC), excluding paused duration.
   */
  async getWorkingHoursReport(
    actorUserId: string,
    actorUserType: string,
    query: QueryWorkingHoursReportDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access working hours reports.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'tasks.time.view',
    );

    // If actor has OWN scope or doesn't have broader permissions, restrict to own hours
    if (actorContext.effectiveDataScope === DataScope.OWN) {
      if (query.employeeId && query.employeeId !== actorUserId) {
        throw new ForbiddenException('You can only view your own working hours.');
      }
      query.employeeId = actorUserId;
    } else if (actorContext.effectiveDataScope === DataScope.DEPARTMENT) {
      if (query.departmentId && !actorContext.departmentIds.includes(query.departmentId)) {
        throw new ForbiddenException('Access denied to specified department.');
      }
      if (query.employeeId) {
        const inDept = await this.prisma.userDepartment.findFirst({
          where: {
            userId: query.employeeId,
            departmentId: { in: actorContext.departmentIds },
          },
        });
        if (!inDept) {
          throw new ForbiddenException('Employee is not in your authorized departments.');
        }
      }
    }

    let rangeStartUtc: Date | undefined;
    let rangeEndUtc: Date | undefined;

    if (query.startDate) {
      rangeStartUtc = new Date(parseKolkataDateToUtc(query.startDate).getTime() - IST_OFFSET_MS);
    }
    if (query.endDate) {
      rangeEndUtc = new Date(
        parseKolkataDateToUtc(query.endDate).getTime() + 24 * 60 * 60 * 1000 - IST_OFFSET_MS,
      );
    }

    const timeEntryWhere: Prisma.TaskTimeEntryWhereInput = {
      isSuperseded: false,
    };

    if (query.employeeId) {
      timeEntryWhere.userId = query.employeeId;
    } else if (actorContext.effectiveDataScope === DataScope.DEPARTMENT) {
      timeEntryWhere.user = {
        departments: { some: { departmentId: { in: actorContext.departmentIds } } },
      };
    }

    if (query.departmentId) {
      timeEntryWhere.task = { departmentId: query.departmentId };
    }

    // Date-range filters include overlapping intervals, not just start dates
    const overlapConditions: Prisma.TaskTimeEntryWhereInput[] = [];
    if (rangeStartUtc) {
      overlapConditions.push({
        OR: [{ endedAt: { gte: rangeStartUtc } }, { endedAt: null }],
      });
    }
    if (rangeEndUtc) {
      overlapConditions.push({
        startedAt: { lt: rangeEndUtc },
      });
    }
    if (overlapConditions.length > 0) {
      timeEntryWhere.AND = overlapConditions;
    }

    const entries = await this.prisma.taskTimeEntry.findMany({
      where: timeEntryWhere,
      include: {
        user: { select: { id: true, userCode: true, name: true, email: true } },
        task: { select: { id: true, taskCode: true, title: true } },
      },
      orderBy: [{ startedAt: 'asc' }],
    });

    const pauseWhere: Prisma.TaskTimePauseWhereInput = {};

    if (query.employeeId) {
      pauseWhere.userId = query.employeeId;
    } else if (actorContext.effectiveDataScope === DataScope.DEPARTMENT) {
      pauseWhere.user = {
        departments: { some: { departmentId: { in: actorContext.departmentIds } } },
      };
    }

    if (query.departmentId) {
      pauseWhere.task = { departmentId: query.departmentId };
    }

    const pauseOverlapConditions: Prisma.TaskTimePauseWhereInput[] = [];
    if (rangeStartUtc) {
      pauseOverlapConditions.push({
        OR: [{ resumedAt: { gte: rangeStartUtc } }, { resumedAt: null }],
      });
    }
    if (rangeEndUtc) {
      pauseOverlapConditions.push({
        pausedAt: { lt: rangeEndUtc },
      });
    }
    if (pauseOverlapConditions.length > 0) {
      pauseWhere.AND = pauseOverlapConditions;
    }

    const pauses = await this.prisma.taskTimePause.findMany({
      where: pauseWhere,
      include: {
        user: { select: { id: true, userCode: true, name: true, email: true } },
      },
      orderBy: [{ pausedAt: 'asc' }],
    });

    interface GroupedDayData {
      userId: string;
      user: { id: string; userCode: string; name: string; email: string };
      workDateStr: string;
      totalWorkingSeconds: number;
      totalPausedSeconds: number;
      sessionCount: number;
      firstStartedAt: Date | null;
      lastStoppedAt: Date | null;
      tasks: Map<
        string,
        { taskId: string; taskCode: string; title: string; durationSeconds: number }
      >;
    }

    const groupsMap = new Map<string, GroupedDayData>();
    const now = new Date();

    const getOrCreateGroup = (
      userId: string,
      user: { id: string; userCode: string; name: string; email: string },
      workDateStr: string,
    ): GroupedDayData => {
      const key = `${userId}_${workDateStr}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          userId,
          user,
          workDateStr,
          totalWorkingSeconds: 0,
          totalPausedSeconds: 0,
          sessionCount: 0,
          firstStartedAt: null,
          lastStoppedAt: null,
          tasks: new Map(),
        });
      }
      return groupsMap.get(key)!;
    };

    // 1. Process time entries (work intervals)
    for (const entry of entries) {
      const isFinalized = entry.endedAt != null;
      const effectiveEnd = entry.endedAt || now;

      let segments = splitIntervalByKolkataMidnight(entry.startedAt, effectiveEnd);

      if (segments.length === 0) {
        const fallbackDate = getKolkataDateString(entry.startedAt);
        const fallbackDuration = isFinalized
          ? entry.durationSeconds
          : calculateDurationSeconds(entry.startedAt, now);
        segments = [{ date: fallbackDate, durationSeconds: fallbackDuration }];
      } else if (isFinalized && entry.durationSeconds > 0) {
        // Finalized entries use persisted duration scaled proportionally across segments
        const totalSegmentSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
        if (totalSegmentSeconds > 0) {
          let allocated = 0;
          for (let i = 0; i < segments.length - 1; i++) {
            const scaled = Math.round(
              (segments[i].durationSeconds / totalSegmentSeconds) * entry.durationSeconds,
            );
            segments[i].durationSeconds = scaled;
            allocated += scaled;
          }
          segments[segments.length - 1].durationSeconds = entry.durationSeconds - allocated;
        }
      }

      for (const segment of segments) {
        if (query.startDate && segment.date < query.startDate) continue;
        if (query.endDate && segment.date > query.endDate) continue;

        const group = getOrCreateGroup(entry.userId, entry.user, segment.date);
        group.totalWorkingSeconds += segment.durationSeconds;
        group.sessionCount += 1;

        const dayStartUtc = new Date(parseKolkataDateToUtc(segment.date).getTime() - IST_OFFSET_MS);
        const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

        const segmentEffectiveStart = entry.startedAt < dayStartUtc ? dayStartUtc : entry.startedAt;
        const segmentEffectiveEnd = effectiveEnd > dayEndUtc ? dayEndUtc : effectiveEnd;

        if (!group.firstStartedAt || segmentEffectiveStart < group.firstStartedAt) {
          group.firstStartedAt = segmentEffectiveStart;
        }
        if (!group.lastStoppedAt || segmentEffectiveEnd > group.lastStoppedAt) {
          group.lastStoppedAt = segmentEffectiveEnd;
        }

        if (!group.tasks.has(entry.taskId)) {
          group.tasks.set(entry.taskId, {
            taskId: entry.taskId,
            taskCode: entry.task.taskCode,
            title: entry.task.title,
            durationSeconds: 0,
          });
        }
        group.tasks.get(entry.taskId)!.durationSeconds += segment.durationSeconds;
      }
    }

    // 2. Process pauses (finalized and open)
    for (const pause of pauses) {
      const isFinalized = pause.resumedAt != null;
      const effectiveEnd = pause.resumedAt || now;

      let segments = splitIntervalByKolkataMidnight(pause.pausedAt, effectiveEnd);

      if (segments.length === 0) {
        const fallbackDate = getKolkataDateString(pause.pausedAt);
        const fallbackDuration = isFinalized
          ? pause.pauseDurationSeconds
          : calculateDurationSeconds(pause.pausedAt, now);
        segments = [{ date: fallbackDate, durationSeconds: fallbackDuration }];
      } else if (isFinalized && pause.pauseDurationSeconds > 0) {
        const totalSegmentSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
        if (totalSegmentSeconds > 0) {
          let allocated = 0;
          for (let i = 0; i < segments.length - 1; i++) {
            const scaled = Math.round(
              (segments[i].durationSeconds / totalSegmentSeconds) * pause.pauseDurationSeconds,
            );
            segments[i].durationSeconds = scaled;
            allocated += scaled;
          }
          segments[segments.length - 1].durationSeconds = pause.pauseDurationSeconds - allocated;
        }
      }

      for (const segment of segments) {
        if (query.startDate && segment.date < query.startDate) continue;
        if (query.endDate && segment.date > query.endDate) continue;

        const group = getOrCreateGroup(pause.userId, pause.user, segment.date);
        group.totalPausedSeconds += segment.durationSeconds;
      }
    }

    const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => {
      if (a.workDateStr !== b.workDateStr) {
        return b.workDateStr.localeCompare(a.workDateStr);
      }
      return a.userId.localeCompare(b.userId);
    });

    const totalGroups = sortedGroups.length;
    const page = query.page || 1;
    const limit = query.limit || 20;
    const totalPages = Math.ceil(totalGroups / limit) || 1;
    const startIndex = (page - 1) * limit;
    const paginatedGroups = sortedGroups.slice(startIndex, startIndex + limit);

    const results = paginatedGroups.map((group) => ({
      employee: group.user,
      workDate: group.workDateStr,
      totalWorkingSeconds: group.totalWorkingSeconds,
      totalWorkingHours: Number((group.totalWorkingSeconds / 3600).toFixed(2)),
      totalPausedSeconds: group.totalPausedSeconds,
      totalPausedHours: Number((group.totalPausedSeconds / 3600).toFixed(2)),
      sessionCount: group.sessionCount,
      firstStartedAt: group.firstStartedAt,
      lastStoppedAt: group.lastStoppedAt,
      tasks: Array.from(group.tasks.values()).map((t) => ({
        ...t,
        durationHours: Number((t.durationSeconds / 3600).toFixed(2)),
      })),
    }));

    return {
      success: true,
      message: 'Working hours report retrieved successfully.',
      data: results,
      pagination: {
        page,
        limit,
        totalItems: totalGroups,
        totalPages,
      },
    };
  }

  /**
   * 6. Employee Task Performance Report (GET /api/tasks/reports/employee-performance)
   */
  async getEmployeePerformanceReport(
    actorUserId: string,
    actorUserType: string,
    query: QueryEmployeePerformanceReportDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access employee performance reports.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    if (actorContext.effectiveDataScope === DataScope.OWN) {
      throw new ForbiddenException(
        'Performance reports require departmental or administrative scope.',
      );
    }

    const userWhere: Prisma.UserWhereInput = {
      deletedAt: null,
      userType: { code: 'EMPLOYEE' },
    };

    if (actorContext.effectiveDataScope === DataScope.DEPARTMENT) {
      userWhere.departments = { some: { departmentId: { in: actorContext.departmentIds } } };
    }

    if (query.departmentId) {
      if (
        actorContext.effectiveDataScope === DataScope.DEPARTMENT &&
        !actorContext.departmentIds.includes(query.departmentId)
      ) {
        throw new ForbiddenException('Access denied to specified department.');
      }
      userWhere.departments = { some: { departmentId: query.departmentId } };
    }

    if (query.employeeId) {
      userWhere.id = query.employeeId;
    }

    const totalUsers = await this.prisma.user.count({ where: userWhere });
    const page = query.page || 1;
    const limit = query.limit || 20;
    const totalPages = Math.ceil(totalUsers / limit) || 1;

    const users = await this.prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        userCode: true,
        name: true,
        email: true,
        departments: { include: { department: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { name: 'asc' },
    });

    const now = new Date();
    const todayStartUtc = parseKolkataDateToUtc(getKolkataDateString(now));

    let rangeStartUtc: Date | undefined;
    let rangeEndUtc: Date | undefined;
    if (query.startDate) {
      rangeStartUtc = new Date(parseKolkataDateToUtc(query.startDate).getTime() - IST_OFFSET_MS);
    }
    if (query.endDate) {
      rangeEndUtc = new Date(
        parseKolkataDateToUtc(query.endDate).getTime() + 24 * 60 * 60 * 1000 - IST_OFFSET_MS,
      );
    }

    const results = [];
    for (const emp of users) {
      const baseTaskWhere: Prisma.TaskWhereInput = {
        assigneeId: emp.id,
        deletedAt: null,
      };

      const metrics = await this.calculateCompletionMetrics(
        baseTaskWhere,
        query.startDate,
        query.endDate,
      );

      const assignedTaskCount =
        query.startDate || query.endDate
          ? metrics.denominator
          : await this.prisma.task.count({ where: baseTaskWhere });

      const completedTaskCount = metrics.numerator;
      const completionPercentage = metrics.completionPercentage;

      const pendingTaskCount =
        query.startDate || query.endDate
          ? Math.max(0, metrics.denominator - metrics.numerator)
          : await this.prisma.task.count({
              where: {
                ...baseTaskWhere,
                status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
              },
            });

      const overdueTaskCount = await this.prisma.task.count({
        where: {
          ...baseTaskWhere,
          dueDate: { lt: todayStartUtc },
          status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
        },
      });

      const tasksAwaitingReview = await this.prisma.task.count({
        where: {
          ...baseTaskWhere,
          status: TaskStatus.IN_REVIEW,
        },
      });

      // Tracked working hours for employee
      const empTimeAgg = await this.prisma.taskTimeEntry.aggregate({
        where: {
          userId: emp.id,
          isSuperseded: false,
          ...(rangeStartUtc || rangeEndUtc
            ? {
                AND: [
                  ...(rangeStartUtc
                    ? [{ OR: [{ endedAt: { gte: rangeStartUtc } }, { endedAt: null }] }]
                    : []),
                  ...(rangeEndUtc ? [{ startedAt: { lt: rangeEndUtc } }] : []),
                ],
              }
            : {}),
        },
        _sum: { durationSeconds: true },
      });
      const totalSeconds = empTimeAgg._sum.durationSeconds || 0;
      const totalTrackedHours = Number((totalSeconds / 3600).toFixed(2));

      results.push({
        employee: {
          id: emp.id,
          userCode: emp.userCode,
          name: emp.name,
          email: emp.email,
          departments: emp.departments.map((d) => d.department.name),
        },
        assignedTaskCount,
        completedTaskCount,
        pendingTaskCount,
        overdueTaskCount,
        tasksAwaitingReview,
        completionPercentage,
        totalTrackedHours,
      });
    }

    return {
      success: true,
      message: 'Employee performance report retrieved successfully.',
      data: results,
      pagination: {
        page,
        limit,
        totalItems: totalUsers,
        totalPages,
      },
    };
  }

  /**
   * 7. Overdue Tasks Report (GET /api/tasks/reports/overdue)
   */
  async getOverdueTasksReport(
    actorUserId: string,
    actorUserType: string,
    query: QueryOverdueTasksReportDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access overdue task reports.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    if (
      query.departmentId &&
      actorContext.effectiveDataScope === DataScope.DEPARTMENT &&
      !actorContext.departmentIds.includes(query.departmentId)
    ) {
      throw new ForbiddenException('Access denied to specified department.');
    }

    if (
      query.assigneeId &&
      actorContext.effectiveDataScope === DataScope.OWN &&
      query.assigneeId !== actorUserId
    ) {
      throw new ForbiddenException('You can only view overdue reports for your own tasks.');
    }

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);
    const now = new Date();
    const todayStartUtc = parseKolkataDateToUtc(getKolkataDateString(now));

    const filterAnd: Prisma.TaskWhereInput[] = [
      visibilityWhere,
      { dueDate: { lt: todayStartUtc } },
      { status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
    ];

    if (query.departmentId) filterAnd.push({ departmentId: query.departmentId });
    if (query.assigneeId) filterAnd.push({ assigneeId: query.assigneeId });
    if (query.priority) filterAnd.push({ priority: query.priority });

    const where: Prisma.TaskWhereInput = { AND: filterAnd };

    const totalItems = await this.prisma.task.count({ where });
    const page = query.page || 1;
    const limit = query.limit || 20;
    const totalPages = Math.ceil(totalItems / limit) || 1;

    let orderBy: Prisma.TaskOrderByWithRelationInput = { dueDate: 'asc' };
    const sortDirection = query.sortOrder === ReportSortOrder.DESC ? 'desc' : 'asc';
    if (query.sortBy === OverdueSortBy.PRIORITY) {
      orderBy = { priority: sortDirection };
    } else if (query.sortBy === OverdueSortBy.CREATED_AT) {
      orderBy = { createdAt: sortDirection };
    } else if (query.sortBy === OverdueSortBy.TITLE) {
      orderBy = { title: sortDirection };
    } else {
      orderBy = { dueDate: sortDirection };
    }

    const tasks = await this.prisma.task.findMany({
      where,
      include: {
        assignee: { select: { id: true, userCode: true, name: true, email: true } },
        createdByUser: { select: { id: true, userCode: true, name: true, email: true } },
        department: { select: { id: true, code: true, name: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy,
    });

    const items = tasks.map((task) => {
      const daysOverdue = task.dueDate
        ? Math.max(
            1,
            Math.floor((todayStartUtc.getTime() - task.dueDate.getTime()) / (1000 * 60 * 60 * 24)),
          )
        : 0;

      return {
        id: task.id,
        taskCode: task.taskCode,
        title: task.title,
        priority: task.priority,
        currentStatus: task.status,
        dueDate: task.dueDate,
        daysOverdue,
        assignee: task.assignee
          ? { id: task.assignee.id, userCode: task.assignee.userCode, name: task.assignee.name }
          : null,
        creator: {
          id: task.createdByUser.id,
          userCode: task.createdByUser.userCode,
          name: task.createdByUser.name,
        },
        department: {
          id: task.department.id,
          code: task.department.code,
          name: task.department.name,
        },
      };
    });

    return {
      success: true,
      message: 'Overdue tasks report retrieved successfully.',
      data: items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
      },
    };
  }

  /**
   * 8. Review Summary Report (GET /api/tasks/reports/reviews)
   */
  async getReviewSummaryReport(
    actorUserId: string,
    actorUserType: string,
    query: QueryReviewSummaryReportDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot access review reports.');
    }

    const actorContext = await resolveActorTaskContext(
      this.prisma,
      this.usersService,
      actorUserId,
      actorUserType,
      'reports.view',
    );

    if (actorContext.effectiveDataScope === DataScope.OWN) {
      throw new ForbiddenException(
        'Review summary report requires departmental or administrative scope.',
      );
    }

    if (
      query.departmentId &&
      actorContext.effectiveDataScope === DataScope.DEPARTMENT &&
      !actorContext.departmentIds.includes(query.departmentId)
    ) {
      throw new ForbiddenException('Access denied to specified department.');
    }

    const visibilityWhere = buildTaskVisibilityWhere(actorContext);
    const filterAnd: Prisma.TaskReviewWhereInput[] = [{ task: visibilityWhere }];

    if (query.departmentId) {
      filterAnd.push({ task: { departmentId: query.departmentId } });
    }
    if (query.reviewerId) {
      filterAnd.push({ reviewerId: query.reviewerId });
    }
    if (query.submitterId) {
      filterAnd.push({ submitterId: query.submitterId });
    }
    if (query.outcome) {
      filterAnd.push({ outcome: query.outcome });
    }

    if (query.startDate || query.endDate) {
      filterAnd.push({
        submittedAt: {
          gte: query.startDate ? parseKolkataDateToUtc(query.startDate) : undefined,
          lte: query.endDate
            ? new Date(parseKolkataDateToUtc(query.endDate).getTime() + 24 * 60 * 60 * 1000 - 1)
            : undefined,
        },
      });
    }

    const where: Prisma.TaskReviewWhereInput = { AND: filterAnd };

    const outcomeGroups = await this.prisma.taskReview.groupBy({
      by: ['outcome'],
      where,
      _count: { id: true },
    });

    const outcomeCounts: Record<TaskReviewOutcome, number> = {
      [TaskReviewOutcome.PENDING]: 0,
      [TaskReviewOutcome.APPROVED]: 0,
      [TaskReviewOutcome.CHANGES_REQUESTED]: 0,
      [TaskReviewOutcome.REJECTED]: 0,
    };
    for (const group of outcomeGroups) {
      outcomeCounts[group.outcome] = group._count.id;
    }

    const pendingReviews = await this.prisma.taskReview.findMany({
      where: {
        AND: [...filterAnd, { outcome: TaskReviewOutcome.PENDING }],
      },
      include: {
        reviewer: { select: { id: true, name: true, userCode: true } },
      },
    });

    const reviewerPendingMap = new Map<
      string,
      { reviewerId: string; reviewerName: string; count: number }
    >();
    for (const r of pendingReviews) {
      const revId = r.reviewerId || 'UNASSIGNED';
      const revName = r.reviewer?.name || 'Unassigned Reviewer';
      if (!reviewerPendingMap.has(revId)) {
        reviewerPendingMap.set(revId, { reviewerId: revId, reviewerName: revName, count: 0 });
      }
      reviewerPendingMap.get(revId)!.count += 1;
    }

    const finalizedReviews = await this.prisma.taskReview.findMany({
      where: {
        AND: [
          ...filterAnd,
          { outcome: { not: TaskReviewOutcome.PENDING } },
          { reviewedAt: { not: null } },
        ],
      },
      select: {
        submittedAt: true,
        reviewedAt: true,
      },
    });

    let totalTurnaroundSeconds = 0;
    for (const r of finalizedReviews) {
      if (r.reviewedAt) {
        totalTurnaroundSeconds += Math.max(
          0,
          Math.floor((r.reviewedAt.getTime() - r.submittedAt.getTime()) / 1000),
        );
      }
    }

    const finalizedCount = finalizedReviews.length;
    const avgTurnaroundSeconds =
      finalizedCount > 0 ? Math.floor(totalTurnaroundSeconds / finalizedCount) : 0;
    const avgTurnaroundHours = Number((avgTurnaroundSeconds / 3600).toFixed(2));

    return {
      success: true,
      message: 'Review summary report retrieved successfully.',
      data: {
        totalReviews: Object.values(outcomeCounts).reduce((a, b) => a + b, 0),
        awaitingReviewCount: outcomeCounts[TaskReviewOutcome.PENDING],
        approvedCount: outcomeCounts[TaskReviewOutcome.APPROVED],
        changesRequestedCount: outcomeCounts[TaskReviewOutcome.CHANGES_REQUESTED],
        rejectedCount: outcomeCounts[TaskReviewOutcome.REJECTED],
        reviewerPendingCounts: Array.from(reviewerPendingMap.values()),
        turnaroundMetrics: {
          finalizedCount,
          avgTurnaroundSeconds,
          avgTurnaroundHours,
        },
      },
    };
  }
}

