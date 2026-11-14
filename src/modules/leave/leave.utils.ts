import { BadRequestException } from '@nestjs/common';
import { WorkCalendarScope } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';

/**
 * Normalizes any valid calendar date string (YYYY-MM-DD) or Date object
 * to UTC midnight Date (YYYY-MM-DDT00:00:00.000Z).
 */
export function parseDateOnly(dateInput: string | Date): Date {
  if (dateInput instanceof Date) {
    if (isNaN(dateInput.getTime())) {
      throw new BadRequestException('Invalid Date instance provided');
    }
    const year = dateInput.getUTCFullYear();
    const month = String(dateInput.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dateInput.getUTCDate()).padStart(2, '0');
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }

  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) {
      throw new BadRequestException(
        `Invalid calendar date format "${dateInput}". Expected YYYY-MM-DD.`,
      );
    }
    const [_, yearStr, monthStr, dayStr] = match;
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new BadRequestException(
        `Invalid calendar date values in "${dateInput}".`,
      );
    }

    const d = new Date(`${yearStr}-${monthStr}-${dayStr}T00:00:00.000Z`);
    if (isNaN(d.getTime())) {
      throw new BadRequestException(`Malformed date: "${dateInput}".`);
    }
    return d;
  }

  throw new BadRequestException('Invalid date input: must be string or Date');
}

/**
 * Formats a Date object to YYYY-MM-DD string.
 */
export function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generates array of YYYY-MM-DD date strings between start and end inclusive.
 */
export function getDatesInRange(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  const current = new Date(startDate.getTime());
  while (current.getTime() <= endDate.getTime()) {
    dates.push(formatDateOnly(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Deterministic scope key builder for holidays and weekly-offs.
 * Eliminates MySQL NULL composite index collisions.
 */
export function computeScopeKey(
  scopeType: WorkCalendarScope,
  departmentId?: string | null,
  location?: string | null,
  userId?: string | null,
): { scopeKey: string; scopeValue: string } {
  switch (scopeType) {
    case WorkCalendarScope.DEPARTMENT:
      if (!departmentId) {
        throw new BadRequestException('departmentId is required when scopeType is DEPARTMENT.');
      }
      return { scopeKey: `DEPT:${departmentId}`, scopeValue: departmentId };

    case WorkCalendarScope.LOCATION:
      if (!location || location.trim().length === 0) {
        throw new BadRequestException('location is required when scopeType is LOCATION.');
      }
      const locClean = location.trim().toUpperCase();
      return { scopeKey: `LOC:${locClean}`, scopeValue: locClean };

    case WorkCalendarScope.USER_OVERRIDE:
      if (!userId) {
        throw new BadRequestException('userId is required when scopeType is USER_OVERRIDE.');
      }
      return { scopeKey: `USER:${userId}`, scopeValue: userId };

    case WorkCalendarScope.GLOBAL:
    default:
      return { scopeKey: 'GLOBAL', scopeValue: 'GLOBAL' };
  }
}

/**
 * Calculates available leave balance using the 6-bucket deterministic formula:
 * Available = Allocated + CarriedForward + Adjusted - Used - Pending
 */
export function calculateAvailableBalance(
  allocated: number | Prisma.Decimal,
  carriedForward: number | Prisma.Decimal,
  adjusted: number | Prisma.Decimal,
  used: number | Prisma.Decimal,
  pending: number | Prisma.Decimal,
): number {
  const a = typeof allocated === 'number' ? allocated : allocated.toNumber();
  const c = typeof carriedForward === 'number' ? carriedForward : carriedForward.toNumber();
  const adj = typeof adjusted === 'number' ? adjusted : adjusted.toNumber();
  const u = typeof used === 'number' ? used : used.toNumber();
  const p = typeof pending === 'number' ? pending : pending.toNumber();

  const available = Math.round((a + c + adj - u - p) * 100) / 100;
  return available;
}

/**
 * Generates an idempotent, human-readable leave request number.
 * Format: LR-YYYYMMDD-XXXX
 */
export function generateLeaveRequestNumber(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `LR-${y}${m}${d}-${randomChars}`;
}

