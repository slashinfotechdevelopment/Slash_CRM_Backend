import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  calculateCompletionRate,
  calculateConversionRate,
  calculateSessionDurationSeconds,
  computeIsOnline,
  computeIsOverdue,
  formatDurationHuman,
  getKolkataDateString,
  ONLINE_THRESHOLD_MS,
  resolveAdminDateRange,
} from './admin-dashboard.utils';
import {
  QueryDateRangeDto,
  QueryEmployeeActivityDto,
  QueryEmployeeSessionsDto,
  QueryEmployeeTasksDto,
  QueryLeadTrendDto,
} from './dto';
import {
  LeadSource,
  LeadStatus,
  Prisma,
  RecordStatus,
  SessionStatus,
  TaskStatus,
} from '../../generated/prisma/client';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // A) EMPLOYEE ACTIVITY (LOGIN/LOGOUT)
  // ===========================================================================

  /**
   * Retrieves high-level login/logout activity and active duration per employee in range.
   * Online status = ACTIVE session with lastUsedAt within the last 20 minutes (ONLINE_THRESHOLD_MS).
   * Session duration = (revokedAt ?? lastUsedAt) - createdAt.
   */
  async getEmployeeActivity(query: QueryEmployeeActivityDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const userWhere: Prisma.UserWhereInput = {
      deletedAt: null,
    };

    if (query.employeeId) {
      userWhere.id = query.employeeId;
    } else {
      userWhere.userType = { code: { not: 'CLIENT' } };
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where: userWhere }),
      this.prisma.user.findMany({
        where: userWhere,
        skip,
        take: limit,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          userCode: true,
          employeeProfile: {
            select: { designation: true },
          },
          departments: {
            select: {
              department: { select: { id: true, name: true, code: true } },
            },
          },
        },
      }),
    ]);

    const userIds = users.map((u) => u.id);

    // 1. Fetch active sessions within the 20-minute cutoff to determine online status
    const onlineCutoff = new Date(Date.now() - ONLINE_THRESHOLD_MS);
    const activeOnlineSessions = await this.prisma.userSession.findMany({
      where: {
        userId: { in: userIds },
        status: SessionStatus.ACTIVE,
        OR: [
          { lastUsedAt: { gte: onlineCutoff } },
          { AND: [{ lastUsedAt: null }, { createdAt: { gte: onlineCutoff } }] },
        ],
      },
      select: { userId: true },
    });
    const onlineUserIds = new Set(activeOnlineSessions.map((s) => s.userId));

    // 2. Fetch all sessions in range for duration and count aggregations
    const sessionsInRange = await this.prisma.userSession.findMany({
      where: {
        userId: { in: userIds },
        createdAt: { gte: from, lte: to },
      },
      select: {
        userId: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // 3. Fetch absolute latest session per user for lastLogin / lastLogout
    const latestSessions = await this.prisma.userSession.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['userId'],
      select: {
        userId: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
        status: true,
      },
    });
    const latestSessionMap = new Map(latestSessions.map((s) => [s.userId, s]));

    // Group sessions in range by user
    const userSessionsMap = new Map<string, typeof sessionsInRange>();
    for (const session of sessionsInRange) {
      const list = userSessionsMap.get(session.userId) || [];
      list.push(session);
      userSessionsMap.set(session.userId, list);
    }

    const items = users.map((user) => {
      const userSessions = userSessionsMap.get(user.id) || [];
      const latest = latestSessionMap.get(user.id);

      let totalDurationSecs = 0;
      for (const s of userSessions) {
        totalDurationSecs += calculateSessionDurationSeconds(s);
      }

      return {
        employeeId: user.id,
        employeeName: user.name,
        employeeCode: user.userCode,
        email: user.email,
        department: user.departments[0]?.department?.name || null,
        designation: user.employeeProfile?.designation || null,
        status: onlineUserIds.has(user.id) ? ('online' as const) : ('offline' as const),
        lastLogin: latest?.createdAt ? latest.createdAt.toISOString() : null,
        lastLogout: latest?.revokedAt ? latest.revokedAt.toISOString() : null,
        totalSessions: userSessions.length,
        totalActiveDurationSeconds: totalDurationSecs,
        totalActiveDurationFormatted: formatDurationHuman(totalDurationSecs),
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  /**
   * Retrieves full paginated login/logout session history for a specific employee.
   */
  async getEmployeeSessions(employeeId: string, query: QueryEmployeeSessionsDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        email: true,
        userCode: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Employee with ID "${employeeId}" not found.`);
    }

    const { from, to } = resolveAdminDateRange(query.from, query.to);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.UserSessionWhereInput = {
      userId: employeeId,
      createdAt: { gte: from, lte: to },
    };

    const [total, sessions] = await Promise.all([
      this.prisma.userSession.count({ where }),
      this.prisma.userSession.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          revokedAt: true,
          lastUsedAt: true,
          expiresAt: true,
          status: true,
          ipAddress: true,
          userAgent: true,
          deviceName: true,
        },
      }),
    ]);

    const items = sessions.map((s) => {
      const durationSeconds = calculateSessionDurationSeconds(s);
      return {
        sessionId: s.id,
        loginAt: s.createdAt.toISOString(),
        logoutAt: s.revokedAt ? s.revokedAt.toISOString() : null,
        lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null,
        expiresAt: s.expiresAt.toISOString(),
        status: s.status,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        deviceName: s.deviceName,
        durationSeconds,
        durationFormatted: formatDurationHuman(durationSeconds),
      };
    });

    return {
      employee: {
        id: user.id,
        name: user.name,
        email: user.email,
        code: user.userCode,
      },
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  // ===========================================================================
  // B) EMPLOYEE TASKS
  // ===========================================================================

  /**
   * Retrieves an employee's tasks with computed status (completed, pending, overdue),
   * due date, and latest completed date.
   */
  async getEmployeeTasks(employeeId: string, query: QueryEmployeeTasksDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        email: true,
        userCode: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Employee with ID "${employeeId}" not found.`);
    }

    const { from, to } = resolveAdminDateRange(query.from, query.to);
    const now = new Date();

    const baseWhere: Prisma.TaskWhereInput = {
      assigneeId: employeeId,
      deletedAt: null,
      createdAt: { gte: from, lte: to },
    };

    // If a raw status or high-level filter is provided:
    if (query.status) {
      const s = query.status.toUpperCase();
      if (s === 'COMPLETED') {
        baseWhere.status = TaskStatus.COMPLETED;
      } else if (s === 'CANCELLED') {
        baseWhere.status = TaskStatus.CANCELLED;
      } else if (s === 'OVERDUE') {
        baseWhere.status = { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] };
        baseWhere.dueDate = { lt: now };
      } else if (s === 'PENDING') {
        baseWhere.status = { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] };
        baseWhere.OR = [{ dueDate: null }, { dueDate: { gte: now } }];
      } else if (Object.values(TaskStatus).includes(s as TaskStatus)) {
        baseWhere.status = s as TaskStatus;
      }
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [total, tasks] = await Promise.all([
      this.prisma.task.count({ where: baseWhere }),
      this.prisma.task.findMany({
        where: baseWhere,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          taskCode: true,
          title: true,
          priority: true,
          status: true,
          progress: true,
          startDate: true,
          dueDate: true,
          createdAt: true,
          statusHistory: {
            where: { newStatus: TaskStatus.COMPLETED },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      }),
    ]);

    const items = tasks.map((task) => {
      let computedStatus: 'completed' | 'pending' | 'overdue' | 'cancelled';
      if (task.status === TaskStatus.CANCELLED) {
        computedStatus = 'cancelled';
      } else if (task.status === TaskStatus.COMPLETED) {
        computedStatus = 'completed';
      } else if (computeIsOverdue(task, now)) {
        computedStatus = 'overdue';
      } else {
        computedStatus = 'pending';
      }

      const completedDate = task.statusHistory[0]?.createdAt
        ? task.statusHistory[0].createdAt.toISOString()
        : null;

      return {
        id: task.id,
        taskCode: task.taskCode,
        title: task.title,
        priority: task.priority,
        rawStatus: task.status,
        computedStatus,
        progress: task.progress,
        startDate: task.startDate ? task.startDate.toISOString().split('T')[0] : null,
        dueDate: task.dueDate ? task.dueDate.toISOString().split('T')[0] : null,
        completedDate,
        createdAt: task.createdAt.toISOString(),
      };
    });

    return {
      employee: {
        id: user.id,
        name: user.name,
        email: user.email,
        code: user.userCode,
      },
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  /**
   * Aggregates tasks summary per employee (total, completed, pending, overdue, completion rate %).
   * Excludes CANCELLED tasks from total and completion percentage rate calculations.
   */
  async getTasksSummary(query: QueryDateRangeDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);
    const now = new Date();

    const tasks = await this.prisma.task.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        deletedAt: null,
        assigneeId: { not: null },
      },
      include: {
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            userCode: true,
            departments: { select: { department: { select: { name: true } } } },
          },
        },
      },
    });

    // Group by assignee
    const employeeMap = new Map<
      string,
      {
        employee: {
          id: string;
          name: string;
          email: string;
          code: string;
          department: string | null;
        };
        total: number;
        completed: number;
        pending: number;
        overdue: number;
        cancelled: number;
      }
    >();

    for (const task of tasks) {
      if (!task.assigneeId || !task.assignee) continue;
      const empId = task.assigneeId;

      let entry = employeeMap.get(empId);
      if (!entry) {
        entry = {
          employee: {
            id: task.assignee.id,
            name: task.assignee.name,
            email: task.assignee.email,
            code: task.assignee.userCode,
            department: task.assignee.departments[0]?.department?.name || null,
          },
          total: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          cancelled: 0,
        };
        employeeMap.set(empId, entry);
      }

      if (task.status === TaskStatus.CANCELLED) {
        entry.cancelled++;
        continue;
      }

      entry.total++;

      if (task.status === TaskStatus.COMPLETED) {
        entry.completed++;
      } else {
        entry.pending++;
        if (computeIsOverdue(task, now)) {
          entry.overdue++;
        }
      }
    }

    const summary = Array.from(employeeMap.values()).map((e) => {
      const completionRatePercentage = calculateCompletionRate(e.completed, e.total);
      return {
        employeeId: e.employee.id,
        employeeName: e.employee.name,
        employeeCode: e.employee.code,
        email: e.employee.email,
        department: e.employee.department,
        totalTasks: e.total,
        completedTasks: e.completed,
        pendingTasks: e.pending,
        overdueTasks: e.overdue,
        cancelledTasks: e.cancelled,
        completionRatePercentage,
      };
    });

    summary.sort((a, b) => b.completedTasks - a.completedTasks);

    return {
      summary,
      totalEmployees: summary.length,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  // ===========================================================================
  // C) LEAD MANAGEMENT DASHBOARD (SUPER ADMIN ONLY)
  // ===========================================================================

  /**
   * Retrieves overall lead metrics summary in date range.
   * - "new leads": createdAt in range.
   * - "converted leads": convertedAt in range.
   * - "conversion rate": (leads created in range that are converted) / (leads created in range).
   */
  async getLeadsSummary(query: QueryDateRangeDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);

    const [
      newLeads,
      convertedLeads,
      lostLeads,
      createdAndConvertedCount,
      stages,
      statusGroups,
      unassignedNewLeadsCount,
    ] = await Promise.all([
      this.prisma.lead.count({
        where: { createdAt: { gte: from, lte: to }, deletedAt: null },
      }),
      this.prisma.lead.count({
        where: { convertedAt: { gte: from, lte: to }, deletedAt: null },
      }),
      this.prisma.lead.count({
        where: {
          status: LeadStatus.LOST,
          updatedAt: { gte: from, lte: to },
          deletedAt: null,
        },
      }),
      this.prisma.lead.count({
        where: {
          createdAt: { gte: from, lte: to },
          status: LeadStatus.CONVERTED,
          deletedAt: null,
        },
      }),
      this.prisma.pipelineStage.findMany({
        where: { status: RecordStatus.ACTIVE },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          color: true,
          _count: {
            select: {
              leads: {
                where: { createdAt: { gte: from, lte: to }, deletedAt: null },
              },
            },
          },
        },
      }),
      this.prisma.lead.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lte: to }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.lead.count({
        where: {
          pipelineStageId: null,
          createdAt: { gte: from, lte: to },
          deletedAt: null,
        },
      }),
    ]);

    const countByStage = stages.map((s, idx) => {
      const extra = (s.code === 'NEW' || idx === 0) ? unassignedNewLeadsCount : 0;
      return {
        stageId: s.id,
        stageCode: s.code,
        stageName: s.name,
        color: s.color,
        count: s._count.leads + extra,
      };
    });

    const countByStatus: Record<string, number> = {};
    for (const g of statusGroups) {
      countByStatus[g.status] = g._count._all;
    }

    const conversionRatePercentage = calculateConversionRate(
      createdAndConvertedCount,
      newLeads,
    );

    return {
      newLeads,
      convertedLeads,
      lostLeads,
      conversionRatePercentage,
      countByStage,
      countByStatus,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  /**
   * Retrieves lead metrics aggregated per employee (leads assigned, converted, conversion rate %).
   */
  async getLeadsByEmployee(query: QueryDateRangeDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);

    const [assignedGroups, convertedGroups, createdAndConvertedGroups] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          createdAt: { gte: from, lte: to },
          assignedToId: { not: null },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          convertedAt: { gte: from, lte: to },
          assignedToId: { not: null },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          createdAt: { gte: from, lte: to },
          status: LeadStatus.CONVERTED,
          assignedToId: { not: null },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
    ]);

    const employeeIds = Array.from(
      new Set([
        ...assignedGroups.map((g) => g.assignedToId!),
        ...convertedGroups.map((g) => g.assignedToId!),
      ]),
    );

    const users = await this.prisma.user.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true,
        name: true,
        email: true,
        userCode: true,
      },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const assignedMap = new Map(assignedGroups.map((g) => [g.assignedToId!, g._count._all]));
    const convertedMap = new Map(convertedGroups.map((g) => [g.assignedToId!, g._count._all]));
    const createdAndConvertedMap = new Map(
      createdAndConvertedGroups.map((g) => [g.assignedToId!, g._count._all]),
    );

    const items = employeeIds.map((id) => {
      const user = userMap.get(id);
      const leadsAssigned = assignedMap.get(id) || 0;
      const leadsConverted = convertedMap.get(id) || 0;
      const createdAndConverted = createdAndConvertedMap.get(id) || 0;
      const conversionRatePercentage = calculateConversionRate(createdAndConverted, leadsAssigned);

      return {
        employeeId: id,
        employeeName: user?.name || 'Unknown',
        employeeCode: user?.userCode || null,
        email: user?.email || null,
        leadsAssigned,
        leadsConverted,
        conversionRatePercentage,
      };
    });

    items.sort((a, b) => b.leadsConverted - a.leadsConverted);

    return {
      items,
      totalEmployees: items.length,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  /**
   * Retrieves lead trend over time (new leads vs converted leads) grouped by day, week, or month.
   */
  async getLeadsTrend(query: QueryLeadTrendDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);
    const interval = query.interval || 'day';

    const [newLeads, convertedLeads] = await Promise.all([
      this.prisma.lead.findMany({
        where: { createdAt: { gte: from, lte: to }, deletedAt: null },
        select: { createdAt: true },
      }),
      this.prisma.lead.findMany({
        where: { convertedAt: { gte: from, lte: to }, deletedAt: null },
        select: { convertedAt: true },
      }),
    ]);

    const formatPeriodKey = (date: Date): string => {
      const kolkataYmd = getKolkataDateString(date); // YYYY-MM-DD
      if (interval === 'month') {
        return kolkataYmd.slice(0, 7); // YYYY-MM
      }
      if (interval === 'week') {
        const d = new Date(date);
        const day = d.getUTCDay();
        const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
        const monday = new Date(d.setUTCDate(diff));
        return getKolkataDateString(monday);
      }
      return kolkataYmd;
    };

    const buckets = new Map<string, { newLeads: number; convertedLeads: number }>();

    for (const lead of newLeads) {
      const key = formatPeriodKey(lead.createdAt);
      const b = buckets.get(key) || { newLeads: 0, convertedLeads: 0 };
      b.newLeads++;
      buckets.set(key, b);
    }

    for (const lead of convertedLeads) {
      if (!lead.convertedAt) continue;
      const key = formatPeriodKey(lead.convertedAt);
      const b = buckets.get(key) || { newLeads: 0, convertedLeads: 0 };
      b.convertedLeads++;
      buckets.set(key, b);
    }

    const periods = Array.from(buckets.keys()).sort();
    const trend = periods.map((period) => {
      const data = buckets.get(period)!;
      return {
        period,
        newLeads: data.newLeads,
        convertedLeads: data.convertedLeads,
      };
    });

    return {
      interval,
      trend,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }

  /**
   * Retrieves lead counts and conversion metrics grouped by lead source.
   */
  async getLeadsBySource(query: QueryDateRangeDto) {
    const { from, to } = resolveAdminDateRange(query.from, query.to);

    const [totalGroups, convertedGroups] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['source'],
        where: { createdAt: { gte: from, lte: to }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['source'],
        where: {
          createdAt: { gte: from, lte: to },
          status: LeadStatus.CONVERTED,
          deletedAt: null,
        },
        _count: { _all: true },
      }),
    ]);

    const convertedMap = new Map(convertedGroups.map((g) => [g.source, g._count._all]));

    const items = totalGroups.map((g) => {
      const count = g._count._all;
      const convertedCount = convertedMap.get(g.source) || 0;
      const conversionRatePercentage = calculateConversionRate(convertedCount, count);

      return {
        source: g.source,
        count,
        convertedCount,
        conversionRatePercentage,
      };
    });

    items.sort((a, b) => b.count - a.count);

    return {
      items,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }
}
