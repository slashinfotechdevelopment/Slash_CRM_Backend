import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';
import {
  IStorageProvider,
  StorageFileStats,
  StorageWriteResult,
} from './storage-provider.interface';

const streamPipeline = promisify(pipeline);

@Injectable()
export class LocalStorageProvider implements IStorageProvider, OnModuleInit {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly storageRoot: string;

  constructor() {
    const rawRoot = process.env.STORAGE_LOCAL_ROOT || path.join(process.cwd(), 'storage');
    this.storageRoot = path.resolve(rawRoot);
  }

  onModuleInit() {
    this.ensureDirectoryTree();
  }

  /**
   * Initializes private directory structure outside public web roots.
   */
  public ensureDirectoryTree(): void {
    const requiredDirs = [
      this.storageRoot,
      path.join(this.storageRoot, '.tmp_spool'),
      path.join(this.storageRoot, 'tasks'),
      path.join(this.storageRoot, '.quarantine'),
      path.join(this.storageRoot, '.unreconciled'),
    ];

    for (const dir of requiredDirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.logger.log(`Created private storage directory: ${dir}`);
      }
    }
  }

  /**
   * Resolves and canonicalizes a safe filesystem path, preventing path traversal and symlink evasion.
   */
  public resolveSafePath(storageKey: string): string {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new BadRequestException('Invalid storage key.');
    }

    if (storageKey.includes('\0')) {
      throw new BadRequestException('Path contains null bytes.');
    }

    if (
      storageKey.includes('..') ||
      path.isAbsolute(storageKey) ||
      storageKey.startsWith('/') ||
      storageKey.startsWith('\\')
    ) {
      throw new BadRequestException('Path traversal attempt outside private storage directory.');
    }

    const resolvedPath = path.resolve(this.storageRoot, storageKey);

    // Verify boundary constraint: resolved path must be within storageRoot
    if (!resolvedPath.startsWith(this.storageRoot + path.sep) && resolvedPath !== this.storageRoot) {
      throw new BadRequestException('Path traversal attempt outside private storage directory.');
    }

    // If file exists, verify that realpath is also within storageRoot (anti-symlink escape)
    if (fs.existsSync(resolvedPath)) {
      try {
        const realPath = fs.realpathSync(resolvedPath);
        if (!realPath.startsWith(this.storageRoot + path.sep) && realPath !== this.storageRoot) {
          throw new BadRequestException('Symbolic link pointing outside storage root detected.');
        }
      } catch (err: any) {
        throw new InternalServerErrorException(`Failed to verify path safety: ${err.message}`);
      }
    }

    return resolvedPath;
  }

  public getStorageRoot(): string {
    return this.storageRoot;
  }

  /**
   * Writes a stream to disk while computing its SHA-256 hash.
   */
  async writeStream(storageKey: string, stream: Readable): Promise<StorageWriteResult> {
    const filePath = this.resolveSafePath(storageKey);
    const parentDir = path.dirname(filePath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }

    const hash = crypto.createHash('sha256');
    let bytesWritten = 0;

    const outStream = fs.createWriteStream(filePath, { flags: 'w', mode: 0o600 });

    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          bytesWritten += chunk.length;
        });

        stream.on('error', (err) => {
          outStream.destroy(err);
          reject(err);
        });

        outStream.on('error', (err) => {
          stream.destroy(err);
          reject(err);
        });

        outStream.on('finish', () => {
          resolve();
        });

        stream.pipe(outStream);
      });

      const sha256 = hash.digest('hex');
      return { bytesWritten, sha256 };
    } catch (err: any) {
      // Clean up partial file on failure
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore unlink error
        }
      }
      throw new InternalServerErrorException(`Failed to write file stream: ${err.message}`);
    }
  }

  /**
   * Returns a readable stream for physical file download or inspection.
   */
  createReadStream(storageKey: string): Readable {
    const filePath = this.resolveSafePath(storageKey);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Physical file not found in storage.');
    }
    return fs.createReadStream(filePath);
  }

  /**
   * Checks whether the file exists in storage.
   */
  async exists(storageKey: string): Promise<boolean> {
    try {
      const filePath = this.resolveSafePath(storageKey);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Safely deletes a file from storage.
   */
  async delete(storageKey: string): Promise<void> {
    try {
      const filePath = this.resolveSafePath(storageKey);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to delete physical file at ${storageKey}: ${err.message}`);
    }
  }

  /**
   * Atomically moves a file from source to target.
   */
  async move(sourceKey: string, targetKey: string): Promise<void> {
    const srcPath = this.resolveSafePath(sourceKey);
    const dstPath = this.resolveSafePath(targetKey);

    if (!fs.existsSync(srcPath)) {
      throw new NotFoundException(`Source file not found at ${sourceKey}`);
    }

    const dstDir = path.dirname(dstPath);
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }

    try {
      // Try atomic rename
      await fs.promises.rename(srcPath, dstPath);
    } catch (err: any) {
      if (err.code === 'EXDEV') {
        // Fallback for cross-device moves
        await fs.promises.copyFile(srcPath, dstPath);
        await fs.promises.unlink(srcPath);
      } else {
        throw new InternalServerErrorException(`Failed to move file: ${err.message}`);
      }
    }
  }

  /**
   * Retrieves file stats.
   */
  async stat(storageKey: string): Promise<StorageFileStats> {
    const filePath = this.resolveSafePath(storageKey);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Physical file not found in storage.');
    }
    const stat = await fs.promises.stat(filePath);
    return {
      size: stat.size,
      mtime: stat.mtime,
    };
  }

  /**
   * Computes the SHA-256 hash of a file on disk.
   */
  async calculateSha256(storageKey: string): Promise<string> {
    const filePath = this.resolveSafePath(storageKey);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Physical file not found in storage.');
    }

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
}
