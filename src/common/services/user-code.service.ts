import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PrismaClient } from '../../generated/prisma/client';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class UserCodeService {
  private readonly defaultPrefixes: Record<string, string> = {
    SUPER_ADMIN: 'SA',
    ADMIN: 'A',
    EMPLOYEE: 'EMP',
    CLIENT: 'CLI',
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates the next atomic user code for a user type.
   * Format: SA001, A001, EMP001, CLI001
   */
  async generateNextCode(
    userTypeCode: string,
    tx?: TransactionClient,
  ): Promise<string> {
    const client = tx || this.prisma;
    const prefix =
      this.defaultPrefixes[userTypeCode] ||
      userTypeCode.substring(0, 3).toUpperCase();

    const sequence = await client.userCodeSequence.upsert({
      where: { userTypeCode },
      update: {
        lastNumber: {
          increment: 1,
        },
      },
      create: {
        userTypeCode,
        prefix,
        lastNumber: 1,
      },
    });

    const paddedNumber = String(sequence.lastNumber).padStart(3, '0');
    return `${sequence.prefix}${paddedNumber}`;
  }
}

