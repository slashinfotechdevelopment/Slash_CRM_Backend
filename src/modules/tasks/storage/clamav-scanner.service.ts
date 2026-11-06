import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { MediaScanStatus } from '../../../generated/prisma/client';

export interface ClamAvScanResult {
  status: MediaScanStatus;
  threat?: string;
  details?: string;
  latencyMs: number;
  scannedSha256: string;
}

@Injectable()
export class ClamAvScannerService {
  private readonly logger = new Logger(ClamAvScannerService.name);

  public isEnabled(): boolean {
    return process.env.CLAMAV_ENABLED === 'true';
  }

  public isStrict(): boolean {
    return process.env.CLAMAV_STRICT === 'true' || process.env.NODE_ENV === 'production';
  }

  public getHost(): string {
    return process.env.CLAMAV_HOST || '127.0.0.1';
  }

  public getPort(): number {
    return Number(process.env.CLAMAV_PORT || 3310);
  }

  /**
   * Calculates dynamic scanner timeout based on file size.
   */
  public calculateTimeout(fileSizeBytes: number): number {
    const baseTimeoutMs = Number(process.env.CLAMAV_TIMEOUT_BASE_MS || 10000);
    const perMbTimeoutMs = Number(process.env.CLAMAV_TIMEOUT_PER_MB_MS || 1500);
    const maxTimeoutMs = Number(process.env.CLAMAV_TIMEOUT_MAX_MS || 60000);
    const mb = Math.ceil(fileSizeBytes / 1_000_000);
    const dynamicTimeout = baseTimeoutMs + mb * perMbTimeoutMs;
    return Math.min(maxTimeoutMs, dynamicTimeout);
  }

  /**
   * Scans a file on disk by streaming chunks to ClamAV via TCP socket (zINSTREAM protocol).
   * Also computes SHA-256 hash of the exact stream sent to scanner.
   */
  async scanFile(filePath: string, fileSizeBytes: number): Promise<ClamAvScanResult> {
    const startTime = Date.now();

    // If ClamAV is disabled (local dev without daemon), calculate hash and return PENDING
    if (!this.isEnabled()) {
      const sha256 = await this.computeFileSha256(filePath);
      const latencyMs = Date.now() - startTime;
      this.logger.log(
        `ClamAV is disabled. File ${filePath} marked PENDING without scan (dev mode).`,
      );
      return {
        status: MediaScanStatus.PENDING,
        details: 'ClamAV scanning disabled (dev mode). Scan pending.',
        latencyMs,
        scannedSha256: sha256,
      };
    }

    const timeoutMs = this.calculateTimeout(fileSizeBytes);

    try {
      return await this.executeSocketScan(filePath, timeoutMs, startTime);
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const sha256 = await this.computeFileSha256(filePath).catch(() => '');

      this.logger.error(
        `ClamAV scanner connection failure [${this.getHost()}:${this.getPort()}]: ${err.message}`,
      );

      // Fail-closed in strict/production mode
      if (this.isStrict()) {
        throw new ServiceUnavailableException(
          'Malware scanning service is temporarily unavailable. Upload rejected per security policy.',
        );
      }

      // Non-strict fallback: NEVER mark clean
      return {
        status: MediaScanStatus.PENDING,
        details: `Scanner unavailable (${err.message}). Strict=false. Scan pending.`,
        latencyMs,
        scannedSha256: sha256,
      };
    }
  }

  /**
   * Executes socket communication with ClamAV daemon.
   */
  private executeSocketScan(
    filePath: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ClamAvScanResult> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const hash = crypto.createHash('sha256');
      let responseData = '';
      let timer: NodeJS.Timeout | null = null;
      let completed = false;
      let digested = false;
      let scannedSha256 = '';
      let fileStream: fs.ReadStream | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (fileStream) fileStream.destroy();
        socket.removeAllListeners();
        socket.destroy();
      };

      timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          reject(new Error(`ClamAV scanner timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs);

      socket.connect(this.getPort(), this.getHost(), () => {
        // Send zINSTREAM command with null delimiter
        socket.write('zINSTREAM\0');

        fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

        fileStream.on('data', (chunk: string | Buffer) => {
          if (digested || completed) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);

          // Frame chunk: 4-byte big-endian length + chunk bytes
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(buf.length, 0);

          // Backpressure handling
          const canContinue = socket.write(lenBuf) && socket.write(buf);
          if (!canContinue) {
            fileStream?.pause();
            socket.once('drain', () => fileStream?.resume());
          }
        });

        fileStream.on('error', (err) => {
          if (!completed) {
            completed = true;
            cleanup();
            reject(err);
          }
        });

        fileStream.on('end', () => {
          if (!digested) {
            scannedSha256 = hash.digest('hex');
            digested = true;
          }
          // Send zero-length chunk to terminate zINSTREAM: 4 bytes of 0x00
          const zeroBuf = Buffer.alloc(4);
          socket.write(zeroBuf);
        });
      });

      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf8');
      });

      socket.on('error', (err) => {
        if (!completed) {
          completed = true;
          cleanup();
          reject(err);
        }
      });

      socket.on('end', () => {
        if (completed) return;
        completed = true;

        if (!digested) {
          scannedSha256 = hash.digest('hex');
          digested = true;
        }

        cleanup();

        const latencyMs = Date.now() - startTime;
        const trimmed = responseData.trim();

        // Response format:
        // "stream: OK" -> Clean
        // "stream: <threat> FOUND" -> Infected
        // "stream: ... ERROR" -> Scanner internal error
        if (trimmed.includes('OK')) {
          this.logger.log(`ClamAV scan completed in ${latencyMs}ms: CLEAN.`);
          resolve({
            status: MediaScanStatus.CLEAN,
            details: 'ClamAV verified clean.',
            latencyMs,
            scannedSha256,
          });
        } else if (trimmed.includes('FOUND')) {
          const match = trimmed.match(/stream:\s*(.+)\s*FOUND/i);
          const threat = match ? match[1].trim() : 'Malware detected';
          this.logger.warn(`ClamAV scan detected threat [${threat}] in ${latencyMs}ms!`);
          resolve({
            status: MediaScanStatus.INFECTED,
            threat,
            details: `Threat detected: ${threat}`,
            latencyMs,
            scannedSha256,
          });
        } else {
          this.logger.error(`ClamAV returned unexpected response: ${trimmed}`);
          if (this.isStrict()) {
            reject(new Error(`ClamAV scanner error: ${trimmed}`));
          } else {
            resolve({
              status: MediaScanStatus.FAILED,
              details: `ClamAV scan failed: ${trimmed}`,
              latencyMs,
              scannedSha256,
            });
          }
        }
      });
    });
  }

  /**
   * Helper to compute SHA-256 of a file on disk.
   */
  private computeFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
}
