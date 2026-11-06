import {
  calculateDurationSeconds,
  getKolkataDateString,
  parseKolkataDateToUtc,
  splitIntervalByKolkataMidnight,
} from './task-time.utils';

describe('Task Time Utils', () => {
  describe('getKolkataDateString', () => {
    it('should correctly format UTC timestamp to Asia/Kolkata date string', () => {
      // 2026-11-04 18:29:00 UTC = 23:59 IST on 2026-11-04
      const d1 = new Date('2026-11-04T18:29:00.000Z');
      expect(getKolkataDateString(d1)).toBe('2026-11-04');

      // 2026-11-04 18:31:00 UTC = 00:01 IST on 2026-11-05
      const d2 = new Date('2026-11-04T18:31:00.000Z');
      expect(getKolkataDateString(d2)).toBe('2026-11-05');
    });
  });

  describe('parseKolkataDateToUtc', () => {
    it('should normalize YYYY-MM-DD string to UTC midnight Date', () => {
      const date = parseKolkataDateToUtc('2026-11-05');
      expect(date.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    });

    it('should accept Date instance and return UTC midnight Date', () => {
      const date = parseKolkataDateToUtc(new Date('2026-11-05T10:00:00.000Z'));
      expect(date.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    });

    it('should throw on invalid format', () => {
      expect(() => parseKolkataDateToUtc('invalid-date')).toThrow();
    });
  });

  describe('calculateDurationSeconds', () => {
    it('should return 0 when start date is invalid or after end date', () => {
      expect(calculateDurationSeconds(new Date('invalid'))).toBe(0);
      const start = new Date('2026-11-05T10:00:00.000Z');
      const end = new Date('2026-11-05T09:00:00.000Z');
      expect(calculateDurationSeconds(start, end)).toBe(0);
    });

    it('should calculate integer seconds between two dates', () => {
      const start = new Date('2026-11-05T10:00:00.000Z');
      const end = new Date('2026-11-05T10:01:30.500Z');
      expect(calculateDurationSeconds(start, end)).toBe(90);
    });
  });

  describe('splitIntervalByKolkataMidnight', () => {
    it('should return empty array if start is after or equal to end', () => {
      const start = new Date('2026-11-05T10:00:00.000Z');
      expect(splitIntervalByKolkataMidnight(start, start)).toEqual([]);
    });

    it('should return a single segment if interval does not cross Kolkata midnight', () => {
      // 10:00 UTC to 11:30 UTC on 2026-11-05 (15:30 IST to 17:00 IST on 2026-11-05)
      const start = new Date('2026-11-05T10:00:00.000Z');
      const end = new Date('2026-11-05T11:30:00.000Z');

      const segments = splitIntervalByKolkataMidnight(start, end);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        date: '2026-11-05',
        durationSeconds: 5400, // 90 minutes
      });
    });

    it('should split overnight interval across Kolkata midnight (18:30:00 UTC)', () => {
      // 18:00 UTC (23:30 IST 2026-11-04) to 20:00 UTC (01:30 IST 2026-11-05)
      const start = new Date('2026-11-04T18:00:00.000Z');
      const end = new Date('2026-11-04T20:00:00.000Z');

      const segments = splitIntervalByKolkataMidnight(start, end);
      expect(segments).toHaveLength(2);
      expect(segments[0]).toEqual({
        date: '2026-11-04',
        durationSeconds: 1800, // 30 minutes before midnight
      });
      expect(segments[1]).toEqual({
        date: '2026-11-05',
        durationSeconds: 5400, // 90 minutes after midnight
      });
      expect(segments[0].durationSeconds + segments[1].durationSeconds).toBe(7200);
    });

    it('should handle intervals spanning multiple days', () => {
      // Starts 2026-11-04 at 10:00 UTC (15:30 IST 2026-11-04)
      // Ends 2026-11-06 at 10:00 UTC (15:30 IST 2026-11-06) = 48 hours = 172800 seconds
      const start = new Date('2026-11-04T10:00:00.000Z');
      const end = new Date('2026-11-06T10:00:00.000Z');

      const segments = splitIntervalByKolkataMidnight(start, end);
      expect(segments).toHaveLength(3);
      expect(segments[0].date).toBe('2026-11-04');
      expect(segments[1].date).toBe('2026-11-05');
      expect(segments[2].date).toBe('2026-11-06');

      const totalSplit = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
      expect(totalSplit).toBe(172800);
    });
  });
});

