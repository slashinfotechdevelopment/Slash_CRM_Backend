import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UsersService } from '../users/users.service';
import { TaskTimerAutoPauseService } from './task-timer-auto-pause.service';
import { TaskActorContext, buildTaskVisibilityWhere } from './tasks-visibility.helper';
import {
  MediaScanStatus,
  MediaStatus,
  MediaStorageProvider,
  MediaType,
  MediaVisibility,
  Prisma,
  RecordStatus,
  TaskPauseReason,
  TaskReviewOutcome,
  TaskStatus,
} from '../../generated/prisma/client';
import { SubmitTaskDto } from './dto/submit-task.dto';
import { ApproveTaskReviewDto } from './dto/approve-task-review.dto';
import { RequestChangesDto } from './dto/request-changes.dto';
import { RejectTaskReviewDto } from './dto/reject-task-review.dto';
import { CreateTaskCommentDto } from './dto/create-task-comment.dto';
import { UpdateTaskCommentDto } from './dto/update-task-comment.dto';
import { QueryTaskCommentsDto } from './dto/query-task-comments.dto';
import { CreateTaskAttachmentDto } from './dto/create-task-attachment.dto';
import { MediaStorageService } from './storage/media-storage.service';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
  'application/json',
  'text/markdown',
]);

const MAX_ATTACHMENT_SIZE_BYTES = 26_214_400; // 25 MB

@Injectable()
export class TasksWorkflowService {
  private readonly logger = new Logger(TasksWorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly taskTimerAutoPauseService: TaskTimerAutoPauseService,
    private readonly mediaStorageService: MediaStorageService,
  ) {}

  /**
   * Resolves actor context for visibility queries.
   */
  async buildActorContext(
    actorUserId: string,
    actorUserType: string,
    permissionCode: string,
  ): Promise<TaskActorContext> {
    const effectiveDataScope = await this.usersService.resolveActorDataScope(
      actorUserId,
      actorUserType,
      permissionCode,
    );

    const userDepts =
      (await this.prisma.userDepartment.findMany({
        where: { userId: actorUserId },
        select: { departmentId: true },
      })) || [];
    const departmentIds = userDepts.map((d) => d.departmentId);

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
   * Helper checking direct or role-based permission for an actor.
   */
  async checkUserPermission(userId: string, permissionCode: string): Promise<boolean> {
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

  /**
   * Validates backend task status transitions.
   */
  validateStatusTransition(
    currentStatus: TaskStatus,
    targetStatus: TaskStatus,
    actorUserType: string,
    isAssignee: boolean,
    hasApprovePermission: boolean,
  ): void {
    if (currentStatus === targetStatus) return;

    const isAdminOrSuper = actorUserType === 'SUPER_ADMIN' || actorUserType === 'ADMIN';

    if (currentStatus === TaskStatus.CANCELLED) {
      if (!isAdminOrSuper) {
        throw new BadRequestException('Cannot modify or transition a cancelled task.');
      }
      return;
    }

    if (currentStatus === TaskStatus.COMPLETED) {
      if (isAdminOrSuper || hasApprovePermission) {
        if (targetStatus === TaskStatus.REOPENED || targetStatus === TaskStatus.CANCELLED) {
          return;
        }
      }
      throw new BadRequestException('Completed tasks cannot transition to ' + targetStatus);
    }

    switch (currentStatus) {
      case TaskStatus.TODO:
        if (
          targetStatus === TaskStatus.IN_PROGRESS ||
          targetStatus === TaskStatus.IN_REVIEW ||
          targetStatus === TaskStatus.CANCELLED ||
          (isAdminOrSuper && (targetStatus === TaskStatus.ON_HOLD || targetStatus === TaskStatus.COMPLETED))
        ) {
          return;
        }
        throw new BadRequestException(`Cannot transition task from TODO directly to ${targetStatus}`);

      case TaskStatus.IN_PROGRESS:
        if (
          targetStatus === TaskStatus.ON_HOLD ||
          targetStatus === TaskStatus.IN_REVIEW ||
          targetStatus === TaskStatus.CANCELLED
        ) {
          return;
        }
        if (targetStatus === TaskStatus.COMPLETED) {
          if (isAdminOrSuper) return;
          if (hasApprovePermission && !isAssignee) return;
          throw new ForbiddenException(
            'Employees cannot directly complete tasks without submission and reviewer approval.',
          );
        }
        throw new BadRequestException(`Cannot transition task from IN_PROGRESS directly to ${targetStatus}`);

      case TaskStatus.ON_HOLD:
        if (
          targetStatus === TaskStatus.IN_PROGRESS ||
          targetStatus === TaskStatus.IN_REVIEW ||
          targetStatus === TaskStatus.CANCELLED ||
          (isAdminOrSuper && (targetStatus === TaskStatus.COMPLETED || targetStatus === TaskStatus.REOPENED))
        ) {
          return;
        }
        throw new BadRequestException(`Cannot transition task from ON_HOLD directly to ${targetStatus}`);

      case TaskStatus.IN_REVIEW:
        if (targetStatus === TaskStatus.CANCELLED) return;
        if (targetStatus === TaskStatus.COMPLETED) {
          if (isAdminOrSuper || (hasApprovePermission && !isAssignee)) return;
          throw new ForbiddenException(
            'Anti-self-approval: An assignee cannot approve their own work into COMPLETED.',
          );
        }
        if (targetStatus === TaskStatus.REOPENED) {
          if (isAdminOrSuper || (hasApprovePermission && !isAssignee)) return;
          throw new ForbiddenException('Assignees cannot request changes on their own review.');
        }
        throw new BadRequestException(
          `Cannot transition task from IN_REVIEW directly to ${targetStatus}. Must go through review approval or request-changes.`,
        );

      case TaskStatus.REOPENED:
        if (
          targetStatus === TaskStatus.IN_PROGRESS ||
          targetStatus === TaskStatus.IN_REVIEW ||
          targetStatus === TaskStatus.CANCELLED ||
          (isAdminOrSuper && (targetStatus === TaskStatus.COMPLETED || targetStatus === TaskStatus.ON_HOLD))
        ) {
          return;
        }
        throw new BadRequestException(`Cannot transition task from REOPENED directly to ${targetStatus}`);

      default:
        throw new BadRequestException(`Unsupported transition from ${currentStatus} to ${targetStatus}`);
    }
  }

  /**
   * Asserts task exists and is visible to actor.
   */
  async assertTaskVisible(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    permissionCode: string,
  ) {
    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client users cannot access internal tasks.');
    }

    const actorContext = await this.buildActorContext(actorUserId, actorUserType, permissionCode);
    const visibilityWhere = buildTaskVisibilityWhere(actorContext);

    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        AND: [visibilityWhere],
      },
      include: {
        assignee: { select: { id: true, userCode: true, name: true, email: true } },
        createdByUser: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found.');
    }

    if (task.deletedAt) {
      throw new BadRequestException('Cannot operate on a deleted task.');
    }

    return task;
  }

  // ===========================================================================
  // A. TASK WORKFLOW & REVIEWS
  // ===========================================================================

  /**
   * Submits an assigned task for review.
   */
  async submitTaskForReview(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: SubmitTaskDto,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.submit');

    if (!task.assigneeId) {
      throw new BadRequestException('Cannot submit an unassigned draft task for review.');
    }

    if (task.assigneeId !== actorUserId && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You can only submit tasks assigned to you.');
    }

    if (
      task.status !== TaskStatus.IN_PROGRESS &&
      task.status !== TaskStatus.TODO &&
      task.status !== TaskStatus.ON_HOLD &&
      task.status !== TaskStatus.REOPENED
    ) {
      throw new BadRequestException(
        `Cannot submit task for review from status ${task.status}. Task must be in progress, on hold, or reopened.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Auto-pause running timer if active for this employee
      if (task.assigneeId) {
        await this.taskTimerAutoPauseService.autoPauseRunningTask(
          task.assigneeId,
          TaskPauseReason.TASK_STATUS_CHANGE,
          'Task submitted for review',
          tx,
        );
      }

      // 2. Determine review round number
      const lastReview = await tx.taskReview.findFirst({
        where: { taskId },
        orderBy: { roundNumber: 'desc' },
      });
      const nextRound = lastReview ? lastReview.roundNumber + 1 : 1;

      // 3. Create review record
      const review = await tx.taskReview.create({
        data: {
          taskId,
          roundNumber: nextRound,
          submitterId: actorUserId,
          outcome: TaskReviewOutcome.PENDING,
          submissionNotes: dto.notes || null,
        },
      });

      // 4. Update task status to IN_REVIEW
      const previousStatus = task.status;
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.IN_REVIEW },
      });

      // 5. Record status history
      await tx.taskStatusHistory.create({
        data: {
          taskId,
          previousStatus,
          newStatus: TaskStatus.IN_REVIEW,
          changedById: actorUserId,
          comment: dto.notes || `Submitted for review (Round ${nextRound})`,
        },
      });

      // 6. Record activity log
      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_SUBMITTED_FOR_REVIEW',
          metadata: {
            roundNumber: nextRound,
            reviewId: review.id,
            notes: dto.notes || null,
          },
        },
      });

      // 7. Associate submission attachments if provided
      if (dto.attachmentIds && dto.attachmentIds.length > 0) {
        for (const mediaId of dto.attachmentIds) {
          const media = await tx.media.findUnique({ where: { id: mediaId } });
          if (media && !media.deletedAt) {
            await tx.mediaAttachment.create({
              data: {
                mediaId,
                entityType: 'TASK',
                entityId: taskId,
                collection: 'submission',
              },
            });
          }
        }
      }

      return {
        success: true,
        message: `Task successfully submitted for review (Round ${nextRound}).`,
        data: {
          taskId,
          status: TaskStatus.IN_REVIEW,
          reviewId: review.id,
          roundNumber: nextRound,
        },
      };
    });
  }

  /**
   * Approves a task review, marking the task COMPLETED.
   */
  async approveTaskReview(
    taskId: string,
    reviewId: string | undefined,
    actorUserId: string,
    actorUserType: string,
    dto: ApproveTaskReviewDto,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.approve');

    if (task.status !== TaskStatus.IN_REVIEW) {
      throw new BadRequestException('Task is not currently in review.');
    }

    const review = await this.resolvePendingReview(taskId, reviewId);

    // Strict Anti-Self-Approval
    if (actorUserType !== 'SUPER_ADMIN') {
      if (task.assigneeId === actorUserId || review.submitterId === actorUserId) {
        throw new ForbiddenException(
          'Anti-self-approval violation: You cannot approve your own submitted task review.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Auto-pause running timer if any
      if (task.assigneeId) {
        await this.taskTimerAutoPauseService.autoPauseRunningTask(
          task.assigneeId,
          TaskPauseReason.TASK_STATUS_CHANGE,
          'Task review approved and completed',
          tx,
        );
      }

      // 2. Finalize review record
      const updatedReview = await tx.taskReview.update({
        where: { id: review.id },
        data: {
          reviewerId: actorUserId,
          outcome: TaskReviewOutcome.APPROVED,
          feedback: dto.feedback || 'Approved',
          rating: dto.rating || null,
          reviewedAt: new Date(),
        },
      });

      // 3. Update task to COMPLETED, 100% progress
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.COMPLETED,
          progress: 100,
        },
      });

      // 4. Record status history
      await tx.taskStatusHistory.create({
        data: {
          taskId,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.COMPLETED,
          changedById: actorUserId,
          comment: dto.feedback || 'Task review approved and completed.',
        },
      });

      // 5. Record activity log
      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_REVIEW_APPROVED',
          metadata: {
            reviewId: review.id,
            roundNumber: review.roundNumber,
            rating: dto.rating || null,
            feedback: dto.feedback || null,
          },
        },
      });

      return {
        success: true,
        message: 'Task review approved successfully. Task is now COMPLETED.',
        data: {
          taskId,
          status: TaskStatus.COMPLETED,
          review: updatedReview,
        },
      };
    });
  }

  /**
   * Requests changes on a review, moving the task to REOPENED.
   */
  async requestChangesOnReview(
    taskId: string,
    reviewId: string | undefined,
    actorUserId: string,
    actorUserType: string,
    dto: RequestChangesDto,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.review');

    if (task.status !== TaskStatus.IN_REVIEW) {
      throw new BadRequestException('Task is not currently in review.');
    }

    const review = await this.resolvePendingReview(taskId, reviewId);

    // Anti-Self-Review
    if (actorUserType !== 'SUPER_ADMIN') {
      if (task.assigneeId === actorUserId || review.submitterId === actorUserId) {
        throw new ForbiddenException(
          'Anti-self-approval violation: You cannot request changes on your own submitted task.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Update review record
      const updatedReview = await tx.taskReview.update({
        where: { id: review.id },
        data: {
          reviewerId: actorUserId,
          outcome: TaskReviewOutcome.CHANGES_REQUESTED,
          feedback: dto.feedback,
          reviewedAt: new Date(),
        },
      });

      // 2. Move task to REOPENED
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.REOPENED },
      });

      // 3. Record status history
      await tx.taskStatusHistory.create({
        data: {
          taskId,
          previousStatus: TaskStatus.IN_REVIEW,
          newStatus: TaskStatus.REOPENED,
          changedById: actorUserId,
          comment: dto.feedback,
        },
      });

      // 4. Record activity log
      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_REVIEW_CHANGES_REQUESTED',
          metadata: {
            reviewId: review.id,
            roundNumber: review.roundNumber,
            feedback: dto.feedback,
          },
        },
      });

      return {
        success: true,
        message: 'Changes requested on task review. Task is now REOPENED for rework.',
        data: {
          taskId,
          status: TaskStatus.REOPENED,
          review: updatedReview,
        },
      };
    });
  }

  /**
   * Rejects a task review.
   */
  async rejectTaskReview(
    taskId: string,
    reviewId: string | undefined,
    actorUserId: string,
    actorUserType: string,
    dto: RejectTaskReviewDto,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.approve');

    if (task.status !== TaskStatus.IN_REVIEW) {
      throw new BadRequestException('Task is not currently in review.');
    }

    const review = await this.resolvePendingReview(taskId, reviewId);

    // Anti-Self-Review
    if (actorUserType !== 'SUPER_ADMIN') {
      if (task.assigneeId === actorUserId || review.submitterId === actorUserId) {
        throw new ForbiddenException(
          'Anti-self-approval violation: You cannot reject your own submitted task.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Update review record
      const updatedReview = await tx.taskReview.update({
        where: { id: review.id },
        data: {
          reviewerId: actorUserId,
          outcome: TaskReviewOutcome.REJECTED,
          feedback: dto.feedback,
          reviewedAt: new Date(),
        },
      });

      // 2. Set task to REOPENED (or leave as is if specified)
      const nextStatus = dto.reopenTask !== false ? TaskStatus.REOPENED : task.status;
      if (nextStatus !== task.status) {
        await tx.task.update({
          where: { id: taskId },
          data: { status: nextStatus },
        });

        await tx.taskStatusHistory.create({
          data: {
            taskId,
            previousStatus: TaskStatus.IN_REVIEW,
            newStatus: nextStatus,
            changedById: actorUserId,
            comment: `Review rejected: ${dto.feedback}`,
          },
        });
      }

      // 3. Record activity log
      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_REVIEW_REJECTED',
          metadata: {
            reviewId: review.id,
            roundNumber: review.roundNumber,
            feedback: dto.feedback,
            reopened: nextStatus === TaskStatus.REOPENED,
          },
        },
      });

      return {
        success: true,
        message: 'Task review rejected.',
        data: {
          taskId,
          status: nextStatus,
          review: updatedReview,
        },
      };
    });
  }

  /**
   * Retrieves review history for a task.
   */
  async listTaskReviews(taskId: string, actorUserId: string, actorUserType: string) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.view');

    const reviews = await this.prisma.taskReview.findMany({
      where: { taskId },
      orderBy: { roundNumber: 'asc' },
      include: {
        reviewer: { select: { id: true, userCode: true, name: true, email: true } },
        submitter: { select: { id: true, userCode: true, name: true, email: true } },
      },
    });

    return {
      success: true,
      message: 'Task review history retrieved successfully.',
      data: reviews,
    };
  }

  private async resolvePendingReview(taskId: string, reviewId?: string) {
    if (reviewId) {
      const review = await this.prisma.taskReview.findFirst({
        where: { id: reviewId, taskId },
      });
      if (!review) throw new NotFoundException(`Review ${reviewId} not found on task.`);
      if (review.outcome !== TaskReviewOutcome.PENDING) {
        throw new BadRequestException(`Review ${reviewId} has already been resolved.`);
      }
      return review;
    }

    const review = await this.prisma.taskReview.findFirst({
      where: { taskId, outcome: TaskReviewOutcome.PENDING },
      orderBy: { roundNumber: 'desc' },
    });

    if (!review) {
      throw new NotFoundException('No pending review found for this task.');
    }

    return review;
  }

  // ===========================================================================
  // B. COMMENTS & COLLABORATION
  // ===========================================================================

  /**
   * Adds a comment to a task.
   */
  async addComment(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto: CreateTaskCommentDto,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.comment');

    if (actorUserType === 'CLIENT' && dto.isInternal) {
      throw new BadRequestException('Client accounts cannot post internal comments.');
    }

    if (dto.parentId) {
      const parent = await this.prisma.taskComment.findFirst({
        where: { id: dto.parentId, taskId, deletedAt: null },
      });
      if (!parent) {
        throw new NotFoundException('Parent comment not found or has been deleted.');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.taskComment.create({
        data: {
          taskId,
          userId: actorUserId,
          parentId: dto.parentId || null,
          content: dto.content,
          isInternal: !!dto.isInternal,
        },
        include: {
          user: { select: { id: true, userCode: true, name: true, email: true } },
        },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_COMMENT_ADDED',
          metadata: {
            commentId: comment.id,
            parentId: dto.parentId || null,
            isInternal: !!dto.isInternal,
          },
        },
      });

      return {
        success: true,
        message: 'Comment added successfully.',
        data: comment,
      };
    });
  }

  /**
   * Retrieves comments for a task.
   */
  async listComments(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    query: QueryTaskCommentsDto,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.view');

    const filter: Prisma.TaskCommentWhereInput = {
      taskId,
      deletedAt: null,
    };

    if (actorUserType === 'CLIENT') {
      filter.isInternal = false;
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const skip = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      this.prisma.taskComment.findMany({
        where: filter,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: {
          user: { select: { id: true, userCode: true, name: true } },
          _count: { select: { replies: true } },
        },
      }),
      this.prisma.taskComment.count({ where: filter }),
    ]);

    return {
      success: true,
      message: 'Task comments retrieved successfully.',
      data: comments,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Edits a comment. Only the author (or SUPER_ADMIN) can edit.
   */
  async updateComment(
    taskId: string,
    commentId: string,
    actorUserId: string,
    actorUserType: string,
    dto: UpdateTaskCommentDto,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.comment');

    const comment = await this.prisma.taskComment.findFirst({
      where: { id: commentId, taskId, deletedAt: null },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found.');
    }

    if (comment.userId !== actorUserId && actorUserType !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You can only edit your own comments.');
    }

    const updated = await this.prisma.taskComment.update({
      where: { id: commentId },
      data: {
        content: dto.content,
        originalContent: comment.originalContent || comment.content,
        isEdited: true,
        editedAt: new Date(),
      },
      include: {
        user: { select: { id: true, userCode: true, name: true } },
      },
    });

    await this.prisma.taskActivityLog.create({
      data: {
        taskId,
        performedBy: actorUserId,
        action: 'TASK_COMMENT_UPDATED',
        metadata: { commentId },
      },
    });

    return {
      success: true,
      message: 'Comment updated successfully.',
      data: updated,
    };
  }

  /**
   * Soft-deletes a comment. Author or admin can delete.
   */
  async deleteComment(
    taskId: string,
    commentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.comment');

    const comment = await this.prisma.taskComment.findFirst({
      where: { id: commentId, taskId, deletedAt: null },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found.');
    }

    if (comment.userId !== actorUserId && actorUserType !== 'SUPER_ADMIN') {
      const canManage = await this.checkUserPermission(actorUserId, 'tasks.update');
      if (!canManage) {
        throw new ForbiddenException('You do not have permission to delete this comment.');
      }
    }

    await this.prisma.taskComment.update({
      where: { id: commentId },
      data: {
        deletedAt: new Date(),
        deletedById: actorUserId,
      },
    });

    await this.prisma.taskActivityLog.create({
      data: {
        taskId,
        performedBy: actorUserId,
        action: 'TASK_COMMENT_DELETED',
        metadata: { commentId },
      },
    });

    return {
      success: true,
      message: 'Comment deleted successfully.',
    };
  }

  // ===========================================================================
  // C. ATTACHMENTS & METADATA
  // ===========================================================================

  /**
   * Attaches an uploaded physical file or validated media metadata to a task.
   */
  async addAttachment(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    dto?: CreateTaskAttachmentDto,
    file?: { path: string; originalname: string; mimetype: string; size: number },
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.attachment');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot upload internal task attachments.');
    }

    // 1. Binary file upload via Multer spool
    if (file) {
      const collection = dto?.collection || 'attachments';
      const result = await this.mediaStorageService.processBinaryUpload(
        taskId,
        file,
        actorUserId,
        collection,
        dto?.originalName,
      );

      return {
        success: true,
        message: 'Attachment uploaded successfully.',
        data: result,
      };
    }

    // 2. Metadata-only creation (Phase 6.3.4 backward compatibility)
    if (!dto || !dto.originalName || !dto.mimeType || !dto.fileSizeBytes) {
      throw new BadRequestException('Either an uploaded binary file or complete attachment metadata (originalName, mimeType, fileSizeBytes) must be provided.');
    }

    const normalizedMime = dto.mimeType.trim().toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
      throw new BadRequestException(
        `File type "${dto.mimeType}" is not permitted. Only standard documents, images, and archives are allowed.`,
      );
    }

    if (dto.fileSizeBytes <= 0 || dto.fileSizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `File size must be between 1 byte and 25 MB (${MAX_ATTACHMENT_SIZE_BYTES} bytes).`,
      );
    }

    if (
      dto.originalName.includes('..') ||
      dto.originalName.includes('/') ||
      dto.originalName.includes('\\')
    ) {
      throw new BadRequestException('Invalid filename. Relative path components are forbidden.');
    }

    if (dto.fileUrl) {
      const lowerUrl = dto.fileUrl.toLowerCase();
      if (
        lowerUrl.startsWith('file:') ||
        lowerUrl.includes('c:\\') ||
        lowerUrl.startsWith('/etc') ||
        lowerUrl.startsWith('/var')
      ) {
        throw new BadRequestException('Invalid fileUrl: Local filesystem storage paths are forbidden.');
      }
    }

    const originalName = dto.originalName;
    const fileSizeBytes = BigInt(dto.fileSizeBytes);

    return this.prisma.$transaction(async (tx) => {
      const storedName = `task_${taskId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const media = await tx.media.create({
        data: {
          originalName,
          storedName,
          storageProvider: MediaStorageProvider.LOCAL,
          storageKey: `tasks/${taskId}/${storedName}`,
          fileUrl: dto.fileUrl || null,
          mimeType: normalizedMime,
          fileSizeBytes,
          mediaType: normalizedMime.startsWith('image/') ? MediaType.IMAGE : MediaType.DOCUMENT,
          visibility: MediaVisibility.PRIVATE,
          status: MediaStatus.ACTIVE,
          uploadedById: actorUserId,
          scanStatus: MediaScanStatus.PENDING,
          scanDetails: 'Metadata attachment (no physical binary uploaded)',
        },
      });

      const attachment = await tx.mediaAttachment.create({
        data: {
          mediaId: media.id,
          entityType: 'TASK',
          entityId: taskId,
          collection: dto.collection || 'attachments',
        },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_ATTACHMENT_ADDED',
          metadata: {
            attachmentId: attachment.id,
            mediaId: media.id,
            originalName: dto.originalName,
            fileSizeBytes: dto.fileSizeBytes,
            collection: dto.collection || 'attachments',
          },
        },
      });

      return {
        success: true,
        message: 'Attachment added successfully.',
        data: {
          id: attachment.id,
          mediaId: media.id,
          originalName: media.originalName,
          mimeType: media.mimeType,
          fileSizeBytes: Number(media.fileSizeBytes),
          fileUrl: media.fileUrl,
          scanStatus: media.scanStatus,
          collection: attachment.collection,
          createdAt: attachment.createdAt,
        },
      };
    });
  }

  /**
   * Lists attachments for a task (excluding infected or deleted files).
   */
  async listAttachments(taskId: string, actorUserId: string, actorUserType: string) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.view');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot view internal task attachments.');
    }

    const attachments = await this.prisma.mediaAttachment.findMany({
      where: {
        entityType: 'TASK',
        entityId: taskId,
        media: {
          deletedAt: null,
          scanStatus: { not: MediaScanStatus.INFECTED },
        },
      },
      include: {
        media: {
          include: {
            uploadedBy: { select: { id: true, userCode: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sanitized = attachments.map((att) => ({
      id: att.id,
      mediaId: att.mediaId,
      originalName: att.media.originalName,
      mimeType: att.media.mimeType,
      fileSizeBytes: Number(att.media.fileSizeBytes),
      fileUrl: att.media.fileUrl,
      scanStatus: att.media.scanStatus,
      isReady: att.media.scanStatus === MediaScanStatus.CLEAN,
      collection: att.collection,
      createdAt: att.createdAt,
      uploadedBy: att.media.uploadedBy,
    }));

    return {
      success: true,
      message: 'Task attachments retrieved successfully.',
      data: sanitized,
    };
  }

  /**
   * Downloads an attachment's binary payload.
   */
  async downloadAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.view');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot download internal task attachments.');
    }

    return this.mediaStorageService.prepareDownload(taskId, attachmentId);
  }

  /**
   * Previews an attachment's binary payload with security headers.
   */
  async previewAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.view');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot preview internal task attachments.');
    }

    return this.mediaStorageService.preparePreview(taskId, attachmentId);
  }

  /**
   * Triggers an authorized rescan for an attachment.
   */
  async rescanAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.approve');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot trigger attachment rescans.');
    }

    let isAuthorized = actorUserType === 'SUPER_ADMIN';
    if (!isAuthorized) {
      const hasApprove = await this.checkUserPermission(actorUserId, 'tasks.approve');
      const hasReview = await this.checkUserPermission(actorUserId, 'tasks.review');
      isAuthorized = hasApprove || hasReview;
    }

    if (!isAuthorized) {
      throw new ForbiddenException('Only authorized reviewers or administrators can trigger malware rescans.');
    }

    return this.mediaStorageService.rescanAttachment(taskId, attachmentId, actorUserId);
  }

  /**
   * Deletes a task attachment.
   */
  async deleteAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    actorUserType: string,
  ) {
    await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.attachment');

    if (actorUserType === 'CLIENT') {
      throw new ForbiddenException('Client accounts cannot delete internal task attachments.');
    }

    let isElevated = actorUserType === 'SUPER_ADMIN';
    if (!isElevated) {
      const canApprove = await this.checkUserPermission(actorUserId, 'tasks.approve');
      const canManage = await this.checkUserPermission(actorUserId, 'tasks.update');
      isElevated = canApprove || canManage;
    }

    return this.mediaStorageService.deleteAttachment(taskId, attachmentId, actorUserId, isElevated);
  }

  /**
   * Explicitly cancels a task.
   */
  async cancelTask(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    reason?: string,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.update');

    if (task.status === TaskStatus.CANCELLED) {
      throw new BadRequestException('Task is already cancelled.');
    }
    if (task.status === TaskStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel an already completed task.');
    }

    if (
      task.createdById !== actorUserId &&
      task.assigneeId !== actorUserId &&
      actorUserType !== 'SUPER_ADMIN'
    ) {
      const canUpdate = await this.checkUserPermission(actorUserId, 'tasks.update');
      if (!canUpdate) {
        throw new ForbiddenException('You do not have permission to cancel this task.');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (task.assigneeId) {
        await this.taskTimerAutoPauseService.autoPauseRunningTask(
          task.assigneeId,
          TaskPauseReason.TASK_STATUS_CHANGE,
          'Task cancelled',
          tx,
        );
      }

      const previousStatus = task.status;
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.CANCELLED },
      });

      await tx.taskStatusHistory.create({
        data: {
          taskId,
          previousStatus,
          newStatus: TaskStatus.CANCELLED,
          changedById: actorUserId,
          comment: reason || 'Task cancelled',
        },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_CANCELLED',
          metadata: { previousStatus, reason },
        },
      });

      return {
        success: true,
        message: 'Task cancelled successfully.',
        data: { taskId, status: TaskStatus.CANCELLED },
      };
    });
  }

  /**
   * Reopens a completed or cancelled task.
   */
  async reopenTask(
    taskId: string,
    actorUserId: string,
    actorUserType: string,
    reason?: string,
  ) {
    const task = await this.assertTaskVisible(taskId, actorUserId, actorUserType, 'tasks.approve');

    if (task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.CANCELLED) {
      throw new BadRequestException(
        `Cannot reopen task from status ${task.status}. Reopen is only for COMPLETED or CANCELLED tasks.`,
      );
    }

    if (actorUserType !== 'SUPER_ADMIN') {
      const hasApprove = await this.checkUserPermission(actorUserId, 'tasks.approve');
      if (!hasApprove) {
        throw new ForbiddenException(
          'Only authorized reviewers or administrators can reopen completed or cancelled tasks.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const previousStatus = task.status;
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.REOPENED },
      });

      await tx.taskStatusHistory.create({
        data: {
          taskId,
          previousStatus,
          newStatus: TaskStatus.REOPENED,
          changedById: actorUserId,
          comment: reason || 'Task reopened',
        },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_REOPENED',
          metadata: { previousStatus, reason },
        },
      });

      return {
        success: true,
        message: 'Task reopened successfully.',
        data: { taskId, status: TaskStatus.REOPENED },
      };
    });
  }
}
