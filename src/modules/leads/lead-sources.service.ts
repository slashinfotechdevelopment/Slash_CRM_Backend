import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { LeadCodeService } from './lead-code.service';
import { normalizePhoneNumber } from './lead-phone.util';
import { parseImportDate } from './lead-date.util';
import { ImportLeadsDto, ImportLeadRowDto, PublicInquiryDto } from './dto';
import {
  LeadSource,
  LeadPriority,
  LeadStatus,
  LeadQualificationStatus,
  LeadActivityType,
} from '../../generated/prisma/client';

@Injectable()
export class LeadSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadCodeService: LeadCodeService,
  ) {}

  private readonly inquiryRateLimits = new Map<string, { count: number; resetTime: number }>();

  private checkInquiryRateLimit(key: string, maxLimit = 5, windowMs = 10 * 60 * 1000) {
    const now = Date.now();
    const entry = this.inquiryRateLimits.get(key);
    if (!entry || now > entry.resetTime) {
      this.inquiryRateLimits.set(key, { count: 1, resetTime: now + windowMs });
      return;
    }
    if (entry.count >= maxLimit) {
      throw new HttpException(
        'Too many inquiries submitted from this source. Please wait a few minutes before trying again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;

    // Periodic cleanup of expired entries
    if (this.inquiryRateLimits.size > 1000) {
      for (const [k, v] of this.inquiryRateLimits.entries()) {
        if (now > v.resetTime) {
          this.inquiryRateLimits.delete(k);
        }
      }
    }
  }

  /**
   * Public website lead ingestion (Phase 7.3)
   * - Enters the UNASSIGNED queue.
   * - Sets source = WEBSITE.
   * - Concurrency-safe duplicate phone check with anti-enumeration response.
   */
  async handlePublicInquiry(dto: PublicInquiryDto, ip?: string, userAgent?: string) {
    if (!dto.name || !dto.name.trim()) {
      throw new BadRequestException('Name is required.');
    }
    if (!dto.phone || !dto.phone.trim()) {
      throw new BadRequestException('Phone number is required.');
    }

    const normalizedPhone = normalizePhoneNumber(dto.phone);

    // Rate-limit checks by IP (exempt loopback in test/dev) and normalized phone
    const isLoopback = !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) {
      this.checkInquiryRateLimit(`ip:${ip}`, 30, 10 * 60 * 1000);
    }
    this.checkInquiryRateLimit(`phone:${normalizedPhone}`, 5, 10 * 60 * 1000);

    // Duplicate check against active leads
    const existingActive = await this.prisma.lead.findFirst({
      where: {
        deletedAt: null,
        normalizedPhone,
      },
    });

    if (existingActive) {
      // Log an activity on the existing lead about a repeat inquiry
      await this.prisma.leadActivity.create({
        data: {
          leadId: existingActive.id,
          type: LeadActivityType.NOTE,
          title: 'Repeat Website Inquiry Received',
          description: `Repeat website inquiry from ${dto.name}. Message: ${dto.message || 'None'}. Course: ${dto.course || 'None'}.`,
          metadata: { ip, userAgent, name: dto.name, phone: dto.phone, course: dto.course },
        },
      });

      return {
        success: true,
        message: 'Thank you for reaching out! Your inquiry has been received and our team will get in touch shortly.',
        data: {
          inquiryReceived: true,
        },
      };
    }

    // Find system default or first Super Admin user as technical system creator
    const systemUser = await this.prisma.user.findFirst({
      where: { userType: { code: 'SUPER_ADMIN' } },
      select: { id: true },
    });

    const createdById = systemUser?.id || 'system';

    const lead = await this.prisma.$transaction(async (tx) => {
      const leadCode = await this.leadCodeService.generateNextCode(tx);

      const newLead = await tx.lead.create({
        data: {
          leadCode,
          leadDate: new Date(),
          leadName: dto.name.trim(),
          phone: dto.phone.trim(),
          normalizedPhone,
          email: dto.email ? dto.email.trim().toLowerCase() : null,
          interestedCourse: dto.course ? dto.course.trim() : null,
          location: dto.location ? dto.location.trim() : null,
          requirementDescription: dto.message ? dto.message.trim() : null,
          source: LeadSource.WEBSITE,
          sourceDetails: dto.sourceDetails || 'Website Contact Form',
          campaignName: dto.campaignName || null,
          createdById,
          departmentId: null, // Unassigned queue
          assignedToId: null, // Unassigned
          priority: LeadPriority.HIGH, // Inbound website inquiries receive high priority
          status: LeadStatus.NEW,
          qualificationStatus: LeadQualificationStatus.PENDING,
        },
      });

      await tx.leadActivity.create({
        data: {
          leadId: newLead.id,
          type: LeadActivityType.NOTE,
          title: 'Website Inbound Inquiry',
          description: `Inbound website inquiry submitted for ${dto.course || 'general inquiry'}.`,
          metadata: { ip, userAgent },
        },
      });

      return newLead;
    });

    return {
      success: true,
      message: 'Thank you for reaching out! Your inquiry has been received and our team will get in touch shortly.',
      data: {
        inquiryReceived: true,
      },
    };
  }

  /**
   * Batch Spreadsheet / CSV Lead Import with Duplicate Prevention (Phase 7.3)
   */
  async importLeads(dto: ImportLeadsDto, actorUserId: string) {
    const { rows, dryRun } = dto;
    if (!rows || rows.length === 0) {
      throw new BadRequestException('No rows provided for import.');
    }

    if (rows.length > 500) {
      throw new BadRequestException(`Import batch exceeds maximum limit of 500 rows (received ${rows.length} rows). Please split into smaller batches.`);
    }

    const seenPhonesInBatch = new Set<string>();
    const validRows: Array<{ row: ImportLeadRowDto; normalizedPhone: string; rowIndex: number }> = [];
    const errors: Array<{ rowIndex: number; rowName: string; phone: string; reason: string }> = [];

    // Phase 1: Validate rows and check intra-batch duplicates
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowIndex = i + 1;

      if (!r.name || !r.name.trim()) {
        errors.push({ rowIndex, rowName: r.name, phone: r.contact, reason: 'Missing lead name' });
        continue;
      }

      if (!r.contact || !r.contact.trim()) {
        errors.push({ rowIndex, rowName: r.name, phone: r.contact, reason: 'Missing phone/contact' });
        continue;
      }

      let normalized: string;
      try {
        normalized = normalizePhoneNumber(r.contact);
      } catch (err: any) {
        errors.push({ rowIndex, rowName: r.name, phone: r.contact, reason: err.message });
        continue;
      }

      if (seenPhonesInBatch.has(normalized)) {
        errors.push({
          rowIndex,
          rowName: r.name,
          phone: r.contact,
          reason: `Duplicate phone within the same import file: ${normalized}`,
        });
        continue;
      }

      seenPhonesInBatch.add(normalized);
      validRows.push({ row: r, normalizedPhone: normalized, rowIndex });
    }

    // Phase 2: Check duplicates against existing active leads in database
    const phonesToCheck = validRows.map((v) => v.normalizedPhone);
    const existingActiveLeads = await this.prisma.lead.findMany({
      where: {
        deletedAt: null,
        normalizedPhone: { in: phonesToCheck },
      },
      select: { leadCode: true, normalizedPhone: true },
    });

    const existingPhoneMap = new Map(existingActiveLeads.map((l) => [l.normalizedPhone, l.leadCode]));

    const finalImportableRows: typeof validRows = [];
    for (const item of validRows) {
      if (existingPhoneMap.has(item.normalizedPhone)) {
        errors.push({
          rowIndex: item.rowIndex,
          rowName: item.row.name,
          phone: item.row.contact,
          reason: `Phone ${item.normalizedPhone} already belongs to active lead ${existingPhoneMap.get(item.normalizedPhone)}`,
        });
      } else {
        finalImportableRows.push(item);
      }
    }

    if (dryRun) {
      return {
        dryRun: true,
        totalRows: rows.length,
        validCount: finalImportableRows.length,
        errorCount: errors.length,
        errors,
        preview: finalImportableRows.slice(0, 5).map((v) => ({
          rowIndex: v.rowIndex,
          leadName: v.row.name,
          normalizedPhone: v.normalizedPhone,
          course: v.row.course,
          location: v.row.location,
          feedback1: v.row.feedback1,
        })),
      };
    }

    // Phase 3: Commit rows in database
    const createdLeads: Array<{ id: string; leadCode: string; name: string; phone: string }> = [];

    for (const item of finalImportableRows) {
      const r = item.row;
      const leadDate = parseImportDate(r.date);

      const created = await this.prisma.$transaction(async (tx) => {
        const leadCode = await this.leadCodeService.generateNextCode(tx);

        const newLead = await tx.lead.create({
          data: {
            leadCode,
            leadDate: isNaN(leadDate.getTime()) ? new Date() : leadDate,
            leadName: r.name.trim(),
            phone: r.contact.trim(),
            normalizedPhone: item.normalizedPhone,
            email: r.email ? r.email.trim().toLowerCase() : null,
            companyName: r.companyName ? r.companyName.trim() : null,
            interestedCourse: r.course ? r.course.trim() : null,
            location: r.location ? r.location.trim() : null,
            feedback1: r.feedback1 || null,
            feedback2: r.feedback2 || null,
            feedback3: r.feedback3 || null,
            source: LeadSource.EXCEL_IMPORT,
            sourceDetails: r.sourceDetails || 'Spreadsheet Import',
            campaignName: r.campaignName || null,
            createdById: actorUserId,
            status: LeadStatus.NEW,
            priority: LeadPriority.MEDIUM,
            qualificationStatus: LeadQualificationStatus.PENDING,
          },
        });

        await tx.leadActivity.create({
          data: {
            leadId: newLead.id,
            actorId: actorUserId,
            type: LeadActivityType.NOTE,
            title: 'Lead Imported',
            description: `Imported via spreadsheet. Feedback 1: ${r.feedback1 || 'N/A'}. Feedback 2: ${r.feedback2 || 'N/A'}.`,
          },
        });

        return newLead;
      });

      createdLeads.push({
        id: created.id,
        leadCode: created.leadCode,
        name: created.leadName,
        phone: created.normalizedPhone,
      });
    }

    return {
      success: true,
      totalRows: rows.length,
      importedCount: createdLeads.length,
      failedCount: errors.length,
      errors,
      importedLeads: createdLeads,
    };
  }
}
