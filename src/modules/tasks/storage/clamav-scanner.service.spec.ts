import { ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MediaScanStatus } from '../../../generated/prisma/client';
import { ClamAvScannerService } from './clamav-scanner.service';

describe('ClamAvScannerService (Unit Tests)', () => {
  const tmpDir = path.join(process.cwd(), 'clamav_unit_test');
  const testFilePath = path.join(tmpDir, 'test_scan.txt');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, 'Scan content payload for unit test');
  });

  afterAll(async () => {
    if (fs.existsSync(tmpDir)) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Timeout Calculation', () => {
    it('should scale timeout dynamically based on file size', () => {
      const scanner = new ClamAvScannerService();
      // Base: 10000ms, Per MB: 1500ms
      const timeout1Mb = scanner.calculateTimeout(1_000_000);
      expect(timeout1Mb).toBe(11_500);

      const timeout25Mb = scanner.calculateTimeout(25_000_000);
      expect(timeout25Mb).toBe(10_000 + 25 * 1_500); // 47,500ms

      const timeoutHuge = scanner.calculateTimeout(100_000_000);
      expect(timeoutHuge).toBe(60_000); // capped at max
    });
  });

  describe('Disabled Mode (CLAMAV_ENABLED=false)', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.CLAMAV_ENABLED;
      process.env.CLAMAV_ENABLED = 'false';
    });

    afterEach(() => {
      process.env.CLAMAV_ENABLED = originalEnv;
    });

    it('should return PENDING status with valid SHA-256 without connecting to socket', async () => {
      const scanner = new ClamAvScannerService();
      const res = await scanner.scanFile(testFilePath, 100);

      expect(res.status).toBe(MediaScanStatus.PENDING);
      expect(res.details).toContain('ClamAV scanning disabled');
      expect(res.scannedSha256).toBeDefined();
      expect(res.scannedSha256.length).toBe(64);
    });
  });

  describe('Failure Handling (Socket Down)', () => {
    it('should throw ServiceUnavailableException in strict mode (fail-closed)', async () => {
      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'true';
      process.env.CLAMAV_PORT = '39999'; // unassigned port

      const scanner = new ClamAvScannerService();
      await expect(scanner.scanFile(testFilePath, 100)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should return PENDING without clean status in non-strict mode when scanner is down', async () => {
      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'false';
      process.env.NODE_ENV = 'test';
      process.env.CLAMAV_PORT = '39999';

      const scanner = new ClamAvScannerService();
      const res = await scanner.scanFile(testFilePath, 100);

      expect(res.status).toBe(MediaScanStatus.PENDING);
      expect(res.status).not.toBe(MediaScanStatus.CLEAN);
      expect(res.details).toContain('Scanner unavailable');
    });
  });

  describe('Mocked Socket Responses', () => {
    let mockServer: net.Server;
    const openSockets = new Set<net.Socket>();
    const mockPort = 33199;

    afterEach((done) => {
      for (const sock of openSockets) {
        try {
          sock.destroy();
        } catch {}
      }
      openSockets.clear();
      if (mockServer) {
        mockServer.close(() => done());
      } else {
        done();
      }
    });

    it('should detect CLEAN when server responds "stream: OK"', async () => {
      mockServer = net.createServer((socket) => {
        openSockets.add(socket);
        socket.on('data', () => {});
        socket.write('stream: OK\0');
        socket.end();
      });
      await new Promise<void>((resolve) => mockServer.listen(mockPort, resolve));

      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'true';
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(mockPort);

      const scanner = new ClamAvScannerService();
      const res = await scanner.scanFile(testFilePath, 100);

      expect(res.status).toBe(MediaScanStatus.CLEAN);
      expect(res.details).toContain('clean');
    });

    it('should detect INFECTED when server responds "stream: Eicar-Test-Signature FOUND"', async () => {
      mockServer = net.createServer((socket) => {
        openSockets.add(socket);
        socket.on('data', () => {});
        socket.write('stream: Eicar-Test-Signature FOUND\0');
        socket.end();
      });
      await new Promise<void>((resolve) => mockServer.listen(mockPort, resolve));

      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'true';
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(mockPort);

      const scanner = new ClamAvScannerService();
      const res = await scanner.scanFile(testFilePath, 100);

      expect(res.status).toBe(MediaScanStatus.INFECTED);
      expect(res.threat).toBe('Eicar-Test-Signature');
    });

    it('should fail closed (ServiceUnavailableException) on scanner timeout when strict=true', async () => {
      mockServer = net.createServer((socket) => {
        openSockets.add(socket);
        // Blackhole socket - never respond
        socket.on('data', () => {});
      });
      await new Promise<void>((resolve) => mockServer.listen(mockPort, resolve));

      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'true';
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(mockPort);
      process.env.CLAMAV_TIMEOUT_BASE_MS = '50';
      process.env.CLAMAV_TIMEOUT_PER_MB_MS = '0';

      try {
        const scanner = new ClamAvScannerService();
        await expect(scanner.scanFile(testFilePath, 100)).rejects.toThrow(
          ServiceUnavailableException,
        );
      } finally {
        delete process.env.CLAMAV_TIMEOUT_BASE_MS;
        delete process.env.CLAMAV_TIMEOUT_PER_MB_MS;
      }
    });

    it('should return PENDING (never CLEAN) on scanner timeout when strict=false', async () => {
      mockServer = net.createServer((socket) => {
        openSockets.add(socket);
        // Blackhole socket - never respond
        socket.on('data', () => {});
      });
      await new Promise<void>((resolve) => mockServer.listen(mockPort, resolve));

      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'false';
      process.env.CLAMAV_HOST = '127.0.0.1';
      process.env.CLAMAV_PORT = String(mockPort);
      process.env.CLAMAV_TIMEOUT_BASE_MS = '50';
      process.env.CLAMAV_TIMEOUT_PER_MB_MS = '0';

      try {
        const scanner = new ClamAvScannerService();
        const res = await scanner.scanFile(testFilePath, 100);
        expect(res.status).toBe(MediaScanStatus.PENDING);
        expect(res.status).not.toBe(MediaScanStatus.CLEAN);
        expect(res.details).toContain('timed out');
      } finally {
        delete process.env.CLAMAV_TIMEOUT_BASE_MS;
        delete process.env.CLAMAV_TIMEOUT_PER_MB_MS;
      }
    });
  });
});

