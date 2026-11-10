import { normalizePhoneNumber } from './lead-phone.util';
import { BadRequestException } from '@nestjs/common';

describe('Lead Phone Normalization & Validation Unit Tests', () => {
  describe('Indian Phone Numbers', () => {
    it('should normalize 10-digit number starting with 9 to +91', () => {
      expect(normalizePhoneNumber('9876543210')).toBe('+919876543210');
    });

    it('should normalize spaced and formatted numbers: +91 98765 43210', () => {
      expect(normalizePhoneNumber('+91 98765 43210')).toBe('+919876543210');
    });

    it('should normalize domestic trunk zero format: 098765-43210', () => {
      expect(normalizePhoneNumber('098765-43210')).toBe('+919876543210');
    });

    it('should normalize hyphenated numbers: +91-98765-43210', () => {
      expect(normalizePhoneNumber('+91-98765-43210')).toBe('+919876543210');
    });

    it('should normalize numbers starting with 91 without plus: 919876543210', () => {
      expect(normalizePhoneNumber('919876543210')).toBe('+919876543210');
    });

    it('should verify equivalence: all 4 inputs resolve to identical +919876543210', () => {
      const inputs = [
        '9876543210',
        '+91 98765 43210',
        '098765-43210',
        '+91-98765-43210',
        '(+91) 98765 43210',
      ];
      const results = inputs.map((input) => normalizePhoneNumber(input));
      results.forEach((res) => expect(res).toBe('+919876543210'));
    });
  });

  describe('International Phone Numbers', () => {
    it('should preserve valid US E.164 number: +1 (415) 555-2671', () => {
      expect(normalizePhoneNumber('+1 (415) 555-2671')).toBe('+14155552671');
    });

    it('should preserve valid UK number: +44 7911 123456', () => {
      expect(normalizePhoneNumber('+44 7911 123456')).toBe('+447911123456');
    });

    it('should convert 00 international prefix to +: 0014155552671', () => {
      expect(normalizePhoneNumber('0014155552671')).toBe('+14155552671');
    });
  });

  describe('Invalid Phone Numbers Rejection', () => {
    it('should throw BadRequestException on empty or whitespace', () => {
      expect(() => normalizePhoneNumber('')).toThrow(BadRequestException);
      expect(() => normalizePhoneNumber('   ')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException on letters and invalid characters', () => {
      expect(() => normalizePhoneNumber('abc9876543210')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException on too short phone numbers', () => {
      expect(() => normalizePhoneNumber('12345')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException on invalid Indian mobile series starting with 1', () => {
      expect(() => normalizePhoneNumber('1234567890')).toThrow(BadRequestException);
    });
  });
});

