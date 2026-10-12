import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BuyerEscrowEntity } from '../entities/buyer-escrow.entity';
import { assertOrganizationScopedSql } from '../organization-scope';
import { OrganizationScopedRepository } from './organization-scoped.repository';

export interface AllocatedSeq {
  /** Decimal `u64`. */
  readonly seq: string;
  readonly escrowAccountId: string;
  readonly escrowAssetAccountId: string;
}

export interface OpenedEscrow {
  readonly organizationId: string;
  readonly accountId: string;
  readonly assetId: string;
  readonly escrowAccountId: string;
  readonly escrowAssetAccountId: string;
  readonly openedTxRef: string | null;
}

@Injectable()
export class BuyerEscrowRepository extends OrganizationScopedRepository<BuyerEscrowEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(BuyerEscrowEntity, dataSource);
  }

  /**
   * Hands out the next sequence number for this account and advances the row in
   * the same statement.
   *
   * `UPDATE … RETURNING` rather than read-then-write: Postgres takes the row
   * lock for the update, so two concurrent calls serialise and get different
   * numbers by construction. A `SELECT` followed by an `UPDATE` would hand the
   * same seq to both, and one of the two vouchers would die on chain with
   * `VoucherSeqNotIncreasing` after its call had already been served.
   *
   * Returns `null` when there is no escrow row — the caller turns that into
   * `PAYMENT_ESCROW_NOT_OPEN` (409) rather than opening one here, because
   * opening an escrow costs rent and is `POST /deposits`' decision to make.
   *
   * **Exactly one row, or it throws.** `uq_buyer_escrows_account` makes more
   * than one row per account impossible, so the check below should be
   * unreachable — and it is written down anyway because the failure it guards
   * has no other symptom. An `UPDATE` matching two rows advances *both*
   * counters and returns whichever Postgres produced first, so the buyer would
   * sign a voucher naming one row's escrow account with a `seq` drawn from the
   * other row's counter, and the redemption would die on chain after the call
   * had been served. Picking `rows[0]` quietly is not an option on a money
   * path; if the index is ever widened, this fails loudly instead.
   */
  async allocateSeq(organizationId: string, accountId: string): Promise<AllocatedSeq | null> {
    const sql = `
      UPDATE "buyer_escrows"
         SET "next_seq" = "next_seq" + 1,
             "updated_at" = now()
       WHERE "organization_id" = $1 AND "account_id" = $2
   RETURNING ("next_seq" - 1)::text AS seq, "escrow_account_id", "escrow_asset_account_id"
    `;
    assertOrganizationScopedSql(sql, 'BuyerEscrowEntity.allocateSeq');

    const rows = returnedRows<{
      seq: string;
      escrow_account_id: string;
      escrow_asset_account_id: string;
    }>(await this.dataSource.query(sql, [organizationId, accountId]));

    if (rows.length > 1) {
      throw new Error(
        `buyer_escrows holds ${rows.length} rows for account ${accountId}; the chain has one ` +
          `escrow and one sequence counter per buyer, so this allocation advanced more than one ` +
          `of them and cannot say which seq belongs to which escrow`,
      );
    }

    const row = rows[0];
    return row
      ? {
          seq: row.seq,
          escrowAccountId: row.escrow_account_id,
          escrowAssetAccountId: row.escrow_asset_account_id,
        }
      : null;
  }

  /**
   * The next sequence number this account would be issued, without issuing it.
   *
   * `GET /escrow/next-seq` needs the number *and* the in-flight gap it implies,
   * and the gap has to be decided before the allocation rather than after — an
   * allocation that is then refused leaves a hole, and while holes are free they
   * are not free to explain.
   */
  async peekNextSeq(organizationId: string, accountId: string): Promise<bigint | null> {
    const row = await this.findOneBy({ organizationId, accountId });
    return row ? BigInt(row.nextSeq) : null;
  }

  async findByAccount(
    organizationId: string,
    accountId: string,
  ): Promise<BuyerEscrowEntity | null> {
    return this.findOneBy({ organizationId, accountId });
  }

  /**
   * Records an escrow the platform has opened on chain.
   *
   * `ON CONFLICT … DO UPDATE` on the account key rather than a read-then-insert:
   * two deposits landing at once for a new buyer would both see no row. The
   * conflict target is `(account_id)` alone — the escrow's real identity, since
   * the chain has one escrow and one sequence space per buyer — so the second
   * writer updates the first writer's row instead of inserting a second
   * allocator for the same on-chain bitmap.
   *
   * **`next_seq` is never in the SET list.** Re-opening is idempotent for the
   * addresses and must not be for the counter: an upsert that reset it to 1
   * would re-issue every number already spent.
   *
   * **The UPDATE is guarded to the row's own organization**, and a collision
   * with another organization's row answers `null`. The conflict target is the
   * account alone, so without the `WHERE` a second organization depositing from
   * the same address rewrote the FIRST organization's escrow addresses and only
   * then failed its own scoped read-back — a cross-tenant write followed by a
   * 500 (measured on the local stack, 2026-09-22). With it, the other
   * organization's row is untouched and the caller decides what to say.
   */
  async upsertOpened(row: OpenedEscrow): Promise<BuyerEscrowEntity | null> {
    const sql = `
      INSERT INTO "buyer_escrows"
        ("organization_id", "account_id", "asset_id", "escrow_account_id",
         "escrow_asset_account_id", "opened_tx_ref", "opened_at")
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT ("account_id") DO UPDATE
         SET "escrow_account_id" = EXCLUDED."escrow_account_id",
             "escrow_asset_account_id" = EXCLUDED."escrow_asset_account_id",
             "opened_tx_ref" = COALESCE(EXCLUDED."opened_tx_ref", "buyer_escrows"."opened_tx_ref"),
             "opened_at" = COALESCE("buyer_escrows"."opened_at", now()),
             "updated_at" = now()
       WHERE "buyer_escrows"."organization_id" = EXCLUDED."organization_id"
      RETURNING "id"
    `;
    assertOrganizationScopedSql(sql, 'BuyerEscrowEntity.upsertOpened');

    await this.dataSource.query(sql, [
      row.organizationId,
      row.accountId,
      row.assetId,
      row.escrowAccountId,
      row.escrowAssetAccountId,
      row.openedTxRef,
    ]);

    // Read back scoped to the caller. `null` here means the account's escrow
    // row belongs to a different organization — neither adopted nor written.
    return this.findOneBy({
      organizationId: row.organizationId,
      accountId: row.accountId,
    });
  }

  /**
   * Raises `next_seq` to `nextSeq`, and never lowers it.
   *
   * The recovery path for a database restored from a backup taken before some
   * of its vouchers were redeemed: a chain read reporting
   * `escrow.seq_high >= next_seq` means the chain has already spent a number we
   * are about to issue. `WHERE "next_seq" < $3` makes the raise idempotent and
   * keeps a concurrent allocation from being rewound; the monotonic trigger is
   * the backstop underneath it.
   *
   * Returns how many rows moved, so a caller can tell a real realignment from a
   * no-op and only alert on the former.
   */
  async bumpNextSeqTo(organizationId: string, accountId: string, nextSeq: bigint): Promise<number> {
    const sql = `
      UPDATE "buyer_escrows"
         SET "next_seq" = $3::bigint,
             "updated_at" = now()
       WHERE "organization_id" = $1
         AND "account_id" = $2
         AND "next_seq" < $3::bigint
   RETURNING "id"
    `;
    assertOrganizationScopedSql(sql, 'BuyerEscrowEntity.bumpNextSeqTo');

    // `RETURNING` rather than the driver's affected-row count: `DataSource.query`
    // hands back `[rows, rowCount]` for an UPDATE, so `.length` is 2 however
    // many rows moved, and reading the count off that shape would report a
    // realignment that never happened.
    return returnedRows<{ id: string }>(
      await this.dataSource.query(sql, [organizationId, accountId, nextSeq.toString()]),
    ).length;
  }

  /**
   * Rewinds `next_seq` to `max(chainSeqHigh, highest recorded seq) + 1`, and
   * returns the new value, or `null` when nothing moved (review S2-2).
   *
   * The way out for a payer whose counter ran more than `MAX_SEQ_GAP` ahead of
   * the chain's `seqHigh` — unpaid allocations alone can do that, and then no
   * seq this table issues is one the chain would accept, so nothing is
   * redeemed and `seqHigh` never moves. A number that was issued but never
   * recorded as an intent was never served on, so issuing it again costs
   * nothing; a recorded one is never issued again.
   *
   * Why it cannot reissue a recorded or served seq:
   *
   * - It runs under the payer's admission lock (`voucher-admission:<payer>`,
   *   the one `PaymentIntentRepository.insertAdmittedVoucherIntent` takes), and
   *   the escrow row is locked `FOR UPDATE` before the `MAX` is read. No
   *   admission can insert a higher seq between the read and the write.
   * - The `MAX` is over every intent of the account, in every organization and
   *   every state.
   * - `trg_buyer_escrows_seq_monotonic` checks the same bound itself, and only
   *   lets the value go down inside this transaction (`assay.seq_rewind`).
   * - An admission that read the OLD counter (its seq now at or above the new
   *   `next_seq`) is refused under the same lock, because the admission
   *   re-reads `next_seq` there.
   *
   * Only lowers, never raises (`WHERE next_seq > target`), and only while the
   * counter is still more than `maxGap` above `chainSeqHigh`, checked under the
   * row lock, so concurrent callers rewind once and never re-issue the seqs
   * handed out after that rewind.
   */
  async rewindNextSeq(
    organizationId: string,
    accountId: string,
    chainSeqHigh: bigint,
    maxGap: bigint,
  ): Promise<bigint | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${accountId}`,
      ]);
      const lockSql = `
        SELECT "next_seq"::text AS "next_seq" FROM "buyer_escrows"
         WHERE "organization_id" = $1 AND "account_id" = $2
         FOR UPDATE
      `;
      assertOrganizationScopedSql(lockSql, 'BuyerEscrowEntity.rewindNextSeq');
      const [locked] = (await manager.query(lockSql, [organizationId, accountId])) as Array<{
        next_seq: string;
      }>;
      // Re-checked under the row lock: a concurrent caller may have rewound it
      // already, and rewinding again would re-issue the seqs handed out since.
      if (!locked || BigInt(locked.next_seq) - chainSeqHigh <= maxGap) return null;

      const [recorded] = (await manager.query(
        `SELECT COALESCE(MAX("voucher_seq"), 0)::text AS max
           FROM "payment_intents"
          WHERE "agent_account" = $1 AND "voucher_seq" IS NOT NULL`,
        [accountId],
      )) as Array<{ max: string }>;
      const highest = BigInt(recorded?.max ?? '0');
      const target = (highest > chainSeqHigh ? highest : chainSeqHigh) + 1n;

      await manager.query(`SELECT set_config('assay.seq_rewind', 'on', true)`);
      const sql = `
        UPDATE "buyer_escrows"
           SET "next_seq" = $3::bigint,
               "updated_at" = now()
         WHERE "organization_id" = $1
           AND "account_id" = $2
           AND "next_seq" > $3::bigint
     RETURNING "id"
      `;
      assertOrganizationScopedSql(sql, 'BuyerEscrowEntity.rewindNextSeq');
      const moved = returnedRows<{ id: string }>(
        await manager.query(sql, [organizationId, accountId, target.toString()]),
      ).length;
      await manager.query(`SELECT set_config('assay.seq_rewind', 'off', true)`);
      return moved > 0 ? target : null;
    });
  }

  /**
   * The oldest sequence number still awaiting a decision, across every
   * organization that shares this account.
   *
   * Deliberately **not** organization-scoped, and this is one of the few places
   * in this schema where that is correct: the sequence window belongs to an
   * on-chain escrow keyed by pubkey, and a second organization's in-flight
   * voucher occupies the same sequence space. Scoping it would under-report the
   * figure. It is the same argument `AccountBalanceRepository`'s reserve sum
   * makes about the pooled vault, and it is why the guard is not called here.
   *
   * Computed from `payment_intents`, not from the allocator, so a seq that was
   * issued and never used never enters the minimum. That is what makes an
   * unused number free: it leaves a permanent hole in the redeemed set, and
   * the contract admits a voucher on `seq > seq_high` alone — holes cost nothing
   * and there is no ceiling on how large one may be.
   */
  async oldestPendingSeq(accountId: string): Promise<bigint | null> {
    const rows: Array<{ min: string | null }> = await this.dataSource.query(
      `SELECT MIN("voucher_seq")::text AS min
         FROM "payment_intents"
        WHERE "agent_account" = $1
          AND "voucher_seq" IS NOT NULL
          AND "hold_released_at" IS NULL`,
      [accountId],
    );

    const min = rows[0]?.min;
    return min === null || min === undefined ? null : BigInt(min);
  }

  /**
   * Every escrow, in id order, for the reconciler.
   *
   * Cross-tenant on purpose and for the same reason as `oldestPendingSeq`: the
   * reconciler compares this platform's whole mirror against the chain, and a
   * per-tenant pass would report a shortfall for every account it did not look
   * at. Keyset paginated rather than offset, so a page cannot skip a row that
   * another writer inserted mid-walk.
   */
  /**
   * One asset's escrows, keyset-paginated.
   *
   * **Scoped to the asset, and that is not an optimisation.** This table holds
   * every chain's escrows together, while `NamespaceEscrowBalanceReader`
   * dispatches on the *account's* namespace and passes the asset straight
   * through. An unscoped walk therefore hands one chain's reader another
   * chain's asset — which on a Solana reader means base58-decoding an `0x`
   * address. See the regression test in
   * `test/unit/settlement/reconciliation.service.spec.ts`.
   */
  async listAll(
    assetId: string,
    limit: number,
    afterId: string | null,
  ): Promise<BuyerEscrowEntity[]> {
    const query = this.dataSource
      .getRepository(BuyerEscrowEntity)
      .createQueryBuilder('escrow')
      .where('escrow.assetId = :assetId', { assetId })
      .orderBy('escrow.id', 'ASC')
      .limit(limit);

    if (afterId) {
      query.andWhere('escrow.id > :afterId', { afterId });
    }

    return query.getMany();
  }
}

/**
 * The rows an `UPDATE … RETURNING` actually produced.
 *
 * `DataSource.query` hands back `[rows, rowCount]` for an UPDATE and a bare
 * `rows` for a SELECT, and only `QueryRunner.query` takes the flag that
 * normalises the two. Reading `[0]` off the wrong shape is quietly wrong in both
 * directions — it is the whole row set where a row was wanted, and it is length
 * 2 where a count was wanted, which is how a realignment that never happened
 * reports as one.
 */
function returnedRows<T>(raw: unknown): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.isArray(raw[0]) ? (raw[0] as T[]) : (raw as T[]);
}
