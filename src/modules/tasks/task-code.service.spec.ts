import { Test, TestingModule } from '@nestjs/testing';
import { TaskCodeService } from './task-code.service';
import { PrismaService } from '../../database/prisma.service';

describe('TaskCodeService', () => {
  let service: TaskCodeService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      taskCodeSequence: {
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskCodeService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<TaskCodeService>(TaskCodeService);
  });

  it('should generate properly formatted task code with 3-digit padding', async () => {
    prismaMock.taskCodeSequence.upsert.mockResolvedValue({
      id: 'seq_1',
      prefix: 'TASK',
      lastNumber: 1,
      updatedAt: new Date(),
    });

    const code = await service.generateNextCode();
    expect(code).toBe('TASK001');
    expect(prismaMock.taskCodeSequence.upsert).toHaveBeenCalledWith({
      where: { prefix: 'TASK' },
      update: { lastNumber: { increment: 1 } },
      create: { prefix: 'TASK', lastNumber: 1 },
    });
  });

  it('should handle multi-digit sequence numbers properly', async () => {
    prismaMock.taskCodeSequence.upsert.mockResolvedValue({
      id: 'seq_1',
      prefix: 'TASK',
      lastNumber: 42,
      updatedAt: new Date(),
    });

    const code = await service.generateNextCode();
    expect(code).toBe('TASK042');

    prismaMock.taskCodeSequence.upsert.mockResolvedValue({
      id: 'seq_1',
      prefix: 'TASK',
      lastNumber: 1050,
      updatedAt: new Date(),
    });

    const largeCode = await service.generateNextCode();
    expect(largeCode).toBe('TASK1050');
  });

  it('should use transaction client if provided', async () => {
    const txMock = {
      taskCodeSequence: {
        upsert: jest.fn().mockResolvedValue({
          prefix: 'TASK',
          lastNumber: 5,
        }),
      },
    };

    const code = await service.generateNextCode(txMock as any);
    expect(code).toBe('TASK005');
    expect(txMock.taskCodeSequence.upsert).toHaveBeenCalled();
    expect(prismaMock.taskCodeSequence.upsert).not.toHaveBeenCalled();
  });
});

