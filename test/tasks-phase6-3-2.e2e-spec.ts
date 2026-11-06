import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TaskPriority, TaskStatus, RecordStatus, DataScope, PermissionEffect } from '../src/generated/prisma/enums';

describe('Phase 6.3.2: Task Management & Assignment (e2e & MySQL Concurrency)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  // Test User IDs & Tokens
  let superAdminId: string;
  let superAdminToken: string;

  let adminDeptAId: string;
  let adminDeptAToken: string;

  let emp1DeptAId: string;
  let emp1DeptAToken: string;

  let emp2DeptAId: string;
  let emp2DeptAToken: string;

  let emp3DeptBId: string;
  let emp3DeptBToken: string;

  let clientUserId: string;
  let clientUserToken: string;

  let deptAId: string;
  let deptBId: string;

  let emp1TaskId: string;
  let emp3DeptBTaskId: string;
  let createTestUser: (
    prefix: string,
    userTypeCode: string,
    deptId: string,
    roleCode: string,
  ) => Promise<{ user: any; token: string }>;

  const createdTaskIds: string[] = [];
  const createdUserIds: string[] = [];

  async function createTestTaskDirect(data: {
    title: string;
    description?: string;
    createdById: string;
    assigneeId?: string | null;
    departmentId: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    progress?: number;
    startDate?: Date;
    dueDate?: Date;
  }) {
    const taskCode = `E2E_${Date.now()}_${Math.floor(Math.random() * 10000)}`.substring(0, 30);
    const task = await prisma.task.create({
      data: {
        taskCode,
        title: data.title,
        description: data.description ?? 'Test description',
        priority: data.priority ?? TaskPriority.MEDIUM,
        status: data.status ?? TaskStatus.TODO,
        progress: data.progress ?? 0,
        startDate: data.startDate ?? new Date(),
        dueDate: data.dueDate,
        createdByUser: { connect: { id: data.createdById } },
        department: { connect: { id: data.departmentId } },
        ...(data.assigneeId ? { assignee: { connect: { id: data.assigneeId } } } : {}),
      },
    });
    createdTaskIds.push(task.id);
    return task;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    const jwtSecret = process.env.JWT_SECRET || 'slash@202612354';

    // 1. Fetch or create Departments
    const deptA = await prisma.department.upsert({
      where: { code: 'E2E_TASK_DEPT_A' },
      update: {},
      create: { code: 'E2E_TASK_DEPT_A', name: 'Task Dept A' },
    });
    deptAId = deptA.id;

    const deptB = await prisma.department.upsert({
      where: { code: 'E2E_TASK_DEPT_B' },
      update: {},
      create: { code: 'E2E_TASK_DEPT_B', name: 'Task Dept B' },
    });
    deptBId = deptB.id;

    // Helper to generate tokens
    createTestUser = async (
      prefix: string,
      userTypeCode: string,
      deptId: string,
      roleCode: string,
    ) => {
      const uType = await prisma.userType.findUniqueOrThrow({
        where: { code: userTypeCode },
      });

      const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const user = await prisma.user.create({
        data: {
          userCode: `E2E_${prefix}_${uniqueSuffix}`.substring(0, 30),
          userTypeId: uType.id,
          name: `Test ${prefix} ${uniqueSuffix}`,
          email: `${prefix.toLowerCase()}_${uniqueSuffix}@testslash.com`,
          status: RecordStatus.ACTIVE,
        },
      });
      createdUserIds.push(user.id);

      // Link department
      await prisma.userDepartment.create({
        data: {
          userId: user.id,
          departmentId: deptId,
          isPrimary: true,
        },
      });

      // Link role
      const role = await prisma.role.findUnique({
        where: { code: roleCode },
      });
      if (role) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
          },
        });
      }

      // Create session
      const session = await prisma.userSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: `hash_${prefix}_${uniqueSuffix}`,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const token = await jwtService.signAsync(
        {
          sub: user.id,
          email: user.email,
          userCode: user.userCode,
          userType: userTypeCode,
          roles: [roleCode],
          sessionId: session.id,
        },
        {
          secret: jwtSecret,
          expiresIn: '1h',
        },
      );

      return { user, token };
    };

    // 2. Setup Super Admin
    let superAdmin = await prisma.user.findFirst({
      where: { userType: { code: 'SUPER_ADMIN' }, status: RecordStatus.ACTIVE },
    });
    if (!superAdmin) {
      const saType = await prisma.userType.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
      superAdmin = await prisma.user.create({
        data: {
          userCode: 'SA_E2E_MAIN',
          userTypeId: saType.id,
          name: 'Super Admin E2E',
          email: 'sa_e2e_main@testslash.com',
          status: RecordStatus.ACTIVE,
        },
      });
      createdUserIds.push(superAdmin.id);
    }
    superAdminId = superAdmin.id;
    const saSession = await prisma.userSession.create({
      data: {
        userId: superAdmin.id,
        refreshTokenHash: 'sa_hash_' + Date.now(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    superAdminToken = await jwtService.signAsync(
      {
        sub: superAdmin.id,
        email: superAdmin.email,
        userCode: superAdmin.userCode,
        userType: 'SUPER_ADMIN',
        roles: ['SUPER_ADMIN'],
        sessionId: saSession.id,
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );

    const saDept = await prisma.userDepartment.findFirst({
      where: { userId: superAdmin.id },
    });
    if (!saDept) {
      await prisma.userDepartment.create({
        data: {
          userId: superAdmin.id,
          departmentId: deptAId,
          isPrimary: true,
        },
      });
    }

    // 3. Setup Admin in Dept A
    const adminA = await createTestUser('ADM', 'ADMIN', deptAId, 'ADMIN');
    adminDeptAId = adminA.user.id;
    adminDeptAToken = adminA.token;

    // Explicitly configure DEPARTMENT data scope for Admin A on tasks.view to test departmental isolation
    const tasksViewPerm = await prisma.permission.findUniqueOrThrow({
      where: { code: 'tasks.view' },
    });
    await prisma.userPermission.create({
      data: {
        userId: adminDeptAId,
        permissionId: tasksViewPerm.id,
        effect: PermissionEffect.ALLOW,
        dataScope: DataScope.DEPARTMENT,
      },
    });

    // 4. Setup Employee 1 in Dept A (Developer role - has tasks.create, tasks.view_own, tasks.view_history)
    const emp1 = await createTestUser('EMP1', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp1DeptAId = emp1.user.id;
    emp1DeptAToken = emp1.token;

    // 5. Setup Employee 2 in Dept A
    const emp2 = await createTestUser('EMP2', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp2DeptAId = emp2.user.id;
    emp2DeptAToken = emp2.token;

    // 6. Setup Employee 3 in Dept B (Sales role)
    const emp3 = await createTestUser('EMP3', 'EMPLOYEE', deptBId, 'SALES');
    emp3DeptBId = emp3.user.id;
    emp3DeptBToken = emp3.token;

    // 7. Setup Client User
    const clientU = await createTestUser('CLI', 'CLIENT', deptAId, 'SUPPORT');
    clientUserId = clientU.user.id;
    clientUserToken = clientU.token;
  });

  afterAll(async () => {
    // Clean up created tasks and related history
    if (createdTaskIds.length > 0) {
      await prisma.taskTagMapping.deleteMany({ where: { taskId: { in: createdTaskIds } } });
      await prisma.taskAssignmentHistory.deleteMany({ where: { taskId: { in: createdTaskIds } } });
      await prisma.taskStatusHistory.deleteMany({ where: { taskId: { in: createdTaskIds } } });
      await prisma.taskActivityLog.deleteMany({ where: { taskId: { in: createdTaskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: createdTaskIds } } });
    }

    // Clean up created users
    if (createdUserIds.length > 0) {
      await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userDepartment.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userPermission.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  describe('1. Task Creation & Atomic Task Code Generation', () => {
    it('should allow an employee to create a self-assigned task (defaults to creator & creator department)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          title: 'Employee self created task',
          description: 'Working on feature unit tests',
          priority: TaskPriority.HIGH,
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      const task = res.body.data;
      expect(task.id).toBeDefined();
      expect(task.taskCode).toMatch(/^TASK\d{3,}$/);
      expect(task.createdById).toBe(emp1DeptAId);
      expect(task.assigneeId).toBe(emp1DeptAId);
      expect(task.departmentId).toBe(deptAId);
      expect(task.status).toBe(TaskStatus.TODO);
      expect(task.progress).toBe(0);

      createdTaskIds.push(task.id);
    });

    it('should allow Super Admin to create a task assigned to an Employee in Dept B', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Super Admin assigned task',
          description: 'Sales pipeline preparation for Q4',
          priority: TaskPriority.URGENT,
          assigneeId: emp3DeptBId,
          tags: ['sales', 'q4'],
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      const task = res.body.data;
      expect(task.assigneeId).toBe(emp3DeptBId);
      expect(task.departmentId).toBe(deptBId); // Derived from assignee's primary department
      expect(task.createdById).toBe(superAdminId);
      expect(task.tagMappings.length).toBe(2);

      createdTaskIds.push(task.id);
    });

    it('should reject task creation if dueDate is earlier than startDate', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          title: 'Invalid dates task',
          description: 'Desc',
          startDate: '2026-11-20',
          dueDate: '2026-11-10',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('dueDate cannot be earlier than startDate');
    });

    it('should reject task creation by CLIENT users', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks')
        .set('Authorization', `Bearer ${clientUserToken}`)
        .send({
          title: 'Client task attempt',
          description: 'Desc',
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('should reject an ordinary employee assigning a task to another employee without tasks.assign', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          title: 'Unauthorized assignment',
          description: 'Desc',
          assigneeId: emp2DeptAId, // Attempting to assign to peer
        })
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('permission to assign tasks to other employees');
    });
  });

  describe('2. Task Listing, Search, Filters, and Pagination', () => {
    it('GET /api/tasks should return paginated list within user scope', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks?page=1&limit=10')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.limit).toBe(10);
    });

    it('GET /api/tasks/my-tasks should return both assigned tasks and unassigned drafts created by the actor', async () => {
      // Create an unassigned draft created by emp1
      const draftTask = await createTestTaskDirect({
        title: 'Emp 1 Unassigned Draft',
        createdById: emp1DeptAId,
        assigneeId: null, // Unassigned!
        departmentId: deptAId,
      });

      const res = await request(app.getHttpServer())
        .get('/api/tasks/my-tasks')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const taskIds = res.body.data.map((t: any) => t.id);
      expect(taskIds).toContain(draftTask.id);

      for (const t of res.body.data) {
        const isAssignedToMe = t.assigneeId === emp1DeptAId;
        const isMyDraft = t.createdById === emp1DeptAId && t.assigneeId === null;
        expect(isAssignedToMe || isMyDraft).toBe(true);
      }
    });

    it('should support searching tasks by keyword', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks?search=unit tests')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].title).toContain('Employee self created task');
    });

    it('should support filtering tasks by status and priority', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks?status=${TaskStatus.TODO}&priority=${TaskPriority.HIGH}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      for (const t of res.body.data) {
        expect(t.status).toBe(TaskStatus.TODO);
        expect(t.priority).toBe(TaskPriority.HIGH);
      }
    });

    it('should support filtering tasks by category, department, and creator', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks?category=GENERAL&departmentId=${deptAId}&createdById=${emp1DeptAId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      for (const t of res.body.data) {
        expect(t.category).toBe('GENERAL');
        expect(t.departmentId).toBe(deptAId);
        expect(t.createdById).toBe(emp1DeptAId);
      }
    });

    it('should support sorting tasks by title in both asc and desc orders', async () => {
      const resAsc = await request(app.getHttpServer())
        .get('/api/tasks?sortBy=title&sortOrder=asc&limit=10')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(resAsc.body.success).toBe(true);
      const titlesAsc = resAsc.body.data.map((t: any) => t.title.toLowerCase());
      for (let i = 0; i < titlesAsc.length - 1; i++) {
        expect(titlesAsc[i].localeCompare(titlesAsc[i + 1]) <= 0).toBe(true);
      }

      const resDesc = await request(app.getHttpServer())
        .get('/api/tasks?sortBy=title&sortOrder=desc&limit=10')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(resDesc.body.success).toBe(true);
      const titlesDesc = resDesc.body.data.map((t: any) => t.title.toLowerCase());
      for (let i = 0; i < titlesDesc.length - 1; i++) {
        expect(titlesDesc[i].localeCompare(titlesDesc[i + 1]) >= 0).toBe(true);
      }
    });
  });

  describe('3. Task Details & Scope Security Boundaries', () => {
    beforeAll(async () => {
      // Create a task for Emp 1
      const t1 = await createTestTaskDirect({
        title: 'Emp 1 Private Task',
        description: 'Desc',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        startDate: new Date(),
      });
      emp1TaskId = t1.id;

      // Create a task for Emp 3 in Dept B
      const t3 = await createTestTaskDirect({
        title: 'Emp 3 Dept B Task',
        description: 'Desc',
        createdById: emp3DeptBId,
        assigneeId: emp3DeptBId,
        departmentId: deptBId,
        startDate: new Date(),
      });
      emp3DeptBTaskId = t3.id;
    });

    it('GET /api/tasks/:id should return complete task details for authorized user', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${emp1TaskId}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(emp1TaskId);
      expect(res.body.data.createdByUser).toBeDefined();
      expect(res.body.data.assignee).toBeDefined();
      expect(res.body.data.department).toBeDefined();
    });

    it('should NOT allow Employee 2 to view Employee 1 task under OWN scope', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${emp1TaskId}`)
        .set('Authorization', `Bearer ${emp2DeptAToken}`)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Task not found');
    });

    it('should NOT allow Admin in Dept A to view task in Dept B under DEPARTMENT scope', async () => {
      // Admin in Dept A querying Emp 3 Dept B task
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${emp3DeptBTaskId}`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Task not found');
    });

    it('CEILING BYPASS TEST: Admin cannot view private Super Admin task even if Admin created it', async () => {
      // Admin creates task assigned to Super Admin
      const saTask = await createTestTaskDirect({
        title: 'Private Super Admin Task',
        description: 'Top secret executive roadmap',
        createdById: adminDeptAId, // Admin created it!
        assigneeId: superAdminId,  // Assigned to Super Admin!
        departmentId: deptAId,
        startDate: new Date(),
      });

      // Admin tries to view it
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${saTask.id}`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Task not found');
    });
  });

  describe('4. Task Field Updates & Status History', () => {
    let updateTaskId: string;

    beforeAll(async () => {
      const t = await createTestTaskDirect({
        title: 'Initial Update Title',
        description: 'Desc',
        createdById: adminDeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
        progress: 0,
        startDate: new Date(),
      });
      updateTaskId = t.id;
    });

    it('PATCH /api/tasks/:id should update fields and record TaskStatusHistory on status change', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${updateTaskId}`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .send({
          title: 'Revised Task Title',
          priority: TaskPriority.URGENT,
          status: TaskStatus.IN_PROGRESS,
          progress: 50,
          statusComment: 'Sprint 2 in-progress transition',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Revised Task Title');
      expect(res.body.data.priority).toBe(TaskPriority.URGENT);
      expect(res.body.data.status).toBe(TaskStatus.IN_PROGRESS);
      expect(res.body.data.progress).toBe(50);

      // Verify status history was recorded in DB
      const history = await prisma.taskStatusHistory.findFirst({
        where: { taskId: updateTaskId, newStatus: TaskStatus.IN_PROGRESS },
      });
      expect(history).toBeDefined();
      expect(history?.previousStatus).toBe(TaskStatus.TODO);
      expect(history?.comment).toBe('Sprint 2 in-progress transition');
      expect(history?.changedById).toBe(adminDeptAId);
    });

    it('should transition through all approved TaskStatus values and record history', async () => {
      const remainingStatuses: TaskStatus[] = [
        TaskStatus.ON_HOLD,
        TaskStatus.IN_REVIEW,
        TaskStatus.REOPENED,
        TaskStatus.COMPLETED,
        TaskStatus.CANCELLED,
      ];

      let prevStatus: TaskStatus = TaskStatus.IN_PROGRESS;

      for (const nextStatus of remainingStatuses) {
        const res = await request(app.getHttpServer())
          .patch(`/api/tasks/${updateTaskId}`)
          .set('Authorization', `Bearer ${adminDeptAToken}`)
          .send({
            status: nextStatus,
            statusComment: `Transitioning ${prevStatus} -> ${nextStatus}`,
          })
          .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe(nextStatus);

        const hist = await prisma.taskStatusHistory.findFirst({
          where: {
            taskId: updateTaskId,
            previousStatus: prevStatus,
            newStatus: nextStatus,
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(hist).toBeDefined();
        expect(hist?.comment).toBe(`Transitioning ${prevStatus} -> ${nextStatus}`);

        prevStatus = nextStatus;
      }
    });
  });

  describe('5. Task Reassignment & History Tracking', () => {
    let reassignTaskId: string;

    beforeAll(async () => {
      const t = await createTestTaskDirect({
        title: 'Reassignment Test Task',
        description: 'Desc',
        createdById: adminDeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
        startDate: new Date(),
      });
      reassignTaskId = t.id;
    });

    it('PATCH /api/tasks/:id/assign should atomically reassign task and record TaskAssignmentHistory', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${reassignTaskId}/assign`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .send({
          assigneeId: emp2DeptAId,
          reason: 'Workload rebalance for Sprint 3',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.assigneeId).toBe(emp2DeptAId);

      // Verify assignment history in DB
      const history = await prisma.taskAssignmentHistory.findFirst({
        where: { taskId: reassignTaskId, newAssigneeId: emp2DeptAId },
      });
      expect(history).toBeDefined();
      expect(history?.previousAssigneeId).toBe(emp1DeptAId);
      expect(history?.assignedById).toBe(adminDeptAId);
      expect(history?.reason).toBe('Workload rebalance for Sprint 3');
    });

    it('should update task department if reassigned to an employee in another department', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${reassignTaskId}/assign`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          assigneeId: emp3DeptBId, // In Dept B
          reason: 'Transferred project to Sales team',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.assigneeId).toBe(emp3DeptBId);
      expect(res.body.data.departmentId).toBe(deptBId); // Department automatically derived!
    });

    it('should reject reassignment if task is outside actor scope (enforces visibility check)', async () => {
      // Admin in Dept A attempts to reassign Emp 3 task in Dept B
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${emp3DeptBTaskId}/assign`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .send({
          assigneeId: emp2DeptAId,
          reason: 'Unauthorized cross-department reassignment',
        })
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Task not found');
    });
  });

  describe('6. Soft Delete & Audit History Endpoint', () => {
    let historyTaskId: string;

    beforeAll(async () => {
      const t = await createTestTaskDirect({
        title: 'History Inspection Task',
        description: 'Desc',
        createdById: adminDeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        startDate: new Date(),
      });
      historyTaskId = t.id;

      await prisma.taskAssignmentHistory.create({
        data: {
          taskId: historyTaskId,
          previousAssigneeId: null,
          newAssigneeId: emp1DeptAId,
          assignedById: adminDeptAId,
          reason: 'Initial assignment',
        },
      });

      await prisma.taskStatusHistory.create({
        data: {
          taskId: historyTaskId,
          previousStatus: null,
          newStatus: TaskStatus.TODO,
          changedById: adminDeptAId,
          comment: 'Initial status',
        },
      });
    });

    it('GET /api/tasks/:id/history should return assignment, status, and activity history', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${historyTaskId}/history`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.taskId).toBe(historyTaskId);
      expect(res.body.data.assignmentHistory.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.statusHistory.length).toBeGreaterThanOrEqual(1);
    });

    it('DELETE /api/tasks/:id should soft-delete the task', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/tasks/${historyTaskId}`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);

      // Verify task cannot be queried anymore
      await request(app.getHttpServer())
        .get(`/api/tasks/${historyTaskId}`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(404);

      // Verify task still exists in DB with deletedAt timestamp
      const dbTask = await prisma.task.findUnique({ where: { id: historyTaskId } });
      expect(dbTask).toBeDefined();
      expect(dbTask?.deletedAt).not.toBeNull();
    });
  });

  describe('7. Real MySQL Concurrency Scenarios', () => {
    it('Concurrency Scenario 1: 10 concurrent task creations generate 10 unique, non-colliding task codes', async () => {
      const creationPromises = Array.from({ length: 10 }, (_, i) =>
        request(app.getHttpServer())
          .post('/api/tasks')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            title: `Concurrent Task ${i + 1}`,
            description: `Testing atomic task code sequence generation under race conditions (${i + 1})`,
            priority: TaskPriority.MEDIUM,
          }),
      );

      const responses = await Promise.all(creationPromises);

      for (const res of responses) {
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        createdTaskIds.push(res.body.data.id);
      }

      const taskCodes = responses.map((r) => r.body.data.taskCode);
      const uniqueCodes = new Set(taskCodes);

      // All 10 codes must be strictly unique! Zero duplicates.
      expect(uniqueCodes.size).toBe(10);
      for (const code of taskCodes) {
        expect(code).toMatch(/^TASK\d{3,}$/);
      }
    });

    it('Concurrency Scenario 2: Concurrent reassignments of the same task serialize cleanly with Tier 1 user locks', async () => {
      // Create a test task
      const targetTask = await createTestTaskDirect({
        title: 'Race Condition Reassignment Task',
        description: 'Testing closed verification loop under concurrent reassignments',
        createdById: adminDeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        startDate: new Date(),
      });

      // Fire 4 concurrent reassignment requests simultaneously
      const targetAssignees = [emp2DeptAId, emp3DeptBId, emp1DeptAId, emp2DeptAId];
      const reassignPromises = targetAssignees.map((assigneeId, idx) =>
        request(app.getHttpServer())
          .patch(`/api/tasks/${targetTask.id}/assign`)
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({
            assigneeId,
            reason: `Concurrent reassign attempt ${idx + 1}`,
          }),
      );

      const responses = await Promise.all(reassignPromises);

      // Every response must be either 200 OK (serialized success) or 409 Conflict (handled retry exhaustion)
      // Zero 500 internal server errors or corrupted DB states!
      for (const res of responses) {
        expect([200, 409]).toContain(res.status);
      }

      // Check persisted state in MySQL: exactly one assignee must be set
      const finalTask = await prisma.task.findUniqueOrThrow({
        where: { id: targetTask.id },
      });
      expect(finalTask.assigneeId).not.toBeNull();

      // Check assignment history: every successful update has a corresponding history entry
      const successCount = responses.filter((r) => r.status === 200).length;
      const historyCount = await prisma.taskAssignmentHistory.count({
        where: { taskId: targetTask.id },
      });
      expect(historyCount).toBe(successCount);
    });
  });

  describe('8. Tag Taxonomy Management (tasks.manage_tags)', () => {
    let createdTagId: string;

    it('should reject tag creation by an employee without tasks.manage_tags', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks/tags')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ name: 'unauthorized_tag' })
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('should allow Super Admin / user with tasks.manage_tags to create a tag', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/tasks/tags')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ name: 'infra_core', color: '#10B981' })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('infra_core');
      expect(res.body.data.color).toBe('#10B981');
      createdTagId = res.body.data.id;
    });

    it('should list all tags with GET /api/tasks/tags', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/tags')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const names = res.body.data.map((t: any) => t.name);
      expect(names).toContain('infra_core');
    });

    it('should allow deletion of a tag with DELETE /api/tasks/tags/:id', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/tasks/tags/${createdTagId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe('9. tasks.view_own Permission Access Consistency', () => {
    let viewOwnEmpId: string;
    let viewOwnEmpToken: string;
    let viewOwnTaskId: string;

    beforeAll(async () => {
      // Create an employee with ONLY tasks.view_own (no tasks.view)
      const empOnly = await createTestUser('VIEW_OWN_ONLY', 'EMPLOYEE', deptAId, 'DEVELOPER');
      viewOwnEmpId = empOnly.user.id;
      viewOwnEmpToken = empOnly.token;

      // Explicitly deny tasks.view
      const viewPerm = await prisma.permission.findUnique({ where: { code: 'tasks.view' } });
      if (viewPerm) {
        await prisma.userPermission.create({
          data: {
            userId: viewOwnEmpId,
            permissionId: viewPerm.id,
            effect: PermissionEffect.DENY,
          },
        });
      }

      // Create a task owned by viewOwnEmp
      const t = await createTestTaskDirect({
        title: 'Own Task for View-Own Only Employee',
        createdById: viewOwnEmpId,
        assigneeId: viewOwnEmpId,
        departmentId: deptAId,
      });
      viewOwnTaskId = t.id;
    });

    it('employee with only tasks.view_own CAN access their own task via GET /api/tasks/:id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${viewOwnTaskId}`)
        .set('Authorization', `Bearer ${viewOwnEmpToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(viewOwnTaskId);
    });

    it('employee with only tasks.view_own CANNOT access another user’s task via GET /api/tasks/:id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${emp1TaskId}`)
        .set('Authorization', `Bearer ${viewOwnEmpToken}`)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Task not found');
    });
  });
});
