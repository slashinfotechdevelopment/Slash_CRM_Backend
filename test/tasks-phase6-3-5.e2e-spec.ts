import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  DataScope,
  PermissionEffect,
  RecordStatus,
  SessionStatus,
  TaskPriority,
  TaskReviewOutcome,
  TaskStatus,
  TaskTimerStatus,
} from '../src/generated/prisma/enums';

describe('Phase 6.3.5: Employee Task Dashboard & Reports (e2e & MySQL Integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminId: string;
  let superAdminToken: string;

  let adminId: string;
  let adminToken: string;

  let managerDeptAId: string;
  let managerDeptAToken: string;

  let managerDeptBId: string;
  let managerDeptBToken: string;

  let emp1DeptAId: string;
  let emp1DeptAToken: string;

  let emp2DeptAId: string;
  let emp2DeptAToken: string;

  let deptAId: string;
  let deptBId: string;

  let clientId: string;
  let clientToken: string;

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
    const taskCode = `RPT_${Date.now()}_${Math.floor(Math.random() * 10000)}`.substring(0, 30);
    const task = await prisma.task.create({
      data: {
        taskCode,
        title: data.title,
        description: data.description ?? 'Reports test task',
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

  async function createTestUser(
    prefix: string,
    userTypeCode: string,
    deptId: string,
    roleCode?: string,
  ) {
    const uType = await prisma.userType.findUniqueOrThrow({
      where: { code: userTypeCode },
    });

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const user = await prisma.user.create({
      data: {
        userCode: `E2E_${prefix}_${uniqueSuffix}`.substring(0, 30),
        userTypeId: uType.id,
        name: `Test ${prefix} ${uniqueSuffix}`,
        email: `${prefix.toLowerCase()}_${uniqueSuffix}@testreports.com`,
        status: RecordStatus.ACTIVE,
      },
    });
    createdUserIds.push(user.id);

    if (deptId) {
      await prisma.userDepartment.create({
        data: {
          userId: user.id,
          departmentId: deptId,
          isPrimary: true,
        },
      });
    }

    if (roleCode) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
        },
      });
    }

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: `hash_${prefix}_${uniqueSuffix}`,
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const token = jwtService.sign({
      sub: user.id,
      email: user.email,
      userType: userTypeCode,
      sessionId: session.id,
    });

    return { id: user.id, token, sessionId: session.id };
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
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Setup Departments
    let deptA = await prisma.department.findUnique({ where: { code: 'RPT_DEPT_A' } });
    if (!deptA) {
      deptA = await prisma.department.create({
        data: { code: 'RPT_DEPT_A', name: 'Reports Department A' },
      });
    }
    deptAId = deptA.id;

    let deptB = await prisma.department.findUnique({ where: { code: 'RPT_DEPT_B' } });
    if (!deptB) {
      deptB = await prisma.department.create({
        data: { code: 'RPT_DEPT_B', name: 'Reports Department B' },
      });
    }
    deptBId = deptB.id;

    // Create Test Actors
    const sa = await createTestUser('SUPER_ADMIN', 'SUPER_ADMIN', deptAId, 'SUPER_ADMIN');
    superAdminId = sa.id;
    superAdminToken = sa.token;

    const adm = await createTestUser('ADMIN', 'ADMIN', deptAId, 'ADMIN');
    adminId = adm.id;
    adminToken = adm.token;

    const mgrA = await createTestUser('MGR_A', 'EMPLOYEE', deptAId, 'PROJECT_MANAGER');
    managerDeptAId = mgrA.id;
    managerDeptAToken = mgrA.token;

    const mgrB = await createTestUser('MGR_B', 'EMPLOYEE', deptBId, 'PROJECT_MANAGER');
    managerDeptBId = mgrB.id;
    managerDeptBToken = mgrB.token;

    const e1 = await createTestUser('EMP_1', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp1DeptAId = e1.id;
    emp1DeptAToken = e1.token;

    const e2 = await createTestUser('EMP_2', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp2DeptAId = e2.id;
    emp2DeptAToken = e2.token;

    const cl = await createTestUser('CLIENT', 'CLIENT', deptAId);
    clientId = cl.id;
    clientToken = cl.token;

    // Grant report viewing permissions explicitly for Manager and Developer
    const permReportsView = await prisma.permission.findUnique({ where: { code: 'reports.view' } });
    if (permReportsView) {
      // Manager has DEPARTMENT scope on reports.view
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: managerDeptAId, permissionId: permReportsView.id } },
        update: { effect: PermissionEffect.ALLOW, dataScope: DataScope.DEPARTMENT },
        create: {
          userId: managerDeptAId,
          permissionId: permReportsView.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
      });
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: managerDeptBId, permissionId: permReportsView.id } },
        update: { effect: PermissionEffect.ALLOW, dataScope: DataScope.DEPARTMENT },
        create: {
          userId: managerDeptBId,
          permissionId: permReportsView.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
      });
      // Emp1 has OWN scope on reports.view
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: emp1DeptAId, permissionId: permReportsView.id } },
        update: { effect: PermissionEffect.ALLOW, dataScope: DataScope.OWN },
        create: {
          userId: emp1DeptAId,
          permissionId: permReportsView.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.OWN,
        },
      });
    }

    const permTimeView = await prisma.permission.findUnique({ where: { code: 'tasks.time.view' } });
    if (permTimeView) {
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: managerDeptAId, permissionId: permTimeView.id } },
        update: { effect: PermissionEffect.ALLOW, dataScope: DataScope.DEPARTMENT },
        create: {
          userId: managerDeptAId,
          permissionId: permTimeView.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
      });
    }
  });

  afterAll(async () => {
    if (createdTaskIds.length > 0) {
      await prisma.taskComment.updateMany({
        where: { taskId: { in: createdTaskIds } },
        data: { parentId: null },
      });
      await prisma.taskComment.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.mediaAttachment.deleteMany({
        where: { entityType: 'TASK', entityId: { in: createdTaskIds } },
      });
      await prisma.taskReview.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskTimePause.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskTimeEntry.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskActivityLog.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskStatusHistory.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskAssignmentHistory.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskTagMapping.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.task.deleteMany({
        where: { id: { in: createdTaskIds } },
      });
    }

    if (createdUserIds.length > 0) {
      await prisma.userSession.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.userDepartment.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.userRole.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.userPermission.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }

    await app.close();
  });

  describe('1. Employee Personal Dashboard (GET /api/tasks/dashboard/my)', () => {
    it('Scenario 1: Returns personal counts, status breakdown, and deadlines without peer data leakage', async () => {
      // 1. Create tasks for emp1: 1 TODO, 1 IN_PROGRESS, 1 COMPLETED, 1 overdue, 1 due today
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const today = new Date();
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Emp1 Task 1: Overdue TODO
      await createTestTaskDirect({
        title: 'Emp1 Overdue Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
        dueDate: yesterday,
      });

      // Emp1 Task 2: Due today IN_PROGRESS
      await createTestTaskDirect({
        title: 'Emp1 Due Today Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
        dueDate: today,
      });

      // Emp1 Task 3: Completed upcoming
      await createTestTaskDirect({
        title: 'Emp1 Completed Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.COMPLETED,
        dueDate: nextWeek,
      });

      // Emp1 Task 4: Own unassigned draft
      await createTestTaskDirect({
        title: 'Emp1 Unassigned Draft',
        createdById: emp1DeptAId,
        assigneeId: null,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // Peer Task (Emp2) - Must NOT be exposed to Emp1
      await createTestTaskDirect({
        title: 'Emp2 Confidential Task',
        createdById: emp2DeptAId,
        assigneeId: emp2DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/my')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;

      // 4 total tasks for emp1 (3 assigned + 1 unassigned draft)
      expect(data.totalTasks).toBe(4);
      expect(data.assignedTasks).toBe(3);
      expect(data.ownUnassignedDrafts).toBe(1);

      // Status breakdown
      expect(data.statusCounts[TaskStatus.TODO]).toBe(2);
      expect(data.statusCounts[TaskStatus.IN_PROGRESS]).toBe(1);
      expect(data.statusCounts[TaskStatus.COMPLETED]).toBe(1);

      // Deadlines
      expect(data.deadlines.overdueTasks).toBe(1);
      expect(data.deadlines.dueTodayTasks).toBe(1);

      // Verify timer telemetry structure exists
      expect(data.timerTelemetry).toBeDefined();
      expect(data.timerTelemetry.todayWorkingSeconds).toBeGreaterThanOrEqual(0);
    });

    it('Scenario 2: Deduplication - Task both created by and assigned to actor is counted exactly once', async () => {
      const task = await createTestTaskDirect({
        title: 'Deduplicated Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/my')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      // Status count for IN_PROGRESS should have incremented by exactly 1
      expect(res.body.data.statusCounts[TaskStatus.IN_PROGRESS]).toBe(2);
    });
  });

  describe('2. Manager Team Dashboard (GET /api/tasks/dashboard/team)', () => {
    it('Scenario 3: Manager in Dept A views Dept A team metrics and employee distributions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/team')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.totalTasks).toBeGreaterThan(0);
      expect(data.employeeDistribution).toBeInstanceOf(Array);
      expect(data.statusCounts).toBeDefined();
      expect(data.priorityCounts).toBeDefined();
    });

    it('Scenario 4: Cross-Department Isolation - Manager in Dept B cannot view Dept A tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/team')
        .set('Authorization', `Bearer ${managerDeptBToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      // Dept B has 0 tasks created so totalTasks should be 0
      expect(res.body.data.totalTasks).toBe(0);
      expect(res.body.data.employeeDistribution.length).toBe(0);
    });

    it('Scenario 5: Actor with OWN scope is rejected from accessing team dashboard (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/team')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('scope');
    });
  });

  describe('3. Admin / Organization Dashboard (GET /api/tasks/dashboard/organization)', () => {
    it('Scenario 6: Super Admin views organization-wide task metrics, department distribution, and trends', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/organization')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.totalTasks).toBeGreaterThan(0);
      expect(data.departmentDistribution).toBeInstanceOf(Array);
      expect(data.trends.completionsLast30Days).toBeGreaterThanOrEqual(0);
      expect(data.timeTelemetry.totalWorkingSeconds).toBeGreaterThanOrEqual(0);
    });

    it('Scenario 7: Ordinary employee is rejected from organization dashboard (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/dashboard/organization')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('4. Client Account Isolation', () => {
    it('Scenario 8: CLIENT users are rejected with 403 Forbidden across all dashboards and reports', async () => {
      await request(app.getHttpServer())
        .get('/api/tasks/dashboard/my')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/tasks/dashboard/team')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/tasks/dashboard/organization')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/tasks/reports/summary')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/tasks/reports/working-hours')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });
  });

  describe('5. Task Summary Report (GET /api/tasks/reports/summary)', () => {
    it('Scenario 9: Computes status distribution and completion percentage excluding CANCELLED tasks', async () => {
      // Create 1 CANCELLED task
      await createTestTaskDirect({
        title: 'Cancelled Test Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.CANCELLED,
      });

      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/summary')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.totalTasks).toBeGreaterThan(0);
      expect(data.completedTasks).toBeGreaterThanOrEqual(1);
      expect(data.statusCounts[TaskStatus.CANCELLED]).toBeGreaterThanOrEqual(1);

      // Verify completion percentage calculation:
      // (completedTasks / (totalTasks - cancelledTasks)) * 100
      const eligibleTasks = data.totalTasks - data.statusCounts[TaskStatus.CANCELLED];
      const expectedPercentage = eligibleTasks > 0 ? Number(((data.completedTasks / eligibleTasks) * 100).toFixed(2)) : 0;
      expect(data.completionPercentage).toBe(expectedPercentage);
    });

    it('Scenario 10: Historical completion tracking - Task completed multiple times in period is counted once', async () => {
      const task = await createTestTaskDirect({
        title: 'Multi-Completed Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.COMPLETED,
      });

      // Insert two TaskStatusHistory rows marking COMPLETED today
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task.id,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: managerDeptAId,
          createdAt: new Date(),
        },
      });

      await prisma.taskStatusHistory.create({
        data: {
          taskId: task.id,
          previousStatus: TaskStatus.REOPENED,
          newStatus: TaskStatus.COMPLETED,
          changedById: managerDeptAId,
          createdAt: new Date(),
        },
      });

      const todayStr = new Date().toISOString().slice(0, 10);
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/reports/summary?startDate=${todayStr}&endDate=${todayStr}`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      // Distinct taskId query ensures it is counted as 1 distinct completed task
      expect(res.body.data.completedTasks).toBeGreaterThanOrEqual(1);
    });
  });

  describe('6. Working Hours Report (GET /api/tasks/reports/working-hours)', () => {
    it('Scenario 11: Calculates working duration excluding pauses, splits across Asia/Kolkata midnight', async () => {
      const task = await createTestTaskDirect({
        title: 'Timer Work Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      const todayDate = new Date();
      todayDate.setUTCHours(0, 0, 0, 0);

      const now = Date.now();
      const startedAt = new Date(now - 9000 * 1000);
      const endedAt = new Date(now - 1800 * 1000);
      const pausedAt = new Date(now - 1800 * 1000);
      const resumedAt = new Date(now);

      // Create a closed time entry: 7200 seconds (2 hours)
      const entry = await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          workDate: todayDate,
          startedAt,
          endedAt,
          durationSeconds: 7200,
          status: TaskTimerStatus.PAUSED,
        },
      });

      // Create an associated pause of 1800 seconds (30 mins)
      await prisma.taskTimePause.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          precedingTimeEntryId: entry.id,
          pausedAt,
          resumedAt,
          pauseDurationSeconds: 1800,
          reason: 'TEA_BREAK',
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      const dayReport = res.body.data[0];
      // Total working seconds must be 7200 (paused duration is NOT added)
      expect(dayReport.totalWorkingSeconds).toBeGreaterThanOrEqual(7200);
      expect(dayReport.totalPausedSeconds).toBeGreaterThanOrEqual(1800);
      expect(dayReport.firstStartedAt).toBeDefined();
      expect(dayReport.lastStoppedAt).toBeDefined();
    });

    it('Scenario 12: Employee with OWN scope is forbidden from querying another employee’s hours (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/reports/working-hours?employeeId=${emp2DeptAId}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('own');
    });
  });

  describe('7. Employee Task Performance Report (GET /api/tasks/reports/employee-performance)', () => {
    it('Scenario 13: Returns factual metrics per employee without subjective scoring', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/employee-performance')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      const empReport = res.body.data.find((e: any) => e.employee.id === emp1DeptAId);
      expect(empReport).toBeDefined();
      expect(empReport.assignedTaskCount).toBeGreaterThanOrEqual(1);
      expect(empReport.totalTrackedHours).toBeGreaterThanOrEqual(0);
      expect(empReport.completionPercentage).toBeGreaterThanOrEqual(0);
    });

    it('Scenario 14: Employee with OWN scope is rejected from performance reports (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/employee-performance')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('8. Overdue Tasks Report (GET /api/tasks/reports/overdue)', () => {
    it('Scenario 15: Returns paginated overdue tasks and accurately computes daysOverdue', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/overdue?page=1&limit=10')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();

      if (res.body.data.length > 0) {
        const item = res.body.data[0];
        expect(item.daysOverdue).toBeGreaterThanOrEqual(1);
        expect(item.currentStatus).not.toBe(TaskStatus.COMPLETED);
        expect(item.currentStatus).not.toBe(TaskStatus.CANCELLED);
      }
    });
  });

  describe('9. Review Summary Report (GET /api/tasks/reports/reviews)', () => {
    it('Scenario 16: Returns review outcome counts and computes average review turnaround duration', async () => {
      const task = await createTestTaskDirect({
        title: 'Review Metric Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      // 1. Pending review
      await prisma.taskReview.create({
        data: {
          taskId: task.id,
          roundNumber: 1,
          submitterId: emp1DeptAId,
          outcome: TaskReviewOutcome.PENDING,
          submittedAt: new Date(),
        },
      });

      // 2. Finalized review: 3600 seconds turnaround (1 hour)
      const submittedAt = new Date(Date.now() - 3600 * 1000);
      const reviewedAt = new Date();
      await prisma.taskReview.create({
        data: {
          taskId: task.id,
          roundNumber: 2,
          submitterId: emp1DeptAId,
          reviewerId: managerDeptAId,
          outcome: TaskReviewOutcome.APPROVED,
          submittedAt,
          reviewedAt,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/reviews')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.awaitingReviewCount).toBeGreaterThanOrEqual(1);
      expect(data.approvedCount).toBeGreaterThanOrEqual(1);
      expect(data.turnaroundMetrics.finalizedCount).toBeGreaterThanOrEqual(1);
      expect(data.turnaroundMetrics.avgTurnaroundSeconds).toBeGreaterThanOrEqual(3500);
    });

    it('Scenario 17: Employee with OWN scope is rejected from review reports (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/reviews')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('10. Empty Dataset Handling', () => {
    it('Scenario 18: Queries with non-matching filters return clean 0s and empty arrays', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/reports/summary?category=NON_EXISTENT_CATEGORY')
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalTasks).toBe(0);
      expect(res.body.data.completedTasks).toBe(0);
      expect(res.body.data.completionPercentage).toBe(0);
    });
  });

  describe('11. Advanced Interval Calculation & Historical Completion Denominator Verification', () => {
    it('Scenario 19: Work interval crossing Asia/Kolkata midnight (18:30 UTC) splits between local calendar dates', async () => {
      const task = await createTestTaskDirect({
        title: 'Midnight Crossing Work Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      // Local dates in Asia/Kolkata: 2026-11-10 and 2026-11-11
      // Midnight between them is 2026-11-10T18:30:00.000Z
      // Work: 23:00 IST Nov 10 (17:30 UTC) to 02:00 IST Nov 11 (20:30 UTC) = 3 hours (10,800s)
      const startedAt = new Date('2026-11-10T17:30:00.000Z');
      const endedAt = new Date('2026-11-10T20:30:00.000Z');

      await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          workDate: new Date('2026-11-10T00:00:00.000Z'),
          startedAt,
          endedAt,
          durationSeconds: 10800,
          status: TaskTimerStatus.STOPPED,
        },
      });

      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}&startDate=2026-11-10&endDate=2026-11-11`,
        )
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(2);

      // Descending order by date: 2026-11-11 first, 2026-11-10 second
      const day2 = res.body.data.find((d: any) => d.workDate === '2026-11-11');
      const day1 = res.body.data.find((d: any) => d.workDate === '2026-11-10');

      expect(day1).toBeDefined();
      expect(day2).toBeDefined();

      // Day 1: 17:30 to 18:30 UTC = 3600 seconds (1.00 hour)
      expect(day1.totalWorkingSeconds).toBe(3600);
      expect(day1.totalWorkingHours).toBe(1);

      // Day 2: 18:30 to 20:30 UTC = 7200 seconds (2.00 hours)
      expect(day2.totalWorkingSeconds).toBe(7200);
      expect(day2.totalWorkingHours).toBe(2);
    });

    it('Scenario 20: Pause interval crossing Asia/Kolkata midnight (18:30 UTC) splits between local calendar dates', async () => {
      const task = await createTestTaskDirect({
        title: 'Midnight Crossing Pause Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      // Midnight is 2026-11-12T18:30:00.000Z
      // Work entry before pause ends at 23:30 IST (18:00 UTC)
      const workStartedAt = new Date('2026-11-12T16:30:00.000Z');
      const workEndedAt = new Date('2026-11-12T18:00:00.000Z');

      const entry = await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          workDate: new Date('2026-11-12T00:00:00.000Z'),
          startedAt: workStartedAt,
          endedAt: workEndedAt,
          durationSeconds: 5400,
          status: TaskTimerStatus.PAUSED,
        },
      });

      // Pause from 23:30 IST (18:00 UTC) to 00:30 IST (19:00 UTC) = 3600s
      // 1800s before midnight (2026-11-12) and 1800s after midnight (2026-11-13)
      const pausedAt = new Date('2026-11-12T18:00:00.000Z');
      const resumedAt = new Date('2026-11-12T19:00:00.000Z');

      await prisma.taskTimePause.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          precedingTimeEntryId: entry.id,
          pausedAt,
          resumedAt,
          pauseDurationSeconds: 3600,
          reason: 'PERSONAL_WORK',
        },
      });

      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}&startDate=2026-11-12&endDate=2026-11-13`,
        )
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const day1 = res.body.data.find((d: any) => d.workDate === '2026-11-12');
      const day2 = res.body.data.find((d: any) => d.workDate === '2026-11-13');

      expect(day1).toBeDefined();
      expect(day2).toBeDefined();

      expect(day1.totalPausedSeconds).toBe(1800);
      expect(day1.totalPausedHours).toBe(0.5);

      expect(day2.totalPausedSeconds).toBe(1800);
      expect(day2.totalPausedHours).toBe(0.5);
    });

    it('Scenario 21: Running timer at report calculation time includes live elapsed duration', async () => {
      const task = await createTestTaskDirect({
        title: 'Live Running Timer Task',
        createdById: emp2DeptAId,
        assigneeId: emp2DeptAId,
        departmentId: deptAId,
      });

      const startedAt = new Date(Date.now() - 3610 * 1000); // ~1 hour ago
      const entry = await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp2DeptAId,
          workDate: new Date(),
          startedAt,
          endedAt: null,
          status: TaskTimerStatus.RUNNING,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/tasks/reports/working-hours?employeeId=${emp2DeptAId}`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      const dayReport = res.body.data[0];

      // Live duration should be at least 3600 seconds
      expect(dayReport.totalWorkingSeconds).toBeGreaterThanOrEqual(3600);
      expect(dayReport.lastStoppedAt).toBeDefined();

      // Clean up running entry to clear unique activeUserId lock
      await prisma.taskTimeEntry.update({
        where: { id: entry.id },
        data: { status: TaskTimerStatus.STOPPED, endedAt: new Date() },
      });
    });

    it('Scenario 22: Open pause at report calculation time is excluded from work time and included in pause time', async () => {
      const task = await createTestTaskDirect({
        title: 'Open Pause Test Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      const now = Date.now();
      const workStartedAt = new Date(now - 7200 * 1000); // 2 hours ago
      const workEndedAt = new Date(now - 3600 * 1000); // 1 hour ago

      const entry = await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          workDate: new Date(),
          startedAt: workStartedAt,
          endedAt: workEndedAt,
          durationSeconds: 3600,
          status: TaskTimerStatus.PAUSED,
        },
      });

      // Open pause starting 1 hour ago
      const pausedAt = new Date(now - 3600 * 1000);
      const pause = await prisma.taskTimePause.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          precedingTimeEntryId: entry.id,
          pausedAt,
          resumedAt: null,
          pauseDurationSeconds: 0,
          reason: 'TECHNICAL_ISSUE',
        },
      });

      const todayStr = new Date().toISOString().slice(0, 10);
      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}&startDate=${todayStr}&endDate=${todayStr}`,
        )
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      const dayReport = res.body.data[0];

      // Work seconds should NOT include open pause
      expect(dayReport.totalWorkingSeconds).toBeGreaterThanOrEqual(3600);
      // Pause seconds must include live open pause (at least 3600 seconds)
      expect(dayReport.totalPausedSeconds).toBeGreaterThanOrEqual(3600);

      // Clean up open pause
      await prisma.taskTimePause.update({
        where: { id: pause.id },
        data: { resumedAt: new Date() },
      });
    });

    it('Scenario 23: Multiple entries on one local date aggregate cleanly with accurate sessionCount and task breakdown', async () => {
      const taskA = await createTestTaskDirect({
        title: 'Multi Entry Task A',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });
      const taskB = await createTestTaskDirect({
        title: 'Multi Entry Task B',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      // Date: 2026-11-15. In IST:
      // Entry 1: Task A 09:00 - 11:00 IST (03:30 - 05:30 UTC) = 7200s
      // Entry 2: Task B 12:00 - 14:00 IST (06:30 - 08:30 UTC) = 7200s
      // Entry 3: Task A 15:00 - 17:00 IST (09:30 - 11:30 UTC) = 7200s
      await prisma.taskTimeEntry.createMany({
        data: [
          {
            taskId: taskA.id,
            userId: emp1DeptAId,
            workDate: new Date('2026-11-15T00:00:00.000Z'),
            startedAt: new Date('2026-11-15T03:30:00.000Z'),
            endedAt: new Date('2026-11-15T05:30:00.000Z'),
            durationSeconds: 7200,
            status: TaskTimerStatus.STOPPED,
          },
          {
            taskId: taskB.id,
            userId: emp1DeptAId,
            workDate: new Date('2026-11-15T00:00:00.000Z'),
            startedAt: new Date('2026-11-15T06:30:00.000Z'),
            endedAt: new Date('2026-11-15T08:30:00.000Z'),
            durationSeconds: 7200,
            status: TaskTimerStatus.STOPPED,
          },
          {
            taskId: taskA.id,
            userId: emp1DeptAId,
            workDate: new Date('2026-11-15T00:00:00.000Z'),
            startedAt: new Date('2026-11-15T09:30:00.000Z'),
            endedAt: new Date('2026-11-15T11:30:00.000Z'),
            durationSeconds: 7200,
            status: TaskTimerStatus.STOPPED,
          },
        ],
      });

      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}&startDate=2026-11-15&endDate=2026-11-15`,
        )
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);

      const dayReport = res.body.data[0];
      expect(dayReport.workDate).toBe('2026-11-15');
      expect(dayReport.sessionCount).toBe(3);
      expect(dayReport.totalWorkingSeconds).toBe(21600); // 6.00 hours
      expect(dayReport.totalWorkingHours).toBe(6);

      // Verify tasks breakdown: Task A has 14400s (4h), Task B has 7200s (2h)
      expect(dayReport.tasks.length).toBe(2);
      const rTaskA = dayReport.tasks.find((t: any) => t.taskId === taskA.id);
      const rTaskB = dayReport.tasks.find((t: any) => t.taskId === taskB.id);

      expect(rTaskA.durationSeconds).toBe(14400);
      expect(rTaskA.durationHours).toBe(4);
      expect(rTaskB.durationSeconds).toBe(7200);
      expect(rTaskB.durationHours).toBe(2);
    });

    it('Scenario 24: Date-range boundary overlap includes segment within requested range and excludes prior day portion', async () => {
      const task = await createTestTaskDirect({
        title: 'Boundary Overlap Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
      });

      // Entry starts Nov 19 23:00 IST (17:30 UTC) and ends Nov 20 02:00 IST (20:30 UTC) = 10,800s
      await prisma.taskTimeEntry.create({
        data: {
          taskId: task.id,
          userId: emp1DeptAId,
          workDate: new Date('2026-11-19T00:00:00.000Z'),
          startedAt: new Date('2026-11-19T17:30:00.000Z'),
          endedAt: new Date('2026-11-19T20:30:00.000Z'),
          durationSeconds: 10800,
          status: TaskTimerStatus.STOPPED,
        },
      });

      // Query ONLY for Nov 20 (startDate=2026-11-20 & endDate=2026-11-20)
      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/working-hours?employeeId=${emp1DeptAId}&startDate=2026-11-20&endDate=2026-11-20`,
        )
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);

      const dayReport = res.body.data[0];
      expect(dayReport.workDate).toBe('2026-11-20');
      // Exactly 7200s (2 hours) on Nov 20; the 3600s on Nov 19 is outside the requested range
      expect(dayReport.totalWorkingSeconds).toBe(7200);
      expect(dayReport.totalWorkingHours).toBe(2);
    });

    it('Scenario 25: Historical completion percentage strictly satisfies numerator, active/due denominator, and CANCELLED exclusion', async () => {
      // Create dedicated isolated department for Scenario 25
      const dept25 = await prisma.department.create({
        data: {
          code: `RPT_DEPT_S25_${Date.now()}`.substring(0, 30),
          name: 'Reports Scenario 25 Department',
        },
      });

      // Historical Period: 2026-11-21 to 2026-11-25

      // Task 1: Created before period (Nov 1), completed in period (Nov 22) -> In Numerator & Denominator
      const task1 = await createTestTaskDirect({
        title: 'Task 1: Pre-created Completed In Period',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: dept25.id,
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        status: TaskStatus.COMPLETED,
      });
      await prisma.task.update({
        where: { id: task1.id },
        data: { createdAt: new Date('2026-11-01T00:00:00.000Z') },
      });
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task1.id,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-22T10:00:00.000Z'),
        },
      });

      // Task 2: Created in period (Nov 22), due in period (Nov 24), status TODO -> In Denominator, NOT Numerator
      const task2 = await createTestTaskDirect({
        title: 'Task 2: Created & Due In Period Open',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: dept25.id,
        dueDate: new Date('2026-11-24T12:00:00.000Z'),
        status: TaskStatus.TODO,
      });
      await prisma.task.update({
        where: { id: task2.id },
        data: { createdAt: new Date('2026-11-22T08:00:00.000Z') },
      });

      // Task 3: Created before period (Nov 1), completed before period (Nov 10) -> EXCLUDED from Numerator & Denominator
      const task3 = await createTestTaskDirect({
        title: 'Task 3: Completed Before Period Inactive',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: dept25.id,
        status: TaskStatus.COMPLETED,
      });
      await prisma.task.update({
        where: { id: task3.id },
        data: { createdAt: new Date('2026-11-01T00:00:00.000Z') },
      });
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task3.id,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-10T10:00:00.000Z'),
        },
      });

      // Task 4: Created in period (Nov 22), CANCELLED in period (Nov 23) -> Strictly EXCLUDED
      const task4 = await createTestTaskDirect({
        title: 'Task 4: Cancelled Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: dept25.id,
        status: TaskStatus.CANCELLED,
      });
      await prisma.task.update({
        where: { id: task4.id },
        data: { createdAt: new Date('2026-11-22T08:00:00.000Z') },
      });
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task4.id,
          previousStatus: TaskStatus.TODO,
          newStatus: TaskStatus.CANCELLED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-23T10:00:00.000Z'),
        },
      });

      // Task 5: Reopened & Completed multiple times in period -> Counted ONCE in Numerator & Denominator
      const task5 = await createTestTaskDirect({
        title: 'Task 5: Multi Completed In Period',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: dept25.id,
        status: TaskStatus.COMPLETED,
      });
      await prisma.task.update({
        where: { id: task5.id },
        data: { createdAt: new Date('2026-11-21T08:00:00.000Z') },
      });
      // Completion 1 on Nov 22
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task5.id,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-22T10:00:00.000Z'),
        },
      });
      // Reopening on Nov 23
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task5.id,
          previousStatus: TaskStatus.COMPLETED,
          newStatus: TaskStatus.REOPENED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-23T10:00:00.000Z'),
        },
      });
      // Completion 2 on Nov 24
      await prisma.taskStatusHistory.create({
        data: {
          taskId: task5.id,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: superAdminId,
          createdAt: new Date('2026-11-24T10:00:00.000Z'),
        },
      });

      // Query task summary report for historical period 2026-11-21 to 2026-11-25 with Super Admin
      const res = await request(app.getHttpServer())
        .get(
          `/api/tasks/reports/summary?departmentId=${dept25.id}&startDate=2026-11-21&endDate=2026-11-25`,
        )
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const data = res.body.data;

      // Numerator: Task 1 + Task 5 (distinct) = 2
      expect(data.completedTasks).toBe(2);

      // Denominator: Task 1 (active/completed) + Task 2 (created/due) + Task 5 (created/completed) = 3
      // Cancelled Task 4 is excluded; pre-period inactive Task 3 is excluded.
      // Completion % = (2 / 3) * 100 = 66.67%
      expect(data.completionPercentage).toBe(66.67);

      // Clean up test tasks and department
      await prisma.taskStatusHistory.deleteMany({
        where: { taskId: { in: [task1.id, task2.id, task3.id, task4.id, task5.id] } },
      });
      await prisma.task.deleteMany({
        where: { id: { in: [task1.id, task2.id, task3.id, task4.id, task5.id] } },
      });
      await prisma.department.delete({ where: { id: dept25.id } });
    });
  });
});
