import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../../database/prisma.service';
import { AuditAction, MediaStatus } from '../../../generated/prisma/client';
import { LocalStorageProvider } from './local-storage.provider';

@Injectable()
export class TasksStorageReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TasksStorageReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageProvider: LocalStorageProvider,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Executing startup storage hygiene sweep...');
    await this.sweepStartupSpool();
  }

  /**
   * Sweeps spool directory on application startup to remove stale temporary files older than 1 hour.
   */
  public async sweepStartupSpool(): Promise<number> {
    const root = this.storageProvider.getStorageRoot();
    const spoolDir = path.join(root, '.tmp_spool');

    if (!fs.existsSync(spoolDir)) {
      return 0;
    }

    let unlinkedCount = 0;
    const now = Date.now();
    const ONE_HOUR_MS = 60 * 60 * 1000;

    try {
      const files = await fs.promises.readdir(spoolDir);
      for (const file of files) {
        const filePath = path.join(spoolDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > ONE_HOUR_MS) {
            await fs.promises.unlink(filePath);
            unlinkedCount++;
          }
        } catch {
          // ignore file access race
        }
      }
      if (unlinkedCount > 0) {
        this.logger.log(`Cleaned up ${unlinkedCount} stale spool file(s) on startup.`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to complete startup spool sweep: ${err.message}`);
    }

    return unlinkedCount;
  }

  /**
   * Comprehensive reconciliation worker.
   */
  public async reconcileStorage(): Promise<{
    cleanedSpoolCount: number;
    quarantinedOrphansCount: number;
    markedInactiveMissingCount: number;
    purgedQuarantineCount: number;
  }> {
    const root = this.storageProvider.getStorageRoot();
    const now = Date.now();

    let cleanedSpoolCount = 0;
    let quarantinedOrphansCount = 0;
    let markedInactiveMissingCount = 0;
    let purgedQuarantineCount = 0;

    // 1. Spool sweep: remove files older than 2 hours
    const spoolDir = path.join(root, '.tmp_spool');
    if (fs.existsSync(spoolDir)) {
      const files = await fs.promises.readdir(spoolDir);
      for (const file of files) {
        const filePath = path.join(spoolDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            await fs.promises.unlink(filePath);
            cleanedSpoolCount++;
          }
        } catch {}
      }
    }

    // 2. Orphaned physical files sweep: Check files in tasks/ older than 24 hours
    const tasksDir = path.join(root, 'tasks');
    if (fs.existsSync(tasksDir)) {
      const taskFolders = await fs.promises.readdir(tasksDir);
      for (const folder of taskFolders) {
        const taskFolderDir = path.join(tasksDir, folder);
        const isDir = (await fs.promises.stat(taskFolderDir)).isDirectory();
        if (!isDir) continue;

        const files = await fs.promises.readdir(taskFolderDir);
        for (const file of files) {
          const filePath = path.join(taskFolderDir, file);
          const stat = await fs.promises.stat(filePath);
          // 24 hour grace period for in-flight transactions
          if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            const relKey = `tasks/${folder}/${file}`.replace(/\\/g, '/');
            const mediaRecord = await this.prisma.media.findFirst({
              where: { storageKey: relKey },
            });

            if (!mediaRecord) {
              // Move to .unreconciled/<date>/
              const dateStr = new Date().toISOString().split('T')[0];
              const unreconciledDir = path.join(root, '.unreconciled', dateStr);
              if (!fs.existsSync(unreconciledDir)) {
                await fs.promises.mkdir(unreconciledDir, { recursive: true });
              }
              const targetPath = path.join(unreconciledDir, `${folder}_${file}`);
              await fs.promises.rename(filePath, targetPath);
              quarantinedOrphansCount++;
              this.logger.warn(
                `[Reconciliation] Orphaned storage asset moved to quarantine: ${filePath} -> ${targetPath}`,
              );
            }
          }
        }
      }
    }

    // 3. Purge files in .unreconciled older than 30 days
    const unreconciledRoot = path.join(root, '.unreconciled');
    if (fs.existsSync(unreconciledRoot)) {
      const dateFolders = await fs.promises.readdir(unreconciledRoot);
      for (const dateFolder of dateFolders) {
        const fullDateDir = path.join(unreconciledRoot, dateFolder);
        const stat = await fs.promises.stat(fullDateDir);
        if (now - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
          await fs.promises.rm(fullDateDir, { recursive: true, force: true });
        }
      }
    }

    // 4. Missing physical files sweep: Check DB records where physical file is missing
    const activeMedia = await this.prisma.media.findMany({
      where: {
        status: MediaStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        id: true,
        storageKey: true,
      },
    });

    for (const record of activeMedia) {
      const exists = await this.storageProvider.exists(record.storageKey);
      if (!exists) {
        await this.prisma.media.update({
          where: { id: record.id },
          data: {
            status: MediaStatus.INACTIVE,
            scanDetails: `Physical file missing during reconciliation on ${new Date().toISOString()}`,
          },
        });

        await this.prisma.auditLog.create({
          data: {
            actorUserId: null,
            action: AuditAction.UPDATE,
            module: 'TASKS',
            entityType: 'MEDIA',
            entityId: record.id,
            oldValues: { status: MediaStatus.ACTIVE },
            newValues: {
              status: MediaStatus.INACTIVE,
              reason: 'PHYSICAL_FILE_MISSING_DURING_RECONCILIATION',
            },
          },
        });

        markedInactiveMissingCount++;
        this.logger.error(
          `[Reconciliation] Active Media ID ${record.id} missing physical file (${record.storageKey}). Marked INACTIVE.`,
        );
      }
    }

    // 5. Quarantine retention sweep: Purge quarantined binaries older than 14 days
    const quarantineDir = path.join(root, '.quarantine');
    if (fs.existsSync(quarantineDir)) {
      const qFiles = await fs.promises.readdir(quarantineDir);
      for (const qFile of qFiles) {
        const qPath = path.join(quarantineDir, qFile);
        const stat = await fs.promises.stat(qPath);
        if (now - stat.mtimeMs > 14 * 24 * 60 * 60 * 1000) {
          try {
            await fs.promises.unlink(qPath);
            purgedQuarantineCount++;

            // Update matching Media row if exists
            const relKey = `.quarantine/${qFile}`;
            await this.prisma.media.updateMany({
              where: { storageKey: relKey },
              data: {
                scanDetails: 'Quarantine expired (14 days); physical payload purged for safety.',
              },
            });
          } catch {}
        }
      }
    }

    return {
      cleanedSpoolCount,
      quarantinedOrphansCount,
      markedInactiveMissingCount,
      purgedQuarantineCount,
    };
  }
}
