import * as fs from 'fs';
import * as path from 'path';
import { MediaStatus } from '../../../generated/prisma/client';
import { LocalStorageProvider } from './local-storage.provider';
import { TasksStorageReconciliationService } from './tasks-storage-reconciliation.service';

describe('TasksStorageReconciliationService (Unit Tests)', () => {
  let service: TasksStorageReconciliationService;
  let storageProvider: LocalStorageProvider;
  let prismaMock: any;
  const testRoot = path.join(process.cwd(), 'recon_unit_test');

  beforeAll(() => {
    process.env.STORAGE_LOCAL_ROOT = testRoot;
    storageProvider = new LocalStorageProvider();
    storageProvider.ensureDirectoryTree();

    prismaMock = {
      media: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    };

    service = new TasksStorageReconciliationService(prismaMock, storageProvider);
  });

  afterAll(async () => {
    if (fs.existsSync(testRoot)) {
      await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
    delete process.env.STORAGE_LOCAL_ROOT;
  });

  it('should clean up stale spool files older than 1 hour on startup', async () => {
    const spoolDir = path.join(testRoot, '.tmp_spool');
    const oldSpoolFile = path.join(spoolDir, 'old_spool.tmp');
    const newSpoolFile = path.join(spoolDir, 'new_spool.tmp');

    fs.writeFileSync(oldSpoolFile, 'old content');
    fs.writeFileSync(newSpoolFile, 'new content');

    // Set old file mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldSpoolFile, twoHoursAgo, twoHoursAgo);

    const count = await service.sweepStartupSpool();
    expect(count).toBe(1);
    expect(fs.existsSync(oldSpoolFile)).toBe(false);
    expect(fs.existsSync(newSpoolFile)).toBe(true);
  });

  it('should quarantine orphaned permanent files older than 24h into .unreconciled/', async () => {
    const taskDir = path.join(testRoot, 'tasks', 'task_orphan_test');
    fs.mkdirSync(taskDir, { recursive: true });
    const orphanFile = path.join(taskDir, 'orphan.txt');
    fs.writeFileSync(orphanFile, 'orphan payload');

    // Set mtime to 48 hours ago
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(orphanFile, twoDaysAgo, twoDaysAgo);

    prismaMock.media.findFirst.mockResolvedValue(null); // No DB record
    prismaMock.media.findMany.mockResolvedValue([]); // No active media missing

    const res = await service.reconcileStorage();
    expect(res.quarantinedOrphansCount).toBe(1);
    expect(fs.existsSync(orphanFile)).toBe(false);

    // Verify it was moved to .unreconciled/<date>/
    const dateStr = new Date().toISOString().split('T')[0];
    const unreconciledDir = path.join(testRoot, '.unreconciled', dateStr);
    expect(fs.existsSync(path.join(unreconciledDir, 'task_orphan_test_orphan.txt'))).toBe(true);
  });

  it('should mark active DB Media rows as INACTIVE if physical file is missing', async () => {
    prismaMock.media.findFirst.mockResolvedValue(null);
    prismaMock.media.findMany.mockResolvedValue([
      {
        id: 'media_missing_physical',
        storageKey: 'tasks/task_missing/non_existent.png',
      },
    ]);

    const res = await service.reconcileStorage();
    expect(res.markedInactiveMissingCount).toBe(1);
    expect(prismaMock.media.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'media_missing_physical' },
        data: expect.objectContaining({
          status: MediaStatus.INACTIVE,
        }),
      }),
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });
});

