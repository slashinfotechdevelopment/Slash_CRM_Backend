import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

@Injectable()
export class LeadCodeService {
  private readonly defaultPrefix = 'LEAD';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates the next atomic lead code using MySQL upsert increment.
   * Format: LEAD001, LEAD002, LEAD003...
   */
  async generateNextCode(
    tx?: Prisma.TransactionClient,
    prefix: string = this.defaultPrefix,
  ): Promise<string> {
    const client = tx || this.prisma;

    const sequence = await client.leadCodeSequence.upsert({
      where: { prefix },
      update: {
        lastNumber: {
          increment: 1,
        },
      },
      create: {
        prefix,
        lastNumber: 1,
      },
    });

    const paddedNumber = String(sequence.lastNumber).padStart(3, '0');
    return `${sequence.prefix}${paddedNumber}`;
  }
}

