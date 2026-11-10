import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { SessionStatus } from '../src/generated/prisma/enums';

describe('Lead Management Subsystem E2E Tests (Phases 7.1 - 7.4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let superAdminToken: string;
  let adminToken: string;
  let salesToken: string;
  let clientToken: string;

  let salesUserId: string;
  let adminUserId: string;
  const createdLeadIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    async function generateToken(userCode: string) {
      const user = await prisma.user.findFirstOrThrow({
        where: { userCode },
        include: { userType: true, userRoles: { include: { role: true } } },
      });

      const session = await prisma.userSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: `leads_test_${Date.now()}_${Math.random()}`,
          status: SessionStatus.ACTIVE,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      createdSessionIds.push(session.id);

      const token = await jwtService.signAsync(
        {
          sub: user.id,
          email: user.email,
          userCode: user.userCode,
          userType: user.userType.code,
          roles: user.userRoles.map((r) => r.role.code),
          sessionId: session.id,
        },
        {
          secret: process.env.JWT_SECRET || 'slash@202612354',
          expiresIn: '1h',
        },
      );
      return { token, user };
    }

    const sa = await generateToken('SA001');
    superAdminToken = sa.token;

    const adm = await generateToken('A001');
    adminToken = adm.token;
    adminUserId = adm.user.id;

    const sls = await generateToken('EMP040'); // Sales Executive
    salesToken = sls.token;
    salesUserId = sls.user.id;

    const cli = await generateToken('CLI001'); // Client
    clientToken = cli.token;
  });

  afterAll(async () => {
    // Clean up created test leads and related activities/follow-ups
    if (createdLeadIds.length > 0) {
      await prisma.leadActivity.deleteMany({
        where: { leadId: { in: createdLeadIds } },
      });
      await prisma.leadFollowUp.deleteMany({
        where: { leadId: { in: createdLeadIds } },
      });
      await prisma.lead.deleteMany({
        where: { id: { in: createdLeadIds } },
      });
    }

    if (createdSessionIds.length > 0) {
      await prisma.userSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }

    await app.close();
  });

  // =========================================================================
  // 1. CORE CRUD, VALIDATION & DUPLICATE PREVENTION (PHASE 7.1)
  // =========================================================================
  describe('Phase 7.1: Core CRUD & Validation', () => {
    const testPhone = '9876000001';
    let lead1Id: string;
    let lead1Code: string;

    it('should create lead with normalized phone, leadDate, and independent feedback fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadDate: '2026-11-10T10:00:00.000Z',
          leadName: 'Amitabh Sen',
          phone: '+91 98760 00001',
          alternatePhone: '09876000002',
          email: 'amitabh.sen@example.com',
          companyName: 'Sen Infotech',
          interestedCourse: 'Executive AI Masterclass',
          location: 'Kolkata',
          estimatedValue: 250000.0,
          feedback1: 'Interested in on-premise training',
          feedback2: 'Needs approval from VP of Engineering',
          feedback3: 'Decision expected within two weeks',
          priority: 'HIGH',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.leadCode).toMatch(/^LEAD\d{3,}$/);
      expect(res.body.data.leadName).toBe('Amitabh Sen');
      expect(res.body.data.normalizedPhone).toBe('+919876000001');
      expect(res.body.data.feedback1).toBe('Interested in on-premise training');
      expect(res.body.data.feedback2).toBe('Needs approval from VP of Engineering');
      expect(res.body.data.feedback3).toBe('Decision expected within two weeks');
      expect(res.body.data.status).toBe('NEW');
      expect(res.body.data.qualificationStatus).toBe('PENDING');

      lead1Id = res.body.data.id;
      lead1Code = res.body.data.leadCode;
      createdLeadIds.push(lead1Id);
    });

    it('should reject creation when required leadName is missing (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ phone: '9876000005' })
        .expect(400);
    });

    it('should reject creation when phone is missing (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ leadName: 'Incomplete Lead' })
        .expect(400);
    });

    it('should reject invalid phone format (400)', async () => {
      await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Invalid Phone Lead',
          phone: '12345',
        })
        .expect(400);
    });

    it('should reject duplicate active phone number (409 Conflict)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Duplicate Person',
          phone: '+919876000001',
        })
        .expect(409);

      expect(res.body.message).toContain('already exists');
    });

    it('should reject duplicate phone entered with different domestic formatting (098760-00001) (409)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Duplicate With Domestic Trunk',
          phone: '098760-00001',
        })
        .expect(409);

      expect(res.body.message).toContain('already exists');
    });

    it('should handle concurrency: parallel creation with same phone results in exactly 1 success and 1 conflict', async () => {
      const uniquePhone = `987${Date.now().toString().slice(-7)}`;
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/leads')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ leadName: 'Parallel Lead 1', phone: uniquePhone }),
        request(app.getHttpServer())
          .post('/api/leads')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ leadName: 'Parallel Lead 2', phone: uniquePhone }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const successBody = res1.status === 201 ? res1.body : res2.body;
      createdLeadIds.push(successBody.data.id);
    });

    it('should handle code generation concurrency: multiple parallel creates receive unique sequential codes', async () => {
      const requests = Array.from({ length: 5 }, (_, i) =>
        request(app.getHttpServer())
          .post('/api/leads')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            leadName: `Concurrent Lead ${i}`,
            phone: `987600010${i}`,
          }),
      );

      const responses = await Promise.all(requests);
      responses.forEach((res) => expect(res.status).toBe(201));

      const codes = responses.map((r) => r.body.data.leadCode);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(5);

      responses.forEach((r) => createdLeadIds.push(r.body.data.id));
    });

    it('should retrieve single lead by ID via /api/leads/:id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/leads/${lead1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(lead1Id);
      expect(res.body.data.leadCode).toBe(lead1Code);
      expect(res.body.data.feedback1).toBe('Interested in on-premise training');
    });

    it('should update lead fields and protect immutable fields (leadCode, createdById)', async () => {
      // 1. Injection attempt of system fields must be rejected with 400 Bad Request
      const tamperRes = await request(app.getHttpServer())
        .put(`/api/leads/${lead1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Amitabh Sen - Updated',
          leadCode: 'HACKED001',
          createdById: 'hacked_user_id',
        })
        .expect(400);

      expect(JSON.stringify(tamperRes.body)).toContain('property leadCode should not exist');

      // 2. Legitimate update succeeds with 200 OK
      const res = await request(app.getHttpServer())
        .put(`/api/leads/${lead1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Amitabh Sen - Updated',
          feedback3: 'Executive committee agreed on budget',
          estimatedValue: 300000.0,
        })
        .expect(200);

      expect(res.body.data.leadName).toBe('Amitabh Sen - Updated');
      expect(res.body.data.feedback3).toBe('Executive committee agreed on budget');
      expect(res.body.data.leadCode).toBe(lead1Code); // Unchanged
    });

    it('should soft-delete lead via DELETE /api/leads/:id and exclude from list', async () => {
      await request(app.getHttpServer())
        .delete(`/api/leads/${lead1Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // Verify excluded from ordinary list
      const listRes = await request(app.getHttpServer())
        .get('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const found = listRes.body.data.items.some((l: any) => l.id === lead1Id);
      expect(found).toBe(false);
    });

    it('should allow creating a new active lead with the same phone once previous is soft-deleted', async () => {
      // Soft-deleted lead holds testPhone. A new active lead can now register it!
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'New Replacement Lead',
          phone: testPhone,
        })
        .expect(201);

      expect(res.body.data.normalizedPhone).toBe('+919876000001');
      createdLeadIds.push(res.body.data.id);
    });

    it('should BLOCK restoring the soft-deleted lead when an active duplicate now exists (409)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/leads/${lead1Id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      expect(res.body.message).toContain('already exists with normalized phone');
    });
  });

  // =========================================================================
  // 2. DATA-SCOPE ISOLATION (PHASE 7.1 / 7.2)
  // =========================================================================
  describe('Data Scope Isolation (SALES vs ADMIN vs CLIENT)', () => {
    let salesLeadId: string;
    let adminLeadId: string;

    beforeAll(async () => {
      // Lead created by SALES rep
      const res1 = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${salesToken}`)
        .send({
          leadName: 'Sales Rep Lead',
          phone: '9876000201',
        })
        .expect(201);
      salesLeadId = res1.body.data.id;
      createdLeadIds.push(salesLeadId);

      // Lead created by ADMIN and assigned to ADMIN
      const res2 = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Admin Private Lead',
          phone: '9876000202',
          assignedToId: adminUserId,
        })
        .expect(201);
      adminLeadId = res2.body.data.id;
      createdLeadIds.push(adminLeadId);
    });

    it('SALES user should only see leads created by or assigned to them (OWN scope)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/leads')
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(200);

      const items = res.body.data.items;
      const seesOwn = items.some((l: any) => l.id === salesLeadId);
      const seesAdminLead = items.some((l: any) => l.id === adminLeadId);

      expect(seesOwn).toBe(true);
      expect(seesAdminLead).toBe(false);
    });

    it('ADMIN user should see all active leads across company (ALL scope)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const items = res.body.data.items;
      const seesSalesLead = items.some((l: any) => l.id === salesLeadId);
      const seesAdminLead = items.some((l: any) => l.id === adminLeadId);

      expect(seesSalesLead).toBe(true);
      expect(seesAdminLead).toBe(true);
    });

    it('CLIENT should be completely forbidden from accessing leads (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/leads')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });
  });

  // =========================================================================
  // 3. ASSIGNMENT, TIMELINE & FOLLOW-UPS (PHASE 7.2)
  // =========================================================================
  describe('Phase 7.2: Assignment, Activities & Follow-ups', () => {
    let targetLeadId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Lifecycle Test Lead',
          phone: '9876000301',
        })
        .expect(201);
      targetLeadId = res.body.data.id;
      createdLeadIds.push(targetLeadId);
    });

    it('should assign lead to sales rep via POST /api/leads/:id/assign', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/leads/${targetLeadId}/assign`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          assignedToId: salesUserId,
          note: 'Assigned to senior sales consultant',
        })
        .expect(200);

      expect(res.body.data.assignedToId).toBe(salesUserId);
      expect(res.body.data.assignedTo.name).toBeTruthy();
    });

    it('should log a manual call activity and record timeline entry', async () => {
      await request(app.getHttpServer())
        .post(`/api/leads/${targetLeadId}/activities`)
        .set('Authorization', `Bearer ${salesToken}`)
        .send({
          type: 'CALL',
          title: 'Introductory Discovery Call',
          description: 'Spoke with CTO for 25 minutes. Deep dive scheduled.',
        })
        .expect(201);

      const timelineRes = await request(app.getHttpServer())
        .get(`/api/leads/${targetLeadId}/timeline`)
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(200);

      expect(timelineRes.body.data.activities.length).toBeGreaterThanOrEqual(2);
      const callAct = timelineRes.body.data.activities.find((a: any) => a.type === 'CALL');
      expect(callAct).toBeDefined();
      expect(callAct.title).toBe('Introductory Discovery Call');
    });

    it('should schedule and complete a follow-up reminder', async () => {
      const scheduledDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const createRes = await request(app.getHttpServer())
        .post(`/api/leads/${targetLeadId}/follow-ups`)
        .set('Authorization', `Bearer ${salesToken}`)
        .send({
          scheduledAt: scheduledDate,
          note: 'Send proposal deck and pricing sheet',
        })
        .expect(201);

      const followUpId = createRes.body.data.id;
      expect(createRes.body.data.status).toBe('PENDING');

      // Complete follow-up
      const completeRes = await request(app.getHttpServer())
        .put(`/api/leads/follow-ups/${followUpId}`)
        .set('Authorization', `Bearer ${salesToken}`)
        .send({
          status: 'COMPLETED',
          note: 'Proposal sent via email',
        })
        .expect(200);

      expect(completeRes.body.data.status).toBe('COMPLETED');
    });
  });

  // =========================================================================
  // 4. SOURCES: PUBLIC INTAKE & IMPORT (PHASE 7.3)
  // =========================================================================
  describe('Phase 7.3: Lead Sources & Import', () => {
    it('should accept public website inquiry without auth and enter unassigned queue', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads/public/inquire')
        .send({
          name: 'Pooja Bhatt',
          phone: '9876000401',
          email: 'pooja.bhatt@example.com',
          course: 'Full Stack Engineering',
          location: 'Pune',
          message: 'Interested in weekend batches',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.inquiryReceived).toBe(true);

      // Verify in DB that it is unassigned and source = WEBSITE
      const lead = await prisma.lead.findFirst({
        where: { normalizedPhone: '+919876000401' },
      });
      expect(lead).toBeDefined();
      expect(lead!.source).toBe('WEBSITE');
      expect(lead!.assignedToId).toBeNull(); // Unassigned queue
      createdLeadIds.push(lead!.id);
    });

    it('should perform dry-run spreadsheet import and preview rows without persisting', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads/import')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          dryRun: true,
          rows: [
            {
              date: '2026-11-01',
              name: 'Import Person 1',
              contact: '9876000501',
              course: 'DevOps',
              feedback1: 'High potential',
            },
            {
              date: '2026-11-02',
              name: 'Import Person 2',
              contact: '9876000502',
              course: 'Data Science',
              feedback1: 'Requested brochure',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.dryRun).toBe(true);
      expect(res.body.data.validCount).toBe(2);
      expect(res.body.data.errorCount).toBe(0);

      // Verify neither was created in database during dryRun
      const count = await prisma.lead.count({
        where: { normalizedPhone: { in: ['+919876000501', '+919876000502'] } },
      });
      expect(count).toBe(0);
    });

    it('should batch-import rows, preserve feedback fields, and report row-level errors', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads/import')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          dryRun: false,
          rows: [
            {
              date: '2026-11-01',
              name: 'Import Actual 1',
              contact: '9876000601',
              course: 'DevOps',
              feedback1: 'Wants cloud certification',
              feedback2: 'Has 3 years experience',
              feedback3: 'Starting next month',
            },
            {
              date: '2026-11-02',
              name: 'Invalid Phone Row',
              contact: '12345', // Invalid
            },
          ],
        })
        .expect(201);

      expect(res.body.data.importedCount).toBe(1);
      expect(res.body.data.failedCount).toBe(1);

      const created = await prisma.lead.findFirst({
        where: { normalizedPhone: '+919876000601' },
      });
      expect(created).toBeDefined();
      expect(created!.feedback1).toBe('Wants cloud certification');
      expect(created!.feedback2).toBe('Has 3 years experience');
      expect(created!.feedback3).toBe('Starting next month');
      createdLeadIds.push(created!.id);
    });
  });

  // =========================================================================
  // 5. PIPELINE, QUALIFICATION, CONVERSION & METRICS (PHASE 7.4)
  // =========================================================================
  describe('Phase 7.4: Pipeline, Qualification, Conversion & Metrics', () => {
    let conversionLeadId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          leadName: 'Conversion Candidate',
          phone: '9876000701',
          estimatedValue: 500000.0,
        })
        .expect(201);
      conversionLeadId = res.body.data.id;
      createdLeadIds.push(conversionLeadId);
    });

    it('should qualify lead via POST /api/leads/:id/qualify', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/leads/${conversionLeadId}/qualify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          qualificationStatus: 'QUALIFIED',
          note: 'Passed technical and budget qualification',
        })
        .expect(200);

      expect(res.body.data.qualificationStatus).toBe('QUALIFIED');
      expect(res.body.data.status).toBe('QUALIFIED');
    });

    it('should convert lead via POST /api/leads/:id/convert without auto-creating customer', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/leads/${conversionLeadId}/convert`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          note: 'Client agreed to terms. Account manager will set up credentials.',
        })
        .expect(200);

      expect(res.body.data.status).toBe('CONVERTED');
      expect(res.body.data.convertedAt).toBeDefined();
      expect(res.body.data.convertedById).toBe(adminUserId);
    });

    it('should block repeat conversion on an already-converted lead (400)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/leads/${conversionLeadId}/convert`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Repeat conversion' })
        .expect(400);

      expect(res.body.message).toContain('already converted');
    });

    it('should retrieve dashboard metrics summary via GET /api/leads/metrics/summary', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/leads/metrics/summary')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.totalActive).toBeGreaterThanOrEqual(1);
      expect(res.body.data.statusCounts.converted).toBeGreaterThanOrEqual(1);
    });

    it('should retrieve pipeline stages and counts via GET /api/leads/pipeline/stages', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/leads/pipeline/stages')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(6); // 6 default stages
    });

    it('should export leads to CSV via GET /api/leads/export', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/leads/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.header['content-type']).toContain('text/csv');
      expect(res.text).toContain('Lead Code,Lead Date,Lead Name,Phone');
    });
  });
});

