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
  TaskPauseReason,
  TaskPriority,
  TaskReviewOutcome,
  TaskStatus,
  TaskTimerStatus,
} from '../src/generated/prisma/enums';

describe('Phase 6.3.4: Task Workflow & Collaboration (e2e & MySQL Integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminId: string;
  let superAdminToken: string;

  let managerDeptAId: string;
  let managerDeptAToken: string;

  let managerDeptBId: string;
  let managerDeptBToken: string;

  let emp1DeptAId: string;
  let emp1DeptAToken: string;
  let emp1SessionId: string;

  let emp2DeptAId: string;
  let emp2DeptAToken: string;

  let deptAId: string;
  let deptBId: string;

  let clientId: string;
  let clientToken: string;

  const createdTaskIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdMediaIds: string[] = [];

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
    const taskCode = `WF_${Date.now()}_${Math.floor(Math.random() * 10000)}`.substring(0, 30);
    const task = await prisma.task.create({
      data: {
        taskCode,
        title: data.title,
        description: data.description ?? 'Workflow test task',
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
        email: `${prefix.toLowerCase()}_${uniqueSuffix}@testworkflow.com`,
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

    if (roleCode) {
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
    }

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: `hash_${prefix}_${uniqueSuffix}`,
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const token = await jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        userCode: user.userCode,
        userType: userTypeCode,
        roles: roleCode ? [roleCode] : [],
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
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Fetch existing default departments
    const deptA = await prisma.department.findFirstOrThrow({ where: { code: 'DEVELOPMENT' } });
    const deptB = await prisma.department.findFirstOrThrow({ where: { code: 'HR' } });
    deptAId = deptA.id;
    deptBId = deptB.id;

    // 1. Super Admin
    const sa = await createTestUser('SA_WF', 'SUPER_ADMIN', deptAId, 'SUPER_ADMIN');
    superAdminId = sa.user.id;
    superAdminToken = sa.token;

    // 2. Manager Dept A (PROJECT_MANAGER has tasks.submit, tasks.review, tasks.approve, tasks.comment, tasks.attachment)
    const mgrA = await createTestUser('MGR_A', 'ADMIN', deptAId, 'PROJECT_MANAGER');
    managerDeptAId = mgrA.user.id;
    managerDeptAToken = mgrA.token;

    // 3. Manager Dept B
    const mgrB = await createTestUser('MGR_B', 'ADMIN', deptBId, 'PROJECT_MANAGER');
    managerDeptBId = mgrB.user.id;
    managerDeptBToken = mgrB.token;

    // 4. Employee 1 Dept A (DEVELOPER role)
    const emp1 = await createTestUser('EMP1_A', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp1DeptAId = emp1.user.id;
    emp1SessionId = emp1.session.id;
    emp1DeptAToken = emp1.token;

    // 5. Employee 2 Dept A
    const emp2 = await createTestUser('EMP2_A', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp2DeptAId = emp2.user.id;
    emp2DeptAToken = emp2.token;

    // 6. Client User
    const client = await createTestUser('CLI_WF', 'CLIENT', deptAId);
    clientId = client.user.id;
    clientToken = client.token;
  });

  afterAll(async () => {
    // Delete in reverse dependency order
    if (createdTaskIds.length > 0) {
      await prisma.mediaAttachment.deleteMany({
        where: { entityType: 'TASK', entityId: { in: createdTaskIds } },
      });
      await prisma.taskComment.updateMany({
        where: { taskId: { in: createdTaskIds } },
        data: { parentId: null },
      });
      await prisma.taskComment.deleteMany({
        where: { taskId: { in: createdTaskIds } },
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
      await prisma.taskAssignmentHistory.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskStatusHistory.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskActivityLog.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.taskTagMapping.deleteMany({
        where: { taskId: { in: createdTaskIds } },
      });
      await prisma.task.deleteMany({
        where: { id: { in: createdTaskIds } },
      });
    }

    if (createdMediaIds.length > 0) {
      await prisma.media.deleteMany({
        where: { id: { in: createdMediaIds } },
      });
    }

    if (createdUserIds.length > 0) {
      await prisma.userSession.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.employeeProfile.deleteMany({
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

  // ===========================================================================
  // 1. VALID & INVALID STATUS TRANSITIONS
  // ===========================================================================

  describe('1. Task Status Transition Machine', () => {
    it('Scenario 1: Employee transitions task from TODO to IN_PROGRESS via PATCH /api/tasks/:id', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 1',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.IN_PROGRESS })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.IN_PROGRESS);

      const dbTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(dbTask.status).toBe(TaskStatus.IN_PROGRESS);
    });

    it('Scenario 2: Employee attempting invalid transition TODO -> ON_HOLD is rejected (400 Bad Request)', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 2',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.ON_HOLD })
        .expect(400);

      expect(res.body.message).toContain('Cannot transition task from TODO directly to ON_HOLD');
    });

    it('Scenario 3: Employee transitioning IN_PROGRESS -> ON_HOLD succeeds', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 3',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.ON_HOLD })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.ON_HOLD);
    });

    it('Scenario 4: Employee transitioning ON_HOLD -> IN_PROGRESS succeeds', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 4',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.ON_HOLD,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.IN_PROGRESS })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.IN_PROGRESS);
    });

    it('Scenario 5: Employee directly attempting IN_PROGRESS -> COMPLETED is rejected (403 Forbidden)', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 5',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.COMPLETED })
        .expect(403);

      expect(res.body.message).toContain('Employees cannot directly complete tasks without submission');
    });

    it('Scenario 6: Transitioning task to CANCELLED explicitly via POST /api/tasks/:id/cancel succeeds and records audit', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 6',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/cancel`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: 'Project scope discontinued' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.CANCELLED);

      const history = await prisma.taskStatusHistory.findFirst({
        where: { taskId: task.id, newStatus: TaskStatus.CANCELLED },
      });
      expect(history).not.toBeNull();
      expect(history?.comment).toBe('Project scope discontinued');
    });

    it('Scenario 7: Attempting to modify a cancelled task is rejected (400 Bad Request)', async () => {
      const task = await createTestTaskDirect({
        title: 'Status Transition Test 7',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.CANCELLED,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.IN_PROGRESS })
        .expect(400);

      expect(res.body.message).toContain('Cannot modify or transition a cancelled task');
    });
  });

  // ===========================================================================
  // 2. TASK SUBMISSION FOR REVIEW
  // ===========================================================================

  describe('2. Task Submission for Review', () => {
    it('Scenario 8: Submitting unassigned draft task is rejected (400 Bad Request)', async () => {
      const task = await createTestTaskDirect({
        title: 'Draft Task Without Assignee',
        createdById: emp1DeptAId,
        assigneeId: null,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Submitting draft' })
        .expect(400);

      expect(res.body.message).toContain('Cannot submit an unassigned draft task');
    });

    it('Scenario 9: Employee submitting another employee’s task is rejected (403 Forbidden)', async () => {
      // Grant emp1 DEPARTMENT scope on tasks.view and tasks.submit so task is visible, but submission of peer's task is forbidden
      const taskSubmitPerm = await prisma.permission.findFirstOrThrow({ where: { code: 'tasks.submit' } });
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: emp1DeptAId, permissionId: taskSubmitPerm.id } },
        update: { effect: PermissionEffect.ALLOW, dataScope: DataScope.DEPARTMENT },
        create: { userId: emp1DeptAId, permissionId: taskSubmitPerm.id, effect: PermissionEffect.ALLOW, dataScope: DataScope.DEPARTMENT },
      });

      const task = await createTestTaskDirect({
        title: 'Assigned to Emp 2',
        createdById: emp2DeptAId,
        assigneeId: emp2DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Attempting to submit colleague task' })
        .expect(403);

      expect(res.body.message).toContain('You can only submit tasks assigned to you');
    });

    it('Scenario 10: Submitting task auto-pauses running timer, sets status IN_REVIEW, and creates Round 1 TaskReview', async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Timer Auto-Pause and Submission',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // Start working on task
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // Verify timer is running
      let activeTimer = await prisma.taskTimeEntry.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId, status: TaskTimerStatus.RUNNING },
      });
      expect(activeTimer).not.toBeNull();

      // Submit for review
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Code ready for initial review' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.IN_REVIEW);
      expect(res.body.data.roundNumber).toBe(1);

      // Verify timer was automatically paused
      activeTimer = await prisma.taskTimeEntry.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId, status: TaskTimerStatus.RUNNING },
      });
      expect(activeTimer).toBeNull();

      const pause = await prisma.taskTimePause.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId },
      });
      expect(pause).not.toBeNull();
      expect(pause?.reason).toBe(TaskPauseReason.TASK_STATUS_CHANGE);
      expect(pause?.customDescription).toContain('Task submitted for review');

      // Verify TaskReview record in DB
      const review = await prisma.taskReview.findFirst({
        where: { taskId: task.id, roundNumber: 1 },
      });
      expect(review).not.toBeNull();
      expect(review?.outcome).toBe(TaskReviewOutcome.PENDING);
      expect(review?.submissionNotes).toBe('Code ready for initial review');
    });

    it('Scenario 10b: Rejects manual submission of protected system reason TASK_STATUS_CHANGE', async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Manual Pause Rejection',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // Play timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // Attempt manual pause with TASK_STATUS_CHANGE
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: TaskPauseReason.TASK_STATUS_CHANGE })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message.toLowerCase()).toContain('system-generated');
    });

    it('Scenario 10c: Direct status change to ON_HOLD auto-pauses timer with TASK_STATUS_CHANGE reason', async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Status Change Auto-Pause',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // 1. Play timer (advances to IN_PROGRESS)
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      let running = await prisma.taskTimeEntry.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId, status: TaskTimerStatus.RUNNING },
      });
      expect(running).not.toBeNull();

      // 2. Change status to ON_HOLD via PATCH /api/tasks/:id
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.ON_HOLD, statusComment: 'Waiting for client asset' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.ON_HOLD);

      // 3. Verify timer was auto-paused
      running = await prisma.taskTimeEntry.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId, status: TaskTimerStatus.RUNNING },
      });
      expect(running).toBeNull();

      const pause = await prisma.taskTimePause.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId },
      });
      expect(pause).not.toBeNull();
      expect(pause?.reason).toBe(TaskPauseReason.TASK_STATUS_CHANGE);
      expect(pause?.customDescription).toContain('Task status changed to ON_HOLD');

      const activity = await prisma.taskActivityLog.findFirst({
        where: { taskId: task.id, action: 'TIMER_PAUSED_STATUS_CHANGE' },
      });
      expect(activity).not.toBeNull();
    });

    it('Scenario 10d: Atomicity verification - Failed workflow status update rolls back timer pause', async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Atomicity Test',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // 1. Play timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // 2. Attempt invalid status update (e.g. IN_PROGRESS -> COMPLETED without permission)
      // Employee cannot transition directly to COMPLETED -> 403 Forbidden
      await request(app.getHttpServer())
        .patch(`/api/tasks/${task.id}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ status: TaskStatus.COMPLETED })
        .expect(403);

      // 3. Verify timer remains RUNNING and status is still IN_PROGRESS (no partial pause or status update)
      const running = await prisma.taskTimeEntry.findFirst({
        where: { taskId: task.id, userId: emp1DeptAId, status: TaskTimerStatus.RUNNING },
      });
      expect(running).not.toBeNull();

      const currentTask = await prisma.task.findUnique({ where: { id: task.id } });
      expect(currentTask?.status).toBe(TaskStatus.IN_PROGRESS);

      const pauses = await prisma.taskTimePause.findMany({
        where: { taskId: task.id, userId: emp1DeptAId },
      });
      expect(pauses.length).toBe(0);
    });

    it('Scenario 11: Submitting already IN_REVIEW task is rejected (400 Bad Request)', async () => {
      const task = await createTestTaskDirect({
        title: 'Already In Review',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Resubmit attempt' })
        .expect(400);

      expect(res.body.message).toContain('Cannot submit task for review from status IN_REVIEW');
    });
  });

  // ===========================================================================
  // 3. REVIEWER AUTHORIZATION & ANTI-SELF-APPROVAL
  // ===========================================================================

  describe('3. Reviewer Authorization & Anti-Self-Approval', () => {
    it('Scenario 12: Assignee/submitter cannot approve their own review (Anti-Self-Approval: 403 Forbidden)', async () => {
      const task = await createTestTaskDirect({
        title: 'Anti-Self-Approval Test Task',
        createdById: managerDeptAId,
        assigneeId: managerDeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      await prisma.taskReview.create({
        data: {
          taskId: task.id,
          roundNumber: 1,
          submitterId: managerDeptAId,
          outcome: TaskReviewOutcome.PENDING,
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/approve`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Self approving' })
        .expect(403);

      expect(res.body.message).toContain('Anti-self-approval violation');
    });

    it('Scenario 13: Assignee/submitter cannot request changes on their own review (Anti-Self-Review: 403 Forbidden)', async () => {
      const task = await createTestTaskDirect({
        title: 'Anti-Self-Review Test Task',
        createdById: managerDeptAId,
        assigneeId: managerDeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      await prisma.taskReview.create({
        data: {
          taskId: task.id,
          roundNumber: 1,
          submitterId: managerDeptAId,
          outcome: TaskReviewOutcome.PENDING,
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/request-changes`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Changes on own review' })
        .expect(403);

      expect(res.body.message).toContain('Anti-self-approval violation');
    });

    it('Scenario 14: User without review permissions cannot approve reviews (403 Forbidden)', async () => {
      const task = await createTestTaskDirect({
        title: 'Peer Review Authorization Test',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      await prisma.taskReview.create({
        data: {
          taskId: task.id,
          roundNumber: 1,
          submitterId: emp1DeptAId,
          outcome: TaskReviewOutcome.PENDING,
        },
      });

      // Employee 2 does not have tasks.approve permission
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/approve`)
        .set('Authorization', `Bearer ${emp2DeptAToken}`)
        .send({ feedback: 'Peer approval attempt' })
        .expect(403);

      expect(res.body.message).toBeDefined();
    });
  });

  // ===========================================================================
  // 4. MULTI-ROUND REVIEW WORKFLOW CYCLE
  // ===========================================================================

  describe('4. Multi-Round Review Workflow Cycle', () => {
    let cycleTaskId: string;

    it('Scenario 15: Reviewer requests changes on Round 1 -> Task moves to REOPENED with feedback', async () => {
      const task = await createTestTaskDirect({
        title: 'Multi-Cycle Workflow Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });
      cycleTaskId = task.id;

      // Submit Round 1
      await request(app.getHttpServer())
        .post(`/api/tasks/${cycleTaskId}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Round 1 Submission' })
        .expect(200);

      // Manager requests changes
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${cycleTaskId}/request-changes`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Please add comprehensive error logging for external API failure.' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.REOPENED);
      expect(res.body.data.review.outcome).toBe(TaskReviewOutcome.CHANGES_REQUESTED);

      const dbTask = await prisma.task.findUniqueOrThrow({ where: { id: cycleTaskId } });
      expect(dbTask.status).toBe(TaskStatus.REOPENED);
    });

    it('Scenario 16: Employee resumes work on reopened task and resubmits -> Round 2 created', async () => {
      // Employee plays timer on reopened task
      await request(app.getHttpServer())
        .post(`/api/tasks/${cycleTaskId}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // Status automatically moves to IN_PROGRESS
      let dbTask = await prisma.task.findUniqueOrThrow({ where: { id: cycleTaskId } });
      expect(dbTask.status).toBe(TaskStatus.IN_PROGRESS);

      // Employee resubmits task
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${cycleTaskId}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Round 2: Added error logging and unit tests.' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.IN_REVIEW);
      expect(res.body.data.roundNumber).toBe(2);

      dbTask = await prisma.task.findUniqueOrThrow({ where: { id: cycleTaskId } });
      expect(dbTask.status).toBe(TaskStatus.IN_REVIEW);
    });

    it('Scenario 17: Reviewer approves Round 2 -> Task moves to COMPLETED with 100% progress and rating', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${cycleTaskId}/approve`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'All requirements satisfied. Approved.', rating: 5 })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.COMPLETED);

      const dbTask = await prisma.task.findUniqueOrThrow({ where: { id: cycleTaskId } });
      expect(dbTask.status).toBe(TaskStatus.COMPLETED);
      expect(dbTask.progress).toBe(100);
    });

    it('Scenario 18: GET /api/tasks/:id/reviews returns complete preserved review history for both rounds', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${cycleTaskId}/reviews`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].roundNumber).toBe(1);
      expect(res.body.data[0].outcome).toBe(TaskReviewOutcome.CHANGES_REQUESTED);
      expect(res.body.data[0].reviewer.id).toBe(managerDeptAId);

      expect(res.body.data[1].roundNumber).toBe(2);
      expect(res.body.data[1].outcome).toBe(TaskReviewOutcome.APPROVED);
      expect(res.body.data[1].rating).toBe(5);
    });
  });

  // ===========================================================================
  // 5. REVIEW REJECTION & EXPLICIT REOPENING
  // ===========================================================================

  describe('5. Review Rejection & Explicit Reopening', () => {
    it('Scenario 19: Reviewer rejects task review -> Review outcome REJECTED and task returns to REOPENED', async () => {
      const task = await createTestTaskDirect({
        title: 'Review Rejection Test Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Deliverable ready' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/reject`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Deliverable fails core integration test specs.', reopenTask: true })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.REOPENED);
      expect(res.body.data.review.outcome).toBe(TaskReviewOutcome.REJECTED);
    });

    it('Scenario 20: Reopening a completed task via POST /api/tasks/:id/reopen succeeds for authorized supervisor', async () => {
      const task = await createTestTaskDirect({
        title: 'Completed Task to Reopen',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.COMPLETED,
        progress: 100,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/reopen`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ reason: 'Reopened to include additional client feedback' })
        .expect(200);

      expect(res.body.data.status).toBe(TaskStatus.REOPENED);

      const dbTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(dbTask.status).toBe(TaskStatus.REOPENED);
    });
  });

  // ===========================================================================
  // 6. TASK COMMENTS & COLLABORATION
  // ===========================================================================

  describe('6. Task Comments & Collaboration', () => {
    let commentTaskId: string;
    let parentCommentId: string;

    beforeAll(async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Comments Collaboration',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });
      commentTaskId = task.id;
    });

    it('Scenario 21: Authorized user adds a collaboration comment', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${commentTaskId}/comments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ content: 'Starting implementation on user authentication flow.' })
        .expect(201);

      expect(res.body.data.content).toBe('Starting implementation on user authentication flow.');
      expect(res.body.data.user.id).toBe(emp1DeptAId);
      parentCommentId = res.body.data.id;
    });

    it('Scenario 22: Threaded reply using parentId links comments together', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${commentTaskId}/comments`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({
          content: 'Make sure to follow OAuth2 spec for session refresh.',
          parentId: parentCommentId,
        })
        .expect(201);

      expect(res.body.data.parentId).toBe(parentCommentId);
    });

    it('Scenario 23: Comment author edits comment -> content updated, isEdited true, originalContent preserved', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${commentTaskId}/comments/${parentCommentId}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ content: 'Starting implementation on OAuth2 authentication flow (Updated).' })
        .expect(200);

      expect(res.body.data.content).toContain('(Updated)');
      expect(res.body.data.isEdited).toBe(true);
      expect(res.body.data.originalContent).toBe('Starting implementation on user authentication flow.');
    });

    it('Scenario 24: Non-author cannot edit comment (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/tasks/${commentTaskId}/comments/${parentCommentId}`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ content: 'Malicious modification' })
        .expect(403);

      expect(res.body.message).toContain('You can only edit your own comments');
    });

    it('Scenario 25: Author or admin soft-deletes comment -> comment excluded from listing', async () => {
      // Delete child comment
      const childComment = await prisma.taskComment.findFirstOrThrow({
        where: { taskId: commentTaskId, parentId: parentCommentId },
      });

      await request(app.getHttpServer())
        .delete(`/api/tasks/${commentTaskId}/comments/${childComment.id}`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(200);

      // Verify not returned in listing
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${commentTaskId}/comments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      const ids = res.body.data.map((c: any) => c.id);
      expect(ids).not.toContain(childComment.id);
    });

    it('Scenario 26: Client account blocked from internal comments', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${commentTaskId}/comments`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ content: 'Client internal note', isInternal: true })
        .expect(403);

      expect(res.body.message).toBeDefined();
    });
  });

  // ===========================================================================
  // 7. TASK ATTACHMENTS
  // ===========================================================================

  describe('7. Task Attachments', () => {
    let attachmentTaskId: string;
    let createdAttachmentId: string;

    beforeAll(async () => {
      const task = await createTestTaskDirect({
        title: 'Task for Attachments Testing',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });
      attachmentTaskId = task.id;
    });

    it('Scenario 27: Rejects disallowed file types like executables (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          originalName: 'payload.exe',
          mimeType: 'application/x-msdownload',
          fileSizeBytes: 2048,
        })
        .expect(400);

      expect(res.body.message).toContain('is not permitted');
    });

    it('Scenario 28: Rejects file sizes exceeding 25 MB (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          originalName: 'massive_video.mp4',
          mimeType: 'application/pdf',
          fileSizeBytes: 30_000_000,
        })
        .expect(400);

      const errString = res.body.errors ? JSON.stringify(res.body.errors) : res.body.message;
      expect(errString).toBeDefined();
    });

    it('Scenario 29: Rejects path traversal in filename (400 Bad Request)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          originalName: '../../../etc/shadow',
          mimeType: 'text/plain',
          fileSizeBytes: 50,
        })
        .expect(400);

      expect(res.body.message).toContain('Invalid filename. Relative path components are forbidden');
    });

    it('Scenario 30: Valid attachment added successfully -> safe metadata returned without disk paths', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({
          originalName: 'architecture_diagram.png',
          mimeType: 'image/png',
          fileSizeBytes: 1048576,
          fileUrl: 'https://cdn.slashinfotech.com/tasks/arch.png',
          collection: 'submission',
        })
        .expect(201);

      expect(res.body.data.originalName).toBe('architecture_diagram.png');
      expect(res.body.data.mimeType).toBe('image/png');
      expect(res.body.data.fileSizeBytes).toBe(1048576);
      expect(res.body.data.collection).toBe('submission');
      createdAttachmentId = res.body.data.id;
      createdMediaIds.push(res.body.data.mediaId);

      // Verify listing attachments
      const listRes = await request(app.getHttpServer())
        .get(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);
      expect(listRes.body.data[0].originalName).toBe('architecture_diagram.png');
    });

    it('Scenario 31: Attachment author or admin deletes attachment -> soft deleted', async () => {
      await request(app.getHttpServer())
        .delete(`/api/tasks/${attachmentTaskId}/attachments/${createdAttachmentId}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      // Verify no longer in active listing
      const listRes = await request(app.getHttpServer())
        .get(`/api/tasks/${attachmentTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      const ids = listRes.body.data.map((a: any) => a.id);
      expect(ids).not.toContain(createdAttachmentId);
    });
  });

  // ===========================================================================
  // 8. SECURITY SCOPES & CROSS-DEPARTMENT ISOLATION
  // ===========================================================================

  describe('8. Security Scopes & Cross-Department Isolation', () => {
    it('Scenario 32: Manager in Dept B cannot review, submit, or comment on task in Dept A (404 Not Found)', async () => {
      const task = await createTestTaskDirect({
        title: 'Dept A Secret Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_REVIEW,
      });

      // Manager B in Dept B tries to review
      const reviewRes = await request(app.getHttpServer())
        .get(`/api/tasks/${task.id}/reviews`)
        .set('Authorization', `Bearer ${managerDeptBToken}`)
        .expect(404);

      expect(reviewRes.body.message).toContain('Task not found');

      // Manager B tries to comment
      const commentRes = await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/comments`)
        .set('Authorization', `Bearer ${managerDeptBToken}`)
        .send({ content: 'Intruding comment' })
        .expect(404);

      expect(commentRes.body.message).toContain('Task not found');
    });

    it('Scenario 33: Client user cannot submit reviews, post comments, or view internal attachments (403 Forbidden)', async () => {
      const task = await createTestTaskDirect({
        title: 'Internal Development Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      // Client cannot submit task
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ notes: 'Client submit' })
        .expect(403);

      // Client cannot view attachments
      await request(app.getHttpServer())
        .get(`/api/tasks/${task.id}/attachments`)
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });
  });

  // ===========================================================================
  // 9. TIMER & AUDIT TRAIL PRESERVATION
  // ===========================================================================

  describe('9. Timer & Audit Trail Preservation', () => {
    it('Scenario 34: Review cycles preserve historical time entries and durations without corruption', async () => {
      const task = await createTestTaskDirect({
        title: 'Time Preservation Workflow Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.TODO,
      });

      // 1. Play timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/play`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // 2. Pause timer with TEA_BREAK
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/pause`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ reason: 'TEA_BREAK' })
        .expect(200);

      // 3. Resume timer
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/timer/resume`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({})
        .expect(200);

      // 4. Submit for review (auto-pauses timer)
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Deliverable complete' })
        .expect(200);

      // 5. Manager approves
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/approve`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Approved with full time audit intact' })
        .expect(200);

      // Verify time entries are intact
      const entries = await prisma.taskTimeEntry.findMany({
        where: { taskId: task.id, userId: emp1DeptAId },
      });
      expect(entries.length).toBe(2);
      expect(entries.every((e) => e.endedAt !== null)).toBe(true);

      const pauses = await prisma.taskTimePause.findMany({
        where: { taskId: task.id, userId: emp1DeptAId },
      });
      expect(pauses.length).toBe(2); // One TEA_BREAK, one TASK_STATUS_CHANGE from submit
      const statusChangePause = pauses.find((p) => p.reason === TaskPauseReason.TASK_STATUS_CHANGE);
      expect(statusChangePause).toBeDefined();
    });

    it('Scenario 35: GET /api/tasks/:id/history reflects all workflow events in audit logs', async () => {
      const task = await createTestTaskDirect({
        title: 'Audit History Verification Task',
        createdById: emp1DeptAId,
        assigneeId: emp1DeptAId,
        departmentId: deptAId,
        status: TaskStatus.IN_PROGRESS,
      });

      // Submit
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/submit`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .send({ notes: 'Initial delivery' })
        .expect(200);

      // Approve
      await request(app.getHttpServer())
        .post(`/api/tasks/${task.id}/approve`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .send({ feedback: 'Verified' })
        .expect(200);

      // History query
      const res = await request(app.getHttpServer())
        .get(`/api/tasks/${task.id}/history`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      const actions = res.body.data.activityLogs.map((l: any) => l.action);
      expect(actions).toContain('TASK_SUBMITTED_FOR_REVIEW');
      expect(actions).toContain('TASK_REVIEW_APPROVED');

      const statuses = res.body.data.statusHistory.map((s: any) => s.newStatus);
      expect(statuses).toContain(TaskStatus.IN_REVIEW);
      expect(statuses).toContain(TaskStatus.COMPLETED);
    });
  });
});
