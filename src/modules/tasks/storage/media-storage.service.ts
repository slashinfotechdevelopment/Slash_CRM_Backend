import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../../database/prisma.service';
import {
  AuditAction,
  MediaScanStatus,
  MediaStatus,
  MediaStorageProvider,
  MediaType,
  MediaVisibility,
} from '../../../generated/prisma/client';
import { ClamAvScannerService } from './clamav-scanner.service';
import { FileValidationUtils } from './file-validation.utils';
import { LocalStorageProvider } from './local-storage.provider';

export interface BinaryAttachmentResult {
  id: string;
  mediaId: string;
  originalName: string;
  mimeType: string;
  fileSizeBytes: number;
  scanStatus: MediaScanStatus;
  scanDetails: string | null;
  collection: string;
  createdAt: Date;
}

export interface StreamDownloadResult {
  stream: NodeJS.ReadableStream;
  originalName: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string | null;
}

export interface StreamPreviewResult extends StreamDownloadResult {
  contentDisposition: 'inline' | 'attachment';
  contentSecurityPolicy: string;
}

@Injectable()
export class MediaStorageService {
  private readonly logger = new Logger(MediaStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageProvider: LocalStorageProvider,
    private readonly clamavScanner: ClamAvScannerService,
  ) {}

  /**
   * Resolves MediaType enum based on detected MIME.
   */
  private resolveMediaType(mime: string): MediaType {
    if (mime.startsWith('image/')) return MediaType.IMAGE;
    if (mime.startsWith('video/')) return MediaType.VIDEO;
    if (
      mime.includes('pdf') ||
      mime.includes('word') ||
      mime.includes('excel') ||
      mime.includes('document') ||
      mime.includes('sheet') ||
      mime.includes('text')
    ) {
      return MediaType.DOCUMENT;
    }
    return MediaType.OTHER;
  }

  /**
   * Sanitizes original filename preventing path traversal, null bytes, and control characters.
   */
  public sanitizeFilename(originalName: string): string {
    if (!originalName || typeof originalName !== 'string') {
      throw new BadRequestException('Filename must be a non-empty string.');
    }

    if (
      originalName.includes('\0') ||
      originalName.includes('..') ||
      originalName.includes('/') ||
      originalName.includes('\\') ||
      originalName.includes(':')
    ) {
      throw new BadRequestException('Filename contains invalid or path traversal characters.');
    }

    const sanitized = path.basename(originalName).trim();
    if (sanitized.length === 0 || sanitized.length > 255) {
      throw new BadRequestException('Filename length must be between 1 and 255 characters.');
    }

    return sanitized;
  }

  /**
   * Handles binary multipart file upload from disk spool.
   */
  async processBinaryUpload(
    taskId: string,
    file: { path: string; originalname: string; mimetype: string; size: number },
    actorUserId: string,
    collection: string = 'attachments',
    customOriginalName?: string,
  ): Promise<BinaryAttachmentResult> {
    const spoolFilePath = file.path;
    const nameToCheck = customOriginalName || file.originalname;
    const sanitizedName = this.sanitizeFilename(nameToCheck);

    let movedPermanentKey: string | null = null;

    try {
      // 1. Deep file validation: Magic bytes, archive inspection, macro detection, SVG checks
      const validation = await FileValidationUtils.validateFile(
        spoolFilePath,
        sanitizedName,
        file.mimetype,
        file.size,
      );

      // 2. Malware scan via ClamAV
      const scanResult = await this.clamavScanner.scanFile(spoolFilePath, file.size);

      // Handle INFECTED files
      if (scanResult.status === MediaScanStatus.INFECTED) {
        const quarantineKey = `.quarantine/${Date.now()}_${crypto.randomBytes(8).toString('hex')}.quarantine`;
        await this.storageProvider.move(
          path.relative(this.storageProvider.getStorageRoot(), spoolFilePath),
          quarantineKey,
        );

        // Strip permissions from quarantined file
        try {
          const qPath = this.storageProvider.resolveSafePath(quarantineKey);
          fs.chmodSync(qPath, 0o000);
        } catch {
          // ignore chmod errors on Windows
        }

        // Persist quarantine metadata in DB for incident response & audit trail
        await this.prisma.$transaction(async (tx) => {
          const media = await tx.media.create({
            data: {
              originalName: sanitizedName,
              storedName: path.basename(quarantineKey),
              storageProvider: MediaStorageProvider.LOCAL,
              storageKey: quarantineKey,
              mimeType: validation.detectedMime,
              fileSizeBytes: BigInt(file.size),
              mediaType: this.resolveMediaType(validation.detectedMime),
              visibility: MediaVisibility.PRIVATE,
              status: MediaStatus.INACTIVE,
              uploadedById: actorUserId,
              checksumSha256: scanResult.scannedSha256,
              scanStatus: MediaScanStatus.INFECTED,
              scanDetails: scanResult.details || `Threat: ${scanResult.threat}`,
            },
          });

          await tx.mediaAttachment.create({
            data: {
              mediaId: media.id,
              entityType: 'TASK',
              entityId: taskId,
              collection: 'quarantine',
            },
          });

          await tx.taskActivityLog.create({
            data: {
              taskId,
              performedBy: actorUserId,
              action: 'TASK_ATTACHMENT_QUARANTINED',
              metadata: {
                mediaId: media.id,
                threat: scanResult.threat,
                originalName: sanitizedName,
                fileSizeBytes: file.size,
              },
            },
          });
        });

        throw new UnprocessableEntityException(
          `Uploaded file contains malicious content (${scanResult.threat}) and has been quarantined.`,
        );
      }

      // 3. Move from spool to permanent storage
      const ext = path.extname(sanitizedName).toLowerCase();
      const storedFileName = `task_${taskId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
      const targetStorageKey = `tasks/${taskId}/${storedFileName}`;

      const relSpoolKey = path.relative(this.storageProvider.getStorageRoot(), spoolFilePath);
      await this.storageProvider.move(relSpoolKey, targetStorageKey);
      movedPermanentKey = targetStorageKey;

      // Verify integrity after move to permanent storage
      if (scanResult.scannedSha256) {
        const movedSha256 = await this.storageProvider.calculateSha256(targetStorageKey);
        if (movedSha256 !== scanResult.scannedSha256) {
          await this.storageProvider.delete(targetStorageKey).catch(() => {});
          throw new BadRequestException('File integrity verification failed: SHA-256 altered after move.');
        }
      }

      // 4. Create database records in transaction
      return await this.prisma.$transaction(async (tx) => {
        const media = await tx.media.create({
          data: {
            originalName: sanitizedName,
            storedName: storedFileName,
            storageProvider: MediaStorageProvider.LOCAL,
            storageKey: targetStorageKey,
            fileUrl: null, // Private local storage
            mimeType: validation.detectedMime,
            fileSizeBytes: BigInt(file.size),
            mediaType: this.resolveMediaType(validation.detectedMime),
            visibility: MediaVisibility.PRIVATE,
            status: MediaStatus.ACTIVE,
            uploadedById: actorUserId,
            checksumSha256: scanResult.scannedSha256,
            scanStatus: scanResult.status,
            scanDetails: scanResult.details,
          },
        });

        const attachment = await tx.mediaAttachment.create({
          data: {
            mediaId: media.id,
            entityType: 'TASK',
            entityId: taskId,
            collection: collection || 'attachments',
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
              originalName: sanitizedName,
              fileSizeBytes: file.size,
              scanStatus: scanResult.status,
              collection: collection || 'attachments',
            },
          },
        });

        return {
          id: attachment.id,
          mediaId: media.id,
          originalName: media.originalName,
          mimeType: media.mimeType,
          fileSizeBytes: Number(media.fileSizeBytes),
          scanStatus: media.scanStatus,
          scanDetails: media.scanDetails,
          collection: attachment.collection,
          createdAt: attachment.createdAt,
        };
      });
    } catch (err: any) {
      // Compensating action: Delete moved permanent file if DB commit failed
      if (movedPermanentKey) {
        await this.storageProvider.delete(movedPermanentKey).catch(() => {});
      }
      throw err;
    } finally {
      // Guaranteed spool cleanup
      if (fs.existsSync(spoolFilePath)) {
        try {
          fs.unlinkSync(spoolFilePath);
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  /**
   * Prepares attachment binary download.
   */
  async prepareDownload(taskId: string, attachmentId: string): Promise<StreamDownloadResult> {
    const attachment = await this.prisma.mediaAttachment.findFirst({
      where: {
        id: attachmentId,
        entityType: 'TASK',
        entityId: taskId,
      },
      include: {
        media: true,
      },
    });

    if (!attachment || !attachment.media) {
      throw new NotFoundException('Attachment not found for this task.');
    }

    const media = attachment.media;

    if (media.deletedAt !== null || media.status !== MediaStatus.ACTIVE) {
      throw new NotFoundException('Attachment has been deleted.');
    }

    if (media.scanStatus === MediaScanStatus.INFECTED) {
      throw new ForbiddenException('Access Denied: Attachment identified as containing malicious content.');
    }

    if (media.scanStatus !== MediaScanStatus.CLEAN) {
      throw new HttpException(
        {
          statusCode: HttpStatus.LOCKED,
          error: 'Locked',
          message: `Attachment cannot be downloaded because malware scan has not completed or failed (current status: ${media.scanStatus}).`,
        },
        HttpStatus.LOCKED,
      );
    }

    const fileExists = await this.storageProvider.exists(media.storageKey);
    if (!fileExists) {
      throw new NotFoundException('Physical file content is unavailable in storage.');
    }

    const stream = this.storageProvider.createReadStream(media.storageKey);

    return {
      stream,
      originalName: media.originalName,
      mimeType: media.mimeType,
      fileSizeBytes: Number(media.fileSizeBytes),
      sha256: media.checksumSha256,
    };
  }

  /**
   * Prepares attachment preview stream with strict security headers.
   */
  async preparePreview(taskId: string, attachmentId: string): Promise<StreamPreviewResult> {
    const download = await this.prepareDownload(taskId, attachmentId);
    const mime = download.mimeType.toLowerCase();

    // Whitelist supported preview MIME types
    const allowedInlineMimes = new Set([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
    ]);

    if (!allowedInlineMimes.has(mime) && mime !== 'image/svg+xml') {
      throw new BadRequestException(
        `Inline preview is not supported for MIME type '${mime}'. Please use the download endpoint.`,
      );
    }

    // Force attachment disposition for SVG to neutralize any potential stored XSS
    const isSvg = mime === 'image/svg+xml';
    const contentDisposition = isSvg ? 'attachment' : 'inline';
    const contentSecurityPolicy =
      "default-src 'none'; img-src 'self' data:; style-src 'none'; script-src 'none'; frame-ancestors 'none';";

    return {
      ...download,
      contentDisposition,
      contentSecurityPolicy,
    };
  }

  /**
   * Triggers an authorized rescan with concurrency lock and SHA-256 integrity verification.
   */
  async rescanAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<{
    success: boolean;
    message: string;
    scanStatus: MediaScanStatus;
    data?: {
      mediaId: string;
      attachmentId: string;
      scanStatus: MediaScanStatus;
    };
  }> {
    const attachment = await this.prisma.mediaAttachment.findFirst({
      where: {
        id: attachmentId,
        entityType: 'TASK',
        entityId: taskId,
      },
      include: {
        media: true,
      },
    });

    if (!attachment || !attachment.media) {
      throw new NotFoundException('Attachment not found.');
    }

    const media = attachment.media;

    // Concurrency Lock: Atomic conditional transition to SCANNING
    const lockResult = await this.prisma.media.updateMany({
      where: {
        id: media.id,
        scanStatus: {
          in: [MediaScanStatus.PENDING, MediaScanStatus.QUARANTINED, MediaScanStatus.FAILED],
        },
        deletedAt: null,
      },
      data: {
        scanStatus: MediaScanStatus.SCANNING,
        scanDetails: `Rescan initiated by ${actorUserId} at ${new Date().toISOString()}`,
      },
    });

    if (lockResult.count === 0) {
      throw new ConflictException(
        'Attachment is currently undergoing a scan, already clean, or has been deleted.',
      );
    }

    const physicalPath = this.storageProvider.resolveSafePath(media.storageKey);
    if (!fs.existsSync(physicalPath)) {
      await this.prisma.media.update({
        where: { id: media.id },
        data: {
          scanStatus: MediaScanStatus.FAILED,
          status: MediaStatus.INACTIVE,
          scanDetails: 'Physical file missing during rescan',
        },
      });
      throw new NotFoundException('Physical file missing from storage.');
    }

    // SHA-256 pre-scan validation: Ensure file has not been altered on disk
    if (media.checksumSha256) {
      const diskSha256 = await this.storageProvider.calculateSha256(media.storageKey);
      if (diskSha256 !== media.checksumSha256) {
        await this.prisma.media.update({
          where: { id: media.id },
          data: {
            scanStatus: MediaScanStatus.FAILED,
            status: MediaStatus.INACTIVE,
            scanDetails: 'Integrity check failed: on-disk SHA-256 mismatch before rescan',
          },
        });
        this.logger.error(
          `Security Alert: Checksum mismatch on media ${media.id}! Expected ${media.checksumSha256}, got ${diskSha256}.`,
        );
        throw new BadRequestException('File integrity verification failed prior to scanning.');
      }
    }

    // Scan file via ClamAV
    const scanResult = await this.clamavScanner.scanFile(physicalPath, Number(media.fileSizeBytes));

    // Post-scan tamper detection: Ensure checksum did not change during scanning
    if (media.checksumSha256 && scanResult.scannedSha256 && scanResult.scannedSha256 !== media.checksumSha256) {
      await this.prisma.media.update({
        where: { id: media.id },
        data: {
          scanStatus: MediaScanStatus.FAILED,
          status: MediaStatus.INACTIVE,
          scanDetails: 'Integrity check failed: on-disk SHA-256 altered during scan',
        },
      });
      this.logger.error(
        `Security Alert: Checksum altered during scan on media ${media.id}! Expected ${media.checksumSha256}, got ${scanResult.scannedSha256}.`,
      );
      throw new BadRequestException('File integrity verification failed: content changed during scan.');
    }

    if (scanResult.status === MediaScanStatus.CLEAN) {
      let finalKey = media.storageKey;

      // If file was previously quarantined, move back to permanent tasks directory
      if (media.storageKey.startsWith('.quarantine')) {
        finalKey = `tasks/${taskId}/${media.storedName}`;
        await this.storageProvider.move(media.storageKey, finalKey);
      }

      await this.prisma.media.update({
        where: { id: media.id },
        data: {
          scanStatus: MediaScanStatus.CLEAN,
          status: MediaStatus.ACTIVE,
          storageKey: finalKey,
          checksumSha256: scanResult.scannedSha256,
          scanDetails: `Rescan clean: ${scanResult.details || 'OK'}`,
        },
      });

      await this.prisma.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_ATTACHMENT_RESCANNED',
          metadata: {
            mediaId: media.id,
            attachmentId,
            outcome: 'CLEAN',
          },
        },
      });

      await this.prisma.auditLog.create({
        data: {
          actorUserId,
          action: AuditAction.STATUS_CHANGE,
          module: 'TASKS',
          entityType: 'MEDIA',
          entityId: media.id,
          oldValues: { scanStatus: media.scanStatus },
          newValues: {
            scanStatus: MediaScanStatus.CLEAN,
            reason: 'ADMIN_TRIGGERED_RESCAN',
          },
        },
      });

      return {
        success: true,
        message: 'Attachment successfully rescanned and marked clean.',
        scanStatus: MediaScanStatus.CLEAN,
        data: {
          mediaId: media.id,
          attachmentId,
          scanStatus: MediaScanStatus.CLEAN,
        },
      };
    } else {
      // Scan was not clean (INFECTED or FAILED)
      await this.prisma.media.update({
        where: { id: media.id },
        data: {
          scanStatus: scanResult.status,
          scanDetails: scanResult.details || 'Rescan detected threat or failed',
        },
      });

      return {
        success: false,
        message: `Attachment rescan resulted in status: ${scanResult.status}.`,
        scanStatus: scanResult.status,
        data: {
          mediaId: media.id,
          attachmentId,
          scanStatus: scanResult.status,
        },
      };
    }
  }

  /**
   * Soft-deletes a task attachment and its associated media.
   */
  async deleteAttachment(
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    isElevated: boolean,
  ): Promise<{ success: boolean; message: string }> {
    const attachment = await this.prisma.mediaAttachment.findFirst({
      where: {
        id: attachmentId,
        entityType: 'TASK',
        entityId: taskId,
      },
      include: {
        media: true,
      },
    });

    if (!attachment || !attachment.media) {
      throw new NotFoundException('Attachment not found.');
    }

    const media = attachment.media;

    if (!isElevated && media.uploadedById !== actorUserId) {
      throw new ForbiddenException('Only the author or an authorized reviewer/admin can delete this attachment.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.media.update({
        where: { id: media.id },
        data: {
          deletedAt: new Date(),
          status: MediaStatus.INACTIVE,
        },
      });

      await tx.mediaAttachment.delete({
        where: { id: attachment.id },
      });

      await tx.taskActivityLog.create({
        data: {
          taskId,
          performedBy: actorUserId,
          action: 'TASK_ATTACHMENT_REMOVED',
          metadata: {
            attachmentId: attachment.id,
            mediaId: media.id,
            originalName: media.originalName,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId,
          action: AuditAction.DELETE,
          module: 'TASKS',
          entityType: 'MEDIA_ATTACHMENT',
          entityId: attachment.id,
          oldValues: {
            mediaId: media.id,
            originalName: media.originalName,
          },
          newValues: { deleted: true },
        },
      });
    });

    return {
      success: true,
      message: 'Attachment deleted successfully.',
    };
  }
}
