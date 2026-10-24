import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EvmSlashRecordEntity } from '../entities/evm-slash-record.entity';
import { AbstractRepository } from './abstract.repository';

/** One `SlashProposed` as the watcher read it. Addresses lower-case, request id bare hex. */
export interface SeenSlashRecord {
  readonly chainId: string;
  readonly requestId: string;
  readonly provider: string;
  readonly verifier: string;
  readonly reserved: bigint;
  readonly executableAt: Date | null;
  readonly foreign: boolean;
  readonly blockNumber: bigint | null;
  readonly transactionHash: string | null;
}

/** A standing (not yet closed) record, as the reaper and the redeemer read it. */
export interface StandingSlashRecord {
  readonly requestId: string;
  readonly provider: string;
  readonly verifier: string;
  readonly reserved: bigint;
}

/**
 * `evm_slash_records` — every `SlashProposed` the watcher saw (review
 * 2026-10-24 wave 2 M-2). Platform data: no tenant scope. Every write is
 * idempotent, so a re-read block range or a re-run reaper changes nothing.
 */
@Injectable()
export class EvmSlashRecordRepository extends AbstractRepository<EvmSlashRecordEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EvmSlashRecordEntity, dataSource);
  }

  /**
   * Upserts each record. A record once seen as foreign stays foreign; a
   * re-read never re-opens a closed one.
   */
  async recordProposed(rows: readonly SeenSlashRecord[]): Promise<void> {
    for (const row of rows) {
      await this.manager.query(
        `INSERT INTO evm_slash_records (chain_id, request_id, provider, verifier, reserved,
           executable_at, "foreign", block_number, transaction_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (chain_id, request_id) DO UPDATE
           SET "foreign" = evm_slash_records."foreign" OR EXCLUDED."foreign",
               updated_at = now()`,
        [
          row.chainId,
          row.requestId,
          row.provider,
          row.verifier,
          row.reserved.toString(),
          row.executableAt,
          row.foreign,
          row.blockNumber === null ? null : row.blockNumber.toString(),
          row.transactionHash,
        ],
      );
    }
  }

  /** Marks the records closed (executed, cancelled or expired). Idempotent. */
  async markClosed(chainId: string, requestIds: readonly string[], closedAt: Date): Promise<void> {
    if (requestIds.length === 0) return;
    await this.manager.query(
      `UPDATE evm_slash_records
          SET closed_at = $3, updated_at = now()
        WHERE chain_id = $1 AND request_id = ANY($2::varchar[]) AND closed_at IS NULL`,
      [chainId, [...requestIds], closedAt],
    );
  }

  /** The distinct verifiers that still have a standing record on `chainId`. */
  async standingVerifiers(chainId: string): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT verifier FROM evm_slash_records
        WHERE chain_id = $1 AND closed_at IS NULL
        ORDER BY verifier`,
      [chainId],
    )) as { verifier: string }[];
    return rows.map((row) => row.verifier);
  }

  /** Flags every record of `verifier` on `chainId`: its key can no longer sign. */
  async markVerifierUnavailable(chainId: string, verifier: string): Promise<void> {
    await this.manager.query(
      `UPDATE evm_slash_records
          SET verifier_unavailable = true, updated_at = now()
        WHERE chain_id = $1 AND verifier = $2 AND NOT verifier_unavailable`,
      [chainId, verifier],
    );
  }

  /**
   * Clears the flag on every standing record of `verifier` on `chainId`: a
   * later read says its key CAN sign (review 2026-10-24 wave 3 N-3). One bad
   * read (a wrong config address, an RPC fault) must not label a live key's
   * honest records "unplanned" for good. Idempotent.
   */
  async markVerifierAvailable(chainId: string, verifier: string): Promise<void> {
    await this.manager.query(
      `UPDATE evm_slash_records
          SET verifier_unavailable = false, updated_at = now()
        WHERE chain_id = $1 AND verifier = $2 AND verifier_unavailable AND closed_at IS NULL`,
      [chainId, verifier],
    );
  }

  /** Up to `limit` standing records of `verifier`, fewest reap attempts first. */
  async standingByVerifier(
    chainId: string,
    verifier: string,
    limit: number,
  ): Promise<StandingSlashRecord[]> {
    const rows = (await this.manager.query(
      `SELECT request_id AS "requestId", provider, verifier, reserved::text AS reserved
         FROM evm_slash_records
        WHERE chain_id = $1 AND verifier = $2 AND closed_at IS NULL
        ORDER BY reap_attempts ASC, created_at ASC, request_id ASC
        LIMIT $3`,
      [chainId, verifier, limit],
    )) as { requestId: string; provider: string; verifier: string; reserved: string }[];
    return rows.map((row) => ({ ...row, reserved: BigInt(row.reserved) }));
  }

  /**
   * The standing records against `provider` on `chainId` that are not the
   * provider's doing: foreign (the platform never planned them) or signed by
   * a key that can no longer sign.
   */
  async standingNotPlanned(chainId: string, provider: string): Promise<StandingSlashRecord[]> {
    const rows = (await this.manager.query(
      `SELECT request_id AS "requestId", provider, verifier, reserved::text AS reserved
         FROM evm_slash_records
        WHERE chain_id = $1 AND provider = $2 AND closed_at IS NULL
          AND ("foreign" OR verifier_unavailable)
        ORDER BY request_id ASC`,
      [chainId, provider],
    )) as { requestId: string; provider: string; verifier: string; reserved: string }[];
    return rows.map((row) => ({ ...row, reserved: BigInt(row.reserved) }));
  }

  /** One failed release, kept for the operator and to rotate the queue. */
  async recordReapFailure(chainId: string, requestId: string, error: string): Promise<void> {
    await this.manager.query(
      `UPDATE evm_slash_records
          SET reap_attempts = reap_attempts + 1, reap_last_error = $3, updated_at = now()
        WHERE chain_id = $1 AND request_id = $2`,
      [chainId, requestId, error.slice(0, 128)],
    );
  }
}
