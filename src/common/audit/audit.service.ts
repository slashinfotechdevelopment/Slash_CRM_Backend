import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction } from '../../generated/prisma/enums';

const SENSITIVE_KEYS = new Set([
  'otp',
  'otphash',
  'password',
  'jwt',
  'token',
  'refreshtoken',
  'refreshtokenhash',
  'secret',
  'authorization',
  'cookie',
  'smtppassword',
]);

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deeply sanitizes an object to remove sensitive keys (passwords, tokens, OTPs, etc.)
   */
  sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeData(item));
    }

    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower) || lower.includes('token') || lower.includes('password') || lower.includes('otp')) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Records an audit log entry.
   */
  async logAudit(params: {
    actorUserId?: string | null;
    action: AuditAction;
    module: string;
    entityType: string;
    entityId?: string | null;
    oldValues?: any;
    newValues?: any;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: params.actorUserId || null,
          action: params.action,
          module: params.module,
          entityType: params.entityType,
          entityId: params.entityId || null,
          oldValues: params.oldValues ? this.sanitizeData(params.oldValues) : undefined,
          newValues: params.newValues ? this.sanitizeData(params.newValues) : undefined,
          ipAddress: params.ipAddress || null,
          userAgent: params.userAgent?.substring(0, 500) || null,
          requestId: params.requestId || null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Records an activity log entry.
   */
  async logActivity(params: {
    actorUserId?: string | null;
    action: string;
    module: string;
    entityType?: string | null;
    entityId?: string | null;
    description: string;
    metadata?: any;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.activityLog.create({
        data: {
          actorUserId: params.actorUserId || null,
          action: params.action,
          module: params.module,
          entityType: params.entityType || null,
          entityId: params.entityId || null,
          description: params.description.substring(0, 500),
          metadata: params.metadata ? this.sanitizeData(params.metadata) : undefined,
          ipAddress: params.ipAddress || null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write activity log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

