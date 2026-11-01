import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  ChannelSettlementEntity,
  ChannelSettlementStatus,
  ChannelTxKind,
  ChannelTxStatus,
  ChannelVoucherEntity,
  VoucherChannelEntity,
  VoucherChannelStatus,
} from '../entities/voucher-channel.entity';
import { checksummedAccount } from '@modules/chains/evm/eip55';

/** A recorded collect or refund (`channel_txs`). */
export interface ChannelTxRecord {
  readonly id: string;
  readonly kind: ChannelTxKind;
  readonly assetId: string;
  readonly intentId: string | null;
  readonly channelRowIds: readonly string[];
  readonly amount: bigint | null;
  readonly txRefs: readonly string[];
  readonly status: ChannelTxStatus;
  readonly createdAt: Date;
  /** The block a "dropped" verdict was first seen at (refunds need two, F2). */
  readonly dropSeenBlock?: bigint | null;
  /** A refund's piece (MF-1); `null`/absent = 0. `amount` is the piece's. */
  readonly pieceIndex?: number | null;
}

/** A served channel call closed without settlement (forfeit or void): its hold to release. */
export interface ClosedChannelCall {
  readonly organizationId: string;
  readonly intentId: string;
  readonly holdId: string;
}

/** A channel call row as the scheduler reads it. */
export interface ChannelCallRecord {
  readonly organizationId: string;
  readonly intentId: string;
  readonly status: string;
  readonly cumulative: bigint;
  readonly calls: number;
  readonly price: bigint;
  readonly holdOpen: boolean;
  readonly heldStatus: string | null;
  readonly disputeOutcome: string | null;
  readonly collectableAt: Date | null;
  readonly createdAt: Date;
  readonly settlementId: string | null;
  readonly lapsed: boolean;
  /** The buyer's ledger hold (`null` before funds were secured). */
  readonly holdId?: string | null;
  /** Closed without settlement: the provider forfeited it, or it was voided. */
  readonly closed?: boolean;
  /**
   * Was a buyer debt at some point (`redemption_lapsed_at` set), renewed or
   * not: a re-lapse stays debt unless the provider caused it (B-2).
   */
  readonly everLapsed?: boolean;
  /**
   * The row's age by the DATABASE clock (`now() - created_at`), seconds: the
   * terminal timeout compares one clock (B-L2). Absent from in-memory callers.
   */
  readonly ageSeconds?: number;
}

/** Intent statuses a channel round treats as terminal (I18). */
export const CHANNEL_TERMINAL_STATUSES: readonly string[] = Object.freeze([
  'SETTLED',
  'REFUNDED',
  'VOIDED',
  'EXPIRED',
]);

/**
 * The channel door's tables (`1793404800000-channel-vouchers`). Cross-tenant
 * by design, like the redemption queue: a channel is the payer account's, and
 * the scheduler and reconciler read every one. Admission reads and writes go
 * through the CALLER's transaction (`manager`), under the payer's advisory
 * lock, so they are atomic with the intent insert they admit.
 */
@Injectable()
export class VoucherChannelRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  get manager(): EntityManager {
    return this.dataSource.manager;
  }

  // ── Admission (inside the payer lock) ───────────────────────────────────

  /**
   * The channel row, locked FOR UPDATE, or `null` when the lane is new. Looked
   * up by `(chain_id, channel_key)`, its unique index (final review 2026-11-01
   * F3): the key is the hash of (payer, signer, provider, channelId) bytes, so
   * it names the lane whatever spelling the caller holds; the caller checks
   * the lane's binding to the session afterwards. `lane` stays in the
   * signature for the callers' sake.
   */
  async lockLane(
    manager: EntityManager,
    lane: {
      chainId: string;
      payer: string;
      signer: string;
      providerAccount: string;
      channelId: string;
    },
    key: `0x${string}`,
  ): Promise<VoucherChannelEntity | null> {
    const rows = (await manager.query(
      `SELECT "id" FROM "voucher_channels"
        WHERE "chain_id" = $1 AND "channel_key" = $2
        FOR UPDATE`,
      [lane.chainId, key.toLowerCase()],
    )) as { id: string }[];
    if (rows.length === 0) return null;
    return manager.findOneByOrFail(VoucherChannelEntity, { id: rows[0].id });
  }

  /**
   * Channels counted against the payer's cap (v3 §5.3): ROTATED and DESYNC
   * until they close, and any other non-closed channel with a non-terminal row
   * or served value above what the chain settled.
   */
  async countOpen(manager: EntityManager, payer: string, assetId: string): Promise<number> {
    const [row] = (await manager.query(
      `SELECT COUNT(*)::int AS "open" FROM "voucher_channels" c
        WHERE c."payer" = ANY($1::text[]) AND c."asset_id" = $2 AND c."status" <> 'CLOSED'
          AND (c."status" = 'ROTATED'
               -- A lane the reconciler stopped holds nothing new: it counts only
               -- while it still has value (review 2026-10-31 L9).
               OR (c."status" = 'DESYNC' AND COALESCE(c."status_reason", '') <> 'RECONCILE')
               OR EXISTS (SELECT 1 FROM "payment_intents" i
                           WHERE i."channel_row_id" = c."id"
                             AND (i."status" NOT IN ('SETTLED', 'REFUNDED', 'VOIDED', 'EXPIRED')
                                  OR (i."channel_cumulative" > c."settled_cumulative"
                                      AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL
                                      AND i."held_at" IS NULL))))`,
      [accountSpellings(payer), assetId],
    )) as { open: number }[];
    return Number(row?.open ?? 0);
  }

  /** Σ price of this channel's admitted calls not yet settled on chain (served or in flight). */
  async pendingOf(manager: EntityManager, channelRowId: string): Promise<bigint> {
    const [row] = (await manager.query(
      `SELECT COALESCE(SUM(i."price_amount"), 0)::text AS "pending"
         FROM "payment_intents" i JOIN "voucher_channels" c ON c."id" = i."channel_row_id"
        WHERE i."channel_row_id" = $1 AND i."channel_cumulative" > c."settled_cumulative"
          AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL AND i."held_at" IS NULL`,
      [channelRowId],
    )) as { pending: string }[];
    return BigInt(row?.pending ?? '0');
  }

  async insertLane(
    manager: EntityManager,
    row: Partial<VoucherChannelEntity>,
  ): Promise<VoucherChannelEntity> {
    const entity = manager.create(VoucherChannelEntity, {
      id: randomUUID(),
      status: VoucherChannelStatus.OPEN,
      lastAcceptedCumulative: '0',
      lastAcceptedCalls: 0,
      settledCumulative: '0',
      settledCalls: 0,
      openedOnChain: false,
      ...row,
    });
    await manager.insert(VoucherChannelEntity, entity);
    return entity;
  }

  async insertVoucher(manager: EntityManager, row: Partial<ChannelVoucherEntity>): Promise<string> {
    const id = randomUUID();
    await manager.insert(ChannelVoucherEntity, { id, ...row });
    return id;
  }

  /** Moves the lane's accepted pair forward, only from the pair admission read (compare-and-set). */
  async advanceAccepted(
    manager: EntityManager,
    id: string,
    from: { cumulative: bigint; calls: number },
    to: { cumulative: bigint; calls: number; issuedAt: number; signerValidUntil?: number | null },
  ): Promise<boolean> {
    const result = (await manager.query(
      `UPDATE "voucher_channels"
          SET "last_accepted_cumulative" = $4, "last_accepted_calls" = $5, "last_issued_at" = $6,
              "signer_valid_until" = $7,
              "oldest_unsettled_at" = COALESCE("oldest_unsettled_at", now()), "updated_at" = now()
        WHERE "id" = $1 AND "last_accepted_cumulative" = $2 AND "last_accepted_calls" = $3
          AND "status" = 'OPEN'
        RETURNING "id"`,
      [
        id,
        from.cumulative.toString(),
        from.calls,
        to.cumulative.toString(),
        to.calls,
        to.issuedAt,
        to.signerValidUntil ?? null,
      ],
    )) as unknown;
    return affectedRows(result) > 0;
  }

  async setStatus(
    id: string,
    status: VoucherChannelStatus,
    reason: string | null,
    manager: EntityManager = this.manager,
  ): Promise<void> {
    await manager.query(
      // Only on a change: a repeat (the reconciler every pass) must not keep
      // `updated_at` fresh, or the lane never goes idle and closes (L9).
      `UPDATE "voucher_channels" SET "status" = $2, "status_reason" = $3, "updated_at" = now()
        WHERE "id" = $1 AND "status" <> 'CLOSED'
          AND ("status" IS DISTINCT FROM $2 OR "status_reason" IS DISTINCT FROM $3)`,
      [id, status, reason],
    );
  }

  /**
   * Override `M-4`: a lane the reconciler stopped (DESYNC/RECONCILE) back to
   * ROTATED — compare-and-set, so only that exact stop is cleared. Returns
   * whether it changed the row.
   */
  async clearReconcile(manager: EntityManager, id: string): Promise<boolean> {
    const result = (await manager.query(
      `UPDATE "voucher_channels" SET "status" = 'ROTATED', "status_reason" = 'RECONCILE_CLEARED',
              "updated_at" = now()
        WHERE "id" = $1 AND "status" = 'DESYNC' AND "status_reason" = 'RECONCILE'
        RETURNING "id"`,
      [id],
    )) as unknown;
    return affectedRows(result) > 0;
  }

  /** The stored result of a replayed voucher: matched on (channel, cumulative, calls, signature). */
  /**
   * The stored voucher of this lane with exactly this message, if any — a
   * replay. Matched on the message fields, not the signature bytes (final
   * review backend F4): the lane key binds payer, signer, provider and
   * channel id, and admission recovered this signature to the lane's signer,
   * so the same fields re-signed by a non-deterministic signer (KMS, HSM, MPC:
   * a random k) are the same voucher, not a rewind.
   */
  async findReplay(
    channelRowId: string,
    cumulative: bigint,
    calls: number,
    times: { readonly issuedAt: bigint | number; readonly expiresAt: bigint | number },
    manager: EntityManager = this.manager,
  ): Promise<{ voucherId: string; intentId: string | null } | null> {
    const rows = (await manager.query(
      `SELECT "id", "intent_id" AS "intentId" FROM "channel_vouchers"
        WHERE "channel_row_id" = $1 AND "cumulative" = $2 AND "calls" = $3
          AND "issued_at" = $4 AND "expires_at" = $5
        LIMIT 1`,
      [
        channelRowId,
        cumulative.toString(),
        calls,
        times.issuedAt.toString(),
        times.expiresAt.toString(),
      ],
    )) as { id: string; intentId: string | null }[];
    return rows[0] ? { voucherId: rows[0].id, intentId: rows[0].intentId } : null;
  }

  /**
   * Asks the scheduler for an urgent round on these channels (SPEC-W2 §3):
   * the payer's reservation passed 80% of available, a debt replacement, a
   * channel at its pending cap. The scheduler bounds how often it obliges.
   */
  async requestUrgent(
    where: { channelRowId?: string; payer?: string; assetId?: string },
    reason: string,
    manager: EntityManager = this.manager,
  ): Promise<void> {
    if (where.channelRowId) {
      await manager.query(
        `UPDATE "voucher_channels" SET "urgent_requested_at" = COALESCE("urgent_requested_at", now()),
                "urgent_reason" = COALESCE("urgent_reason", $2)
          WHERE "id" = $1`,
        [where.channelRowId, reason.slice(0, 16)],
      );
      return;
    }
    if (!where.payer || !where.assetId) return;
    await manager.query(
      `UPDATE "voucher_channels" SET "urgent_requested_at" = COALESCE("urgent_requested_at", now()),
              "urgent_reason" = COALESCE("urgent_reason", $3)
        WHERE "payer" = ANY($1::text[]) AND "asset_id" = $2 AND "status" <> 'CLOSED'
          AND "last_accepted_cumulative" > "settled_cumulative"`,
      [accountSpellings(where.payer), where.assetId, reason.slice(0, 16)],
    );
  }

  /**
   * Asks for an urgent round on every channel of a provider with value still to
   * settle (a slash about to be proposed, v3 §5.4.7). Returns how many channels
   * still hold unsettled value or a settlement in flight.
   */
  async requestProviderSettle(
    providerId: string,
    chainId: string,
    reason: string,
  ): Promise<number> {
    const rows = (await this.manager.query(
      `UPDATE "voucher_channels" c
          SET "urgent_requested_at" = COALESCE(c."urgent_requested_at", now()), "urgent_reason" = $3
        WHERE c."provider_id" = $1 AND c."chain_id" = $2 AND c."status" <> 'CLOSED'
          AND (c."settling_to" IS NOT NULL OR EXISTS (
                SELECT 1 FROM "payment_intents" i
                 WHERE i."channel_row_id" = c."id" AND i."channel_cumulative" > c."settled_cumulative"
                   AND i."status" = 'SETTLED' AND i."held_status" IS NULL
                   AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL
                   AND i."redemption_lapsed_at" IS NULL))
        RETURNING c."id"`,
      [providerId, chainId, reason.slice(0, 16)],
    )) as unknown;
    return affectedRows(rows);
  }

  /**
   * An operator drain (override `M-2`): every channel with value to settle, on
   * one asset or all, gets an urgent round that no rate limit holds back.
   * Idempotent: asking twice marks nothing new. Returns the channels marked.
   */
  async requestDrain(manager: EntityManager, assetId: string | null): Promise<number> {
    const rows = (await manager.query(
      `UPDATE "voucher_channels" c
          SET "urgent_requested_at" = COALESCE(c."urgent_requested_at", now()), "urgent_reason" = 'DRAIN'
        WHERE c."status" <> 'CLOSED' AND ($1::text IS NULL OR c."asset_id" = $1)
          AND EXISTS (SELECT 1 FROM "payment_intents" i
                       WHERE i."channel_row_id" = c."id" AND i."channel_cumulative" > c."settled_cumulative"
                         AND i."status" = 'SETTLED' AND i."held_status" IS NULL
                         AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL
                         AND i."redemption_lapsed_at" IS NULL)
        RETURNING c."id"`,
      [assetId],
    )) as unknown;
    return affectedRows(rows);
  }

  async clearUrgent(channelRowIds: readonly string[]): Promise<void> {
    if (channelRowIds.length === 0) return;
    await this.manager.query(
      `UPDATE "voucher_channels" SET "urgent_requested_at" = NULL, "urgent_reason" = NULL
        WHERE "id" = ANY($1::uuid[])`,
      [[...channelRowIds]],
    );
  }

  async findLaneByKey(chainId: string, key: string): Promise<VoucherChannelEntity | null> {
    return this.manager.findOneBy(VoucherChannelEntity, { chainId, channelKey: key.toLowerCase() });
  }

  async findById(id: string): Promise<VoucherChannelEntity | null> {
    return this.manager.findOneBy(VoucherChannelEntity, { id });
  }

  /**
   * Lanes the reconciler stopped (DESYNC / RECONCILE, `CHANNEL_STATE_BREACH`)
   * and not cleared yet (override `M-4`), newest first, at most `limit`. The
   * operator console's list of stops to investigate.
   */
  async listReconcileStopped(limit = 200): Promise<VoucherChannelEntity[]> {
    return this.manager.find(VoucherChannelEntity, {
      where: { status: VoucherChannelStatus.DESYNC, statusReason: 'RECONCILE' },
      order: { updatedAt: 'DESC' },
      take: limit,
    });
  }

  // ── Scheduler ───────────────────────────────────────────────────────────

  /**
   * Channels with anything left to do on `assetId`, at most `limit`.
   *
   * Final review 2026-11-01 MF-3 (zombie lanes): a CLOSED lane is listed only
   * while it still has a HELD call (money in a bucket) or a chargeable
   * unsettled call (served or in progress, buyer hold open, not voided or
   * forfeited) — never for a voided / expired tail above `settled`, which no
   * round settles (a zero-charge step is waived by never settling it).
   *
   * Order: lanes with value to settle first (a chargeable unsettled call
   * that has not lapsed into a debt; fix review FR-M1), by their deadline — a lane without one yet (a new lane before its first
   * round) at `created_at + 2 h`, the latest a fresh voucher's deadline can
   * be (`expiresAt ≤ +300 s`, `+7,200 s` grace) — then the rest (held money
   * only), oldest first. Old lanes can no longer push new ones past the limit.
   */
  async listActive(assetId: string, limit = 2_000): Promise<VoucherChannelEntity[]> {
    return (
      this.manager
        .createQueryBuilder(VoucherChannelEntity, 'c')
        .where('c.assetId = :assetId', { assetId })
        // Raw, quoted column names: TypeORM rewrites `alias.property` only when the
        // property is followed by a space, `=`, `)` or `,`; one followed by a line
        // break (`c.settledCumulative⏎`) was passed through and Postgres read the
        // unknown `c.settledcumulative`, failing every scheduler pass (e2e B-1).
        .andWhere(
          `(c."status" <> 'CLOSED' OR EXISTS (SELECT 1 FROM "payment_intents" i ` +
            `WHERE i."channel_row_id" = c."id" AND (i."held_status" = 'HELD' ` +
            `OR (i."channel_cumulative" > c."settled_cumulative" AND i."held_status" IS NULL ` +
            `AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL ` +
            `AND i."status" NOT IN ('REFUNDED', 'VOIDED', 'EXPIRED') ` +
            `AND COALESCE(i."redemption_last_error" NOT LIKE 'provider_forfeit:%' ` +
            `AND i."redemption_last_error" NOT LIKE 'voided:%', true)))))`,
        )
        // Fix review FR-M1: the first group is the lanes with value to SETTLE
        // now: a chargeable unsettled call that has NOT lapsed into a buyer
        // debt. Lanes holding only HELD money, or only an old debt (hold open
        // until renewed or replaced), are listed after them, so neither can
        // push a new lane with money to settle past the limit.
        .orderBy(
          `CASE WHEN EXISTS (SELECT 1 FROM "payment_intents" w ` +
            `WHERE w."channel_row_id" = c."id" ` +
            `AND w."channel_cumulative" > c."settled_cumulative" AND w."held_status" IS NULL ` +
            `AND w."hold_id" IS NOT NULL AND w."hold_released_at" IS NULL ` +
            `AND w."redemption_lapsed_at" IS NULL ` +
            `AND w."status" NOT IN ('REFUNDED', 'VOIDED', 'EXPIRED') ` +
            `AND COALESCE(w."redemption_last_error" NOT LIKE 'provider_forfeit:%' ` +
            `AND w."redemption_last_error" NOT LIKE 'voided:%', true)) THEN 0 ELSE 1 END`,
          'ASC',
        )
        .addOrderBy(`COALESCE(c."deadline_at", c."created_at" + interval '2 hours')`, 'ASC')
        .addOrderBy('c.createdAt', 'ASC')
        .limit(limit)
        .getMany()
    );
  }

  /** The assets with an active channel. */
  async activeAssets(): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT "asset_id" AS "assetId" FROM "voucher_channels" WHERE "status" <> 'CLOSED'
       UNION
       SELECT DISTINCT "asset_id" FROM "payment_intents"
        WHERE "voucher_format" = 'CHANNEL' AND "held_status" = 'HELD'`,
    )) as { assetId: string }[];
    return rows.map((row) => row.assetId);
  }

  async calls(channelRowId: string, aboveCumulative = -1n): Promise<ChannelCallRecord[]> {
    const rows = (await this.manager.query(
      `SELECT "organization_id" AS "organizationId", "id" AS "intentId", "status",
              "channel_cumulative"::text AS "cumulative", "channel_calls" AS "calls",
              "price_amount"::text AS "price",
              ("hold_id" IS NOT NULL AND "hold_released_at" IS NULL) AS "holdOpen",
              "held_status" AS "heldStatus", "dispute_outcome" AS "disputeOutcome",
              "collectable_at" AS "collectableAt", "created_at" AS "createdAt",
              "channel_settlement_id" AS "settlementId",
              ("redemption_lapsed_at" IS NOT NULL AND "redemption_replaced_at" IS NULL) AS "lapsed",
              "hold_id" AS "holdId",
              COALESCE("redemption_last_error" LIKE 'provider_forfeit:%'
                       OR "redemption_last_error" LIKE 'voided:%', false) AS "closed",
              ("redemption_lapsed_at" IS NOT NULL) AS "everLapsed",
              EXTRACT(EPOCH FROM (now() - "created_at"))::float8 AS "ageSeconds"
         FROM "payment_intents"
        WHERE "channel_row_id" = $1 AND "channel_cumulative" > $2
        ORDER BY "channel_cumulative" ASC`,
      [channelRowId, aboveCumulative.toString()],
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      organizationId: String(row.organizationId),
      intentId: String(row.intentId),
      status: String(row.status),
      cumulative: BigInt(String(row.cumulative)),
      calls: Number(row.calls),
      price: BigInt(String(row.price)),
      holdOpen: row.holdOpen === true || row.holdOpen === 'true',
      heldStatus: (row.heldStatus as string | null) ?? null,
      disputeOutcome: (row.disputeOutcome as string | null) ?? null,
      collectableAt: row.collectableAt ? new Date(row.collectableAt as string) : null,
      createdAt: new Date(row.createdAt as string),
      settlementId: (row.settlementId as string | null) ?? null,
      lapsed: row.lapsed === true || row.lapsed === 'true',
      holdId: (row.holdId as string | null) ?? null,
      closed: row.closed === true || row.closed === 'true',
      everLapsed: row.everLapsed === true || row.everLapsed === 'true',
      ageSeconds: Number(row.ageSeconds),
    }));
  }

  async vouchers(channelRowId: string, aboveCumulative: bigint): Promise<ChannelVoucherEntity[]> {
    return this.manager
      .createQueryBuilder(ChannelVoucherEntity, 'v')
      .where('v.channelRowId = :channelRowId', { channelRowId })
      .andWhere('v.cumulative > :above', { above: aboveCumulative.toString() })
      .orderBy('v.cumulative', 'DESC')
      .addOrderBy('v.issuedAt', 'DESC')
      .getMany();
  }

  /**
   * Binds a settlement: inserts its row and sets `settling_to`, both only
   * while nothing else is in flight on the channel and its settled value is
   * still `fromSettled`. `null` when the channel moved underneath, or when a
   * call it would charge is no longer a row of the lane (moved to the per-call
   * door, `PaymentIntentRepository.replaceChannelDebtPerCall`): re-checked under
   * the row locks, so a moved call is never bound (rev3 L-2).
   */
  async bindSettlement(input: {
    channelRowId: string;
    voucherId: string;
    fromSettled: bigint;
    toCumulative: bigint;
    fromCalls: number;
    toCalls: number;
    charge: bigint;
    waived: bigint;
    trigger: string;
    intentIds: readonly string[];
    /** The bound calls this settlement charges (the rest of `intentIds` are waived). */
    chargedIntentIds?: readonly string[];
  }): Promise<string | null> {
    const charged = [...new Set(input.chargedIntentIds ?? [])];
    const refused = Symbol('charged call moved');
    return this.manager
      .transaction(async (manager) => {
        const moved = (await manager.query(
          `UPDATE "voucher_channels" SET "settling_to" = $2, "settling_since" = now(), "updated_at" = now()
            WHERE "id" = $1 AND "settling_to" IS NULL AND "settled_cumulative" = $3
            RETURNING "id"`,
          [input.channelRowId, input.toCumulative.toString(), input.fromSettled.toString()],
        )) as unknown;
        if (affectedRows(moved) === 0) return null;
        if (charged.length > 0) {
          // A planned round also re-checks that every call it charges is
          // still chargeable: its hold open and not closed (a late REFUND /
          // VOID verdict may have voided it meanwhile, sec-audit B-6). A
          // RECOVER bind books what the chain already did, so it does not.
          const chargeableOnly =
            input.trigger === 'RECOVER'
              ? ''
              : `AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
                 AND COALESCE("redemption_last_error" NOT LIKE 'provider_forfeit:%'
                              AND "redemption_last_error" NOT LIKE 'voided:%', true)`;
          const still = (await manager.query(
            `SELECT "id" FROM "payment_intents"
              WHERE "id" = ANY($2::uuid[]) AND "channel_row_id" = $1 ${chargeableOnly}
              FOR UPDATE`,
            [input.channelRowId, charged],
          )) as unknown[];
          // Rolls the `settling_to` above back with it.
          if (still.length !== charged.length) throw refused;
        }
        return this.insertSettlement(manager, input);
      })
      .catch((error: unknown) => {
        if (error === refused) return null;
        throw error;
      });
  }

  private async insertSettlement(
    manager: EntityManager,
    input: Parameters<VoucherChannelRepository['bindSettlement']>[0],
  ): Promise<string> {
    const id = randomUUID();
    await manager.insert(ChannelSettlementEntity, {
      id,
      channelRowId: input.channelRowId,
      voucherId: input.voucherId,
      fromSettled: input.fromSettled.toString(),
      toCumulative: input.toCumulative.toString(),
      fromCalls: input.fromCalls,
      toCalls: input.toCalls,
      charge: input.charge.toString(),
      waived: input.waived.toString(),
      status: ChannelSettlementStatus.PENDING,
      trigger: input.trigger,
      chargedIntentIds: [...(input.chargedIntentIds ?? [])],
    });
    if (input.intentIds.length > 0) {
      await manager.query(
        `UPDATE "payment_intents" SET "channel_settlement_id" = $2
            WHERE "channel_row_id" = $1 AND "id" = ANY($3::uuid[])`,
        [input.channelRowId, id, [...input.intentIds]],
      );
    }
    return id;
  }

  /**
   * The settlement goes SENT; with `txRef`, the hash is recorded BEFORE its
   * broadcast (`beforeBroadcast`). Recording a hash on a settlement that is no
   * longer live (released meanwhile) THROWS: the hook then fails, the door
   * answers "not sent" and nothing is broadcast (re-review F1).
   */
  async markSent(settlementId: string, txRef: string | null): Promise<void> {
    const result = (await this.manager.query(
      `UPDATE "channel_settlements"
          SET "status" = 'SENT', "tx_refs" = CASE WHEN $2::text IS NULL THEN "tx_refs"
                                                 ELSE array_append("tx_refs", $2::text) END
        WHERE "id" = $1 AND "status" IN ('PENDING', 'SENT')
        RETURNING "id"`,
      [settlementId, txRef],
    )) as unknown;
    if (txRef !== null && affectedRows(result) === 0) {
      throw new Error(`settlement ${settlementId} is no longer live: ${txRef} not recorded`);
    }
  }

  /**
   * A settlement that did not land (skipped by the chain, dropped by the
   * simulation, a send that failed before broadcast): the rows are unbound and
   * `settling_to` cleared, so the next round can try again.
   */
  async releaseSettlement(
    settlementId: string,
    status: ChannelSettlementStatus.SKIPPED | ChannelSettlementStatus.DROPPED,
    reason: string,
  ): Promise<void> {
    await this.manager.transaction(async (manager) => {
      const result = (await manager.query(
        `UPDATE "channel_settlements" SET "status" = $2, "skip_reason" = $3
          WHERE "id" = $1 AND "status" IN ('PENDING', 'SENT')
          RETURNING "channel_row_id" AS "channelRowId"`,
        [settlementId, status, reason.slice(0, 32)],
      )) as unknown;
      const channelRowId = returnedRows<{ channelRowId: string }>(result)[0]?.channelRowId;
      if (!channelRowId) return;
      await manager.query(
        `UPDATE "payment_intents" SET "channel_settlement_id" = NULL
          WHERE "channel_row_id" = $1 AND "channel_settlement_id" = $2`,
        [channelRowId, settlementId],
      );
      await manager.query(
        `UPDATE "voucher_channels" SET "settling_to" = NULL, "settling_since" = NULL, "updated_at" = now()
          WHERE "id" = $1`,
        [channelRowId],
      );
    });
  }

  /**
   * A settlement that landed: the channel's settled pair moves to what the
   * chain says, `settling_to` clears, and the settlement records its bucket.
   * The rows themselves are booked by the caller (held, waived) in the same
   * transaction (`manager`).
   */
  async landSettlement(
    manager: EntityManager,
    settlementId: string,
    channelRowId: string,
    landed: {
      cumulative: bigint;
      calls: number;
      maturityHour: number;
      takeRateBps: number;
      txRef: string;
    },
  ): Promise<boolean> {
    const result = (await manager.query(
      `UPDATE "channel_settlements"
          SET "status" = 'LANDED', "landed_at" = now(), "maturity_hour" = $2, "take_rate_bps" = $3,
              "tx_refs" = CASE WHEN $4 = ANY("tx_refs") THEN "tx_refs" ELSE array_append("tx_refs", $4) END
        WHERE "id" = $1 AND "status" IN ('PENDING', 'SENT')
        RETURNING "id"`,
      [settlementId, landed.maturityHour, landed.takeRateBps, landed.txRef],
    )) as unknown;
    if (affectedRows(result) === 0) return false;
    await manager.query(
      `UPDATE "voucher_channels"
          SET "settled_cumulative" = GREATEST("settled_cumulative", $2::numeric),
              "settled_calls" = GREATEST("settled_calls", $3),
              "settling_to" = NULL, "settling_since" = NULL, "last_settled_at" = now(),
              "opened_on_chain" = true, "last_skip_reason" = NULL, "updated_at" = now()
        WHERE "id" = $1`,
      [channelRowId, landed.cumulative.toString(), landed.calls],
    );
    return true;
  }

  /**
   * Books the calls a landed settlement charged: into the hold at the bucket's
   * maturity, with the fee re-priced at the take rate the contract applied at
   * settlement (SPEC-W2 §13: the rate in force at settlement applies). Only a
   * served call whose buyer hold is still open; returns those booked.
   */
  async bookCharged(
    manager: EntityManager,
    channelRowId: string,
    intentIds: readonly string[],
    heldAt: Date,
    collectableAt: Date,
    takeRateBps: number,
  ): Promise<number> {
    if (intentIds.length === 0) return 0;
    const result = (await manager.query(
      `UPDATE "payment_intents"
          SET "held_status" = 'HELD', "held_at" = $3, "collectable_at" = $4,
              "platform_fee" = floor("price_amount" * $5 / 10000),
              "provider_amount" = "price_amount" - floor("price_amount" * $5 / 10000)
        WHERE "channel_row_id" = $1 AND "id" = ANY($2::uuid[]) AND "status" = 'SETTLED'
          AND "held_status" IS NULL AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [channelRowId, [...intentIds], heldAt, collectableAt, takeRateBps],
    )) as unknown;
    return affectedRows(result);
  }

  async markWaived(
    manager: EntityManager,
    channelRowId: string,
    intentIds: readonly string[],
    reason: string,
  ): Promise<void> {
    if (intentIds.length === 0) return;
    await manager.query(
      `UPDATE "payment_intents" SET "waived_reason" = COALESCE("waived_reason", $3)
        WHERE "channel_row_id" = $1 AND "id" = ANY($2::uuid[])`,
      [channelRowId, [...intentIds], reason.slice(0, 32)],
    );
  }

  /**
   * Served calls no stored voucher can settle any more (v3 §5.6): they become
   * buyer debt — the hold stays open, nobody is credited, the payer's paid
   * calls are refused until a renew of the exact pair is signed.
   */
  async lapse(channelRowId: string, intentIds: readonly string[], cause: string): Promise<number> {
    if (intentIds.length === 0) return 0;
    const result = (await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_lapsed_at" = COALESCE("redemption_lapsed_at", now()),
              "redemption_replaced_at" = NULL, "redemption_last_error" = $3
        WHERE "channel_row_id" = $1 AND "id" = ANY($2::uuid[]) AND "status" = 'SETTLED'
          AND "held_status" IS NULL AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
          AND "channel_settlement_id" IS NULL
        RETURNING "id"`,
      [channelRowId, [...intentIds], cause],
    )) as unknown;
    return affectedRows(result);
  }

  /** A renew of a lapsed channel's exact pair: its lapsed calls go back to settlement (REPLACING). */
  async markReplaced(
    channelRowId: string,
    upToCumulative: bigint,
    manager: EntityManager = this.manager,
  ): Promise<number> {
    const result = (await manager.query(
      `UPDATE "payment_intents" SET "redemption_replaced_at" = now()
        WHERE "channel_row_id" = $1 AND "channel_cumulative" <= $2 AND "redemption_lapsed_at" IS NOT NULL
          AND "redemption_replaced_at" IS NULL AND "hold_released_at" IS NULL
        RETURNING "id"`,
      [channelRowId, upToCumulative.toString()],
    )) as unknown;
    return affectedRows(result);
  }

  /** Why the last settle of this channel did not land; `null` clears it. */
  async setLastSkip(channelRowId: string, reason: string | null): Promise<void> {
    await this.manager.query(
      `UPDATE "voucher_channels" SET "last_skip_reason" = $2
        WHERE "id" = $1 AND "last_skip_reason" IS DISTINCT FROM $2`,
      [channelRowId, reason === null ? null : reason.slice(0, 32)],
    );
  }

  /**
   * Served calls closed WITHOUT settlement and without debt (review
   * 2026-10-31 H3/H4): the provider forfeits them (`provider_forfeit:<cause>`)
   * or they are voided (`voided:<cause>`). Only calls still served, unbound,
   * not held and with their buyer hold open; returns those marked, whose hold
   * the caller releases. A mark already written (a crash before the release)
   * is returned again.
   */
  async closeUnsettled(
    channelRowId: string,
    intentIds: readonly string[],
    mark: string,
  ): Promise<ClosedChannelCall[]> {
    if (intentIds.length === 0) return [];
    const result = (await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_last_error" = CASE
                WHEN "redemption_last_error" LIKE 'provider_forfeit:%'
                  OR "redemption_last_error" LIKE 'voided:%' THEN "redemption_last_error"
                ELSE $3 END
        WHERE "channel_row_id" = $1 AND "id" = ANY($2::uuid[]) AND "status" = 'SETTLED'
          AND "held_status" IS NULL AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
          AND "channel_settlement_id" IS NULL
        RETURNING "organization_id" AS "organizationId", "id" AS "intentId", "hold_id" AS "holdId"`,
      [channelRowId, [...intentIds], mark.slice(0, 64)],
    )) as unknown;
    return returnedRows<ClosedChannelCall>(result);
  }

  /** The lapsed (debt) calls of a lane up to `cumulative`, for a renew. */
  async lapsedDebtsUpTo(
    channelRowId: string,
    cumulative: bigint,
  ): Promise<{ intentId: string; writtenOff: boolean; replaced: boolean }[]> {
    const rows = (await this.manager.query(
      `SELECT "id" AS "intentId",
              COALESCE("redemption_last_error" LIKE 'uncollected:%', false) AS "writtenOff",
              ("redemption_replaced_at" IS NOT NULL) AS "replaced"
         FROM "payment_intents"
        WHERE "channel_row_id" = $1 AND "channel_cumulative" <= $2
          AND "redemption_lapsed_at" IS NOT NULL AND "status" = 'SETTLED'
          AND ("hold_released_at" IS NULL OR "redemption_last_error" LIKE 'uncollected:%')
        ORDER BY "channel_cumulative" ASC`,
      [channelRowId, cumulative.toString()],
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      intentId: String(row.intentId),
      writtenOff: row.writtenOff === true || row.writtenOff === 'true',
      replaced: row.replaced === true || row.replaced === 'true',
    }));
  }

  /**
   * A WRITTEN-OFF channel debt renewed (review 2026-10-31 H6): a fresh hold
   * (`holdId`, opened by the caller) takes the released one's place and the
   * row goes back to settlement as REPLACING. Only while it is still exactly
   * that written-off debt.
   */
  async markWrittenOffReplaced(
    channelRowId: string,
    intentId: string,
    holdId: string,
  ): Promise<boolean> {
    const result = (await this.manager.query(
      `UPDATE "payment_intents"
          SET "redemption_replaced_at" = now(), "hold_id" = $3, "hold_released_at" = NULL,
              "redemption_last_error" = NULL
        WHERE "channel_row_id" = $1 AND "id" = $2 AND "redemption_lapsed_at" IS NOT NULL
          AND "redemption_replaced_at" IS NULL AND "hold_released_at" IS NOT NULL
          AND "redemption_last_error" LIKE 'uncollected:%' AND "held_status" IS NULL
        RETURNING "id"`,
      [channelRowId, intentId, holdId],
    )) as unknown;
    return affectedRows(result) > 0;
  }

  /**
   * Whether this call was a channel debt settled per call in the portal
   * (client review M-2, migration 1793404800030): it left its lane for good,
   * so a renew of it is refused.
   */
  async replacedPerCall(intentId: string): Promise<boolean> {
    const [row] = (await this.manager.query(
      `SELECT ("replaced_channel_row_id" IS NOT NULL) AS "moved" FROM "payment_intents" WHERE "id" = $1`,
      [intentId],
    )) as { moved: boolean | string }[];
    return row?.moved === true || row?.moved === 'true';
  }

  /** When this lane last took a renew (a voucher with no call), or `null`. */
  async lastRenewAt(
    channelRowId: string,
    manager: EntityManager = this.manager,
  ): Promise<Date | null> {
    const [row] = (await manager.query(
      `SELECT MAX("received_at") AS "at" FROM "channel_vouchers"
        WHERE "channel_row_id" = $1 AND "intent_id" IS NULL`,
      [channelRowId],
    )) as { at: Date | string | null }[];
    return row?.at ? new Date(row.at) : null;
  }

  /**
   * Seconds since the lane's last renew by the DATABASE clock (`now() -
   * MAX(received_at)`, the same clock that wrote it), or `null` (backend F5).
   */
  async lastRenewAgeSeconds(
    channelRowId: string,
    manager: EntityManager = this.manager,
  ): Promise<number | null> {
    const [row] = (await manager.query(
      `SELECT EXTRACT(EPOCH FROM (now() - MAX("received_at")))::float8 AS "age"
         FROM "channel_vouchers"
        WHERE "channel_row_id" = $1 AND "intent_id" IS NULL`,
      [channelRowId],
    )) as { age: number | string | null }[];
    return row?.age === null || row?.age === undefined ? null : Number(row.age);
  }

  // ── Recorded collects and refunds (`channel_txs`) ───────────────────────

  /**
   * Records a collect or refund about to be sent. A refund is one call's: a
   * second live one for the same call is refused by the unique index, and
   * `null` comes back (another send of it is in flight or landed).
   */
  async insertTx(input: {
    kind: ChannelTxKind;
    assetId: string;
    intentId?: string | null;
    channelRowIds: readonly string[];
    amount?: bigint | null;
    /** A refund's piece (MF-1); `amount` is then the piece's. */
    pieceIndex?: number | null;
  }): Promise<string | null> {
    const id = randomUUID();
    try {
      await this.manager.query(
        `INSERT INTO "channel_txs" ("id", "kind", "asset_id", "intent_id", "channel_row_ids", "amount",
                                    "piece_index")
         VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)`,
        [
          id,
          input.kind,
          input.assetId,
          input.intentId ?? null,
          [...input.channelRowIds],
          input.amount === undefined || input.amount === null ? null : input.amount.toString(),
          input.pieceIndex ?? null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') return null;
      throw error;
    }
    return id;
  }

  /** The hash `beforeBroadcast` handed over, recorded before the broadcast. */
  /**
   * Throws when the record is no longer live (DROPPED by another caller): the
   * `beforeBroadcast` hook then fails and nothing is broadcast (re-review F1).
   */
  async appendTxRef(id: string, txRef: string): Promise<void> {
    const result = (await this.manager.query(
      `UPDATE "channel_txs"
          SET "status" = 'SENT',
              "tx_refs" = CASE WHEN $2::text = ANY("tx_refs") THEN "tx_refs"
                               ELSE array_append("tx_refs", $2::text) END
        WHERE "id" = $1 AND "status" IN ('PENDING', 'SENT')
        RETURNING "id"`,
      [id, txRef],
    )) as unknown;
    if (affectedRows(result) === 0) {
      throw new Error(`channel tx ${id} is no longer live: ${txRef} not recorded`);
    }
  }

  /**
   * Runs `work` as the ONLY owner of one call's channel refund, across every
   * process (re-review F1): a transaction-scoped advisory lock keyed by the
   * call, held for the whole read-back → insert → send → record sequence.
   * `null` (work not run) when another caller holds it. A crashed owner's
   * connection closes and frees it.
   *
   * Pool sizing (re-review L6): the lock is transaction-scoped, so the
   * owner keeps ONE pooled connection (idle in transaction, no row locks)
   * for the whole send — up to the relayer budget plus the receipt wait,
   * about 6 minutes in the worst case. Kept deliberately: a lease row that
   * frees the connection would let a second owner in while a slow first one
   * may still broadcast (the F1 double refund). The holders are bounded:
   * the channel scheduler's `refundBlocked` and the held-collection job
   * refund one call at a time (one connection each per process), and an
   * operator's upheld decision holds one for its own request. With the
   * default pool (10 per process) that leaves at least 7 for paid calls;
   * raise the pool before running more refund callers in parallel.
   */
  async withRefundLock<T>(intentId: string, work: () => Promise<T>): Promise<T | null> {
    return this.dataSource.transaction(async (manager) => {
      const [row] = (await manager.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"`,
        [`channel-refund:${intentId}`],
      )) as { locked: boolean }[];
      if (!row?.locked) return null;
      return work();
    });
  }

  /**
   * The block at which a refund's "dropped" verdict was first seen; a second
   * verdict at a later block is required before it is sent again (F2).
   * Returns the stored block (the first time: `block`).
   */
  async noteDropSeen(id: string, block: bigint): Promise<bigint> {
    const result = (await this.manager.query(
      `UPDATE "channel_txs" SET "drop_seen_block" = COALESCE("drop_seen_block", $2::numeric)
        WHERE "id" = $1 RETURNING "drop_seen_block"::text AS "block"`,
      [id, block.toString()],
    )) as unknown;
    const stored = returnedRows<{ block: string | null }>(result)[0]?.block;
    return stored ? BigInt(stored) : block;
  }

  /**
   * Resolves a recorded send. `amount` (refunds): what the piece actually
   * refunded on chain, when it differs from what was recorded (a re-sent
   * piece the chain answered `AlreadyRefunded` for, booked at its landing's
   * amount — MF-1).
   */
  async finishTx(
    id: string,
    status: ChannelTxStatus.LANDED | ChannelTxStatus.PARTIAL | ChannelTxStatus.DROPPED,
    detail: string | null,
    txRef?: string | null,
    amount?: bigint | null,
  ): Promise<void> {
    await this.manager.query(
      `UPDATE "channel_txs"
          SET "status" = $2::varchar, "detail" = $3::varchar,
              "amount" = COALESCE($5::numeric, "amount"),
              "landed_at" = CASE WHEN $2::varchar IN ('LANDED', 'PARTIAL') THEN now() ELSE "landed_at" END,
              "tx_refs" = CASE WHEN $4::text IS NULL OR $4::text = ANY("tx_refs") THEN "tx_refs"
                               ELSE array_append("tx_refs", $4::text) END
        WHERE "id" = $1 AND "status" IN ('PENDING', 'SENT')`,
      [
        id,
        status,
        detail === null ? null : detail.slice(0, 64),
        txRef ?? null,
        amount === undefined || amount === null ? null : amount.toString(),
      ],
    );
  }

  /**
   * A LANDED collect whose payout is booked (re-review L3): `detail = 'booked'`.
   * A LANDED collect without it crashed between the landing and the booking,
   * and is re-booked from its receipt ({@link findUnbookedCollects}).
   */
  async markTxBooked(id: string): Promise<void> {
    await this.manager.query(
      `UPDATE "channel_txs" SET "detail" = 'booked' WHERE "id" = $1 AND "status" = 'LANDED'`,
      [id],
    );
  }

  /** LANDED collects of the last week not booked yet (a crash after the landing). */
  async findUnbookedCollects(assetId: string): Promise<ChannelTxRecord[]> {
    const rows = (await this.manager.query(
      `SELECT * FROM "channel_txs"
        WHERE "asset_id" = $1 AND "kind" = 'COLLECT' AND "status" = 'LANDED' AND "detail" IS NULL
          AND "landed_at" > now() - interval '7 days'
        ORDER BY "landed_at" ASC LIMIT 50`,
      [assetId],
    )) as Array<Record<string, unknown>>;
    return rows.map(toTxRecord);
  }

  /**
   * Σ price of this channel's calls already booked COLLECTED by collect `txRef`
   * (`held_tx_ref`): a re-booking attributes only the rest of the payout.
   */
  async collectedByTx(channelRowId: string, txRef: string): Promise<bigint> {
    const [row] = (await this.manager.query(
      `SELECT COALESCE(SUM("price_amount"), 0)::text AS "sum" FROM "payment_intents"
        WHERE "channel_row_id" = $1 AND "held_status" = 'COLLECTED' AND "held_tx_ref" = $2`,
      [channelRowId, txRef],
    )) as { sum: string }[];
    return BigInt(row?.sum ?? '0');
  }

  /** The live (pending, sent or landed) refund of one call, if any. */
  async findLiveRefund(intentId: string): Promise<ChannelTxRecord | null> {
    const rows = (await this.manager.query(
      `SELECT * FROM "channel_txs"
        WHERE "kind" = 'REFUND' AND "intent_id" = $1 AND "status" IN ('PENDING', 'SENT', 'LANDED')
        LIMIT 1`,
      [intentId],
    )) as Array<Record<string, unknown>>;
    return rows[0] ? toTxRecord(rows[0]) : null;
  }

  /** Every recorded refund of one call (any status), oldest first: its pieces (MF-1). */
  async refundRecords(intentId: string): Promise<ChannelTxRecord[]> {
    const rows = (await this.manager.query(
      `SELECT * FROM "channel_txs" WHERE "kind" = 'REFUND' AND "intent_id" = $1
        ORDER BY "created_at" ASC, "id" ASC`,
      [intentId],
    )) as Array<Record<string, unknown>>;
    return rows.map(toTxRecord);
  }

  /** Collects or refunds sent and not resolved yet, on one asset. */
  async findInFlightTxs(assetId: string, kind: ChannelTxKind): Promise<ChannelTxRecord[]> {
    const rows = (await this.manager.query(
      `SELECT * FROM "channel_txs"
        WHERE "asset_id" = $1 AND "kind" = $2 AND "status" IN ('PENDING', 'SENT')
        ORDER BY "created_at" ASC LIMIT 200`,
      [assetId, kind],
    )) as Array<Record<string, unknown>>;
    return rows.map(toTxRecord);
  }

  /** The sender and nonce of a hash about to be broadcast (idempotent). */
  async recordAttempt(txHash: string, sender: string, nonce: bigint): Promise<void> {
    await this.manager.query(
      `INSERT INTO "channel_tx_attempts" ("tx_hash", "sender", "nonce") VALUES ($1, lower($2), $3)
       ON CONFLICT ("tx_hash") DO NOTHING`,
      [txHash, sender, nonce.toString()],
    );
  }

  /** The recorded sender and nonce of each hash (a hash without a record is absent). */
  async attemptsOf(
    txHashes: readonly string[],
  ): Promise<Map<string, { sender: string; nonce: bigint }>> {
    if (txHashes.length === 0) return new Map();
    const rows = (await this.manager.query(
      `SELECT "tx_hash" AS "hash", "sender", "nonce"::text AS "nonce"
         FROM "channel_tx_attempts" WHERE "tx_hash" = ANY($1::text[])`,
      [[...txHashes]],
    )) as { hash: string; sender: string; nonce: string }[];
    return new Map(rows.map((r) => [r.hash, { sender: r.sender, nonce: BigInt(r.nonce) }]));
  }

  // ── Unpaid payouts (issuer-frozen recipients, review 2026-10-31 M4) ─────

  /** A `TransferDeferred` of a collect: the payout sits in the escrow's `unpaid`. Idempotent. */
  async recordUnpaid(input: {
    assetId: string;
    address: string;
    providerId: string | null;
    amount: bigint;
    txRef: string;
  }): Promise<void> {
    await this.manager.query(
      `INSERT INTO "channel_unpaid_payouts" ("id", "asset_id", "address", "provider_id", "amount", "tx_ref")
       VALUES ($1, $2, lower($3), $4, $5, $6)
       ON CONFLICT ("tx_ref", "address", "amount") DO NOTHING`,
      [
        randomUUID(),
        input.assetId,
        input.address,
        input.providerId,
        input.amount.toString(),
        input.txRef,
      ],
    );
  }

  /** Operator `M-3`: asks the scheduler to claim an address's unpaid payouts. Returns rows marked. */
  async requestClaim(manager: EntityManager, assetId: string, address: string): Promise<number> {
    const result = (await manager.query(
      `UPDATE "channel_unpaid_payouts" SET "claim_requested_at" = COALESCE("claim_requested_at", now())
        WHERE "asset_id" = $1 AND "address" = lower($2) AND "claimed_at" IS NULL
        RETURNING "id"`,
      [assetId, address],
    )) as unknown;
    return affectedRows(result);
  }

  /** The addresses an operator asked to claim for, on one asset. */
  async claimRequests(assetId: string): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT "address" FROM "channel_unpaid_payouts"
        WHERE "asset_id" = $1 AND "claimed_at" IS NULL AND "claim_requested_at" IS NOT NULL`,
      [assetId],
    )) as { address: string }[];
    return rows.map((row) => row.address);
  }

  async markClaimed(assetId: string, address: string, txRef: string | null): Promise<void> {
    await this.manager.query(
      `UPDATE "channel_unpaid_payouts" SET "claimed_at" = now(), "claim_tx_ref" = $3
        WHERE "asset_id" = $1 AND "address" = lower($2) AND "claimed_at" IS NULL`,
      [assetId, address, txRef],
    );
  }

  /** Σ a provider's payouts set aside and not claimed yet (not in its wallet). */
  async unpaidOf(
    providerId: string,
    assetId: string | null,
  ): Promise<{ amount: bigint; since: Date | null }> {
    const [row] = (await this.manager.query(
      `SELECT COALESCE(SUM("amount"), 0)::text AS "amount", MIN("created_at") AS "since"
         FROM "channel_unpaid_payouts"
        WHERE "provider_id" = $1 AND "claimed_at" IS NULL AND ($2::text IS NULL OR "asset_id" = $2)`,
      [providerId, assetId],
    )) as { amount: string; since: Date | string | null }[];
    return {
      amount: BigInt(row?.amount ?? '0'),
      since: row?.since ? new Date(row.since) : null,
    };
  }

  /**
   * The provider's unclaimed unpaid payouts per asset, every asset (frontend
   * L-6: a payout blocked on one asset shows whatever asset the page reads).
   */
  async unpaidByAsset(
    providerId: string,
  ): Promise<Array<{ assetId: string; amount: bigint; since: Date | null }>> {
    const rows = (await this.manager.query(
      `SELECT "asset_id" AS "assetId", SUM("amount")::text AS "amount", MIN("created_at") AS "since"
         FROM "channel_unpaid_payouts"
        WHERE "provider_id" = $1 AND "claimed_at" IS NULL
        GROUP BY "asset_id" HAVING SUM("amount") > 0
        ORDER BY "asset_id"`,
      [providerId],
    )) as { assetId: string; amount: string; since: Date | string | null }[];
    return rows.map((row) => ({
      assetId: row.assetId,
      amount: BigInt(row.amount),
      since: row.since ? new Date(row.since) : null,
    }));
  }

  /** The assets with unpaid payouts an operator asked to claim. */
  async assetsWithClaimRequests(): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT "asset_id" AS "assetId" FROM "channel_unpaid_payouts"
        WHERE "claimed_at" IS NULL AND "claim_requested_at" IS NOT NULL`,
    )) as { assetId: string }[];
    return rows.map((row) => row.assetId);
  }

  // ── The reconciler's foreign-transaction scan position ──────────────────

  async scanCursor(assetId: string): Promise<bigint | null> {
    const [row] = (await this.manager.query(
      `SELECT "scanned_to"::text AS "to" FROM "channel_scan_cursors" WHERE "asset_id" = $1`,
      [assetId],
    )) as { to: string }[];
    return row ? BigInt(row.to) : null;
  }

  async setScanCursor(assetId: string, scannedTo: bigint): Promise<void> {
    await this.manager.query(
      `INSERT INTO "channel_scan_cursors" ("asset_id", "scanned_to") VALUES ($1, $2)
       ON CONFLICT ("asset_id") DO UPDATE
         SET "scanned_to" = GREATEST("channel_scan_cursors"."scanned_to", EXCLUDED."scanned_to"),
             "updated_at" = now()`,
      [assetId, scannedTo.toString()],
    );
  }

  async findSettlement(id: string): Promise<ChannelSettlementEntity | null> {
    return this.manager.findOneBy(ChannelSettlementEntity, { id });
  }

  /**
   * The newest released settlement of `channelRowId` to exactly `toCumulative`:
   * what a lost send bound, so a late landing found on chain is booked with
   * the calls it really charged (review 2026-10-31 H2).
   */
  async findReleasedTo(
    channelRowId: string,
    toCumulative: bigint,
  ): Promise<ChannelSettlementEntity | null> {
    return this.manager
      .createQueryBuilder(ChannelSettlementEntity, 's')
      .where('s.channelRowId = :channelRowId', { channelRowId })
      .andWhere('s.toCumulative = :to', { to: toCumulative.toString() })
      .andWhere(`s.status IN ('DROPPED', 'SKIPPED')`)
      .orderBy('s.createdAt', 'DESC')
      .getOne();
  }

  /**
   * Every released settlement of `channelRowId` to exactly `toCumulative`,
   * newest first: `recoverAhead` books the one whose recorded receipt shows
   * the settle (re-review L2), not merely the newest.
   */
  async releasedTo(channelRowId: string, toCumulative: bigint): Promise<ChannelSettlementEntity[]> {
    return this.manager
      .createQueryBuilder(ChannelSettlementEntity, 's')
      .where('s.channelRowId = :channelRowId', { channelRowId })
      .andWhere('s.toCumulative = :to', { to: toCumulative.toString() })
      .andWhere(`s.status IN ('DROPPED', 'SKIPPED')`)
      .orderBy('s.createdAt', 'DESC')
      .limit(20)
      .getMany();
  }

  /** Settlements sent and not landed or released: landing is retried for them. */
  async findInFlight(assetId: string): Promise<ChannelSettlementEntity[]> {
    return this.manager
      .createQueryBuilder(ChannelSettlementEntity, 's')
      .innerJoin(VoucherChannelEntity, 'c', 'c.id = s.channelRowId')
      .where('c.assetId = :assetId', { assetId })
      .andWhere(`s.status IN ('PENDING', 'SENT')`)
      .orderBy('s.createdAt', 'ASC')
      .getMany();
  }

  async findVoucher(id: string): Promise<ChannelVoucherEntity | null> {
    return this.manager.findOneBy(ChannelVoucherEntity, { id });
  }

  /** A bucket's maturity moved later (`ChannelBucketDeferred`): its held rows move with it. */
  async deferBucket(
    manager: EntityManager,
    channelRowId: string,
    fromHour: number,
    toHour: number,
    takeRateBps: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE "channel_settlements" SET "maturity_hour" = $3
        WHERE "channel_row_id" = $1 AND "maturity_hour" = $2 AND "take_rate_bps" = $4
          AND "status" = 'LANDED'`,
      [channelRowId, fromHour, toHour, takeRateBps],
    );
    await manager.query(
      `UPDATE "payment_intents" SET "collectable_at" = to_timestamp($3::bigint * 3600)
        WHERE "channel_row_id" = $1 AND "held_status" = 'HELD'
          AND "collectable_at" = to_timestamp($2::bigint * 3600)`,
      [channelRowId, fromHour, toHour],
    );
  }

  async recordCollected(channelRowId: string): Promise<void> {
    await this.manager.query(
      `UPDATE "voucher_channels" SET "last_collected_at" = now(), "updated_at" = now() WHERE "id" = $1`,
      [channelRowId],
    );
  }

  async setDeadline(channelRowId: string, deadline: Date | null): Promise<void> {
    await this.manager.query(`UPDATE "voucher_channels" SET "deadline_at" = $2 WHERE "id" = $1`, [
      channelRowId,
      deadline,
    ]);
  }

  /**
   * The take rate the newest landed settlement on `assetId` was charged at
   * (last two days), or `null` (final review MF-9: the scheduler's rate
   * memory after a restart).
   */
  async lastLandedRate(assetId: string): Promise<number | null> {
    const [row] = (await this.manager.query(
      `SELECT s."take_rate_bps" AS "rate" FROM "channel_settlements" s
         JOIN "voucher_channels" c ON c."id" = s."channel_row_id"
        WHERE c."asset_id" = $1 AND s."status" = 'LANDED' AND s."take_rate_bps" IS NOT NULL
          AND s."landed_at" > now() - interval '2 days'
        ORDER BY s."landed_at" DESC LIMIT 1`,
      [assetId],
    )) as { rate: number | string | null }[];
    return row?.rate === null || row?.rate === undefined ? null : Number(row.rate);
  }

  /**
   * Keys of lanes whose stored deadline is less than `withinSeconds` away (or
   * past) while they still hold a served call to settle (ops F2): the deadline
   * alert computed from the database, for a pass that failed before its round.
   */
  async nearDeadline(assetId: string, withinSeconds: number): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT c."channel_key" AS "key" FROM "voucher_channels" c
        WHERE c."asset_id" = $1 AND c."deadline_at" IS NOT NULL
          AND c."deadline_at" < now() + make_interval(secs => $2)
          AND c."last_accepted_cumulative" > c."settled_cumulative"
          AND EXISTS (SELECT 1 FROM "payment_intents" i
                       WHERE i."channel_row_id" = c."id"
                         AND i."channel_cumulative" > c."settled_cumulative"
                         AND i."status" = 'SETTLED' AND i."held_status" IS NULL
                         AND i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL
                         AND i."redemption_lapsed_at" IS NULL
                         AND COALESCE(i."redemption_last_error" NOT LIKE 'provider_forfeit:%'
                                      AND i."redemption_last_error" NOT LIKE 'voided:%', true))
        ORDER BY c."deadline_at" ASC LIMIT 50`,
      [assetId, withinSeconds],
    )) as { key: string }[];
    return rows.map((row) => row.key);
  }

  /** Clears `oldest_unsettled_at` when nothing is pending; otherwise the oldest pending row's admission. */
  async refreshOldestUnsettled(channelRowId: string): Promise<void> {
    await this.manager.query(
      `UPDATE "voucher_channels" c SET "oldest_unsettled_at" = (
         SELECT MIN(i."created_at") FROM "payment_intents" i
          WHERE i."channel_row_id" = c."id" AND i."channel_cumulative" > c."settled_cumulative"
            AND i."hold_released_at" IS NULL AND i."held_at" IS NULL)
        WHERE c."id" = $1`,
      [channelRowId],
    );
  }

  /**
   * Closes a channel with nothing left to settle or hold, idle an hour: every
   * call terminal, none held, no buyer hold open. A step above `settled` whose
   * calls were all refunded or voided is waived by never settling it. Its
   * `deadline_at` is cleared (MF-3): nothing is left for it to be early for.
   */
  async closeIdle(assetId: string): Promise<number> {
    const result = (await this.manager.query(
      `UPDATE "voucher_channels" c SET "status" = 'CLOSED', "deadline_at" = NULL, "updated_at" = now()
        WHERE c."asset_id" = $1 AND c."status" <> 'CLOSED'
          AND c."settling_to" IS NULL
          AND c."updated_at" < now() - interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM "payment_intents" i
                           WHERE i."channel_row_id" = c."id"
                             AND (i."held_status" = 'HELD'
                                  OR i."status" NOT IN ('SETTLED', 'REFUNDED', 'VOIDED', 'EXPIRED')
                                  OR (i."hold_id" IS NOT NULL AND i."hold_released_at" IS NULL)))
        RETURNING c."id"`,
      [assetId],
    )) as unknown;
    return affectedRows(result);
  }

  // ── Provider payout cadence (SPEC-W2 §8) ──────────────────────────────────

  /** Each provider's cadence and last payout; a provider with no row is on the default. */
  async cadenceOf(
    providerIds: readonly string[],
  ): Promise<Map<string, { cadence: string; lastPayoutAt: Date | null; changedAt: Date | null }>> {
    if (providerIds.length === 0) return new Map();
    const rows = (await this.manager.query(
      `SELECT "organization_id" AS "providerId", "payout_cadence" AS "cadence",
              "last_payout_at" AS "lastPayoutAt", "payout_cadence_changed_at" AS "changedAt"
         FROM "providers" WHERE "organization_id" = ANY($1::uuid[])`,
      [[...providerIds]],
    )) as Array<{
      providerId: string;
      cadence: string;
      lastPayoutAt: Date | null;
      changedAt: Date | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.providerId,
        { cadence: row.cadence, lastPayoutAt: row.lastPayoutAt, changedAt: row.changedAt },
      ]),
    );
  }

  async setCadence(providerId: string, cadence: string): Promise<boolean> {
    const result = (await this.manager.query(
      `UPDATE "providers" SET "payout_cadence" = $2, "payout_cadence_changed_at" = now()
        WHERE "organization_id" = $1 RETURNING "id"`,
      [providerId, cadence],
    )) as unknown;
    return affectedRows(result) > 0;
  }

  async markPaidOut(providerIds: readonly string[]): Promise<void> {
    if (providerIds.length === 0) return;
    await this.manager.query(
      `UPDATE "providers" SET "last_payout_at" = now() WHERE "organization_id" = ANY($1::uuid[])`,
      [[...providerIds]],
    );
  }

  // ── Read models ─────────────────────────────────────────────────────────

  /** Per provider: Σ calls awaiting settlement, in the hold, and ready (hold over, not collected). */
  async providerStages(
    providerId: string,
    assetId: string | null,
  ): Promise<{
    awaiting: { amount: bigint; calls: number; oldest: Date | null };
    inHold: { amount: bigint; calls: number; endsAt: Date | null };
    ready: { amount: bigint; calls: number };
    assets: string[];
    /** Per door (SPEC-W2 §8, review 2026-10-31 M2): what is ready, and when holds end. */
    doors: {
      perCall: { ready: bigint; oldestReadyAt: Date | null; holdEndsAt: Date | null };
      channel: { ready: bigint; holdEndsAt: Date | null; active: boolean };
    };
  }> {
    const [row] = (await this.manager.query(
      `SELECT
         COALESCE(SUM("provider_amount") FILTER (WHERE "held_status" IS NULL AND "status" = 'SETTLED'
                   AND "hold_released_at" IS NULL AND "redemption_lapsed_at" IS NULL), 0)::text AS "awaiting",
         COUNT(*) FILTER (WHERE "held_status" IS NULL AND "status" = 'SETTLED'
                   AND "hold_released_at" IS NULL AND "redemption_lapsed_at" IS NULL)::int AS "awaitingCalls",
         MIN("created_at") FILTER (WHERE "held_status" IS NULL AND "status" = 'SETTLED'
                   AND "hold_released_at" IS NULL AND "redemption_lapsed_at" IS NULL) AS "oldest",
         COALESCE(SUM("provider_amount") FILTER (WHERE "held_status" = 'HELD' AND "collectable_at" > now()), 0)::text AS "inHold",
         COUNT(*) FILTER (WHERE "held_status" = 'HELD' AND "collectable_at" > now())::int AS "inHoldCalls",
         MIN("collectable_at") FILTER (WHERE "held_status" = 'HELD' AND "collectable_at" > now()) AS "holdEndsAt",
         COALESCE(SUM("provider_amount") FILTER (WHERE "held_status" = 'HELD' AND "collectable_at" <= now()
                   AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED')), 0)::text AS "ready",
         COUNT(*) FILTER (WHERE "held_status" = 'HELD' AND "collectable_at" <= now()
                   AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED'))::int AS "readyCalls",
         array_agg(DISTINCT "asset_id") AS "assets",
         COALESCE(SUM("provider_amount") FILTER (WHERE "voucher_format" = 'PER_CALL' AND "held_status" = 'HELD'
                   AND "collectable_at" <= now()
                   AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED')), 0)::text AS "pcReady",
         MIN("collectable_at") FILTER (WHERE "voucher_format" = 'PER_CALL' AND "held_status" = 'HELD'
                   AND "collectable_at" <= now()
                   AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED')) AS "pcOldestReady",
         MIN("collectable_at") FILTER (WHERE "voucher_format" = 'PER_CALL' AND "held_status" = 'HELD'
                   AND "collectable_at" > now()) AS "pcHoldEnds",
         COALESCE(SUM("provider_amount") FILTER (WHERE "voucher_format" = 'CHANNEL' AND "held_status" = 'HELD'
                   AND "collectable_at" <= now()
                   AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'REJECTED')), 0)::text AS "chReady",
         MIN("collectable_at") FILTER (WHERE "voucher_format" = 'CHANNEL' AND "held_status" = 'HELD'
                   AND "collectable_at" > now()) AS "chHoldEnds",
         COALESCE(bool_or("voucher_format" = 'CHANNEL' AND "held_status" IS NULL AND "status" = 'SETTLED'
                   AND "hold_released_at" IS NULL AND "redemption_lapsed_at" IS NULL), false) AS "chActive"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND "provider_id" = $1 AND "rail" = 'RAIL_B_VOUCHER'
          AND ($2::text IS NULL OR "asset_id" = $2)
          AND ("held_status" = 'HELD' OR ("status" = 'SETTLED' AND "hold_released_at" IS NULL))`,
      [providerId, assetId],
    )) as Array<Record<string, unknown>>;
    const date = (value: unknown) => (value ? new Date(value as string) : null);
    return {
      awaiting: {
        amount: BigInt(String(row?.awaiting ?? '0')),
        calls: Number(row?.awaitingCalls ?? 0),
        oldest: row?.oldest ? new Date(row.oldest as string) : null,
      },
      inHold: {
        amount: BigInt(String(row?.inHold ?? '0')),
        calls: Number(row?.inHoldCalls ?? 0),
        endsAt: row?.holdEndsAt ? new Date(row.holdEndsAt as string) : null,
      },
      ready: { amount: BigInt(String(row?.ready ?? '0')), calls: Number(row?.readyCalls ?? 0) },
      assets: ((row?.assets as string[] | null) ?? []).filter((a) => a !== null),
      doors: {
        perCall: {
          ready: BigInt(String(row?.pcReady ?? '0')),
          oldestReadyAt: date(row?.pcOldestReady),
          holdEndsAt: date(row?.pcHoldEnds),
        },
        channel: {
          ready: BigInt(String(row?.chReady ?? '0')),
          holdEndsAt: date(row?.chHoldEnds),
          active: row?.chActive === true || row?.chActive === 'true',
        },
      },
    };
  }

  /** Per payer: calls admitted (both doors) whose money is still in the escrow balance. */
  async payerPending(
    payer: string,
    assetId: string,
  ): Promise<{
    amount: bigint;
    calls: number;
    signedLast24h: bigint;
    /** Of `amount`: open buyer debts — never settled from the escrow unless renewed. */
    debt: bigint;
    /** When the oldest non-debt pending call was admitted, or `null`. */
    oldest: Date | null;
    /**
     * Calls whose settlement landed: out of the escrow balance, in the
     * on-chain dispute hold (a channel bucket, or the per-call hold), not
     * collected and not refunded yet (BUG-R2-BUY-01). Not in `amount`.
     */
    onChainHeld: bigint;
    onChainHeldCalls: number;
    /** The latest `collectable_at` of those calls, or `null`. */
    onChainHoldEndsAt: Date | null;
  }> {
    const [row] = (await this.manager.query(
      `SELECT
         COALESCE(SUM("price_amount") FILTER (WHERE "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
                   AND "held_status" IS NULL AND "redemption_lapsed_at" IS NOT NULL
                   AND "redemption_replaced_at" IS NULL), 0)::text AS "debt",
         MIN("created_at") FILTER (WHERE "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
                   AND "held_status" IS NULL AND "status" = 'SETTLED'
                   AND ("redemption_lapsed_at" IS NULL OR "redemption_replaced_at" IS NOT NULL)) AS "oldest",
         COALESCE(SUM("price_amount") FILTER (WHERE "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
                   AND "held_status" IS NULL), 0)::text AS "pending",
         COUNT(*) FILTER (WHERE "hold_id" IS NOT NULL AND "hold_released_at" IS NULL
                   AND "held_status" IS NULL)::int AS "calls",
         COALESCE(SUM("price_amount") FILTER (WHERE "held_status" = 'HELD'
                   AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL), 0)::text AS "onChainHeld",
         COUNT(*) FILTER (WHERE "held_status" = 'HELD'
                   AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL)::int AS "onChainHeldCalls",
         MAX("collectable_at") FILTER (WHERE "held_status" = 'HELD'
                   AND "hold_id" IS NOT NULL AND "hold_released_at" IS NULL) AS "onChainHoldEndsAt",
         COALESCE(SUM("price_amount") FILTER (WHERE "created_at" > now() - interval '24 hours'
                   AND "hold_id" IS NOT NULL
                   AND "status" IN ('FUNDS_SECURED', 'PROVIDER_EXECUTING', 'VERIFYING', 'SETTLED')), 0)::text AS "signed"
         FROM "payment_intents"
        WHERE "organization_id" IS NOT NULL AND "agent_account" = $1 AND "asset_id" = $2
          AND "rail" = 'RAIL_B_VOUCHER'`,
      [payer, assetId],
    )) as Array<Record<string, unknown>>;
    return {
      amount: BigInt(String(row?.pending ?? '0')),
      calls: Number(row?.calls ?? 0),
      signedLast24h: BigInt(String(row?.signed ?? '0')),
      debt: BigInt(String(row?.debt ?? '0')),
      oldest: row?.oldest ? new Date(row.oldest as string) : null,
      onChainHeld: BigInt(String(row?.onChainHeld ?? '0')),
      onChainHeldCalls: Number(row?.onChainHeldCalls ?? 0),
      onChainHoldEndsAt: row?.onChainHoldEndsAt ? new Date(row.onChainHoldEndsAt as string) : null,
    };
  }

  /** Operator view: last settle and collect, open channels, pending of one provider. */
  async providerChannelSummary(providerId: string): Promise<{
    lastSettleAt: Date | null;
    lastCollectAt: Date | null;
    openChannels: number;
    /** The payout address its newest channel pays (`0x…`), or `null` without a channel. */
    payoutAddress?: string | null;
  }> {
    const [row] = (await this.manager.query(
      `SELECT MAX("last_settled_at") AS "lastSettleAt", MAX("last_collected_at") AS "lastCollectAt",
              COUNT(*) FILTER (WHERE "status" <> 'CLOSED')::int AS "open",
              (array_agg(split_part("provider_account", ':', 3) ORDER BY "updated_at" DESC))[1]
                AS "payoutAddress"
         FROM "voucher_channels" WHERE "provider_id" = $1`,
      [providerId],
    )) as Array<Record<string, unknown>>;
    return {
      lastSettleAt: row?.lastSettleAt ? new Date(row.lastSettleAt as string) : null,
      lastCollectAt: row?.lastCollectAt ? new Date(row.lastCollectAt as string) : null,
      openChannels: Number(row?.open ?? 0),
      payoutAddress: (row?.payoutAddress as string | null | undefined) ?? null,
    };
  }

  /** The reconciler's per-channel mirror: Σ HELD rows by channel key. */
  async heldByChannel(assetId: string): Promise<
    Array<{
      channelRowId: string;
      key: string;
      held: bigint;
      settled: bigint;
      accepted: bigint;
      settling: boolean;
    }>
  > {
    const rows = (await this.manager.query(
      `SELECT c."id" AS "channelRowId", c."channel_key" AS "key",
              c."settled_cumulative"::text AS "settled", c."last_accepted_cumulative"::text AS "accepted",
              (c."settling_to" IS NOT NULL) AS "settling",
              COALESCE((SELECT SUM(i."price_amount") FROM "payment_intents" i
                         WHERE i."channel_row_id" = c."id" AND i."held_status" = 'HELD'), 0)::text AS "held"
         FROM "voucher_channels" c
        WHERE c."asset_id" = $1 AND (c."status" <> 'CLOSED' OR EXISTS (
                SELECT 1 FROM "payment_intents" i WHERE i."channel_row_id" = c."id" AND i."held_status" = 'HELD'))
        ORDER BY c."updated_at" DESC
        LIMIT 500`,
      [assetId],
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      channelRowId: String(row.channelRowId),
      key: String(row.key),
      held: BigInt(String(row.held)),
      settled: BigInt(String(row.settled)),
      accepted: BigInt(String(row.accepted)),
      settling: row.settling === true || row.settling === 'true',
    }));
  }

  /**
   * Writes each landed settlement's `collected`, `refunded` and `left_amount`
   * (what still sits in its bucket: `charge − collected − refunded`) from its
   * booked calls, the same rows the reconciler reads (e2e B-4). Only rows that
   * changed are written; idempotent. Returns how many were updated.
   */
  async refreshSettlementTotals(assetId: string): Promise<number> {
    const result = (await this.manager.query(
      `UPDATE "channel_settlements" s
          SET "collected" = t."collected", "refunded" = t."refunded",
              "left_amount" = s."charge" - t."collected" - t."refunded"
         FROM (SELECT s2."id",
                      COALESCE(SUM(i."price_amount") FILTER (WHERE i."held_status" = 'COLLECTED'), 0) AS "collected",
                      COALESCE(SUM(i."price_amount") FILTER (WHERE i."held_status" = 'REFUNDED'), 0) AS "refunded"
                 FROM "channel_settlements" s2
                 JOIN "voucher_channels" c ON c."id" = s2."channel_row_id"
                 LEFT JOIN "payment_intents" i ON i."channel_settlement_id" = s2."id"
                WHERE c."asset_id" = $1 AND s2."status" = 'LANDED'
                GROUP BY s2."id") t
        WHERE s."id" = t."id"
          AND t."collected" + t."refunded" <= s."charge"
          AND (s."collected" <> t."collected" OR s."refunded" <> t."refunded"
               OR s."left_amount" <> s."charge" - t."collected" - t."refunded")
        RETURNING s."id"`,
      [assetId],
    )) as unknown;
    return affectedRows(result);
  }

  /** Per settlement: `collected + refunded ≤ charge` and the held remainder. */
  async settlementIdentityBreaks(assetId: string): Promise<
    Array<{
      settlementId: string;
      charge: bigint;
      collected: bigint;
      refunded: bigint;
      held: bigint;
    }>
  > {
    const rows = (await this.manager.query(
      `SELECT s."id" AS "settlementId", s."charge"::text AS "charge",
              COALESCE(SUM(i."price_amount") FILTER (WHERE i."held_status" = 'COLLECTED'), 0)::text AS "collected",
              COALESCE(SUM(i."price_amount") FILTER (WHERE i."held_status" = 'REFUNDED'), 0)::text AS "refunded",
              COALESCE(SUM(i."price_amount") FILTER (WHERE i."held_status" = 'HELD'), 0)::text AS "held"
         FROM "channel_settlements" s
         JOIN "voucher_channels" c ON c."id" = s."channel_row_id"
         LEFT JOIN "payment_intents" i ON i."channel_settlement_id" = s."id"
        WHERE c."asset_id" = $1 AND s."status" = 'LANDED'
        GROUP BY s."id", s."charge"
       HAVING s."charge" <> COALESCE(SUM(i."price_amount") FILTER (
                WHERE i."held_status" IN ('COLLECTED', 'REFUNDED', 'HELD')), 0)
        LIMIT 50`,
      [assetId],
    )) as Array<Record<string, string>>;
    return rows.map((row) => ({
      settlementId: row.settlementId,
      charge: BigInt(row.charge),
      collected: BigInt(row.collected),
      refunded: BigInt(row.refunded),
      held: BigInt(row.held),
    }));
  }

  /** Distinct provider payout addresses with a channel on `assetId` (for `Σ unpaid`). */
  async providerAddresses(assetId: string): Promise<string[]> {
    const rows = (await this.manager.query(
      `SELECT DISTINCT lower(split_part("provider_account", ':', 3)) AS "address"
         FROM "voucher_channels" WHERE "asset_id" = $1`,
      [assetId],
    )) as { address: string }[];
    return rows.map((row) => row.address);
  }
}

function toTxRecord(row: Record<string, unknown>): ChannelTxRecord {
  return {
    id: String(row.id),
    kind: row.kind as ChannelTxKind,
    assetId: String(row.asset_id),
    intentId: (row.intent_id as string | null) ?? null,
    channelRowIds: (row.channel_row_ids as string[] | null) ?? [],
    amount: row.amount === null || row.amount === undefined ? null : BigInt(String(row.amount)),
    txRefs: (row.tx_refs as string[] | null) ?? [],
    status: row.status as ChannelTxStatus,
    createdAt: new Date(row.created_at as string),
    dropSeenBlock:
      row.drop_seen_block === null || row.drop_seen_block === undefined
        ? null
        : BigInt(String(row.drop_seen_block)),
    pieceIndex:
      row.piece_index === null || row.piece_index === undefined ? null : Number(row.piece_index),
  };
}

/** The rows an `UPDATE … RETURNING` answered (`[rows, count]` from the pg driver). */
function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}

/**
 * The spellings one eip155 CAIP-10 account is stored under (as given, EIP-55
 * checksummed, all lower, all upper hex), so a payer lookup matches every
 * spelling of the same wallet through an index (`= ANY($1)`) instead of
 * `lower(column)` (final review 2026-11-01 F3). Any other account (Solana's
 * base58 is case-sensitive, a malformed id) is matched exactly.
 */
export function accountSpellings(account: string): string[] {
  const match = /^(eip155:[0-9]+:)0x([0-9a-fA-F]{40})$/.exec(account);
  if (!match) return [account];
  const [, prefix, hex] = match;
  return [
    ...new Set([
      account,
      checksummedAccount(account),
      `${prefix}0x${hex.toLowerCase()}`,
      `${prefix}0x${hex.toUpperCase()}`,
    ]),
  ];
}
