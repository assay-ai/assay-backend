import { Logger } from '@nestjs/common';
import { executeWithRetry } from '@shared/utils/retry-promise.util';
import { DataSource, EntityTarget, ObjectLiteral, Repository, QueryRunner } from 'typeorm';

export const RETRYABLE_ERROR_CODES = [
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
];
export const UNIQUE_VIOLATION_CODE = '23505'; // PostgreSQL unique constraint violation
export const DEFAULT_CHUNK_SIZE = 1000;
export const MIN_CHUNK_SIZE = 1;

export abstract class AbstractRepository<T extends ObjectLiteral> extends Repository<T> {
  protected readonly logger = new Logger(this.constructor.name);

  protected constructor(
    protected readonly entity: EntityTarget<T>,
    protected readonly dataSource: DataSource,
  ) {
    super(entity, dataSource.manager);
  }

  /**
   * Batch insert with chunking and retry logic
   * Inserts new rows and ignores existing ones (based on unique constraints)
   *
   * Note: `.orIgnore()` without parameters will ignore conflicts on ANY unique constraint.
   * This works correctly when entities have unique constraints defined (e.g., @Column({ unique: true }))
   *
   * @returns Number of newly inserted rows (existing rows are ignored and not counted)
   */
  async batchInsertWithSplit({
    values,
    chunkSize = DEFAULT_CHUNK_SIZE,
    queryRunner,
  }: {
    values: Partial<T>[];
    chunkSize?: number;
    queryRunner?: QueryRunner;
  }): Promise<number> {
    let insertedCount = 0;
    for (let i = 0; i < values.length; i += chunkSize) {
      const chunk = values.slice(i, i + chunkSize);

      try {
        const result = await (
          queryRunner ? queryRunner.manager.createQueryBuilder() : this.createQueryBuilder()
        )
          .insert()
          .into(this.entity)
          .values(chunk)
          .orIgnore() // Insert if not exists, ignore if already exists (checks all unique constraints)
          .returning('*')
          .execute();
        insertedCount += result.raw?.length || 0;
      } catch (error: any) {
        const isRetryable = RETRYABLE_ERROR_CODES.includes(error?.code);
        if (isRetryable && chunkSize > MIN_CHUNK_SIZE) {
          const newChunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
          this.logger.warn(`${error?.code} error, splitting chunk ${chunkSize} -> ${newChunkSize}`);
          insertedCount += await this.batchInsertWithSplit({
            values: chunk,
            chunkSize: newChunkSize,
            queryRunner,
          });
        } else {
          throw error;
        }
      }
    }
    return insertedCount;
  }

  async batchUpsertWithSplit({
    values,
    conflictColumns,
    columnsToUpdate,
    chunkSize = DEFAULT_CHUNK_SIZE,
    queryRunner,
  }: {
    values: Partial<T>[];
    conflictColumns: string[];
    columnsToUpdate: string[];
    chunkSize?: number;
    queryRunner?: QueryRunner;
  }): Promise<number> {
    let upsertedCount = 0;

    for (let i = 0; i < values.length; i += chunkSize) {
      const chunk = values.slice(i, i + chunkSize);
      try {
        const result = await executeWithRetry(async () => {
          return await (
            queryRunner ? queryRunner.manager.createQueryBuilder() : this.createQueryBuilder()
          )
            .insert()
            .into(this.entity)
            .values(chunk as Partial<T>[])
            .orUpdate(columnsToUpdate, conflictColumns)
            .returning(conflictColumns)
            .execute();
        });
        upsertedCount += result.raw?.length || 0;
      } catch (error: any) {
        const isRetryable = RETRYABLE_ERROR_CODES.includes(error?.code);
        if (isRetryable && chunkSize > MIN_CHUNK_SIZE) {
          const newChunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
          this.logger.warn(`${error?.code} error, splitting chunk ${chunkSize} -> ${newChunkSize}`);
          upsertedCount += await this.batchUpsertWithSplit({
            values: chunk,
            conflictColumns,
            columnsToUpdate,
            chunkSize: newChunkSize,
            queryRunner,
          });
        } else {
          throw error;
        }
      }
    }
    return upsertedCount;
  }

  async batchInsertOrUpsertWithSplit({
    values,
    conflictColumns,
    columnsToUpdate,
    chunkSize = DEFAULT_CHUNK_SIZE,
    queryRunner,
  }: {
    values: Partial<T>[];
    conflictColumns: string[];
    columnsToUpdate: string[];
    chunkSize?: number;
    queryRunner?: QueryRunner;
  }): Promise<number> {
    try {
      // Try naive insert first (without conflict handling)
      return await this.batchInsertWithSplit({ values, chunkSize, queryRunner });
    } catch (error: any) {
      this.logger.error('🚀 ~ AbstractRepository ~ batchInsertOrUpsertWithSplit ~ error:', error);
      // If unique constraint violation occurs, fallback to batch upsert
      if (error?.code === UNIQUE_VIOLATION_CODE) {
        this.logger.debug(`Insert conflict detected, falling back to batch upsert`);
        return await this.batchUpsertWithSplit({
          values,
          conflictColumns,
          columnsToUpdate,
          chunkSize,
          queryRunner,
        });
      }
      throw error;
    }
  }
}
