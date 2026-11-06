import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { PrismaService } from '../src/database/prisma.service';
import {
  MediaScanStatus,
  MediaStatus,
  RecordStatus,
  SessionStatus,
  TaskPriority,
  TaskStatus,
} from '../src/generated/prisma/client';
import { TasksStorageReconciliationService } from '../src/modules/tasks/storage/tasks-storage-reconciliation.service';

describe('Phase 6.3.6: Security, Storage & Attachment Subsystem (E2E & MySQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let reconciliationService: TasksStorageReconciliationService;

  // Track created entities for teardown
  const createdUserIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdMediaIds: string[] = [];

  let deptAId: string;
  let deptBId: string;

  let superAdminToken: string;
  let superAdminId: string;

  let managerDeptAToken: string;
  let managerDeptAId: string;

  let managerDeptBToken: string;
  let managerDeptBId: string;

  let emp1DeptAToken: string;
  let emp1DeptAId: string;

  let clientToken: string;
  let clientUserId: string;

  let testTaskId: string;
  let testTaskDeptBId: string;

  const storageDir = path.resolve(process.env.STORAGE_LOCAL_ROOT || './storage');
  const tmpFixturesDir = path.join(process.cwd(), 'test_fixtures_p636');

  // Helper to build test zip files with customized Central Directory entries
  function buildTestZipBuffer(
    entries: Array<{
      name: string;
      content: string;
      gpFlag?: number;
      externalAttr?: number;
      overrideCompressedSize?: number;
      overrideUncompressedSize?: number;
    }>,
  ): Buffer {
    const parts: Buffer[] = [];
    const cdEntries: Buffer[] = [];
    let offset = 0;

    for (const ent of entries) {
      const nameBuf = Buffer.from(ent.name, 'utf8');
      const dataBuf = Buffer.from(ent.content, 'utf8');
      const lfhOffset = offset;
      const gpFlag = ent.gpFlag || 0;
      const uncompSize = ent.overrideUncompressedSize !== undefined ? ent.overrideUncompressedSize : dataBuf.length;
      const compSize = ent.overrideCompressedSize !== undefined ? ent.overrideCompressedSize : dataBuf.length;

      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(gpFlag, 6);
      lfh.writeUInt16LE(0, 8);
      lfh.writeUInt16LE(0, 10);
      lfh.writeUInt16LE(0, 12);
      lfh.writeUInt32LE(0, 14);
      lfh.writeUInt32LE(compSize, 18);
      lfh.writeUInt32LE(uncompSize, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);

      parts.push(lfh, nameBuf, dataBuf);
      offset += 30 + nameBuf.length + dataBuf.length;

      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);
      cdh.writeUInt16LE(20, 6);
      cdh.writeUInt16LE(gpFlag, 8);
      cdh.writeUInt16LE(0, 10);
      cdh.writeUInt16LE(0, 12);
      cdh.writeUInt16LE(0, 14);
      cdh.writeUInt32LE(0, 16);
      cdh.writeUInt32LE(compSize, 20);
      cdh.writeUInt32LE(uncompSize, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt16LE(0, 30);
      cdh.writeUInt16LE(0, 32);
      cdh.writeUInt16LE(0, 34);
      cdh.writeUInt16LE(0, 36);
      const unsignedAttr = ent.externalAttr !== undefined ? ent.externalAttr >>> 0 : 0;
      cdh.writeUInt32LE(unsignedAttr, 38);
      cdh.writeUInt32LE(lfhOffset, 42);

      cdEntries.push(cdh, nameBuf);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const b of cdEntries) {
      parts.push(b);
      cdSize += b.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    parts.push(eocd);

    return Buffer.concat(parts);
  }

  async function createTestTaskDirect(params: {
    title: string;
    createdById: string;
    assigneeId?: string;
    departmentId: string;
    status?: TaskStatus;
  }) {
    const taskCount = await prisma.task.count();
    const taskCode = `TSK-${String(taskCount + 1).padStart(5, '0')}`;

    const task = await prisma.task.create({
      data: {
        taskCode,
        title: params.title,
        description: 'Task for attachment and storage verification',
        status: params.status || TaskStatus.IN_PROGRESS,
        priority: TaskPriority.MEDIUM,
        progress: 0,
        startDate: new Date(),
        createdById: params.createdById,
        assigneeId: params.assigneeId,
        departmentId: params.departmentId,
      },
    });
    createdTaskIds.push(task.id);
    return task;
  }

  async function createTestUser(
    prefix: string,
    userTypeCode: string,
    deptId: string,
    roleCode?: string,
  ) {
    const uType = await prisma.userType.findUniqueOrThrow({
      where: { code: userTypeCode },
    });

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const user = await prisma.user.create({
      data: {
        userCode: `E2E_${prefix}_${uniqueSuffix}`.substring(0, 30),
        userTypeId: uType.id,
        name: `Test ${prefix} ${uniqueSuffix}`,
        email: `${prefix.toLowerCase()}_${uniqueSuffix}@teststorage.com`,
        status: RecordStatus.ACTIVE,
      },
    });
    createdUserIds.push(user.id);

    await prisma.userDepartment.create({
      data: {
        userId: user.id,
        departmentId: deptId,
        isPrimary: true,
      },
    });

    if (roleCode) {
      const role = await prisma.role.findUnique({
        where: { code: roleCode },
      });
      if (role) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: role.id,
          },
        });
      }
    }

    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: `hash_${prefix}_${uniqueSuffix}`,
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const token = await jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        userCode: user.userCode,
        userType: userTypeCode,
        roles: roleCode ? [roleCode] : [],
        sessionId: session.id,
      },
      {
        secret: process.env.JWT_SECRET || 'slash@202612354',
        expiresIn: '1h',
      },
    );

    return { user, token };
  }

  beforeAll(async () => {
    if (!fs.existsSync(tmpFixturesDir)) {
      fs.mkdirSync(tmpFixturesDir, { recursive: true });
    }

    const spoolDir = path.join(storageDir, '.tmp_spool');
    if (fs.existsSync(spoolDir)) {
      const files = fs.readdirSync(spoolDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(spoolDir, f));
        } catch {}
      }
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    reconciliationService = app.get(TasksStorageReconciliationService);

    const deptA = await prisma.department.findFirstOrThrow({ where: { code: 'DEVELOPMENT' } });
    const deptB = await prisma.department.findFirstOrThrow({ where: { code: 'HR' } });
    deptAId = deptA.id;
    deptBId = deptB.id;

    // Super Admin
    const sa = await createTestUser('SA_ST', 'SUPER_ADMIN', deptAId, 'SUPER_ADMIN');
    superAdminId = sa.user.id;
    superAdminToken = sa.token;

    // Manager Dept A
    const mgrA = await createTestUser('MGR_A', 'ADMIN', deptAId, 'PROJECT_MANAGER');
    managerDeptAId = mgrA.user.id;
    managerDeptAToken = mgrA.token;

    // Manager Dept B
    const mgrB = await createTestUser('MGR_B', 'ADMIN', deptBId, 'PROJECT_MANAGER');
    managerDeptBId = mgrB.user.id;
    managerDeptBToken = mgrB.token;

    // Employee Dept A
    const emp1 = await createTestUser('EMP1_A', 'EMPLOYEE', deptAId, 'DEVELOPER');
    emp1DeptAId = emp1.user.id;
    emp1DeptAToken = emp1.token;

    // Client user
    const client = await createTestUser('CLI_ST', 'CLIENT', deptAId);
    clientUserId = client.user.id;
    clientToken = client.token;

    // Create primary test task in Dept A
    const taskA = await createTestTaskDirect({
      title: 'Phase 6.3.6 Attachment Storage Test Task',
      createdById: emp1DeptAId,
      assigneeId: emp1DeptAId,
      departmentId: deptAId,
    });
    testTaskId = taskA.id;

    // Create task in Dept B for cross-scope checks
    const taskB = await createTestTaskDirect({
      title: 'Dept B Isolated Task',
      createdById: managerDeptBId,
      assigneeId: managerDeptBId,
      departmentId: deptBId,
    });
    testTaskDeptBId = taskB.id;
  });

  afterAll(async () => {
    // Clean up created tasks and media
    for (const taskId of createdTaskIds) {
      await prisma.mediaAttachment.deleteMany({ where: { entityId: taskId } }).catch(() => {});
      await prisma.taskActivityLog.deleteMany({ where: { taskId } }).catch(() => {});
      await prisma.task.deleteMany({ where: { id: taskId } }).catch(() => {});
    }

    for (const mediaId of createdMediaIds) {
      await prisma.media.deleteMany({ where: { id: mediaId } }).catch(() => {});
    }

    for (const userId of createdUserIds) {
      await prisma.userDepartment.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.userSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }

    if (fs.existsSync(tmpFixturesDir)) {
      await fs.promises.rm(tmpFixturesDir, { recursive: true, force: true }).catch(() => {});
    }

    await app.close();
  });

  // =========================================================================
  // 1. MULTIPART BINARY UPLOAD & LOCAL STORAGE VERIFICATION
  // =========================================================================
  describe('1. Multipart Binary Upload & Local Filesystem Storage', () => {
    let uploadedAttachmentId: string;
    let uploadedMediaId: string;
    const testPngContent = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it('Scenario 1: Real multipart binary upload writes to disk and stores checksumSha256', async () => {
      const fixturePath = path.join(tmpFixturesDir, 'sample_spec.png');
      fs.writeFileSync(fixturePath, testPngContent);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', fixturePath)
        .field('collection', 'deliverables')
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.mediaId).toBeDefined();
      expect(res.body.data.mimeType).toBe('image/png');
      expect(res.body.data.scanStatus).toBe(MediaScanStatus.PENDING); // ClamAV disabled in default test env

      uploadedAttachmentId = res.body.data.id;
      uploadedMediaId = res.body.data.mediaId;
      createdMediaIds.push(uploadedMediaId);

      // Verify database record has SHA-256 and PENDING scanStatus
      const media = await prisma.media.findUniqueOrThrow({
        where: { id: uploadedMediaId },
      });
      expect(media.scanStatus).toBe(MediaScanStatus.PENDING);
      expect(media.checksumSha256).toBeDefined();
      expect(media.checksumSha256).toBe(
        crypto.createHash('sha256').update(testPngContent).digest('hex'),
      );

      // Verify physical storage on local disk
      const physicalFilePath = path.resolve(storageDir, media.storageKey);
      expect(fs.existsSync(physicalFilePath)).toBe(true);
      const diskBytes = fs.readFileSync(physicalFilePath);
      expect(diskBytes.equals(testPngContent)).toBe(true);

      // Verify spool directory has no leftover temp files
      const spoolDir = path.join(storageDir, '.tmp_spool');
      const spoolFiles = fs.readdirSync(spoolDir);
      expect(spoolFiles.length).toBe(0);
    });

    it('Scenario 2: Unscanned attachment (PENDING) is locked from download and preview (423 Locked)', async () => {
      // Download attempt
      const downRes = await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/download`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(423);

      expect(downRes.body.message).toContain('malware scan has not completed');

      // Preview attempt
      const prevRes = await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/preview`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(423);

      expect(prevRes.body.message).toContain('malware scan has not completed');
    });

    it('Scenario 2b: Attachments in SCANNING, FAILED, INFECTED, and QUARANTINED are blocked from download and preview', async () => {
      const nonCleanStatuses = [
        MediaScanStatus.SCANNING,
        MediaScanStatus.FAILED,
        MediaScanStatus.INFECTED,
        MediaScanStatus.QUARANTINED,
      ];

      for (const st of nonCleanStatuses) {
        await prisma.media.update({
          where: { id: uploadedMediaId },
          data: { scanStatus: st },
        });

        const downRes = await request(app.getHttpServer())
          .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/download`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`);

        expect([403, 423]).toContain(downRes.status);

        const prevRes = await request(app.getHttpServer())
          .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/preview`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`);

        expect([403, 423]).toContain(prevRes.status);
      }

      // Reset back to PENDING for subsequent tests
      await prisma.media.update({
        where: { id: uploadedMediaId },
        data: { scanStatus: MediaScanStatus.PENDING },
      });
    });

    it('Scenario 3: Authorized rescan releases file to CLEAN and enables download/preview', async () => {
      // Start a mock ClamAV server that waits for streamed chunks and confirms "stream: OK"
      const mockPort = 33189;
      const mockClamServer = net.createServer((socket) => {
        let streamClosed = false;
        socket.on('data', (chunk) => {
          if (!streamClosed && chunk.includes(Buffer.alloc(4))) {
            streamClosed = true;
            socket.write('stream: OK\0');
            socket.end();
          }
        });
      });
      await new Promise<void>((resolve) => mockClamServer.listen(mockPort, resolve));

      // Temporarily set env to connect to mock ClamAV
      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_PORT = String(mockPort);

      try {
        const rescanRes = await request(app.getHttpServer())
          .post(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/rescan`)
          .set('Authorization', `Bearer ${managerDeptAToken}`)
          .expect(200);

        expect(rescanRes.body.success).toBe(true);
        expect(rescanRes.body.data.scanStatus).toBe(MediaScanStatus.CLEAN);

        // Verify database is now CLEAN
        const media = await prisma.media.findUniqueOrThrow({ where: { id: uploadedMediaId } });
        expect(media.scanStatus).toBe(MediaScanStatus.CLEAN);

        // Now download succeeds (200 OK) with matching bytes and headers
        const downRes = await request(app.getHttpServer())
          .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/download`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .expect(200);

        expect(downRes.headers['content-type']).toBe('image/png');
        expect(downRes.headers['content-disposition']).toContain('attachment');
        expect(downRes.headers['x-content-type-options']).toBe('nosniff');
        expect(downRes.body).toEqual(testPngContent);

        // Now preview succeeds (200 OK) with inline disposition and CSP
        const prevRes = await request(app.getHttpServer())
          .get(`/api/tasks/${testTaskId}/attachments/${uploadedAttachmentId}/preview`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .expect(200);

        expect(prevRes.headers['content-disposition']).toContain('inline');
        expect(prevRes.headers['content-security-policy']).toContain("default-src 'none'");
      } finally {
        process.env.CLAMAV_ENABLED = 'false';
        mockClamServer.close();
      }
    });

    it('Scenario 4: Previewing non-previewable format (.zip) returns 400 Bad Request', async () => {
      // Create and upload a valid zip
      const zipBuffer = buildTestZipBuffer([{ name: 'code.txt', content: 'print(1)' }]);
      const zipFixture = path.join(tmpFixturesDir, 'code.zip');
      fs.writeFileSync(zipFixture, zipBuffer);

      const upRes = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', zipFixture)
        .expect(201);

      const zipAttId = upRes.body.data.id;
      createdMediaIds.push(upRes.body.data.mediaId);

      // Force status to CLEAN directly in DB for testing format check
      await prisma.media.update({
        where: { id: upRes.body.data.mediaId },
        data: { scanStatus: MediaScanStatus.CLEAN },
      });

      const prevRes = await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${zipAttId}/preview`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(400);

      expect(prevRes.body.message).toContain('Inline preview is not supported');
    });
  });

  // =========================================================================
  // 2. SECURITY FILTERS: MAGIC BYTES, PATH TRAVERSAL, SPOOFING & SIZE
  // =========================================================================
  describe('2. Security Filters: Magic Bytes, Path Traversal & Size Limits', () => {
    it('Scenario 5: Spoofed file (EXE renamed to .pdf) is rejected (400 Bad Request)', async () => {
      const fakePdf = path.join(tmpFixturesDir, 'fake.pdf');
      fs.writeFileSync(fakePdf, Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'));

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', fakePdf)
        .expect(400);

      expect(res.body.message).toContain('File signature does not match');
    });

    it('Scenario 6: Path traversal in uploaded filename is rejected (400 Bad Request)', async () => {
      const goodPng = path.join(tmpFixturesDir, 'traversal.png');
      fs.writeFileSync(
        goodPng,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', goodPng)
        .field('originalName', '../../etc/shadow.png')
        .expect(400);

      expect(res.body.message).toContain('path traversal');
    });

    it('Scenario 7: SVG with embedded script is rejected (400 Bad Request)', async () => {
      const badSvg = path.join(tmpFixturesDir, 'xss.svg');
      fs.writeFileSync(badSvg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', badSvg)
        .expect(400);

      expect(res.body.message).toContain('prohibited active scripts');
    });
  });

  // =========================================================================
  // 3. HARDENED ARCHIVE & MACRO VALIDATION
  // =========================================================================
  describe('3. Hardened Archive & Macro Validation (Zero Disk Extraction)', () => {
    it('Scenario 8: ZIP with password protection (encrypted bit) is rejected (400 Bad Request)', async () => {
      const encZipBuf = buildTestZipBuffer([{ name: 'pass.txt', content: '123', gpFlag: 0x0001 }]);
      const encPath = path.join(tmpFixturesDir, 'enc.zip');
      fs.writeFileSync(encPath, encZipBuf);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', encPath)
        .expect(400);

      expect(res.body.message).toContain('encrypted archives are strictly prohibited');
    });

    it('Scenario 9: ZIP containing executable payload is rejected (400 Bad Request)', async () => {
      const exeZipBuf = buildTestZipBuffer([{ name: 'installer/setup.exe', content: 'bin' }]);
      const exePath = path.join(tmpFixturesDir, 'with_exe.zip');
      fs.writeFileSync(exePath, exeZipBuf);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', exePath)
        .expect(400);

      expect(res.body.message).toContain('prohibited executable or macro');
    });

    it('Scenario 10: Word document containing Office macro (vbaProject.bin) is rejected (400 Bad Request)', async () => {
      const macroDocxBuf = buildTestZipBuffer([{ name: 'word/vbaProject.bin', content: 'VBA code' }]);
      const docxPath = path.join(tmpFixturesDir, 'infected.docx');
      fs.writeFileSync(docxPath, macroDocxBuf);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', docxPath, 'report.docx')
        .expect(400);

      expect(res.body.message).toContain('Macro-enabled components detected');
    });

    it('Scenario 11: ZIP bomb with excessive ratio is rejected (400 Bad Request)', async () => {
      const bombBuf = buildTestZipBuffer([
        {
          name: 'bomb.txt',
          content: '0',
          overrideCompressedSize: 500,
          overrideUncompressedSize: 200_000,
        },
      ]);
      const bombPath = path.join(tmpFixturesDir, 'bomb.zip');
      fs.writeFileSync(bombPath, bombBuf);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', bombPath)
        .expect(400);

      expect(res.body.message).toContain('suspicious compression ratio');
    });

    it('Scenario 12: ZIP containing duplicate entries is rejected (400 Bad Request)', async () => {
      const dupBuf = buildTestZipBuffer([
        { name: 'entry.txt', content: 'A' },
        { name: 'entry.txt', content: 'B' },
      ]);
      const dupPath = path.join(tmpFixturesDir, 'dup.zip');
      fs.writeFileSync(dupPath, dupBuf);

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', dupPath)
        .expect(400);

      expect(res.body.message).toContain('duplicate entry');
    });
  });

  // =========================================================================
  // 4. MALWARE DETECTION & SECURE QUARANTINE LIFECYCLE
  // =========================================================================
  describe('4. Malware Detection & Secure Quarantine Lifecycle', () => {
    it('Scenario 13: EICAR malware is quarantined and rejected (422 Unprocessable Entity)', async () => {
      const mockPort = 33191;
      const mockClamServer = net.createServer((socket) => {
        socket.on('data', () => {});
        socket.write('stream: Win.Test.EICAR_HDB-1 FOUND\0');
        socket.end();
      });
      await new Promise<void>((resolve) => mockClamServer.listen(mockPort, resolve));

      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_PORT = String(mockPort);

      try {
        const eicarPdf = path.join(tmpFixturesDir, 'eicar.pdf');
        fs.writeFileSync(eicarPdf, '%PDF-1.4\nEICAR_TEST_PAYLOAD');

        const res = await request(app.getHttpServer())
          .post(`/api/tasks/${testTaskId}/attachments`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .attach('file', eicarPdf)
          .expect(422);

        expect(res.body.message).toContain('malicious content (Win.Test.EICAR_HDB-1)');

        // Verify DB recorded quarantine metadata
        const quarantinedMedia = await prisma.media.findFirst({
          where: { scanStatus: MediaScanStatus.INFECTED },
          orderBy: { createdAt: 'desc' },
        });

        expect(quarantinedMedia).toBeDefined();
        expect(quarantinedMedia!.status).toBe(MediaStatus.INACTIVE);
        expect(quarantinedMedia!.storageKey).toContain('.quarantine');
        createdMediaIds.push(quarantinedMedia!.id);

        // Verify file physically moved to .quarantine/
        const qPath = path.resolve(storageDir, quarantinedMedia!.storageKey);
        expect(fs.existsSync(qPath)).toBe(true);

        // Verify infected attachment is NOT shown in employee attachment listing
        const listRes = await request(app.getHttpServer())
          .get(`/api/tasks/${testTaskId}/attachments`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .expect(200);

        const ids = listRes.body.data.map((a: any) => a.mediaId);
        expect(ids).not.toContain(quarantinedMedia!.id);
      } finally {
        process.env.CLAMAV_ENABLED = 'false';
        mockClamServer.close();
      }
    });

    it('Scenario 14: ClamAV offline when CLAMAV_STRICT=true fails closed (503 Service Unavailable)', async () => {
      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'true';
      process.env.CLAMAV_PORT = '39991'; // closed port

      try {
        const pdfFile = path.join(tmpFixturesDir, 'strict_fail.pdf');
        fs.writeFileSync(pdfFile, '%PDF-1.4\nContent');

        const res = await request(app.getHttpServer())
          .post(`/api/tasks/${testTaskId}/attachments`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .attach('file', pdfFile)
          .expect(503);

        expect(res.body.message).toContain('temporarily unavailable');
      } finally {
        process.env.CLAMAV_ENABLED = 'false';
        process.env.CLAMAV_STRICT = 'false';
      }
    });

    it('Scenario 15: ClamAV offline when CLAMAV_STRICT=false saves file as PENDING (never CLEAN)', async () => {
      process.env.CLAMAV_ENABLED = 'true';
      process.env.CLAMAV_STRICT = 'false';
      process.env.NODE_ENV = 'test';
      process.env.CLAMAV_PORT = '39991'; // closed port

      try {
        const pdfFile = path.join(tmpFixturesDir, 'non_strict.pdf');
        fs.writeFileSync(pdfFile, '%PDF-1.4\nNon-strict content');

        const res = await request(app.getHttpServer())
          .post(`/api/tasks/${testTaskId}/attachments`)
          .set('Authorization', `Bearer ${emp1DeptAToken}`)
          .attach('file', pdfFile)
          .expect(201);

        expect(res.body.data.scanStatus).toBe(MediaScanStatus.PENDING);
        expect(res.body.data.scanStatus).not.toBe(MediaScanStatus.CLEAN);
        createdMediaIds.push(res.body.data.mediaId);
      } finally {
        process.env.CLAMAV_ENABLED = 'false';
      }
    });
  });

  // =========================================================================
  // 5. CONCURRENCY, REVALIDATION & RESCAN RACE CONDITIONS
  // =========================================================================
  describe('5. Concurrency Protection & Rescan State Machine', () => {
    let rescanAttId: string;
    let rescanMediaId: string;

    beforeAll(async () => {
      const pdfFile = path.join(tmpFixturesDir, 'concurrency.pdf');
      fs.writeFileSync(pdfFile, '%PDF-1.4\nConcurrency test content');

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', pdfFile);

      rescanAttId = res.body.data.id;
      rescanMediaId = res.body.data.mediaId;
      createdMediaIds.push(rescanMediaId);
    });

    it('Scenario 16: Two concurrent rescan calls serialize via SCANNING lock -> one returns 409 Conflict', async () => {
      // Set status to SCANNING manually to simulate in-flight scan
      await prisma.media.update({
        where: { id: rescanMediaId },
        data: { scanStatus: MediaScanStatus.SCANNING },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments/${rescanAttId}/rescan`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(409);

      expect(res.body.message).toContain('currently undergoing a scan');

      // Reset to PENDING
      await prisma.media.update({
        where: { id: rescanMediaId },
        data: { scanStatus: MediaScanStatus.PENDING },
      });
    });

    it('Scenario 17: Rescan fails with 400 Bad Request if file on disk was tampered with (SHA-256 mismatch)', async () => {
      const media = await prisma.media.findUniqueOrThrow({ where: { id: rescanMediaId } });
      const physicalPath = path.resolve(storageDir, media.storageKey);

      // Tamper with physical file
      fs.appendFileSync(physicalPath, '\nTAMPERED_BYTES');

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments/${rescanAttId}/rescan`)
        .set('Authorization', `Bearer ${managerDeptAToken}`)
        .expect(400);

      expect(res.body.message).toContain('File integrity verification failed');

      const updated = await prisma.media.findUniqueOrThrow({ where: { id: rescanMediaId } });
      expect(updated.scanStatus).toBe(MediaScanStatus.FAILED);
      expect(updated.status).toBe(MediaStatus.INACTIVE);
    });

    it('Scenario 18: Regular employee without tasks.approve/review cannot trigger rescan (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments/${rescanAttId}/rescan`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(403);
    });
  });

  // =========================================================================
  // 6. ACCESS SCOPE & CLIENT ISOLATION
  // =========================================================================
  describe('6. Access Scopes & Client Isolation', () => {
    let cleanAttId: string;

    beforeAll(async () => {
      const pdfFile = path.join(tmpFixturesDir, 'scope_test.pdf');
      fs.writeFileSync(pdfFile, '%PDF-1.4\nScope test');

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', pdfFile);

      cleanAttId = res.body.data.id;
      createdMediaIds.push(res.body.data.mediaId);

      await prisma.media.update({
        where: { id: res.body.data.mediaId },
        data: { scanStatus: MediaScanStatus.CLEAN },
      });
    });

    it('Scenario 19: CLIENT users are rejected with 403 Forbidden across all attachment endpoints', async () => {
      // Upload
      await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ originalName: 'doc.pdf', mimeType: 'application/pdf', fileSizeBytes: 100 })
        .expect(403);

      // List
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      // Download
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${cleanAttId}/download`)
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      // Preview
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${cleanAttId}/preview`)
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);

      // Delete
      await request(app.getHttpServer())
        .delete(`/api/tasks/${testTaskId}/attachments/${cleanAttId}`)
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });

    it('Scenario 20: Cross-task IDOR - Requesting attachment of Task A via Task B URL returns 404 Not Found', async () => {
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskDeptBId}/attachments/${cleanAttId}/download`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(404);
    });

    it('Scenario 21: Department isolation - Manager in Dept B cannot download attachment from Dept A task (404 Not Found)', async () => {
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${cleanAttId}/download`)
        .set('Authorization', `Bearer ${managerDeptBToken}`)
        .expect(404);
    });
  });

  // =========================================================================
  // 7. SOFT DELETION & STORAGE RECONCILIATION
  // =========================================================================
  describe('7. Soft Deletion & Crash Recovery Reconciliation', () => {
    let delAttId: string;
    let delMediaId: string;

    beforeAll(async () => {
      const pdfFile = path.join(tmpFixturesDir, 'delete_test.pdf');
      fs.writeFileSync(pdfFile, '%PDF-1.4\nDelete test content');

      const res = await request(app.getHttpServer())
        .post(`/api/tasks/${testTaskId}/attachments`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .attach('file', pdfFile);

      delAttId = res.body.data.id;
      delMediaId = res.body.data.mediaId;
      createdMediaIds.push(delMediaId);

      await prisma.media.update({
        where: { id: delMediaId },
        data: { scanStatus: MediaScanStatus.CLEAN },
      });
    });

    it('Scenario 22: Attachment author deletes attachment -> soft deleted and blocked from download (404 Not Found)', async () => {
      await request(app.getHttpServer())
        .delete(`/api/tasks/${testTaskId}/attachments/${delAttId}`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(200);

      // Verify DB record
      const media = await prisma.media.findUniqueOrThrow({ where: { id: delMediaId } });
      expect(media.deletedAt).not.toBeNull();
      expect(media.status).toBe(MediaStatus.INACTIVE);

      // Subsequent download returns 404
      await request(app.getHttpServer())
        .get(`/api/tasks/${testTaskId}/attachments/${delAttId}/download`)
        .set('Authorization', `Bearer ${emp1DeptAToken}`)
        .expect(404);
    });

    it('Scenario 23: Reconciliation worker sweeps missing physical files and marks DB INACTIVE', async () => {
      // Create a test media entry pointing to a non-existent physical file
      const ghostMedia = await prisma.media.create({
        data: {
          originalName: 'ghost.pdf',
          storedName: 'ghost_file.pdf',
          storageKey: 'tasks/non_existent_folder/ghost.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 100n,
          mediaType: 'DOCUMENT',
          status: MediaStatus.ACTIVE,
          scanStatus: MediaScanStatus.CLEAN,
        },
      });
      createdMediaIds.push(ghostMedia.id);

      const reconResult = await reconciliationService.reconcileStorage();
      expect(reconResult.markedInactiveMissingCount).toBeGreaterThanOrEqual(1);

      const updatedGhost = await prisma.media.findUniqueOrThrow({ where: { id: ghostMedia.id } });
      expect(updatedGhost.status).toBe(MediaStatus.INACTIVE);
      expect(updatedGhost.scanDetails).toContain('Physical file missing during reconciliation');
    });

    it('Scenario 24: Reconciliation worker moves orphaned storage files (>24h) to .unreconciled/', async () => {
      const taskFolder = path.join(storageDir, 'tasks', 'recon_orphan_task');
      fs.mkdirSync(taskFolder, { recursive: true });
      const orphanFile = path.join(taskFolder, 'untracked_binary.dat');
      fs.writeFileSync(orphanFile, 'Untracked binary data');

      // Set mtime to 48 hours ago
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(orphanFile, twoDaysAgo, twoDaysAgo);

      const reconResult = await reconciliationService.reconcileStorage();
      expect(reconResult.quarantinedOrphansCount).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(orphanFile)).toBe(false);

      const dateStr = new Date().toISOString().split('T')[0];
      const movedFile = path.join(
        storageDir,
        '.unreconciled',
        dateStr,
        'recon_orphan_task_untracked_binary.dat',
      );
      expect(fs.existsSync(movedFile)).toBe(true);
    });
  });
});
