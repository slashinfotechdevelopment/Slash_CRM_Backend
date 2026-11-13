import { BadRequestException } from '@nestjs/common';
import { BreakPolicyDto } from './dto/break-policy.dto';

/**
 * Normalizes any valid calendar date string (YYYY-MM-DD or ISO 8601) or Date object
 * to UTC midnight Date (YYYY-MM-DDT00:00:00.000Z) to ensure reliable @db.Date storage.
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
 * Resolves the calendar date (YYYY-MM-DD) for a given UTC Date in the Asia/Kolkata timezone (+05:30).
 */
export function getAsiaKolkataDateString(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Resolves the 24-hour time (HH:mm) for a given UTC Date in the Asia/Kolkata timezone (+05:30).
 */
export function getAsiaKolkataTimeString(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
}

/**
 * Constructs a UTC Date object representing a specific calendar date and time in Asia/Kolkata (+05:30).
 * If isNextDay is true, advances the calendar date by one day (used for overnight shift scheduled ends).
 */
export function createAsiaKolkataDateTime(
  calendarDateStr: string,
  timeStr: string,
  isNextDay: boolean = false,
): Date {
  const baseDate = parseDateOnly(calendarDateStr);
  if (isNextDay) {
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);
  }
  const datePart = formatDateOnly(baseDate);
  const trimmedTime = timeStr.trim();
  const timeFormatted =
    trimmedTime.length === 5 ? `${trimmedTime}:00` : trimmedTime;
  return new Date(`${datePart}T${timeFormatted}+05:30`);
}

/**
 * Returns the calendar date string for the day preceding dateStr (YYYY-MM-DD).
 */
export function getPreviousDayString(dateStr: string): string {
  const d = parseDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatDateOnly(d);
}

/**
 * Returns the calendar date string for the day following dateStr (YYYY-MM-DD).
 */
export function getNextDayString(dateStr: string): string {
  const d = parseDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return formatDateOnly(d);
}

/**
 * Mathematically determines whether two calendar date intervals [startA, endA] and [startB, endB]
 * overlap. A null end date represents an open-ended interval (+infinity).
 *
 * Mathematical interval overlap condition:
 * max(startA, startB) <= min(endA, endB)
 * <=> startA <= endB AND startB <= endA
 */
export function intervalsOverlap(
  startA: Date,
  endA: Date | null,
  startB: Date,
  endB: Date | null,
): boolean {
  const timeStartA = startA.getTime();
  const timeEndA = endA ? endA.getTime() : Infinity;

  const timeStartB = startB.getTime();
  const timeEndB = endB ? endB.getTime() : Infinity;

  return timeStartA <= timeEndB && timeStartB <= timeEndA;
}

/**
 * Validates and normalizes break policy input into a clean object and serialized JSON snapshot.
 * Supports:
 * - Full BreakPolicyDto: { paidAllowanceMinutes: 60, breakTypes: [...] }
 * - Frontend modal payload: { paidBreakAllowance: 60, allowedBreakTypes: [...] }
 * - Direct array of break codes/names: ['LUNCH', 'TEA', 'PERSONAL', 'MEDICAL']
 * - Custom objects: [{ code: 'LUNCH', maxDurationMinutes: 60 }]
 */
export function validateAndNormalizeBreakPolicy(
  policyInput: any,
): {
  normalizedPolicy: BreakPolicyDto;
  snapshotString: string;
} {
  if (!policyInput) {
    throw new BadRequestException('Break policy configuration is required.');
  }

  let raw = policyInput;
  if (typeof policyInput === 'string') {
    try {
      raw = JSON.parse(policyInput);
    } catch {
      throw new BadRequestException(
        'Invalid break policy JSON string format.',
      );
    }
  }

  // Handle direct array input e.g. ["LUNCH", "TEA"] or [{ code: "LUNCH" }]
  if (Array.isArray(raw)) {
    raw = {
      paidAllowanceMinutes: 60,
      breakTypes: raw,
    };
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new BadRequestException(
      'Break policy must be an object containing paidAllowanceMinutes/paidBreakAllowance and breakTypes/allowedBreakTypes.',
    );
  }

  // Resolve paid allowance minutes
  let rawAllowance = raw.paidAllowanceMinutes ?? raw.paidBreakAllowance;
  if (rawAllowance === undefined || rawAllowance === null) {
    rawAllowance = 60;
  }
  const paidAllowanceMinutes = Number(rawAllowance);
  if (
    isNaN(paidAllowanceMinutes) ||
    paidAllowanceMinutes < 0 ||
    paidAllowanceMinutes > 360
  ) {
    throw new BadRequestException(
      'paidAllowanceMinutes must be an integer between 0 and 360.',
    );
  }

  // Resolve break types array
  const rawBreakTypes = raw.breakTypes ?? raw.allowedBreakTypes;
  if (!Array.isArray(rawBreakTypes) || rawBreakTypes.length === 0) {
    throw new BadRequestException(
      'breakTypes or allowedBreakTypes must be a non-empty array with at least one configured break type.',
    );
  }

  const seenCodes = new Set<string>();
  const normalizedBreakTypes = rawBreakTypes.map((bt: any, idx: number) => {
    if (!bt) {
      throw new BadRequestException(
        `Invalid break type definition at index ${idx}.`,
      );
    }

    let code = '';
    let name = '';
    let maxDurationMinutes = 0;
    let isPaid = true;
    let maxOccurrences = 1;

    if (typeof bt === 'string') {
      const trimmed = bt.trim();
      const matchMinutes = trimmed.match(/\((\d+)\s*m(?:ins?)?\)/i);
      const extractedMins = matchMinutes ? Number(matchMinutes[1]) : 0;
      const cleanLabel = trimmed.replace(/\([^)]*\)/g, '').trim();
      const upper = cleanLabel.toUpperCase();

      if (upper.includes('LUNCH')) {
        code = 'LUNCH';
        name = 'Lunch Break';
        maxDurationMinutes = extractedMins || 60;
        isPaid = true;
        maxOccurrences = 1;
      } else if (upper.includes('TEA')) {
        code = 'TEA';
        name = 'Tea Break';
        maxDurationMinutes = extractedMins || 20;
        isPaid = true;
        maxOccurrences = 2;
      } else if (upper.includes('PERSONAL')) {
        code = 'PERSONAL';
        name = 'Personal Break';
        maxDurationMinutes = extractedMins || 20;
        isPaid = true;
        maxOccurrences = 2;
      } else if (upper.includes('MEDICAL')) {
        code = 'MEDICAL';
        name = 'Medical Break';
        maxDurationMinutes = extractedMins || 20;
        isPaid = true;
        maxOccurrences = 2;
      } else {
        code = upper.replace(/[^A-Z0-9]/g, '_');
        name = cleanLabel || code;
        maxDurationMinutes = extractedMins || 30;
        isPaid = true;
        maxOccurrences = 2;
      }
    } else if (typeof bt === 'object') {
      code = String(bt.code || bt.breakTypeId || bt.id || bt.name || '').trim().toUpperCase();
      name = bt.name ? String(bt.name).trim() : code;

      const parsedDuration = Number(bt.maxDurationMinutes);
      if (!isNaN(parsedDuration) && parsedDuration >= 1) {
        maxDurationMinutes = parsedDuration;
      } else {
        if (code === 'LUNCH') maxDurationMinutes = 60;
        else if (code === 'TEA' || code === 'PERSONAL' || code === 'MEDICAL') maxDurationMinutes = 20;
        else maxDurationMinutes = 30;
      }

      isPaid = bt.isPaid !== undefined ? Boolean(bt.isPaid) : true;
      maxOccurrences =
        bt.maxOccurrencesPerDay !== undefined
          ? Math.max(1, Math.min(20, Number(bt.maxOccurrencesPerDay) || 1))
          : code === 'LUNCH'
            ? 1
            : 2;
    } else {
      throw new BadRequestException(
        `Invalid break type definition at index ${idx}.`,
      );
    }

    if (!code || code.length < 2 || code.length > 50) {
      throw new BadRequestException(
        `Break type at index ${idx} must have a valid code between 2 and 50 characters.`,
      );
    }

    if (seenCodes.has(code)) {
      throw new BadRequestException(
        `Duplicate break type code "${code}" found in break policy.`,
      );
    }
    seenCodes.add(code);

    return {
      code,
      breakTypeId: code,
      name: name || code,
      maxDurationMinutes,
      isPaid,
      maxOccurrencesPerDay: maxOccurrences,
    };
  });

  const normalizedPolicy: BreakPolicyDto = {
    paidAllowanceMinutes,
    breakTypes: normalizedBreakTypes,
  };

  return {
    normalizedPolicy,
    snapshotString: JSON.stringify(normalizedPolicy),
  };
}

/**
 * Safely parses and validates a break policy snapshot from the database.
 * Returns null if missing or malformed.
 */
export function parseBreakPolicySnapshot(
  snapshot: string | null | undefined,
): BreakPolicyDto | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.paidAllowanceMinutes === 'number' &&
      Array.isArray(parsed.breakTypes)
    ) {
      return parsed as BreakPolicyDto;
    }
    return null;
  } catch {
    return null;
  }
}

