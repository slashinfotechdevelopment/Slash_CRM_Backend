/**
 * Utility for parsing date filter inputs interpreting calendar dates in Asia/Kolkata (IST = UTC+05:30).
 *
 * For date filters selected by users in India:
 * - Start of day (e.g. 2026-11-10) -> 2026-11-09T18:30:00.000Z
 * - End of day (e.g. 2026-11-10)   -> 2026-11-10T18:29:59.999Z
 *
 * This ensures that MySQL queries filter the exact complete local day in India.
 */
export function parseKolkataDateBoundary(dateStr: string, isEndOfDay: boolean): Date {
  const trimmed = dateStr.trim();

  // Pattern 1: Date-only format 'YYYY-MM-DD'
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const timeComponent = isEndOfDay ? 'T23:59:59.999+05:30' : 'T00:00:00.000+05:30';
    return new Date(`${trimmed}${timeComponent}`);
  }

  // Pattern 2: ISO string without timezone indicator (e.g. '2026-11-10T15:30:00')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(trimmed)) {
    return new Date(`${trimmed}+05:30`);
  }

  // Pattern 3: Explicit ISO format with Z or timezone offset (e.g. '2026-11-09T18:30:00.000Z')
  return new Date(trimmed);
}

/**
 * Safely parses spreadsheet imported dates, supporting ISO, YYYY-MM-DD, and Indian DD/MM/YYYY formats.
 */
export function parseImportDate(val?: string | null): Date {
  if (!val || typeof val !== 'string') {
    return new Date();
  }
  const trimmed = val.trim();

  // Check DD-MM-YYYY or DD/MM/YYYY format common in Indian spreadsheets
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const isoDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const parsed = new Date(`${isoDate}T00:00:00.000+05:30`);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // Check standard YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000+05:30`);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}
