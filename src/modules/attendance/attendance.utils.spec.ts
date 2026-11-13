import { BadRequestException } from '@nestjs/common';
import {
  validateAndNormalizeBreakPolicy,
  parseBreakPolicySnapshot,
  formatDayMonthYear,
  formatDayMonthYearText,
  formatDateRange,
  formatDateRangeDisplay,
  formatTime12Hour,
  formatTimeRange,
} from './attendance.utils';

describe('validateAndNormalizeBreakPolicy', () => {
  it('should accept full BreakPolicyDto with structured breakTypes', () => {
    const input = {
      paidAllowanceMinutes: 60,
      breakTypes: [
        {
          code: 'LUNCH',
          name: 'Lunch Break',
          maxDurationMinutes: 60,
          isPaid: true,
          maxOccurrencesPerDay: 1,
        },
      ],
    };

    const { normalizedPolicy, snapshotString } =
      validateAndNormalizeBreakPolicy(input);

    expect(normalizedPolicy.paidAllowanceMinutes).toBe(60);
    expect(normalizedPolicy.breakTypes).toHaveLength(1);
    expect(normalizedPolicy.breakTypes[0].code).toBe('LUNCH');
    expect(normalizedPolicy.breakTypes[0].maxDurationMinutes).toBe(60);

    const parsed = parseBreakPolicySnapshot(snapshotString);
    expect(parsed?.breakTypes[0].code).toBe('LUNCH');
  });

  it('should accept frontend modal format with allowedBreakTypes strings and paidBreakAllowance', () => {
    const input = {
      paidBreakAllowance: 60,
      allowedBreakTypes: [
        'Lunch (60m)',
        'Tea Break (20m)',
        'Personal (20m)',
        'Medical (20m)',
      ],
    };

    const { normalizedPolicy } = validateAndNormalizeBreakPolicy(input);

    expect(normalizedPolicy.paidAllowanceMinutes).toBe(60);
    expect(normalizedPolicy.breakTypes).toHaveLength(4);
    expect(normalizedPolicy.breakTypes.map((bt) => bt.code)).toEqual([
      'LUNCH',
      'TEA',
      'PERSONAL',
      'MEDICAL',
    ]);
    expect(normalizedPolicy.breakTypes[0].maxDurationMinutes).toBe(60);
    expect(normalizedPolicy.breakTypes[1].maxDurationMinutes).toBe(20);
  });

  it('should accept direct array of break type string codes', () => {
    const input = ['LUNCH', 'TEA'];

    const { normalizedPolicy } = validateAndNormalizeBreakPolicy(input);

    expect(normalizedPolicy.paidAllowanceMinutes).toBe(60);
    expect(normalizedPolicy.breakTypes).toHaveLength(2);
    expect(normalizedPolicy.breakTypes[0].code).toBe('LUNCH');
    expect(normalizedPolicy.breakTypes[1].code).toBe('TEA');
  });

  it('should reject empty or missing break types', () => {
    expect(() =>
      validateAndNormalizeBreakPolicy({
        paidAllowanceMinutes: 60,
        breakTypes: [],
      }),
    ).toThrow(BadRequestException);
  });
});

describe('Date and Time formatting utilities', () => {
  describe('formatDayMonthYear', () => {
    it('should format ISO string to DD-MM-YYYY', () => {
      expect(formatDayMonthYear('2026-11-13T00:00:00.000Z')).toBe('13-11-2026');
      expect(formatDayMonthYear('2026-11-14T00:00:00.000Z')).toBe('14-11-2026');
    });

    it('should format YYYY-MM-DD string to DD-MM-YYYY', () => {
      expect(formatDayMonthYear('2026-11-13')).toBe('13-11-2026');
      expect(formatDayMonthYear('2026-05-09')).toBe('09-05-2026');
    });

    it('should format Date instance to DD-MM-YYYY', () => {
      const d = new Date('2026-11-13T00:00:00.000Z');
      expect(formatDayMonthYear(d)).toBe('13-11-2026');
    });

    it('should return empty string for null or undefined', () => {
      expect(formatDayMonthYear(null)).toBe('');
      expect(formatDayMonthYear(undefined)).toBe('');
    });
  });

  describe('formatDayMonthYearText', () => {
    it('should format ISO string to DD MMM YYYY', () => {
      expect(formatDayMonthYearText('2026-11-13T00:00:00.000Z')).toBe('13 Nov 2026');
      expect(formatDayMonthYearText('2026-11-14T00:00:00.000Z')).toBe('14 Nov 2026');
    });

    it('should format Date instance to DD MMM YYYY', () => {
      const d = new Date('2026-11-13T00:00:00.000Z');
      expect(formatDayMonthYearText(d)).toBe('13 Nov 2026');
    });
  });

  describe('formatDateRange', () => {
    it('should format range from two dates', () => {
      expect(
        formatDateRange(
          '2026-11-13T00:00:00.000Z',
          '2026-11-14T00:00:00.000Z',
        ),
      ).toBe('13-11-2026 to 14-11-2026');
    });

    it('should return single date if start and end are identical', () => {
      expect(
        formatDateRange(
          '2026-11-13T00:00:00.000Z',
          '2026-11-13T00:00:00.000Z',
        ),
      ).toBe('13-11-2026');
    });

    it('should return "to Ongoing" if end date is null', () => {
      expect(formatDateRange('2026-11-13T00:00:00.000Z', null)).toBe(
        '13-11-2026 to Ongoing',
      );
    });
  });

  describe('formatDateRangeDisplay', () => {
    it('should format readable range text', () => {
      expect(
        formatDateRangeDisplay(
          '2026-11-13T00:00:00.000Z',
          '2026-11-14T00:00:00.000Z',
        ),
      ).toBe('13 Nov 2026 to 14 Nov 2026');
    });
  });

  describe('formatTime12Hour', () => {
    it('should convert 24hr HH:mm strings to 12hr AM/PM', () => {
      expect(formatTime12Hour('09:00')).toBe('09:00 AM');
      expect(formatTime12Hour('18:00')).toBe('06:00 PM');
      expect(formatTime12Hour('13:30')).toBe('01:30 PM');
      expect(formatTime12Hour('00:15')).toBe('12:15 AM');
      expect(formatTime12Hour('12:00')).toBe('12:00 PM');
    });

    it('should convert Date timestamp to Asia/Kolkata 12hr time', () => {
      // 2026-11-13T12:30:00.000Z in UTC is 18:00 (06:00 PM) in Asia/Kolkata (+05:30)
      const d = new Date('2026-11-13T12:30:00.000Z');
      expect(formatTime12Hour(d)).toBe('06:00 PM');
    });
  });

  describe('formatTimeRange', () => {
    it('should format start and end times into range', () => {
      expect(formatTimeRange('09:00', '18:00')).toBe('09:00 AM to 06:00 PM');
      const start = new Date('2026-11-13T12:30:00.000Z'); // 18:00 IST
      const end = new Date('2026-11-13T14:30:00.000Z');   // 20:00 IST
      expect(formatTimeRange(start, end)).toBe('06:00 PM to 08:00 PM');
    });
  });
});

