import { Prisma, PrismaClient } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';

export function isUniqueCollision(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function inTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await prisma.$transaction(operation, { maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      // Mongo raw batches report WriteConflict (112) via P2010; both guarantee rollback.
      // Never retry an unknown/uncertain commit error.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !(error.code === 'P2034' || (error.code === 'P2010' && Number(error.meta?.code) === 112))) throw error;
      if (attempt === 11) throw new ServiceUnavailableException('Concurrent update; retry the request');
      await new Promise((resolve) => setTimeout(resolve, Math.min(5 * (attempt + 1), 50)));
    }
  }
  throw new ServiceUnavailableException('Concurrent update; retry the request');
}
