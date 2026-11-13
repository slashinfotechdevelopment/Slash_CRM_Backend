import { BadRequestException } from '@nestjs/common';
import {
  validateAndNormalizeBreakPolicy,
  parseBreakPolicySnapshot,
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
