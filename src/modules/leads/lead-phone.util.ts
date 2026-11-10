import { BadRequestException } from '@nestjs/common';

/**
 * Standardizes phone numbers to E.164 format.
 * - Defaults to India (+91) for standard 10-digit numbers without international prefix.
 * - Preserves valid international numbers starting with + or 00.
 * - Strips whitespace, hyphens, periods, parentheses, and leading domestic trunk zeros.
 * - Validates format and throws BadRequestException if invalid.
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new BadRequestException('Phone number is required.');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BadRequestException('Phone number cannot be empty.');
  }

  // Remove formatting characters
  let clean = trimmed.replace(/[\s\-\.\(\)]/g, '');

  // Convert international double-zero prefix to +
  if (clean.startsWith('00')) {
    clean = '+' + clean.slice(2);
  }

  // Explicit international number starting with +
  if (clean.startsWith('+')) {
    if (!/^\+[1-9]\d{7,14}$/.test(clean)) {
      throw new BadRequestException(
        `Invalid international phone number format: ${raw}. Must be E.164 compatible (+ followed by 8 to 15 digits).`,
      );
    }
    return clean;
  }

  // Strip domestic trunk zero (e.g. 09876543210 -> 9876543210)
  if (clean.startsWith('0') && clean.length === 11) {
    clean = clean.slice(1);
  }

  // Standard Indian 10-digit mobile number starting with 6, 7, 8, or 9
  if (/^[6-9]\d{9}$/.test(clean)) {
    return `+91${clean}`;
  }

  // Indian number having 91 prefix without plus (e.g. 919876543210)
  if (/^91[6-9]\d{9}$/.test(clean)) {
    return `+${clean}`;
  }

  if (/^\d{10}$/.test(clean)) {
    throw new BadRequestException(
      `Invalid Indian mobile number: ${raw}. 10-digit mobile numbers must start with 6, 7, 8, or 9. For international numbers, please include '+' followed by the country code.`,
    );
  }

  throw new BadRequestException(
    `Invalid phone number format: ${raw}. Domestic numbers must be 10 digits, and international numbers must include '+' with country code.`,
  );
}
