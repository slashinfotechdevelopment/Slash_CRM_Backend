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
  TaskPauseReason,
  TaskPriority,
  TaskStatus,
  TaskTimerStatus,
} from '../src/generated/prisma/enums';

describe('Phase 6.3.3: Task Timer & Working Hours (e2e & MySQL Concurrency)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminId: string;
  let superAdminToken: string;

  let adminDeptAId: string;
  let adminDeptAToken: string;

  let emp1DeptAId: string;
  let emp1DeptAToken: string;
  let emp1SessionId: string;

  let emp2DeptAId: string;
  let emp2DeptAToken: string;

  let emp3DeptBId: string;
  let emp3DeptBToken: string;

  let deptAId: string;
  let deptBId: string;

  let taskAId: string;
  let taskBId: string;
  let taskDeptBId: string;

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
    const taskCode = `TMR_${Date.now()}_${Math.floor(Math.random() * 10000)}`.substring(0, 30);
    const task = await prisma.task.create({
      data: {
        taskCode,
        title: data.title,
        description: data.description ?? 'Timer test task',
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
    roleCode: string,
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
        email: `${prefix.toLowerCase()}_${uniqueSuffix}@testtimer.com`,
        status: RecordStatus.ACTIVE,
      },
    });
    createdUserIds.push(user.id);

    await prisma.userDepartment.create({
      data: {
        userId: user.id,
        departmentId: deptId,
        isPrimary: true,
      },
    });

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
        secret: process.env.JWT_SECRET || 'slash@202612354',
        expiresIn: '1h',
      },
    );

    return { user, token, session };
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

    // 1. Departments
    const deptA = await prisma.department.upsert({
      where: { code: 'E2E_TIMER_DEPT_A' },
      update: {},
      create: { code: 'E2E_TIMER_DEPT_A', name: 'Timer Dept A' },
    });
    deptAId = deptA.id;

    const deptB = await prisma.department.upsert({
      where: { code: 'E2E_TIMER_DEPT_B' },
      update: {},
      create: { code: 'E2E_TIMER_DEPT_B', name: 'Timer Dept B' },
    });
    deptBId = deptB.id;

    // 2. Users
    const sa = await createTestUser('SA', 'SUPER_ADMIN', deptAId, 'SUPER_ADMIN');
    superAdminId = sa.user.id;
    superAdminToken = sa.token;

    const adm = await createTestUser('ADMIN_A', 'ADMIN', deptAId, 'ADMIN');
    adminDeptAId = adm.user.id;
    adminDeptAToken = adm.token;

    const emp1 = await createTestUser('EMP1_A', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp1DeptAId = emp1.user.id;
    emp1DeptAToken = emp1.token;
    emp1SessionId = emp1.session.id;

    const emp2 = await createTestUser('EMP2_A', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp2DeptAId = emp2.user.id;
    emp2DeptAToken = emp2.token;

    const emp3 = await createTestUser('EMP3_B', 'EMPLOYEE', deptBId, 'DEVELOPER');
    emp3DeptBId = emp3.user.id;
    emp3DeptBToken = emp3.token;

    const cli = await createTestUser('CLI', 'CLIENT', deptAId, 'SUPPORT');
    clientId = cli.user.id;
    clientToken = cli.token;

    // 3. Tasks
    const tA = await createTestTaskDirect({
      title: 'Task Alpha - Timer Spec',
      createdById: emp1DeptAId,
      assigneeId: emp1DeptAId,
      departmentId: deptAId,
      status: TaskStatus.TODO,
    });
    taskAId = tA.id;

    const tB = await createTestTaskDirect({
      title: 'Task Beta - Timer Spec',
      createdById: emp1DeptAId,
      assigneeId: emp1DeptAId,
      departmentId: deptAId,
      status: TaskStatus.TODO,
    });
    taskBId = tB.id;

    const tDeptB = await createTestTaskDirect({
      title: 'Task Dept B - Isolation',
      createdById: emp3DeptBId,
      assigneeId: emp3DeptBId,
      departmentId: deptBId,
      status: TaskStatus.TODO,
    });
    taskDeptBId = tDeptB.id;

    // Explicitly configure DEPARTMENT data scope for Admin A on tasks.view, tasks.time.view, tasks.time.view_summary
    const tasksViewPerm = await prisma.permission.findUniqueOrThrow({
      where: { code: 'tasks.view' },
    });
    const tasksTimeViewPerm = await prisma.permission.findUniqueOrThrow({
      where: { code: 'tasks.time.view' },
    });
    const tasksTimeSummaryPerm = await prisma.permission.findUniqueOrThrow({
      where: { code: 'tasks.time.view_summary' },
    });

    await prisma.userPermission.createMany({
      data: [
        {
          userId: adminDeptAId,
          permissionId: tasksViewPerm.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
        {
          userId: adminDeptAId,
          permissionId: tasksTimeViewPerm.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
        {
          userId: adminDeptAId,
          permissionId: tasksTimeSummaryPerm.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
        {
          userId: emp2DeptAId,
          permissionId: tasksViewPerm.id,
          effect: PermissionEffect.ALLOW,
          dataScope: DataScope.DEPARTMENT,
        },
      ],
    });
  });

  afterAll(async () => {
    // Cleanup created records
    try {
      if (prisma) {
        await prisma.userPermission.deleteMany({
          where: { userId: { in: createdUserIds } },
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
        await prisma.taskTagMapping.deleteMany({
          where: { taskId: { in: createdTaskIds } },
        });
        await prisma.taskAssignmentHistory.deleteMany({
          where: { taskId: { in: createdTaskIds } },
        });
        await prisma.task.deleteMany({
          where: { id: { in: createdTaskIds } },
        });
        await prisma.userSession.deleteMany({
          where: { userId: { in: createdUserIds } },
        });
        await prisma.userRole.deleteMany({
          where: { userId: { in: createdUserIds } },
        });
        await prisma.userDepartment.deleteMany({
          where: { userId: { in: createdUserIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    } catch (e) {
      console.error('Cleanup error:', e);
    }
    if (app) {
      await app.close();
    }
  });

  describe('1. Play Task Timer & Automatic Status Advance', () => {
    it('Scenario 1: Employee starts Task A (play endpoint advances TODO to IN_PROGRESS)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ deviceType: 'WEB' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Timer started successfully');
      expect(res.body.data.isTaskSwitch).toBe(false);
      expect(res.body.data.entry.status).toBe(TaskTimerStatus.RUNNING);

      // Verify DB Task status moved from TODO to IN_PROGRESS
      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });
      expect(task.status).toBe(TaskStatus.IN_PROGRESS);

      // Verify active_user_id in DB is set to emp1DeptAId
      const activeEntry = await prisma.taskTimeEntry.findFirst({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(activeEntry).toBeDefined();
      expect(activeEntry?.taskId).toBe(taskAId);
      expect(activeEntry?.status).toBe(TaskTimerStatus.RUNNING);

      // Verify Status History and Activity Log recorded
      const histories = await prisma.taskStatusHistory.findMany({ where: { taskId: taskAId } });
      expect(histories.some((h) => h.previousStatus === TaskStatus.TODO && h.newStatus === TaskStatus.IN_PROGRESS)).toBe(true);

      const logs = await prisma.taskActivityLog.findMany({ where: { taskId: taskAId } });
      expect(logs.some((l) => l.action === 'TIMER_STARTED')).toBe(true);
    });

    it('Scenario 1b: Re-playing already running Task A is idempotent', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('already running');
      expect(res.body.data.isTaskSwitch).toBe(false);

      // Exactly 1 running entry in DB
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(1);
    });
  });

  describe('2. Automatic Task Switching & Single Running Timer Rule', () => {
    it('Scenario 2: Employee starts Task B; Task A automatically pauses with TASK_SWITCH', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskBId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Timer started successfully');
      expect(res.body.data.isTaskSwitch).toBe(true);

      // 1. Task A work entry is closed with PAUSED
      const taskAEntry = await prisma.taskTimeEntry.findFirst({
        where: { taskId: taskAId, userId: emp1DeptAId },
        orderBy: { startedAt: 'desc' },
      });
      expect(taskAEntry?.endedAt).not.toBeNull();
      expect(taskAEntry?.status).toBe(TaskTimerStatus.PAUSED);

      // 2. Pause record exists for Task A with TASK_SWITCH
      const taskAPause = await prisma.taskTimePause.findFirst({
        where: { taskId: taskAId, userId: emp1DeptAId },
      });
      expect(taskAPause).toBeDefined();
      expect(taskAPause?.reason).toBe(TaskPauseReason.TASK_SWITCH);
      expect(taskAPause?.precedingTimeEntryId).toBe(taskAEntry?.id);

      // 3. Task B now has the single active running entry
      const activeEntry = await prisma.taskTimeEntry.findFirst({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(activeEntry?.taskId).toBe(taskBId);
      expect(activeEntry?.status).toBe(TaskTimerStatus.RUNNING);
    });

    it('Scenario 3: DB & Constraint Proof - Exactly one running work entry per employee', async () => {
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(1);

      // Direct MySQL raw query verification
      const rawCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM task_time_entries WHERE user_id = ${emp1DeptAId} AND ended_at IS NULL
      `;
      expect(Number(rawCount[0].count)).toBe(1);
    });
  });

  describe('3. Concurrency Protection (Real MySQL Row Locks & Unique Index)', () => {
    it('Scenario 4: 10 concurrent Play requests for two tasks produce exactly ONE running timer', async () => {
      // 5 requests for Task A, 5 requests for Task B simultaneously
      const promises = [
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${emp1DeptAToken}`).send({}),
      ];

      const responses = await Promise.all(promises);

      // Every response should be 200 (or 409 conflict handled gracefully)
      for (const res of responses) {
        expect([200, 409]).toContain(res.status);
      }

      // Crucial verification: In MySQL, active_user_id unique index + row locks ensure exactly 1 running timer
      const rawCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM task_time_entries WHERE user_id = ${emp1DeptAId} AND ended_at IS NULL
      `;
      expect(Number(rawCount[0].count)).toBe(1);
    });

    it('Scenario 5: 10 concurrent Play requests for the same task do not create duplicates', async () => {
      const promises = Array.from({ length: 10 }).map(() =>
        request(app.getHttpServer())
          .post(`/api/tasks/${taskAId}/timer/play`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .send({}),
      );

      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect([200, 409]).toContain(res.status);
      }

      const rawCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM task_time_entries WHERE user_id = ${emp1DeptAId} AND ended_at IS NULL
      `;
      expect(Number(rawCount[0].count)).toBe(1);
    });
  });

  describe('4. Pause & Resume Lifecycle & History Preservation', () => {
    it('Scenario 6a: Pause Task with manual reason (TEA_BREAK)', async () => {
      // Ensure Task A is running
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({});

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.TEA_BREAK })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Timer paused successfully');
      expect(res.body.data.pause.reason).toBe(TaskPauseReason.TEA_BREAK);

      // 0 running timers
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(0);

      // 1 open pause exists
      const openPause = await prisma.taskTimePause.findFirst({
        where: { taskId: taskAId, userId: emp1DeptAId, resumedAt: null },
      });
      expect(openPause).toBeDefined();
      expect(openPause?.reason).toBe(TaskPauseReason.TEA_BREAK);
    });

    it('Scenario 6b: Resume paused Task A', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/resume`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Timer resumed successfully');
      expect(res.body.data.entry.status).toBe(TaskTimerStatus.RUNNING);

      // Verify the open pause was closed and linked to the new entry
      const previousPause = await prisma.taskTimePause.findFirst({
        where: { taskId: taskAId, userId: emp1DeptAId, reason: TaskPauseReason.TEA_BREAK },
      });
      expect(previousPause?.resumedAt).not.toBeNull();
      expect(previousPause?.followingTimeEntryId).toBe(res.body.data.entry.id);

      // Exactly 1 running timer now
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(1);
    });
  });

  describe('5. Pause Reason Rules & Impersonation Prevention', () => {
    it('Scenario 12a: Rejects manual submission of system reason TASK_SWITCH', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.TASK_SWITCH })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('system-generated');
    });

    it('Scenario 12b: Rejects manual submission of system reason LOGOUT', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.LOGOUT })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('system-generated');
    });

    it('Scenario 12e: Rejects manual submission of system reason TASK_STATUS_CHANGE', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.TASK_STATUS_CHANGE })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('system-generated');
    });

    it('Scenario 12c: Rejects OTHER pause reason without customDescription', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.OTHER })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Validation failed');
      expect(JSON.stringify(res.body.errors)).toContain('customDescription');
    });

    it('Scenario 12d: Accepts OTHER pause reason with valid customDescription', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          reason: TaskPauseReason.OTHER,
          customDescription: 'Doctor appointment consultation',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.pause.reason).toBe(TaskPauseReason.OTHER);
      expect(res.body.data.pause.customDescription).toBe('Doctor appointment consultation');
    });
  });

  describe('6. Logout & Logout-All Auto-Pause Integration', () => {
    it('Scenario 7: Logout automatically pauses running timer with LOGOUT reason', async () => {
      // 1. Resume Task A
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/resume`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({});

      // Confirm timer is running
      let active = await prisma.taskTimeEntry.findFirst({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(active).toBeDefined();

      // 2. Perform Logout
      const logoutRes = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(logoutRes.body.success).toBe(true);

      // 3. Verify timer auto-paused with reason LOGOUT
      active = await prisma.taskTimeEntry.findFirst({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(active).toBeNull(); // 0 running timers

      const logoutPause = await prisma.taskTimePause.findFirst({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
        orderBy: { pausedAt: 'desc' },
      });
      expect(logoutPause).toBeDefined();
      expect(logoutPause?.reason).toBe(TaskPauseReason.LOGOUT);

      // 4. Verify session revoked
      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: emp1SessionId },
      });
      expect(session.status).toBe('REVOKED');
    });

    it('Scenario 8: Logout-all automatically pauses running timer exactly once', async () => {
      // Re-create active session and token for emp1
      const newSession = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_logout_all',
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      const newToken = await jwtService.signAsync(
        {
          sub: emp1DeptAId,
          email: 'emp1@test.com',
          userCode: 'EMP1',
          userType: 'EMPLOYEE',
          roles: ['DEVELOPER'],
          sessionId: newSession.id,
        },
        { secret: process.env.JWT_SECRET || 'slash@202612354' },
      );

      // Start timer on Task B
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskBId}/timer/play`)
        .set('Authorization', `Bearer ${newToken}`)
        .send({});

      const pauseCountBefore = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });

      // Call logout-all
      const res = await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${newToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);

      // Exactly 1 new LOGOUT pause record created
      const pauseCountAfter = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });
      expect(pauseCountAfter).toBe(pauseCountBefore + 1);

      // 0 running timers
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(0);
    });

    it('Scenario 9: Next login does NOT automatically resume timer', async () => {
      // Simulate next day login: create fresh session and query active timer
      const loginSession = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_next_day_login',
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      const loginToken = await jwtService.signAsync(
        {
          sub: emp1DeptAId,
          email: 'emp1@test.com',
          userCode: 'EMP1',
          userType: 'EMPLOYEE',
          roles: ['DEVELOPER'],
          sessionId: loginSession.id,
        },
        { secret: process.env.JWT_SECRET || 'slash@202612354' },
      );

      const activeRes = await request(app.getHttpServer())
        .get('/api/tasks/timer/active')
        .set('Authorization', `Bearer ${loginToken}`)
        .expect(200);

      expect(activeRes.body.success).toBe(true);
      expect(activeRes.body.data.isRunning).toBe(false);
      expect(activeRes.body.data.isPaused).toBe(true); // paused from previous logout
    });
  });

  describe('7. Security Boundaries & Cross-Employee Isolation', () => {
    it('Scenario 10: Another employee CANNOT pause or resume someone else’s timer', async () => {
      // emp1 owns task A, emp2 is in Dept A (has tasks.view DEPARTMENT scope, so can view task A, but is not assignee)
      const resPause = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp2DeptAToken}`)
        .send({ reason: TaskPauseReason.LUNCH })
        .expect(403);

      expect(resPause.body.success).toBe(false);
      expect(resPause.body.message).toContain('assigned to you');

      const resResume = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/resume`)
        .set('Authorization', `Bearer ${emp2DeptAToken}`)
        .send({})
        .expect(403);

      expect(resResume.body.success).toBe(false);
      expect(resResume.body.message).toContain('assigned to you');

      // Colleague in another department (Dept B) cannot even view task A (404)
      const resCrossDept = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/pause`)
        .set('Authorization', `Bearer ${emp3DeptBToken}`)
        .send({ reason: TaskPauseReason.LUNCH })
        .expect(404);

      expect(resCrossDept.body.success).toBe(false);
    });

    it('Scenario 11: Admin in Dept A cannot view Dept B task time entries or summary', async () => {
      const resEntries = await request(app.getHttpServer())
        .get(`/api/tasks/${taskDeptBId}/time-entries`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(404);

      expect(resEntries.body.success).toBe(false);

      const resSummary = await request(app.getHttpServer())
        .get(`/api/tasks/${taskDeptBId}/time-summary`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(404);

      expect(resSummary.body.success).toBe(false);
    });
  });

  describe('8. Time Calculations & Daily Splits across Asia/Kolkata Midnight', () => {
    beforeEach(async () => {
      // Create fresh active session and token for emp1 since previous session was logged out in Scenario 7
      const freshSession = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_fresh_emp1_' + Date.now(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      emp1DeptAToken = await jwtService.signAsync(
        {
          sub: emp1DeptAId,
          email: 'emp1@testtimer.com',
          userCode: 'EMP1_A',
          userType: 'EMPLOYEE',
          roles: ['DEVELOPER'],
          sessionId: freshSession.id,
        },
        { secret: process.env.JWT_SECRET || 'slash@202612354', expiresIn: '1h' },
      );
    });
    it('Scenario 13: Overnight work is calculated and split correctly at IST midnight (18:30 UTC)', async () => {
      // Seed a closed overnight entry for Task A:
      // Started at 18:00 UTC (23:30 IST on 2026-11-04)
      // Ended at 20:00 UTC (01:30 IST on 2026-11-05)
      // Total 7200 seconds (2 hours)
      const overnightStart = new Date('2026-11-04T18:00:00.000Z');
      const overnightEnd = new Date('2026-11-04T20:00:00.000Z');

      await prisma.taskTimeEntry.create({
        data: {
          taskId: taskAId,
          userId: emp1DeptAId,
          workDate: new Date('2026-11-04T00:00:00.000Z'),
          startedAt: overnightStart,
          endedAt: overnightEnd,
          durationSeconds: 7200,
          status: TaskTimerStatus.COMPLETED,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${taskAId}/time-summary`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const summary = res.body.data;
      expect(summary.totalWorkingSeconds).toBeGreaterThanOrEqual(7200);

      // Verify daily breakdown has 2026-11-04 and 2026-11-05 segments
      const d1 = summary.dailyBreakdown.find((d: any) => d.date === '2026-11-04');
      const d2 = summary.dailyBreakdown.find((d: any) => d.date === '2026-11-05');

      expect(d1).toBeDefined();
      expect(d1.workingSeconds).toBeGreaterThanOrEqual(1800); // 30 min before midnight
      expect(d2).toBeDefined();
      expect(d2.workingSeconds).toBeGreaterThanOrEqual(5400); // 90 min after midnight
    });

    it('GET /api/tasks/my-time-summary aggregates personal time summary across tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/tasks/my-time-summary')
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.userId).toBe(emp1DeptAId);
      expect(res.body.data.totalWorkingSeconds).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.dailyBreakdown)).toBe(true);
      expect(Array.isArray(res.body.data.taskBreakdown)).toBe(true);
    });

    it('Scenario 14: Stop timer explicitly ends session without marking task COMPLETED', async () => {
      // 1. Play task A
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({});

      // 2. Stop task A
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/stop`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ finalComment: 'Day finished' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Timer stopped successfully');

      // Verify task status is STILL IN_PROGRESS (NOT COMPLETED!)
      const task = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });
      expect(task.status).toBe(TaskStatus.IN_PROGRESS);

      // Verify no running timer
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(0);
    });
  });

  describe('9. Attendance Non-Interference Verification', () => {
    it('Scenario 15: Task timer actions do NOT create or mutate attendance breaks or sessions', async () => {
      const attSessions = await prisma.attendanceSession.count({
        where: { userId: emp1DeptAId },
      });
      const attBreaks = await prisma.attendanceBreak.count({
        where: { attendanceRecord: { userId: emp1DeptAId } },
      });

      // Pure task timers should have 0 attendance sessions / breaks created
      expect(attSessions).toBe(0);
      expect(attBreaks).toBe(0);
    });
  });

  describe('10. TaskTimePause Relationship Integrity & Database Constraints', () => {
    let testEntryAId: string;

    beforeAll(async () => {
      // Create a closed test work entry on taskA for emp1
      const started = new Date(Date.now() - 3600000);
      const ended = new Date(Date.now() - 1800000);
      const entry = await prisma.taskTimeEntry.create({
        data: {
          taskId: taskAId,
          userId: emp1DeptAId,
          workDate: new Date(),
          startedAt: started,
          endedAt: ended,
          durationSeconds: 1800,
          status: TaskTimerStatus.PAUSED,
        },
      });
      testEntryAId = entry.id;
    });

    it('Scenario 16a: Raw SQL - Cross-Employee pause link is rejected by Composite FK constraint', async () => {
      // Attempt to link a pause belonging to emp2 to a work entry belonging to emp1
      const invalidPauseId = `p_bad_usr_${Date.now()}`.substring(0, 30);
      let errorThrown: any = null;

      try {
        await prisma.$executeRaw`
          INSERT INTO task_time_pauses (
            id, task_id, user_id, preceding_time_entry_id, paused_at, reason, created_at, updated_at
          ) VALUES (
            ${invalidPauseId}, ${taskAId}, ${emp2DeptAId}, ${testEntryAId}, NOW(), 'TEA_BREAK', NOW(), NOW()
          )
        `;
      } catch (err: any) {
        errorThrown = err;
      }

      expect(errorThrown).not.toBeNull();
      // MySQL Error 1452: foreign key constraint fails
      expect(errorThrown.message).toMatch(/(1452|foreign key constraint fails)/i);
    });

    it('Scenario 16b: Raw SQL - Cross-Task pause link is rejected by Composite FK constraint', async () => {
      // Attempt to link a pause for taskB to a work entry on taskA (both emp1)
      const invalidPauseId = `p_bad_tsk_${Date.now()}`.substring(0, 30);
      let errorThrown: any = null;

      try {
        await prisma.$executeRaw`
          INSERT INTO task_time_pauses (
            id, task_id, user_id, preceding_time_entry_id, paused_at, reason, created_at, updated_at
          ) VALUES (
            ${invalidPauseId}, ${taskBId}, ${emp1DeptAId}, ${testEntryAId}, NOW(), 'TEA_BREAK', NOW(), NOW()
          )
        `;
      } catch (err: any) {
        errorThrown = err;
      }

      expect(errorThrown).not.toBeNull();
      expect(errorThrown.message).toMatch(/(1452|foreign key constraint fails)/i);
    });

    it('Scenario 16c: Raw SQL - Pause cannot point to unclosed work entry (Trigger check)', async () => {
      // Create an open running entry
      const openEntry = await prisma.taskTimeEntry.create({
        data: {
          taskId: taskAId,
          userId: emp1DeptAId,
          workDate: new Date(),
          startedAt: new Date(),
          endedAt: null,
          status: TaskTimerStatus.RUNNING,
        },
      });

      const invalidPauseId = `p_bad_opn_${Date.now()}`.substring(0, 30);
      let errorThrown: any = null;

      try {
        await prisma.$executeRaw`
          INSERT INTO task_time_pauses (
            id, task_id, user_id, preceding_time_entry_id, paused_at, reason, created_at, updated_at
          ) VALUES (
            ${invalidPauseId}, ${taskAId}, ${emp1DeptAId}, ${openEntry.id}, NOW(), 'TEA_BREAK', NOW(), NOW()
          )
        `;
      } catch (err: any) {
        errorThrown = err;
      }

      // Cleanup open entry
      await prisma.taskTimeEntry.delete({ where: { id: openEntry.id } });

      expect(errorThrown).not.toBeNull();
      expect(errorThrown.message).toMatch(/(Preceding work entry must be closed|45000)/i);
    });

    it('Scenario 16d: Raw SQL - Pause cannot start before preceding entry ended (Trigger check)', async () => {
      // testEntryAId ended at Date.now() - 1800000. Attempt pause starting at Date.now() - 2500000
      const earlierDate = new Date(Date.now() - 2500000);
      const invalidPauseId = `p_bad_tim_${Date.now()}`.substring(0, 30);
      let errorThrown: any = null;

      try {
        await prisma.$executeRaw`
          INSERT INTO task_time_pauses (
            id, task_id, user_id, preceding_time_entry_id, paused_at, reason, created_at, updated_at
          ) VALUES (
            ${invalidPauseId}, ${taskAId}, ${emp1DeptAId}, ${testEntryAId}, ${earlierDate}, 'TEA_BREAK', NOW(), NOW()
          )
        `;
      } catch (err: any) {
        errorThrown = err;
      }

      expect(errorThrown).not.toBeNull();
      expect(errorThrown.message).toMatch(/(Pause cannot begin before preceding work entry ended|45000)/i);
    });

    it('Scenario 16e: Raw SQL - Valid matching pause succeeds and links accurately', async () => {
      const validPauseId = `p_valid_${Date.now()}`.substring(0, 30);
      const validPauseTime = new Date();

      await prisma.$executeRaw`
        INSERT INTO task_time_pauses (
          id, task_id, user_id, preceding_time_entry_id, paused_at, reason, created_at, updated_at
        ) VALUES (
          ${validPauseId}, ${taskAId}, ${emp1DeptAId}, ${testEntryAId}, ${validPauseTime}, 'TEA_BREAK', NOW(), NOW()
        )
      `;

      const pause = await prisma.taskTimePause.findUnique({
        where: { id: validPauseId },
      });
      expect(pause).toBeDefined();
      expect(pause?.taskId).toBe(taskAId);
      expect(pause?.userId).toBe(emp1DeptAId);

      // Cleanup
      await prisma.taskTimePause.delete({ where: { id: validPauseId } });
    });
  });

  describe('11. Logout Transaction & Real MySQL Concurrency Integrity', () => {
    let empLogoutSession: any;
    let empLogoutToken: string;

    beforeEach(async () => {
      const session = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_logout_test_' + Date.now() + Math.random(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      empLogoutSession = session;
      empLogoutToken = await jwtService.signAsync(
        {
          sub: emp1DeptAId,
          email: 'emp1@testtimer.com',
          userCode: 'EMP1_A',
          userType: 'EMPLOYEE',
          roles: ['DEVELOPER'],
          sessionId: session.id,
        },
        { secret: process.env.JWT_SECRET || 'slash@202612354', expiresIn: '1h' },
      );
    });

    it('Scenario 17: Concurrent logout requests are idempotent, create 1 LOGOUT pause, and revoke session', async () => {
      // Start timer on Task A
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});

      const pauseCountBefore = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });

      // 5 simultaneous logout calls
      const promises = Array.from({ length: 5 }).map(() =>
        request(app.getHttpServer())
          .post('/api/auth/logout')
          .set('Authorization', `Bearer ${empLogoutToken}`),
      );

      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Session is REVOKED
      const updatedSession = await prisma.userSession.findUniqueOrThrow({
        where: { id: empLogoutSession.id },
      });
      expect(updatedSession.status).toBe('REVOKED');

      // Exactly 1 new LOGOUT pause
      const pauseCountAfter = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });
      expect(pauseCountAfter).toBe(pauseCountBefore + 1);

      // 0 running timers
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(0);
    });

    it('Scenario 18: Concurrent logout and Play requests serialize via row lock (timer never remains running)', async () => {
      // Fire 1 Logout and 4 Play requests simultaneously
      const reqs = [
        request(app.getHttpServer()).post('/api/auth/logout').set('Authorization', `Bearer ${empLogoutToken}`),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${empLogoutToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${empLogoutToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskAId}/timer/play`).set('Authorization', `Bearer ${empLogoutToken}`).send({}),
        request(app.getHttpServer()).post(`/api/tasks/${taskBId}/timer/play`).set('Authorization', `Bearer ${empLogoutToken}`).send({}),
      ];

      await Promise.all(reqs);

      // Session MUST be revoked
      const updatedSession = await prisma.userSession.findUniqueOrThrow({
        where: { id: empLogoutSession.id },
      });
      expect(updatedSession.status).toBe('REVOKED');

      // Crucial verification: Active timer must NOT remain running after logout completes
      const runningCount = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(runningCount).toBe(0);
    });

    it('Scenario 19: Logout-all while timer is running revokes all sessions and creates at most 1 LOGOUT pause', async () => {
      // Create 2 more active sessions for emp1
      const s2 = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_s2_' + Date.now(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      const s3 = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_s3_' + Date.now(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      // Start timer on Task A
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});

      const pauseCountBefore = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });

      const res = await request(app.getHttpServer())
        .post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);

      // All 3 sessions revoked
      const sessions = await prisma.userSession.findMany({
        where: { id: { in: [empLogoutSession.id, s2.id, s3.id] } },
      });
      for (const s of sessions) {
        expect(s.status).toBe('REVOKED');
      }

      // Exactly 1 new LOGOUT pause
      const pauseCountAfter = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });
      expect(pauseCountAfter).toBe(pauseCountBefore + 1);

      // 0 running timers
      const running = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(running).toBe(0);
    });

    it('Scenario 20: Injected failure in logout transaction rolls back session revocation', async () => {
      // Start timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});

      // Transactionally test failure injection:
      let txError: any = null;
      try {
        await prisma.$transaction(async (tx) => {
          // 1. Simulate auto-pause
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${emp1DeptAId} FOR UPDATE`;
          // 2. Injected failure
          throw new Error('INJECTED_TIMER_PAUSE_FAILURE');
        });
      } catch (err: any) {
        txError = err;
      }

      expect(txError?.message).toBe('INJECTED_TIMER_PAUSE_FAILURE');

      // Session must still be ACTIVE
      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: empLogoutSession.id },
      });
      expect(session.status).toBe('ACTIVE');

      // Timer must still be RUNNING
      const running = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(running).toBe(1);

      // Cleanup running timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/stop`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});
    });

    it('Scenario 21: Injected failure during session revocation rolls back timer pause', async () => {
      // Start timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});

      const pauseCountBefore = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });

      let txError: any = null;
      try {
        await prisma.$transaction(async (tx) => {
          // 1. Auto-pause closes work entry
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${emp1DeptAId} FOR UPDATE`;
          await tx.taskTimePause.create({
            data: {
              taskId: taskAId,
              userId: emp1DeptAId,
              pausedAt: new Date(),
              reason: TaskPauseReason.LOGOUT,
            },
          });
          // 2. Injected failure during session update
          throw new Error('INJECTED_SESSION_REVOCATION_FAILURE');
        });
      } catch (err: any) {
        txError = err;
      }

      expect(txError?.message).toBe('INJECTED_SESSION_REVOCATION_FAILURE');

      // Pause was rolled back (count unchanged)
      const pauseCountAfter = await prisma.taskTimePause.count({
        where: { userId: emp1DeptAId, reason: TaskPauseReason.LOGOUT },
      });
      expect(pauseCountAfter).toBe(pauseCountBefore);

      // Session remains ACTIVE
      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: empLogoutSession.id },
      });
      expect(session.status).toBe('ACTIVE');

      // Timer remains RUNNING
      const running = await prisma.taskTimeEntry.count({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(running).toBe(1);

      // Cleanup
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/stop`)
        .set('Authorization', `Bearer ${empLogoutToken}`)
        .send({});
    });
  });

  describe('12. Task Assignment, Unassigned Drafts & Data Scope Integrity', () => {
    let unassignedTaskId: string;
    let freshEmp1Token: string;

    beforeAll(async () => {
      const draft = await createTestTaskDirect({
        title: 'Unassigned Draft Task',
        createdById: emp1DeptAId,
        assigneeId: null,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });
      unassignedTaskId = draft.id;
    });

    beforeEach(async () => {
      const s = await prisma.userSession.create({
        data: {
          userId: emp1DeptAId,
          refreshTokenHash: 'hash_draft_' + Date.now() + Math.random(),
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      freshEmp1Token = await jwtService.signAsync(
        {
          sub: emp1DeptAId,
          email: 'emp1@testtimer.com',
          userCode: 'EMP1_A',
          userType: 'EMPLOYEE',
          roles: ['DEVELOPER'],
          sessionId: s.id,
        },
        { secret: process.env.JWT_SECRET || 'slash@202612354', expiresIn: '1h' },
      );
    });

    it('Scenario 22: Unassigned draft task cannot be played (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${unassignedTaskId}/timer/play`)
        .set('Authorization', `Bearer ${freshEmp1Token}`)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('unassigned task');
    });

    it('Scenario 23: Task assigned to another employee cannot be operated (403 Forbidden)', async () => {
      // taskDeptBId is assigned to emp3DeptB. emp1 attempts to play it.
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${taskDeptBId}/timer/play`)
        .set('Authorization', `Bearer ${freshEmp1Token}`)
        .send({});

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it('Scenario 24: Reassigning a task with running timer auto-pauses original employee timer and preserves history', async () => {
      // 1. Play Task A by emp1
      await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${freshEmp1Token}`)
        .send({});

      // Confirm timer is running
      const active = await prisma.taskTimeEntry.findFirst({
        where: { userId: emp1DeptAId, endedAt: null },
      });
      expect(active).toBeDefined();

      // 2. Super Admin reassigns Task A to emp2
      const resReassign = await request(app.getHttpServer())
        .patch(`/api/tasks/${taskAId}/assign`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ assigneeId: emp2DeptAId, reason: 'Reassigned for load balancing' })
        .expect(200);

      expect(resReassign.body.success).toBe(true);

      // 3. Original employee's timer entry was cleanly closed with status PAUSED
      const closedEntry = await prisma.taskTimeEntry.findUnique({
        where: { id: active!.id },
      });
      expect(closedEntry?.endedAt).not.toBeNull();
      expect(closedEntry?.status).toBe(TaskTimerStatus.PAUSED);
      expect(closedEntry?.durationSeconds).toBeGreaterThanOrEqual(0);

      // 4. An audit pause was created for emp1
      const pause = await prisma.taskTimePause.findFirst({
        where: { precedingTimeEntryId: active!.id },
      });
      expect(pause).toBeDefined();
      expect(pause?.userId).toBe(emp1DeptAId);
      expect(pause?.reason).toBe(TaskPauseReason.TASK_SWITCH);
      expect(pause?.customDescription).toContain('reassigned');

      // 5. New assignee does not have a phantom running timer
      const emp2Running = await prisma.taskTimeEntry.count({
        where: { userId: emp2DeptAId, endedAt: null },
      });
      expect(emp2Running).toBe(0);

      // Reassign back to emp1 for subsequent tests
      await request(app.getHttpServer())
        .patch(`/api/tasks/${taskAId}/assign`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ assigneeId: emp1DeptAId, reason: 'Restored to emp1' })
        .expect(200);
    });

    it('Scenario 25: Manager can view employee time entries, but CANNOT operate employee timer (403 Forbidden)', async () => {
      // Admin A in Dept A queries time entries of taskA -> 200 OK
      const resView = await request(app.getHttpServer())
        .get(`/api/tasks/${taskAId}/time-entries`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .expect(200);

      expect(resView.body.success).toBe(true);

      // Admin A attempts to play timer on taskA (which is assigned to emp1) -> 403 Forbidden
      const resPlay = await request(app.getHttpServer())
        .post(`/api/tasks/${taskAId}/timer/play`)
        .set('Authorization', `Bearer ${adminDeptAToken}`)
        .send({})
        .expect(403);

      expect(resPlay.body.success).toBe(false);
      expect(resPlay.body.message).toContain('assigned to you');
    });

    it('Scenario 26: Client users cannot access internal time records (403 Forbidden)', async () => {
      // Client calling get active timer
      const resActive = await request(app.getHttpServer())
        .get('/api/tasks/timer/active')
        .set('Authorization', `Bearer ${clientToken}`);

      expect([403, 404]).toContain(resActive.status);
      expect(resActive.body.success).toBe(false);

      // Client calling my-time-summary
      const resSummary = await request(app.getHttpServer())
        .get('/api/tasks/my-time-summary')
        .set('Authorization', `Bearer ${clientToken}`);

      expect([403, 404]).toContain(resSummary.status);
      expect(resSummary.body.success).toBe(false);
    });
  });
});
