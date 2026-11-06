import { Test, TestingModule } from '@nestjs/testing';
import { TasksService } from './tasks.service';
import { PrismaService } from '../../database/prisma.service';
import { TaskCodeService } from './task-code.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import { TasksWorkflowService } from './tasks-workflow.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskPriority, TaskStatus, RecordStatus, DataScope } from '../../generated/prisma/enums';

describe('TasksService (Unit Tests)', () => {
  let service: TasksService;
  let prismaMock: any;
  let taskCodeServiceMock: any;
  let usersServiceMock: any;
  let taskTimerAutoPauseServiceMock: any;
  let tasksWorkflowServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      $queryRaw: jest.fn(),
      task: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      taskAssignmentHistory: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      taskStatusHistory: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      taskActivityLog: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      taskTag: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      taskTagMapping: {
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      userDepartment: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      employeeProfile: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      userPermission: {
        findFirst: jest.fn(),
      },
      userRole: {
        findMany: jest.fn(),
      },
    };

    taskCodeServiceMock = {
      generateNextCode: jest.fn().mockResolvedValue('TASK001'),
    };

    usersServiceMock = {
      resolveActorDataScope: jest.fn().mockResolvedValue(DataScope.ALL),
    };

    taskTimerAutoPauseServiceMock = {
      autoPauseRunningTask: jest.fn().mockResolvedValue(undefined),
    };

    tasksWorkflowServiceMock = {
      validateStatusTransition: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: TaskCodeService, useValue: taskCodeServiceMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: TaskTimerAutoPauseService, useValue: taskTimerAutoPauseServiceMock },
        { provide: TasksWorkflowService, useValue: tasksWorkflowServiceMock },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  describe('createTask', () => {
    it('should reject client users from creating tasks', async () => {
      await expect(
        service.createTask('client_1', 'CLIENT', {
          title: 'Client task',
          description: 'Desc',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create self-assigned task for an employee and derive department', async () => {
      prismaMock.userDepartment.findMany.mockResolvedValue([
        { departmentId: 'dept_dev', isPrimary: true },
      ]);

      const createdTaskMock = {
        id: 'task_1',
        taskCode: 'TASK001',
        title: 'Build feature',
        description: 'Implement backend',
        priority: TaskPriority.MEDIUM,
        status: TaskStatus.TODO,
        category: 'GENERAL',
        progress: 0,
        departmentId: 'dept_dev',
        createdById: 'emp_1',
        assigneeId: 'emp_1',
      };

      prismaMock.task.create.mockResolvedValue(createdTaskMock);
      prismaMock.task.findUniqueOrThrow.mockResolvedValue(createdTaskMock);

      const result = await service.createTask('emp_1', 'EMPLOYEE', {
        title: 'Build feature',
        description: 'Implement backend',
      });

      expect(result).toBeDefined();
      expect(taskCodeServiceMock.generateNextCode).toHaveBeenCalled();
      expect(prismaMock.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskCode: 'TASK001',
            createdById: 'emp_1',
            assigneeId: 'emp_1',
            departmentId: 'dept_dev',
          }),
        }),
      );
      expect(prismaMock.taskAssignmentHistory.create).toHaveBeenCalled();
      expect(prismaMock.taskStatusHistory.create).toHaveBeenCalled();
      expect(prismaMock.taskActivityLog.create).toHaveBeenCalled();
    });

    it('should reject assigning task to inactive user', async () => {
      prismaMock.userPermission.findFirst.mockResolvedValue({ effect: 'ALLOW' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'emp_inactive',
        status: RecordStatus.INACTIVE,
        deletedAt: null,
        userType: { code: 'EMPLOYEE' },
      });

      await expect(
        service.createTask('admin_1', 'ADMIN', {
          title: 'Task',
          description: 'Desc',
          assigneeId: 'emp_inactive',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject assigning task to client account', async () => {
      prismaMock.userPermission.findFirst.mockResolvedValue({ effect: 'ALLOW' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'client_1',
        status: RecordStatus.ACTIVE,
        deletedAt: null,
        userType: { code: 'CLIENT' },
      });

      await expect(
        service.createTask('admin_1', 'ADMIN', {
          title: 'Task',
          description: 'Desc',
          assigneeId: 'client_1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject employee assigning task to Admin', async () => {
      prismaMock.userPermission.findFirst.mockResolvedValue({ effect: 'ALLOW' });
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'admin_target',
        status: RecordStatus.ACTIVE,
        deletedAt: null,
        userType: { code: 'ADMIN' },
      });

      await expect(
        service.createTask('emp_1', 'EMPLOYEE', {
          title: 'Task',
          description: 'Desc',
          assigneeId: 'admin_target',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject dueDate earlier than startDate', async () => {
      prismaMock.userDepartment.findMany.mockResolvedValue([
        { departmentId: 'dept_dev', isPrimary: true },
      ]);

      await expect(
        service.createTask('emp_1', 'EMPLOYEE', {
          title: 'Task',
          description: 'Desc',
          startDate: '2026-11-10',
          dueDate: '2026-11-05',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateTask', () => {
    it('should reject updating deleted task', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        title: 'Task',
        deletedAt: new Date(),
      });

      await expect(
        service.updateTask('task_1', 'admin_1', 'ADMIN', {
          title: 'New title',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should record TaskStatusHistory when status changes', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        title: 'Task',
        status: TaskStatus.TODO,
        deletedAt: null,
      });

      prismaMock.task.update.mockResolvedValue({
        id: 'task_1',
        status: TaskStatus.IN_PROGRESS,
      });
      prismaMock.task.findUniqueOrThrow.mockResolvedValue({
        id: 'task_1',
        status: TaskStatus.IN_PROGRESS,
      });

      await service.updateTask('task_1', 'emp_1', 'EMPLOYEE', {
        status: TaskStatus.IN_PROGRESS,
        statusComment: 'Started coding',
      });

      expect(prismaMock.taskStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskId: 'task_1',
            previousStatus: TaskStatus.TODO,
            newStatus: TaskStatus.IN_PROGRESS,
            comment: 'Started coding',
          }),
        }),
      );
    });
  });

  describe('deleteTask', () => {
    it('should soft delete task by setting deletedAt', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        taskCode: 'TASK001',
        deletedAt: null,
      });

      const res = await service.deleteTask('task_1', 'admin_1', 'ADMIN');
      expect(res.success).toBe(true);
      expect(prismaMock.task.update).toHaveBeenCalledWith({
        where: { id: 'task_1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prismaMock.taskActivityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            taskId: 'task_1',
            action: 'TASK_DELETED',
          }),
        }),
      );
    });
  });

  describe('getTaskHistory', () => {
    it('should return assignment, status, and activity histories', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        deletedAt: null,
      });

      prismaMock.taskAssignmentHistory.findMany.mockResolvedValue([
        { id: 'ah_1', newAssigneeId: 'emp_1' },
      ]);
      prismaMock.taskStatusHistory.findMany.mockResolvedValue([
        { id: 'sh_1', newStatus: TaskStatus.TODO },
      ]);
      prismaMock.taskActivityLog.findMany.mockResolvedValue([
        { id: 'act_1', action: 'TASK_CREATED' },
      ]);

      const history = await service.getTaskHistory('task_1', 'emp_1', 'EMPLOYEE');
      expect(history.taskId).toBe('task_1');
      expect(history.assignmentHistory.length).toBe(1);
      expect(history.statusHistory.length).toBe(1);
      expect(history.activityLogs.length).toBe(1);
    });
  });

  describe('findMyTasks (OWN Scope Compliance)', () => {
    it('should query both assigned tasks and unassigned drafts created by the actor', async () => {
      prismaMock.task.findMany.mockResolvedValue([
        { id: 'task_assigned', assigneeId: 'emp_1', createdById: 'admin_1' },
        { id: 'task_draft', assigneeId: null, createdById: 'emp_1' },
      ]);
      prismaMock.task.count.mockResolvedValue(2);

      const res = await service.findMyTasks('emp_1', 'EMPLOYEE', {});
      expect(res.success).toBe(true);
      expect(res.data.length).toBe(2);

      expect(prismaMock.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              {
                deletedAt: null,
                OR: [
                  { assigneeId: 'emp_1' },
                  { createdById: 'emp_1', assigneeId: null },
                ],
              },
            ]),
          },
        }),
      );
    });
  });

  describe('Approved TaskStatus Transitions', () => {
    const statuses = [
      TaskStatus.TODO,
      TaskStatus.IN_PROGRESS,
      TaskStatus.ON_HOLD,
      TaskStatus.IN_REVIEW,
      TaskStatus.REOPENED,
      TaskStatus.COMPLETED,
      TaskStatus.CANCELLED,
    ];

    for (let i = 0; i < statuses.length - 1; i++) {
      const fromStatus = statuses[i];
      const toStatus = statuses[i + 1];

      it(`should successfully transition status from ${fromStatus} to ${toStatus}`, async () => {
        prismaMock.task.findFirst.mockResolvedValue({
          id: 'task_1',
          title: 'Task Lifecycle',
          status: fromStatus,
          deletedAt: null,
        });

        prismaMock.task.update.mockResolvedValue({
          id: 'task_1',
          status: toStatus,
        });

        prismaMock.task.findUniqueOrThrow.mockResolvedValue({
          id: 'task_1',
          status: toStatus,
        });

        await service.updateTask('task_1', 'admin_1', 'ADMIN', {
          status: toStatus,
          statusComment: `Transitioning ${fromStatus} -> ${toStatus}`,
        });

        expect(prismaMock.taskStatusHistory.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              taskId: 'task_1',
              previousStatus: fromStatus,
              newStatus: toStatus,
            }),
          }),
        );
      });
    }
  });

  describe('reassignTask (Visibility Enforcement)', () => {
    it('should reject reassignment if task is not found or outside actor visibility', async () => {
      // Permission check passes
      prismaMock.userPermission.findFirst.mockResolvedValue({ effect: 'ALLOW' });

      // findFirst returns null because task is outside scope
      prismaMock.task.findFirst.mockResolvedValue(null);

      await expect(
        service.reassignTask('task_outside_scope', 'admin_1', 'ADMIN', {
          assigneeId: 'emp_2',
          reason: 'Attempted reassignment outside department',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Tag Management Functionality', () => {
    it('listTags should return tags with association count', async () => {
      prismaMock.taskTag.findMany.mockResolvedValue([
        { id: 'tag_1', name: 'backend', color: '#123456', _count: { tasks: 5 } },
      ]);

      const tags = await service.listTags();
      expect(tags.length).toBe(1);
      expect(tags[0].name).toBe('backend');
    });

    it('createTag should format tag name to trimmed lowercase and upsert', async () => {
      prismaMock.taskTag.upsert.mockResolvedValue({
        id: 'tag_new',
        name: 'database',
        color: '#00FF00',
      });

      const tag = await service.createTag({
        name: '  DATABASE  ',
        color: '#00FF00',
      });

      expect(tag.name).toBe('database');
      expect(prismaMock.taskTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: 'database' },
          create: { name: 'database', color: '#00FF00' },
        }),
      );
    });

    it('deleteTag should delete existing tag', async () => {
      prismaMock.taskTag.findUnique.mockResolvedValue({
        id: 'tag_1',
        name: 'old_tag',
      });
      prismaMock.taskTag.delete.mockResolvedValue({ id: 'tag_1' });

      const res = await service.deleteTag('tag_1');
      expect(res.success).toBe(true);
      expect(prismaMock.taskTag.delete).toHaveBeenCalledWith({
        where: { id: 'tag_1' },
      });
    });

    it('deleteTag should throw NotFoundException for non-existent tag', async () => {
      prismaMock.taskTag.findUnique.mockResolvedValue(null);

      await expect(service.deleteTag('tag_missing')).rejects.toThrow(NotFoundException);
    });
  });
});
