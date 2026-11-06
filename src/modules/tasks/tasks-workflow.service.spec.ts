import { Test, TestingModule } from '@nestjs/testing';
import { TasksWorkflowService } from './tasks-workflow.service';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import { MediaStorageService } from './storage/media-storage.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  DataScope,
  TaskPauseReason,
  TaskReviewOutcome,
  TaskStatus,
} from '../../generated/prisma/client';

describe('TasksWorkflowService (Unit Tests)', () => {
  let service: TasksWorkflowService;
  let prismaMock: any;
  let usersServiceMock: any;
  let taskTimerAutoPauseServiceMock: any;
  let mediaStorageServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      task: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      taskReview: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      taskStatusHistory: {
        create: jest.fn(),
      },
      taskActivityLog: {
        create: jest.fn(),
      },
      taskComment: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      media: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      mediaAttachment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
      userDepartment: {
        findMany: jest.fn().mockResolvedValue([{ departmentId: 'dept_dev' }]),
      },
      employeeProfile: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      userPermission: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      userRole: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    usersServiceMock = {
      resolveActorDataScope: jest.fn().mockResolvedValue(DataScope.ALL),
    };

    taskTimerAutoPauseServiceMock = {
      autoPauseRunningTask: jest.fn().mockResolvedValue(undefined),
    };

    mediaStorageServiceMock = {
      processBinaryUpload: jest.fn(),
      prepareDownload: jest.fn(),
      preparePreview: jest.fn(),
      rescanAttachment: jest.fn(),
      deleteAttachment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksWorkflowService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: TaskTimerAutoPauseService, useValue: taskTimerAutoPauseServiceMock },
        { provide: MediaStorageService, useValue: mediaStorageServiceMock },
      ],
    }).compile();

    service = module.get<TasksWorkflowService>(TasksWorkflowService);
  });

  describe('validateStatusTransition', () => {
    it('should allow valid transitions from TODO to IN_PROGRESS, IN_REVIEW, and CANCELLED', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.TODO, TaskStatus.IN_PROGRESS, 'EMPLOYEE', true, false),
      ).not.toThrow();
      expect(() =>
        service.validateStatusTransition(TaskStatus.TODO, TaskStatus.IN_REVIEW, 'EMPLOYEE', true, false),
      ).not.toThrow();
      expect(() =>
        service.validateStatusTransition(TaskStatus.TODO, TaskStatus.CANCELLED, 'EMPLOYEE', true, false),
      ).not.toThrow();
    });

    it('should reject invalid transitions from TODO directly to COMPLETED or ON_HOLD', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.TODO, TaskStatus.COMPLETED, 'EMPLOYEE', true, false),
      ).toThrow(BadRequestException);
      expect(() =>
        service.validateStatusTransition(TaskStatus.TODO, TaskStatus.ON_HOLD, 'EMPLOYEE', true, false),
      ).toThrow(BadRequestException);
    });

    it('should prevent ordinary employee from completing task directly without review approval', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, 'EMPLOYEE', true, false),
      ).toThrow(ForbiddenException);
    });

    it('should allow supervisor with tasks.approve to complete task directly if not assignee', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, 'ADMIN', false, true),
      ).not.toThrow();
    });

    it('should allow Super Admin to transition to any valid target status', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, 'SUPER_ADMIN', true, true),
      ).not.toThrow();
    });

    it('should reject direct jump from IN_REVIEW to COMPLETED without approval permission', () => {
      expect(() =>
        service.validateStatusTransition(TaskStatus.IN_REVIEW, TaskStatus.COMPLETED, 'EMPLOYEE', true, false),
      ).toThrow(ForbiddenException);
    });
  });

  describe('submitTaskForReview', () => {
    it('should reject unassigned draft task submission', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: null,
        status: TaskStatus.TODO,
        deletedAt: null,
      });

      await expect(
        service.submitTaskForReview('task_1', 'user_1', 'EMPLOYEE', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject submission of task assigned to another employee', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_other',
        status: TaskStatus.IN_PROGRESS,
        deletedAt: null,
      });

      await expect(
        service.submitTaskForReview('task_1', 'user_1', 'EMPLOYEE', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should auto-pause running timer and advance task to IN_REVIEW on valid submission', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_1',
        status: TaskStatus.IN_PROGRESS,
        deletedAt: null,
      });
      prismaMock.taskReview.findFirst.mockResolvedValue(null);
      prismaMock.taskReview.create.mockResolvedValue({
        id: 'rev_1',
        taskId: 'task_1',
        roundNumber: 1,
        outcome: TaskReviewOutcome.PENDING,
      });
      prismaMock.task.update.mockResolvedValue({ id: 'task_1', status: TaskStatus.IN_REVIEW });

      const res = await service.submitTaskForReview('task_1', 'user_1', 'EMPLOYEE', {
        notes: 'Ready for review',
      });

      expect(res.success).toBe(true);
      expect(res.data.status).toBe(TaskStatus.IN_REVIEW);
      expect(res.data.roundNumber).toBe(1);
      expect(taskTimerAutoPauseServiceMock.autoPauseRunningTask).toHaveBeenCalledWith(
        'user_1',
        TaskPauseReason.TASK_STATUS_CHANGE,
        'Task submitted for review',
        prismaMock,
      );
    });
  });

  describe('approveTaskReview', () => {
    it('should reject approval with anti-self-approval if actor is the assignee', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_1',
        status: TaskStatus.IN_REVIEW,
        deletedAt: null,
      });
      prismaMock.taskReview.findFirst.mockResolvedValue({
        id: 'rev_1',
        taskId: 'task_1',
        roundNumber: 1,
        submitterId: 'user_1',
        outcome: TaskReviewOutcome.PENDING,
      });

      await expect(
        service.approveTaskReview('task_1', 'rev_1', 'user_1', 'EMPLOYEE', { feedback: 'Self approve' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should successfully approve task review and mark task COMPLETED by authorized reviewer', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_dev',
        status: TaskStatus.IN_REVIEW,
        deletedAt: null,
      });
      prismaMock.taskReview.findFirst.mockResolvedValue({
        id: 'rev_1',
        taskId: 'task_1',
        roundNumber: 1,
        submitterId: 'user_dev',
        outcome: TaskReviewOutcome.PENDING,
      });
      prismaMock.taskReview.update.mockResolvedValue({
        id: 'rev_1',
        outcome: TaskReviewOutcome.APPROVED,
        reviewerId: 'user_mgr',
      });
      prismaMock.task.update.mockResolvedValue({ id: 'task_1', status: TaskStatus.COMPLETED });

      const res = await service.approveTaskReview('task_1', 'rev_1', 'user_mgr', 'EMPLOYEE', {
        feedback: 'Great job!',
        rating: 5,
      });

      expect(res.success).toBe(true);
      expect(res.data.status).toBe(TaskStatus.COMPLETED);
      expect(prismaMock.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task_1' },
          data: { status: TaskStatus.COMPLETED, progress: 100 },
        }),
      );
    });
  });

  describe('requestChangesOnReview', () => {
    it('should reject request changes if actor is the submitter/assignee', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_1',
        status: TaskStatus.IN_REVIEW,
        deletedAt: null,
      });
      prismaMock.taskReview.findFirst.mockResolvedValue({
        id: 'rev_1',
        submitterId: 'user_1',
        outcome: TaskReviewOutcome.PENDING,
      });

      await expect(
        service.requestChangesOnReview('task_1', 'rev_1', 'user_1', 'EMPLOYEE', { feedback: 'Need fix' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should update review to CHANGES_REQUESTED and task status to REOPENED', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        assigneeId: 'user_dev',
        status: TaskStatus.IN_REVIEW,
        deletedAt: null,
      });
      prismaMock.taskReview.findFirst.mockResolvedValue({
        id: 'rev_1',
        submitterId: 'user_dev',
        outcome: TaskReviewOutcome.PENDING,
      });
      prismaMock.taskReview.update.mockResolvedValue({
        id: 'rev_1',
        outcome: TaskReviewOutcome.CHANGES_REQUESTED,
      });

      const res = await service.requestChangesOnReview('task_1', 'rev_1', 'user_mgr', 'EMPLOYEE', {
        feedback: 'Missing test coverage for edge case',
      });

      expect(res.success).toBe(true);
      expect(res.data.status).toBe(TaskStatus.REOPENED);
      expect(prismaMock.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task_1' },
          data: { status: TaskStatus.REOPENED },
        }),
      );
    });
  });

  describe('Comments Collaboration', () => {
    it('should reject client accounts posting internal comments', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });

      // Actor user type CLIENT is rejected from accessing internal tasks
      await expect(
        service.addComment('task_1', 'client_1', 'CLIENT', {
          content: 'Internal note',
          isInternal: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject comment editing by a non-author user', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });
      prismaMock.taskComment.findFirst.mockResolvedValue({
        id: 'com_1',
        taskId: 'task_1',
        userId: 'user_author',
        deletedAt: null,
      });

      await expect(
        service.updateComment('task_1', 'com_1', 'user_other', 'EMPLOYEE', { content: 'Hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow author to edit comment and preserve originalContent', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });
      prismaMock.taskComment.findFirst.mockResolvedValue({
        id: 'com_1',
        taskId: 'task_1',
        userId: 'user_author',
        content: 'Original note',
        originalContent: null,
        deletedAt: null,
      });
      prismaMock.taskComment.update.mockResolvedValue({
        id: 'com_1',
        content: 'Edited note',
        isEdited: true,
      });

      const res = await service.updateComment('task_1', 'com_1', 'user_author', 'EMPLOYEE', {
        content: 'Edited note',
      });

      expect(res.success).toBe(true);
      expect(prismaMock.taskComment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'com_1' },
          data: expect.objectContaining({
            content: 'Edited note',
            originalContent: 'Original note',
            isEdited: true,
          }),
        }),
      );
    });
  });

  describe('Attachments Validation', () => {
    it('should reject disallowed executable MIME types', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });

      await expect(
        service.addAttachment('task_1', 'user_1', 'EMPLOYEE', {
          originalName: 'virus.exe',
          mimeType: 'application/x-msdownload',
          fileSizeBytes: 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject file sizes exceeding 25 MB limit', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });

      await expect(
        service.addAttachment('task_1', 'user_1', 'EMPLOYEE', {
          originalName: 'large.zip',
          mimeType: 'application/zip',
          fileSizeBytes: 30_000_000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject path traversal in originalName', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });

      await expect(
        service.addAttachment('task_1', 'user_1', 'EMPLOYEE', {
          originalName: '../../etc/passwd',
          mimeType: 'text/plain',
          fileSizeBytes: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept valid PDF attachment and store safely', async () => {
      prismaMock.task.findFirst.mockResolvedValue({ id: 'task_1', deletedAt: null });
      prismaMock.media.create.mockResolvedValue({
        id: 'med_1',
        originalName: 'spec.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(5000),
        fileUrl: 'https://storage.slashcrm.internal/spec.pdf',
      });
      prismaMock.mediaAttachment.create.mockResolvedValue({
        id: 'att_1',
        mediaId: 'med_1',
        collection: 'attachments',
      });

      const res = await service.addAttachment('task_1', 'user_1', 'EMPLOYEE', {
        originalName: 'spec.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 5000,
        fileUrl: 'https://storage.slashcrm.internal/spec.pdf',
      });

      expect(res.success).toBe(true);
      expect(res.data.originalName).toBe('spec.pdf');
      expect(res.data.fileSizeBytes).toBe(5000);
    });
  });

  describe('cancelTask and reopenTask', () => {
    it('should cancel task and auto-pause running timer', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        createdById: 'user_1',
        assigneeId: 'user_1',
        status: TaskStatus.IN_PROGRESS,
        deletedAt: null,
      });

      const res = await service.cancelTask('task_1', 'user_1', 'EMPLOYEE', 'No longer needed');
      expect(res.success).toBe(true);
      expect(res.data.status).toBe(TaskStatus.CANCELLED);
      expect(taskTimerAutoPauseServiceMock.autoPauseRunningTask).toHaveBeenCalledWith(
        'user_1',
        TaskPauseReason.TASK_STATUS_CHANGE,
        'Task cancelled',
        prismaMock,
      );
    });

    it('should reject reopening a task that is not completed or cancelled', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        status: TaskStatus.IN_PROGRESS,
        deletedAt: null,
      });

      await expect(
        service.reopenTask('task_1', 'user_1', 'SUPER_ADMIN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow Super Admin to reopen a completed task', async () => {
      prismaMock.task.findFirst.mockResolvedValue({
        id: 'task_1',
        status: TaskStatus.COMPLETED,
        deletedAt: null,
      });

      const res = await service.reopenTask('task_1', 'user_sa', 'SUPER_ADMIN', 'Reopening for phase 2');
      expect(res.success).toBe(true);
      expect(res.data.status).toBe(TaskStatus.REOPENED);
    });
  });
});

