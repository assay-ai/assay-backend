import { Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { RETRYABLE_ERROR_CODES } from '@database/postgres/repositories/abstract.repository';

/**
 * How many times a transaction aborted by Postgres for a *concurrency* reason
 * is replayed before the caller sees the failure.
 *
 * Deadlock and serialization failures mean "you and someone else collided, try
 * again"; they say nothing about whether the work was valid. A balance check
 * that failed, by contrast, will fail identically forever and is never retried.
 */
export const TRANSACTION_ATTEMPTS = 5;

const RETRY_BASE_DELAY_MS = 5;

/**
 * Runs `work` in one Postgres transaction, retrying only on concurrency aborts.
 *
 * Every ledger mutation goes through here, and so does every evidence seal,
 * which is what lets their callers be written as if single-threaded: by the
 * time `work` sees a locked row, it is the only writer of that row until it returns.
 *
 * Retrying is safe because the whole transaction is replayed — a retry never
 * resumes a half-applied batch, it re-runs one from the start. That is also why
 * `work` must not have side effects outside the transaction.
 */
export async function runInTransaction<T>(
  dataSource: DataSource,
  work: (queryRunner: QueryRunner) => Promise<T>,
  logger?: Logger,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await work(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      lastError = error;

      if (!isRetryable(error) || attempt === TRANSACTION_ATTEMPTS) {
        throw error;
      }

      logger?.warn(
        `Transaction aborted (${describe(error)}), retrying ${attempt}/${TRANSACTION_ATTEMPTS - 1}`,
      );
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    } finally {
      await queryRunner.release();
    }
  }

  throw lastError;
}

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.includes(code);
}

function describe(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
