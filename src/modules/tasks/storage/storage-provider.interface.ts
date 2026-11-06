import { Readable } from 'stream';

export interface StorageFileStats {
  size: number;
  mtime: Date;
}

export interface StorageWriteResult {
  bytesWritten: number;
  sha256: string;
}

export interface IStorageProvider {
  /**
   * Writes a readable stream to physical storage at storageKey.
   */
  writeStream(storageKey: string, stream: Readable): Promise<StorageWriteResult>;

  /**
   * Returns a readable stream for the file at storageKey.
   */
  createReadStream(storageKey: string): Readable;

  /**
   * Checks whether the file exists at storageKey.
   */
  exists(storageKey: string): Promise<boolean>;

  /**
   * Safely deletes the file at storageKey.
   */
  delete(storageKey: string): Promise<void>;

  /**
   * Moves a file from sourceKey to targetKey (e.g. from spool to permanent or quarantine).
   */
  move(sourceKey: string, targetKey: string): Promise<void>;

  /**
   * Returns file metadata (size, modification time).
   */
  stat(storageKey: string): Promise<StorageFileStats>;

  /**
   * Computes SHA-256 hash of the file at storageKey.
   */
  calculateSha256(storageKey: string): Promise<string>;

  /**
   * Resolves canonicalized safe physical path on disk.
   */
  resolveSafePath(storageKey: string): string;

  /**
   * Returns the root storage directory.
   */
  getStorageRoot(): string;
}

