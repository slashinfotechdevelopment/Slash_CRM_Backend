/**
 * Time utility functions for task tracking, duration calculations,
 * and midnight splits across Asia/Kolkata calendar days.
 */

export const ASIA_KOLKATA_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30 in milliseconds

/**
 * Returns the calendar date string in YYYY-MM-DD corresponding to Asia/Kolkata timezone.
 */
export function getKolkataDateString(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ASIA_KOLKATA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Normalizes a calendar date string (YYYY-MM-DD) or Date object
 * to UTC midnight Date (YYYY-MM-DDT00:00:00.000Z) for MySQL @db.Date storage.
 */
export function parseKolkataDateToUtc(dateInput: string | Date): Date {
  if (dateInput instanceof Date) {
    const kolkataStr = getKolkataDateString(dateInput);
    return new Date(`${kolkataStr}T00:00:00.000Z`);
  }

  const trimmed = dateInput.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new Error(`Invalid calendar date format "${dateInput}". Expected YYYY-MM-DD.`);
  }
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
}

/**
 * Calculates duration in integer seconds between two dates using Math.floor.
 */
export function calculateDurationSeconds(start: Date, end?: Date | null): number {
  if (!start || isNaN(start.getTime())) return 0;
  const targetEnd = end && !isNaN(end.getTime()) ? end : new Date();
  const diffMs = targetEnd.getTime() - start.getTime();
  return Math.max(0, Math.floor(diffMs / 1000));
}

export interface DailyDurationSegment {
  date: string; // YYYY-MM-DD in Asia/Kolkata
  durationSeconds: number;
}

/**
 * Splits a continuous time interval [start, end] at Asia/Kolkata midnight boundaries (18:30:00 UTC).
 * Attributes each portion of whole seconds to its respective calendar date.
 */
export function splitIntervalByKolkataMidnight(
  start: Date,
  end?: Date | null,
): DailyDurationSegment[] {
  if (!start || isNaN(start.getTime())) return [];
  const targetEnd = end && !isNaN(end.getTime()) ? end : new Date();
  if (start.getTime() >= targetEnd.getTime()) return [];

  const segments: DailyDurationSegment[] = [];
  let currentStart = new Date(start);

  while (currentStart < targetEnd) {
    // Current time shifted to IST representation
    const istTime = new Date(currentStart.getTime() + IST_OFFSET_MS);
    const dateStr = istTime.toISOString().slice(0, 10); // YYYY-MM-DD in IST

    // Next local midnight in IST
    const nextMidnightIst = new Date(
      Date.UTC(
        istTime.getUTCFullYear(),
        istTime.getUTCMonth(),
        istTime.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );

    // Convert next midnight back to UTC
    const nextMidnightUtc = new Date(nextMidnightIst.getTime() - IST_OFFSET_MS);

    const segmentEnd = targetEnd < nextMidnightUtc ? targetEnd : nextMidnightUtc;
    const durationSeconds = Math.max(
      0,
      Math.floor((segmentEnd.getTime() - currentStart.getTime()) / 1000),
    );

    if (durationSeconds > 0) {
      segments.push({ date: dateStr, durationSeconds });
    }

    currentStart = segmentEnd;
  }

  return segments;
}

