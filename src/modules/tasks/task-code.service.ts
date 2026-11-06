import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

@Injectable()
export class TaskCodeService {
  private readonly defaultPrefix = 'TASK';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates the next atomic task code using MySQL upsert increment.
   * Format: TASK001, TASK002, TASK003...
   */
  async generateNextCode(
    tx?: Prisma.TransactionClient,
    prefix: string = this.defaultPrefix,
  ): Promise<string> {
    const client = tx || this.prisma;

    const sequence = await client.taskCodeSequence.upsert({
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

