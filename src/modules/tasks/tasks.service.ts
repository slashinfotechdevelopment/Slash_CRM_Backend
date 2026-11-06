import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TaskCodeService } from './task-code.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import { TasksWorkflowService } from './tasks-workflow.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { CreateTaskTagDto } from './dto/create-task-tag.dto';
import { QueryTasksDto, TaskSortBy, SortOrder } from './dto/query-tasks.dto';
import { QueryMyTasksDto } from './dto/query-my-tasks.dto';
import {
  buildTaskVisibilityWhere,
  TaskActorContext,
} from './tasks-visibility.helper';
import {
  Prisma,
  RecordStatus,
  TaskPriority,
  TaskStatus,
} from '../../generated/prisma/client';
import {
  DataScope,
  TaskPauseReason,
  TaskTimerStatus,
} from '../../generated/prisma/enums';

class StaleAssigneeDiscoveryException extends Error {
  constructor(public readonly actualAssigneeId: string | null) {
    super(`Task assignee altered prior to lock acquisition.`);
  }
}

function parseCalendarDate(dateStr?: string): Date {
  if (!dateStr) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taskCodeService: TaskCodeService,
    private readonly usersService: UsersService,
    private readonly taskTimerAutoPauseService: TaskTimerAutoPauseService,
    private readonly tasksWorkflowService: TasksWorkflowService,
  ) { }

  /**
   * Resolves actor context for visibility queries.
   */
  private async buildActorContext(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string,
  ): Promise<TaskActorContext> {
    const effectiveDataScope = await this.usersService.resolveActorDataScope(
      actorUserId,
      actorUserType,
      permissionCode,
    );

    // Fetch actor's accessible departments
    const userDepts =
      (await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      })) || [];
    const departmentIds = userDepts.map((d) => d.departmentId);

    // Fetch direct subordinates (where reportingToId is actor)
    const subordinates =
      (await this.prisma.employeeProfile.findMany({
        where: { reportingToId: actorUserId },
        select: { userId: true },
      })) || [];
    const subordinateUserIds = subordinates.map((s) => s.userId);

    return {
      userId: actorUserId,
      userType: actorUserType,
      departmentIds,
      subordinateUserIds,
      effectiveDataScope,
    };
  }

  /**
   * Resolves the primary department for a given user.
   */
  private async resolveUserDepartment(userId: string): Promise<string> {
    const userDepts = await this.prisma.userDepartment.findMany({
      where: { userId },
      orderBy: { isPrimary: 'desc' },
      select: { departmentId: true },
    });

    if (userDepts.length === 0) {
      throw new BadRequestException(
        `User ${userId} is not assigned to any active department. Cannot determine task department.`,
      );
    }

    return userDepts[0].departmentId;
  }

  /**
   * Creates a new task atomically.
   */
  async createTask(
    actorUserId: string,
    actorUserType: string,
    dto: CreateTaskDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot create internal tasks.');
    }

    let targetAssigneeId: string | null = null;
    let targetDepartmentId: string;

    // Determine assignee
    if (dto.assigneeId) {
      targetAssigneeId = dto.assigneeId;

      if (targetAssigneeId !== actorUserId) {
        // Assigning to someone else requires tasks.assign permission (unless SUPER_ADMIN)
        if (actorUserType !== 'SUPER_ADMIN') {
          const canAssign = await this.checkUserPermission(actorUserId, 'tasks.assign');
          if (!canAssign) {
            throw new ForbiddenException(
              'You do not have permission to assign tasks to other employees.',
            );
          }
        }

        // Validate target assignee exists, is active, not deleted, and is an employee/admin
        const targetUser = await this.prisma.user.findUnique({
          where: { id: targetAssigneeId },
          include: { userType: true },
        });

        if (!targetUser || targetUser.deletedAt || targetUser.status !== RecordStatus.ACTIVE) {
          throw new BadRequestException('Target assignee user is invalid or inactive.');
        }

        if (targetUser.userType.code === 'CLIENT') {
          throw new BadRequestException('Tasks cannot be assigned to client accounts.');
        }

        if (actorUserType === 'EMPLOYEE' && targetUser.userType.code !== 'EMPLOYEE') {
          throw new ForbiddenException('Employees cannot assign tasks to Admins or Super Admins.');
        }

        targetDepartmentId = await this.resolveUserDepartment(targetAssigneeId);
      } else {
        // Self-assignment
        targetDepartmentId = await this.resolveUserDepartment(actorUserId);
      }
    } else {
      // If omitted, self-created task defaults to creator for Employees
      if (actorUserType === 'EMPLOYEE') {
        targetAssigneeId = actorUserId;
        targetDepartmentId = await this.resolveUserDepartment(actorUserId);
      } else {
        // Admins can create unassigned drafts; department derives from creator
        targetAssigneeId = null;
        targetDepartmentId = await this.resolveUserDepartment(actorUserId);
      }
    }

    // Validate dates
    const startDate = parseCalendarDate(dto.startDate);
    let dueDate: Date | null = null;
    if (dto.dueDate) {
      dueDate = parseCalendarDate(dto.dueDate);
      if (dueDate < startDate) {
        throw new BadRequestException('dueDate cannot be earlier than startDate.');
      }
    }

    // Execute atomic creation transaction
    return this.prisma.$transaction(
      async (tx) => {
        const taskCode = await this.taskCodeService.generateNextCode(tx);

        const task = await tx.task.create({
          data: {
            taskCode,
            title: dto.title,
            description: dto.description,
            priority: dto.priority || TaskPriority.MEDIUM,
            status: TaskStatus.TODO,
            category: dto.category || 'GENERAL',
            progress: 0,
            startDate,
            dueDate,
            estimatedHours: dto.estimatedHours ? new Prisma.Decimal(dto.estimatedHours) : null,
            createdById: actorUserId,
            assigneeId: targetAssigneeId,
            assignedById: targetAssigneeId ? actorUserId : null,
            assignedAt: targetAssigneeId ? new Date() : null,
            departmentId: targetDepartmentId,
          },
        });

        // Record initial assignment history if assigned
        if (targetAssigneeId) {
          await tx.taskAssignmentHistory.create({
            data: {
              taskId: task.id,
              previousAssigneeId: null,
              newAssigneeId: targetAssigneeId,
              assignedById: actorUserId,
              reason: 'Initial task creation and assignment',
              assignedAt: new Date(),
            },
          });
        }

        // Record initial status history
        await tx.taskStatusHistory.create({
          data: {
            taskId: task.id,
            previousStatus: null,
            newStatus: TaskStatus.TODO,
            changedById: actorUserId,
            comment: 'Task created in backlog (TODO).',
          },
        });

        // Record activity log
        await tx.taskActivityLog.create({
          data: {
            taskId: task.id,
            performedBy: actorUserId,
            action: 'TASK_CREATED',
            metadata: {
              taskCode: task.taskCode,
              title: task.title,
              priority: task.priority,
              assigneeId: targetAssigneeId,
            },
          },
        });

        // Attach tags if provided
        if (dto.tags && dto.tags.length > 0) {
          for (const tagName of dto.tags) {
            const cleanName = tagName.trim().toLowerCase();
            if (cleanName) {
              const tag = await tx.taskTag.upsert({
                where: { name: cleanName },
                update: {},
                create: { name: cleanName },
              });
              await tx.taskTagMapping.create({
                data: {
                  taskId: task.id,
                  tagId: tag.id,
                },
              });
            }
          }
        }

        return tx.task.findUniqueOrThrow({
          where: { id: task.id },
          include: {
            createdByUser: {
              select: { id: true, userCode: true, name: true, email: true },
            },
            assignee: {
              select: { id: true, userCode: true, name: true, email: true },
            },
            assignedByUser: {
              select: { id: true, userCode: true, name: true, email: true },
            },
            department: {
              select: { id: true, code: true, name: true },
            },
            tagMappings: {
              include: { tag: true },
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      },
    );
  }

  /**
   * Lists tasks matching filters, pagination, and RBAC visibility.
   */
  async findTasks(
    actorUserId: string,
    actorUserType: string,
    query: QueryTasksDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal tasks.');
    }

    const actorContext = await this.buildActorContext(
      actorUserId,
      actorUserType,
      'tasks.view',
    );
    const visibilityWhere = buildTaskVisibilityWhere(actorContext);

    // Build filter conditions
    const filterAnd: Prisma.TaskWhereInput[] = [visibilityWhere];

    if (query.search) {
      const search = query.search.trim();
      filterAnd.push({
        OR: [
          { taskCode: { contains: search } },
          { title: { contains: search } },
          { description: { contains: search } },
        ],
      });
    }

    if (query.status) {
      filterAnd.push({ status: query.status });
    }

    if (query.priority) {
      filterAnd.push({ priority: query.priority });
    }

    if (query.category) {
      filterAnd.push({ category: query.category });
    }

    if (query.assigneeId) {
      filterAnd.push({ assigneeId: query.assigneeId });
    }

    if (query.createdById) {
      filterAnd.push({ createdById: query.createdById });
    }

    if (query.departmentId) {
      filterAnd.push({ departmentId: query.departmentId });
    }

    if (query.startDateFrom || query.startDateTo) {
      const startDateFilter: Prisma.DateTimeFilter = {};
      if (query.startDateFrom) startDateFilter.gte = parseCalendarDate(query.startDateFrom);
      if (query.startDateTo) startDateFilter.lte = parseCalendarDate(query.startDateTo);
      filterAnd.push({ startDate: startDateFilter });
    }

    if (query.dueDateFrom || query.dueDateTo) {
      const dueDateFilter: Prisma.DateTimeNullableFilter = {};
      if (query.dueDateFrom) dueDateFilter.gte = parseCalendarDate(query.dueDateFrom);
      if (query.dueDateTo) dueDateFilter.lte = parseCalendarDate(query.dueDateTo);
      filterAnd.push({ dueDate: dueDateFilter });
    }

    if (query.isOverdue) {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      filterAnd.push({
        dueDate: { lt: today },
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      });
    }

    const where: Prisma.TaskWhereInput = { AND: filterAnd };

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const sortBy = query.sortBy || TaskSortBy.CREATED_AT;
    const sortOrder = query.sortOrder || SortOrder.DESC;
    const orderBy: Prisma.TaskOrderByWithRelationInput = { [sortBy]: sortOrder };

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          createdByUser: {
            select: { id: true, userCode: true, name: true, email: true },
          },
          assignee: {
            select: { id: true, userCode: true, name: true, email: true },
          },
          department: {
            select: { id: true, code: true, name: true },
          },
          tagMappings: {
            include: { tag: true },
          },
        },
      }),
      this.prisma.task.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Tasks retrieved successfully',
      data: tasks,
      meta: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }

  /**
   * Retrieves the current user's personal assigned tasks.
   */
  async findMyTasks(
    actorUserId: string,
    actorUserType: string,
    query: QueryMyTasksDto,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal tasks.');
    }

    const filterAnd: Prisma.TaskWhereInput[] = [
      {
        deletedAt: null,
        OR: [
          { assigneeId: actorUserId },
          { createdById: actorUserId, assigneeId: null },
        ],
      },
    ];

    if (query.search) {
      const search = query.search.trim();
      filterAnd.push({
        OR: [
          { taskCode: { contains: search } },
          { title: { contains: search } },
          { description: { contains: search } },
        ],
      });
    }

    if (query.status) filterAnd.push({ status: query.status });
    if (query.priority) filterAnd.push({ priority: query.priority });
    if (query.category) filterAnd.push({ category: query.category });

    if (query.isOverdue) {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      filterAnd.push({
        dueDate: { lt: today },
        status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] },
      });
    }

    const where: Prisma.TaskWhereInput = { AND: filterAnd };

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const sortBy = query.sortBy || TaskSortBy.CREATED_AT;
    const sortOrder = query.sortOrder || SortOrder.DESC;
    const orderBy: Prisma.TaskOrderByWithRelationInput = { [sortBy]: sortOrder };

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          createdByUser: {
            select: { id: true, userCode: true, name: true, email: true },
          },
          assignee: {
            select: { id: true, userCode: true, name: true, email: true },
          },
          department: {
            select: { id: true, code: true, name: true },
          },
          tagMappings: {
            include: { tag: true },
          },
        },
      }),
      this.prisma.task.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Tasks retrieved successfully',
      data: tasks,
      meta: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }

  /**
   * Retrieves single task details with visibility enforcement.
   */
  async findTaskById(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal tasks.');
    }

    const actorContext = await this.buildActorContext(
      actorUserId,
      actorUserType,
      'tasks.view',
    );
    const visibilityWhere = buildTaskVisibilityWhere(actorContext);

    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        AND: [visibilityWhere],
      },
      include: {
        createdByUser: {
          select: { id: true, userCode: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, userCode: true, name: true, email: true },
        },
        assignedByUser: {
          select: { id: true, userCode: true, name: true, email: true },
        },
        department: {
          select: { id: true, code: true, name: true },
        },
        tagMappings: {
          include: { tag: true },
        },
        assignmentHistory: {
          orderBy: { assignedAt: 'desc' },
          take: 10,
          include: {
            previousAssignee: { select: { id: true, userCode: true, name: true } },
            newAssignee: { select: { id: true, userCode: true, name: true } },
            assignedByUser: { select: { id: true, userCode: true, name: true } },
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            changedByUser: { select: { id: true, userCode: true, name: true } },
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found.');
    }

    return task;
  }

  /**
   * Updates permitted task fields.
   */
  async updateTask(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: UpdateTaskDto,
  ) {
    // Assert task exists and is visible to actor
    const existingTask = await this.findTaskById(taskId, actorUserId, actorUserType);

    if (existingTask.deletedAt) {
      throw new BadRequestException('Cannot modify a deleted task.');
    }

    const updateData: Prisma.TaskUpdateInput = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.priority !== undefined) updateData.priority = dto.priority;
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.progress !== undefined) updateData.progress = dto.progress;
    if (dto.startDate !== undefined) updateData.startDate = parseCalendarDate(dto.startDate);
    if (dto.dueDate !== undefined) updateData.dueDate = parseCalendarDate(dto.dueDate);
    if (dto.estimatedHours !== undefined) {
      updateData.estimatedHours = new Prisma.Decimal(dto.estimatedHours);
    }

    let isStatusChanged = false;
    if (dto.status && dto.status !== existingTask.status) {
      const hasApprovePermission = await this.checkUserPermission(actorUserId, 'tasks.approve');
      this.tasksWorkflowService.validateStatusTransition(
        existingTask.status,
        dto.status,
        actorUserType,
        existingTask.assigneeId === actorUserId,
        hasApprovePermission,
      );
      isStatusChanged = true;
      updateData.status = dto.status;
      if (dto.status === TaskStatus.COMPLETED && dto.progress === undefined) {
        updateData.progress = 100;
      }
    }

    return this.prisma.$transaction(
      async (tx) => {
        // Auto-pause timer if transitioning to non-working status
        if (
          isStatusChanged &&
          existingTask.assigneeId &&
          (dto.status === TaskStatus.COMPLETED ||
            dto.status === TaskStatus.CANCELLED ||
            dto.status === TaskStatus.ON_HOLD ||
            dto.status === TaskStatus.IN_REVIEW)
        ) {
          await this.taskTimerAutoPauseService.autoPauseRunningTask(
            existingTask.assigneeId,
            TaskPauseReason.TASK_STATUS_CHANGE,
            `Task status changed to ${dto.status}`,
            tx,
          );
        }

        const updated = await tx.task.update({
          where: { id: taskId },
          data: updateData,
        });

        // Record status change history if status altered
        if (isStatusChanged) {
          await tx.taskStatusHistory.create({
            data: {
              taskId,
              previousStatus: existingTask.status,
              newStatus: dto.status!,
              changedById: actorUserId,
              comment: dto.statusComment || 'Task status updated.',
            },
          });
        }

        // Update tags if provided
        if (dto.tags !== undefined) {
          // Remove old mappings
          await tx.taskTagMapping.deleteMany({ where: { taskId } });

          for (const tagName of dto.tags) {
            const cleanName = tagName.trim().toLowerCase();
            if (cleanName) {
              const tag = await tx.taskTag.upsert({
                where: { name: cleanName },
                update: {},
                create: { name: cleanName },
              });
              await tx.taskTagMapping.create({
                data: { taskId, tagId: tag.id },
              });
            }
          }
        }

        // Record activity log
        await tx.taskActivityLog.create({
          data: {
            taskId,
            performedBy: actorUserId,
            action: 'TASK_UPDATED',
            metadata: {
              updatedFields: Object.keys(dto),
              previousStatus: isStatusChanged ? existingTask.status : undefined,
              newStatus: isStatusChanged ? dto.status : undefined,
            },
          },
        });

        return tx.task.findUniqueOrThrow({
          where: { id: taskId },
          include: {
            createdByUser: {
              select: { id: true, userCode: true, name: true, email: true },
            },
            assignee: {
              select: { id: true, userCode: true, name: true, email: true },
            },
            department: {
              select: { id: true, code: true, name: true },
            },
            tagMappings: {
              include: { tag: true },
            },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      },
    );
  }

  /**
   * Reassigns a task using the approved 3-tier lock hierarchy and closed discovery loop.
   */
  async reassignTask(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: AssignTaskDto,
    maxDiscoveryRetries = 3,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot reassign tasks.');
    }

    // Permission check: actor must have tasks.reassign or tasks.assign
    if (actorUserType !== 'SUPER_ADMIN') {
      const canReassign =
        (await this.checkUserPermission(actorUserId, 'tasks.reassign')) ||
        (await this.checkUserPermission(actorUserId, 'tasks.assign'));

      if (!canReassign) {
        throw new ForbiddenException(
          'You do not have permission to reassign tasks.',
        );
      }
    }

    // Assert task exists and is visible to actor within scope & ceiling
    await this.findTaskById(taskId, actorUserId, actorUserType);

    const targetNewAssigneeId = dto.assigneeId || null;

    // Validate new assignee if provided
    let newAssigneeDeptId: string | null = null;
    if (targetNewAssigneeId) {
      const newAssigneeUser = await this.prisma.user.findUnique({
        where: { id: targetNewAssigneeId },
        include: { userType: true },
      });

      if (!newAssigneeUser || newAssigneeUser.deletedAt || newAssigneeUser.status !== RecordStatus.ACTIVE) {
        throw new BadRequestException('Target new assignee user is invalid or inactive.');
      }

      if (newAssigneeUser.userType.code === 'CLIENT') {
        throw new BadRequestException('Tasks cannot be assigned to client accounts.');
      }

      if (actorUserType === 'EMPLOYEE' && newAssigneeUser.userType.code !== 'EMPLOYEE') {
        throw new ForbiddenException('Employees cannot assign tasks to Admins or Super Admins.');
      }

      newAssigneeDeptId = await this.resolveUserDepartment(targetNewAssigneeId);
    }

    let discoveryAttempt = 0;
    let knownAssigneeId: string | null = null;

    while (discoveryAttempt < maxDiscoveryRetries) {
      discoveryAttempt++;

      if (discoveryAttempt === 1) {
        const preliminary = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { id: true, assigneeId: true, deletedAt: true },
        });

        if (!preliminary || preliminary.deletedAt) {
          throw new NotFoundException('Task not found.');
        }

        knownAssigneeId = preliminary.assigneeId;
      }

      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // TIER 1: Lock candidate user rows in ascending ID order
            const candidateUserIds = Array.from(
              new Set([actorUserId, targetNewAssigneeId, knownAssigneeId].filter(Boolean) as string[]),
            ).sort();

            await tx.$queryRaw`
              SELECT id FROM users 
              WHERE id IN (${Prisma.join(candidateUserIds)}) 
              ORDER BY id ASC 
              FOR UPDATE
            `;

            // TIER 2: Lock the task row
            const [task] = await tx.$queryRaw<any[]>`
              SELECT id, assignee_id, department_id, status, deleted_at 
              FROM tasks 
              WHERE id = ${taskId} 
              FOR UPDATE
            `;

            if (!task || task.deleted_at) {
              throw new NotFoundException('Task not found.');
            }

            // VERIFICATION LOOP: Verify actual assignee inclusion
            const actualAssigneeId: string | null = task.assignee_id;
            if (actualAssigneeId && !candidateUserIds.includes(actualAssigneeId)) {
              knownAssigneeId = actualAssigneeId;
              throw new StaleAssigneeDiscoveryException(actualAssigneeId);
            }

            if ([TaskStatus.COMPLETED, TaskStatus.CANCELLED].includes(task.status)) {
              throw new BadRequestException('Cannot reassign a completed or cancelled task.');
            }

            // Department updates to new assignee's department (or retains creator's department if unassigned)
            const targetDepartmentId = newAssigneeDeptId || task.department_id;

            // If the previous assignee has an active running timer on this task, cleanly auto-pause it to preserve their work history
            if (actualAssigneeId && actualAssigneeId !== targetNewAssigneeId) {
              const activeTimer = await tx.$queryRaw<
                Array<{ id: string; started_at: Date }>
              >`
                SELECT id, started_at FROM task_time_entries 
                WHERE user_id = ${actualAssigneeId} AND task_id = ${taskId} AND ended_at IS NULL 
                LIMIT 1 FOR UPDATE
              `;

              if (activeTimer && activeTimer.length > 0) {
                const now = new Date();
                const startedAt = new Date(activeTimer[0].started_at);
                const durationSeconds = Math.max(
                  0,
                  Math.floor((now.getTime() - startedAt.getTime()) / 1000),
                );
                await tx.taskTimeEntry.update({
                  where: { id: activeTimer[0].id },
                  data: {
                    endedAt: now,
                    durationSeconds,
                    status: TaskTimerStatus.PAUSED,
                  },
                });

                await tx.taskTimePause.create({
                  data: {
                    taskId,
                    userId: actualAssigneeId,
                    precedingTimeEntryId: activeTimer[0].id,
                    pausedAt: now,
                    reason: TaskPauseReason.TASK_SWITCH,
                    customDescription: 'Task reassigned to another employee',
                  },
                });
              }
            }

            // Atomic update on tasks table
            await tx.task.update({
              where: { id: taskId },
              data: {
                assigneeId: targetNewAssigneeId,
                assignedById: actorUserId,
                assignedAt: targetNewAssigneeId ? new Date() : null,
                departmentId: targetDepartmentId,
              },
            });

            // Insert assignment history row
            await tx.taskAssignmentHistory.create({
              data: {
                taskId,
                previousAssigneeId: actualAssigneeId,
                newAssigneeId: targetNewAssigneeId,
                assignedById: actorUserId,
                reason: dto.reason || 'Task reassigned.',
                assignedAt: new Date(),
              },
            });

            // Record activity log
            await tx.taskActivityLog.create({
              data: {
                taskId,
                performedBy: actorUserId,
                action: 'TASK_REASSIGNED',
                metadata: {
                  previousAssigneeId: actualAssigneeId,
                  newAssigneeId: targetNewAssigneeId,
                  reason: dto.reason,
                },
              },
            });

            return tx.task.findUniqueOrThrow({
              where: { id: taskId },
              include: {
                createdByUser: {
                  select: { id: true, userCode: true, name: true, email: true },
                },
                assignee: {
                  select: { id: true, userCode: true, name: true, email: true },
                },
                assignedByUser: {
                  select: { id: true, userCode: true, name: true, email: true },
                },
                department: {
                  select: { id: true, code: true, name: true },
                },
                tagMappings: {
                  include: { tag: true },
                },
              },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000,
          },
        );
      } catch (error: any) {
        if (error instanceof StaleAssigneeDiscoveryException && discoveryAttempt < maxDiscoveryRetries) {
          this.logger.warn(
            `Concurrent reassignment detected on task ${taskId}. Retrying with assignee ${knownAssigneeId}... (Attempt ${discoveryAttempt})`,
          );
          continue;
        }

        // Retry on MySQL deadlock (1213) or lock wait timeout (1205)
        const isDeadlock =
          error.code === 'P2034' ||
          error.message?.includes('1213') ||
          error.message?.includes('Deadlock');
        const isLockTimeout =
          error.message?.includes('1205') ||
          error.message?.includes('Lock wait timeout');

        if ((isDeadlock || isLockTimeout) && discoveryAttempt < maxDiscoveryRetries) {
          const jitter = Math.floor(Math.random() * 50);
          const delay = Math.pow(2, discoveryAttempt) * 50 + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Failed to acquire consistent assignment locks due to high concurrent reassignment volume. Please retry.',
    );
  }

  /**
   * Soft-deletes a task.
   */
  async deleteTask(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot delete tasks.');
    }

    const task = await this.findTaskById(taskId, actorUserId, actorUserType);

    if (task.deletedAt) {
      throw new BadRequestException('Task is already deleted.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { deletedAt: new Date() },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_DELETED',
          metadata: { taskCode: task.taskCode },
        },
      });

      return { success: true, message: 'Task soft-deleted successfully.' };
    });
  }

  /**
   * Retrieves complete audit, assignment, and status history for a task.
   */
  async getTaskHistory(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    // Assert task exists and is visible
    await this.findTaskById(taskId, actorUserId, actorUserType);

    const [assignmentHistory, statusHistory, activityLogs] = await Promise.all([
      this.prisma.taskAssignmentHistory.findMany({
        where: { taskId },
        orderBy: { assignedAt: 'desc' },
        include: {
          previousAssignee: { select: { id: true, userCode: true, name: true, email: true } },
          newAssignee: { select: { id: true, userCode: true, name: true, email: true } },
          assignedByUser: { select: { id: true, userCode: true, name: true, email: true } },
        },
      }),
      this.prisma.taskStatusHistory.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        include: {
          changedByUser: { select: { id: true, userCode: true, name: true, email: true } },
        },
      }),
      this.prisma.taskActivityLog.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        include: {
          actor: { select: { id: true, userCode: true, name: true, email: true } },
        },
      }),
    ]);

    return {
      taskId,
      assignmentHistory,
      statusHistory,
      activityLogs,
    };
  }

  /**
   * Lists all existing task taxonomy tags.
   */
  async listTags() {
    return this.prisma.taskTag.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { tasks: true },
        },
      },
    });
  }

  /**
   * Creates or updates a taxonomy tag.
   */
  async createTag(dto: CreateTaskTagDto) {
    const cleanName = dto.name.trim().toLowerCase();
    if (!cleanName) {
      throw new BadRequestException('Tag name cannot be empty.');
    }

    return this.prisma.taskTag.upsert({
      where: { name: cleanName },
      update: {
        color: dto.color !== undefined ? dto.color : undefined,
      },
      create: {
        name: cleanName,
        color: dto.color,
      },
    });
  }

  /**
   * Deletes a taxonomy tag and cascade-removes its task mappings.
   */
  async deleteTag(tagId: string) {
    const tag = await this.prisma.taskTag.findUnique({
      where: { id: tagId },
    });

    if (!tag) {
      throw new NotFoundException('Tag not found.');
    }

    await this.prisma.taskTag.delete({
      where: { id: tagId },
    });

    return {
      success: true,
      message: 'Tag deleted successfully.',
    };
  }

  /**
   * Helper checking direct or role-based permission for an actor.
   */
  private async checkUserPermission(userId: string, permissionCode: string): Promise<boolean> {
    const directPerm = await this.prisma.userPermission.findFirst({
      where: {
        userId,
        permission: { code: permissionCode, status: RecordStatus.ACTIVE },
      },
    });

    if (directPerm) {
      return directPerm.effect === 'ALLOW';
    }

    const userRoles =
      (await this.prisma.userRole.findMany({
        where: {
          userId,
          role: { status: RecordStatus.ACTIVE, deletedAt: null },
        },
        include: {
          role: {
            include: {
              permissions: {
                where: {
                  permission: { code: permissionCode, status: RecordStatus.ACTIVE },
                },
              },
            },
          },
        },
      })) || [];

    return userRoles.some((ur) => ur.role.permissions.length > 0);
  }
}
