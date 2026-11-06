import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { LocalStorageProvider } from './local-storage.provider';

describe('LocalStorageProvider (Unit Tests)', () => {
  let provider: LocalStorageProvider;
  const testStorageDir = path.join(process.cwd(), 'storage_unit_test');

  beforeAll(() => {
    process.env.STORAGE_LOCAL_ROOT = testStorageDir;
    provider = new LocalStorageProvider();
    provider.ensureDirectoryTree();
  });

  afterAll(async () => {
    if (fs.existsSync(testStorageDir)) {
      await fs.promises.rm(testStorageDir, { recursive: true, force: true });
    }
    delete process.env.STORAGE_LOCAL_ROOT;
  });

  it('should initialize directory tree on startup', () => {
    expect(fs.existsSync(testStorageDir)).toBe(true);
    expect(fs.existsSync(path.join(testStorageDir, '.tmp_spool'))).toBe(true);
    expect(fs.existsSync(path.join(testStorageDir, 'tasks'))).toBe(true);
    expect(fs.existsSync(path.join(testStorageDir, '.quarantine'))).toBe(true);
    expect(fs.existsSync(path.join(testStorageDir, '.unreconciled'))).toBe(true);
  });

  it('should reject path traversal attempts (BadRequestException)', () => {
    expect(() => provider.resolveSafePath('../../etc/passwd')).toThrow(BadRequestException);
    expect(() => provider.resolveSafePath('..\\..\\windows\\system32')).toThrow(BadRequestException);
    expect(() => provider.resolveSafePath('tasks/../../secret.txt')).toThrow(BadRequestException);
    expect(() => provider.resolveSafePath('tasks/evil\0file.txt')).toThrow(BadRequestException);
  });

  it('should write stream and calculate SHA-256 correctly', async () => {
    const key = 'tasks/test_task/sample.txt';
    const content = 'Slash Infotech CRM Secure Task Attachment Content';
    const stream = Readable.from(Buffer.from(content, 'utf8'));

    const writeRes = await provider.writeStream(key, stream);
    expect(writeRes.bytesWritten).toBe(Buffer.byteLength(content));
    expect(writeRes.sha256).toBeDefined();

    // Verify exists
    const exists = await provider.exists(key);
    expect(exists).toBe(true);

    // Verify SHA-256 calculation matches
    const calculated = await provider.calculateSha256(key);
    expect(calculated).toBe(writeRes.sha256);

    // Verify stat
    const stat = await provider.stat(key);
    expect(stat.size).toBe(Buffer.byteLength(content));
  });

  it('should move file atomically from one storage key to another', async () => {
    const srcKey = '.tmp_spool/temp_move_test.tmp';
    const dstKey = 'tasks/test_task/moved_test.txt';

    await provider.writeStream(srcKey, Readable.from(Buffer.from('Move payload', 'utf8')));
    expect(await provider.exists(srcKey)).toBe(true);

    await provider.move(srcKey, dstKey);
    expect(await provider.exists(srcKey)).toBe(false);
    expect(await provider.exists(dstKey)).toBe(true);

    // Clean up
    await provider.delete(dstKey);
    expect(await provider.exists(dstKey)).toBe(false);
  });
});

