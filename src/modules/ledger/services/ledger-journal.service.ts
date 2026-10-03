import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import {
  AccountBalanceRepository,
  BalanceRowDelta,
  rowKeyOf,
} from '@database/postgres/repositories/account-balance.repository';
import {
  JournalFilter,
  LedgerEntryRepository,
} from '@database/postgres/repositories/ledger-entry.repository';
import { AssetId, isAccountId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { Money } from '@modules/chains/ports/money.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  BALANCE_LOW_THRESHOLD_MAJOR_UNITS,
  BALANCE_LOW_THRESHOLD_MAJOR_UNITS_ENV,
} from '../constants/balance-notification.constants';
import { addDelta, deltaOf } from '../domain/ledger-entry-effect';
import { LedgerErrors } from '../errors/ledger.errors';
import {
  AppendEntryInput,
  BalanceDelta,
  JournalEntry,
  LedgerAccountId,
  LedgerEntryType,
  ZERO_DELTA,
  isLedgerAccountId,
} from '../ports/ledger.types';
import { runInLedgerTransaction } from './ledger-transaction.util';

/** An entry with its identity assigned, ready to be written. */
export interface PreparedEntry extends AppendEntryInput {
  readonly id: string;
  readonly batchId: string | null;
}

/**
 * The journal, and the one place a balance is allowed to change.
 *
 * Nothing else in the module writes `ledger_entries` or `account_balances`.
 * That is deliberate: the pairing of "an entry was written" with "the snapshot
 * moved by exactly that entry's delta" is the invariant the whole design rests
 * on, and it can only be guaranteed if there is a single function that does
 * both, in one transaction, under one lock.
 */
@Injectable()
export class LedgerJournalService {
  private readonly logger = new Logger(LedgerJournalService.name);

  constructor(
    private readonly entries: LedgerEntryRepository,
    private readonly balances: AccountBalanceRepository,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    // Optional, not required: a long list of `test/integration/helpers/*`
    // construct this class with `new LedgerJournalService(a, b, c)` directly,
    // outside DI, and widening them all is not worth it. In the running
    // app `NotificationModule` is always imported (see `ledger.module.ts`), so
    // this is never actually undefined there — only in a raw construction that
    // has no notification port to give it.
    @Optional()
    @Inject(NOTIFICATION_PORT)
    private readonly notifications?: NotificationPort,
  ) {}

  /** Assigns identity and validates an input before it can be written or buffered. */
  prepare(input: AppendEntryInput, batchId: string | null = null): PreparedEntry {
    if (!isLedgerAccountId(input.accountId)) {
      throw LedgerErrors.invalidAccountId({ value: input.accountId });
    }

    // The scale is registered, not supplied. A caller quoting USDC at 9
    // decimals is off by a factor of a thousand, and the only moment that is
    // cheap to notice is before it reaches the journal.
    const registered = getAssetMetadata(input.money.asset).decimals;
    if (input.money.decimals !== registered) {
      throw LedgerErrors.assetMismatch({
        expected: `${input.money.asset}@${registered}`,
        actual: `${input.money.asset}@${input.money.decimals}`,
      });
    }

    return {
      ...input,
      id: randomUUID(),
      intentId: input.intentId ?? null,
      holdId: input.holdId ?? null,
      chainTxRef: input.chainTxRef ?? null,
      batchId,
    };
  }

  /** Writes one entry in its own transaction. */
  async appendNow(input: AppendEntryInput): Promise<JournalEntry> {
    const prepared = this.prepare(input);
    const [written] = await runInLedgerTransaction(
      this.dataSource,
      (queryRunner) => this.applyEntries(queryRunner, input.organizationId, [prepared]),
      this.logger,
    );
    return written;
  }

  /**
   * Writes entries and moves the snapshots they imply — atomically.
   *
   * Runs inside the caller's transaction so a hold's entry and the hold row
   * itself commit together, and so a batch of five hundred entries is one
   * all-or-nothing unit.
   *
   * The sequence is fixed: materialise the rows, lock them **in key order**,
   * check every resulting bucket, then write. Checking before the lock would be
   * a time-of-check-to-time-of-use bug; locking in an unstable order would
   * deadlock two flushes touching the same accounts in different orders.
   */
  async applyEntries(
    queryRunner: QueryRunner,
    organizationId: string,
    prepared: readonly PreparedEntry[],
  ): Promise<JournalEntry[]> {
    if (prepared.length === 0) {
      return [];
    }

    const groups = this.groupByBalance(prepared);
    const keys = [...groups.values()].sort(
      (a, b) => a.accountId.localeCompare(b.accountId) || a.assetId.localeCompare(b.assetId),
    );

    await this.balances.ensureRows(organizationId, keys, queryRunner);
    const locked = await this.balances.lockRows(organizationId, keys, queryRunner);

    // Before and after `available`, per account — the crossing edge
    // `notifyBalanceCrossings` needs, gathered here because this is the only
    // place both numbers exist together under the row lock. Recomputing
    // "before" from a later read would race the very write this method is
    // making.
    const crossings: BalanceCrossing[] = [];

    for (const group of keys) {
      const row = locked.get(rowKeyOf(group.accountId, group.assetId));
      const current: BalanceDelta = row
        ? {
            available: BigInt(row.available),
            held: BigInt(row.held),
            pending: BigInt(row.pending),
          }
        : ZERO_DELTA;
      const next = addDelta(current, group.delta);

      this.assertApplicable(group, current, next);

      crossings.push({
        accountId: group.accountId,
        assetId: group.assetId,
        decimals: group.decimals,
        before: current.available,
        after: next.available,
      });
    }

    const rows = prepared.map((entry) => this.toRow(entry));
    await this.entries.appendMany(rows, queryRunner);

    const deltas: BalanceRowDelta[] = keys.map((group) => ({
      accountId: group.accountId,
      assetId: group.assetId,
      decimals: group.decimals,
      available: group.delta.available,
      held: group.delta.held,
      pending: group.delta.pending,
    }));
    const updated = await this.balances.applyDeltas(organizationId, deltas, queryRunner);

    // Every key was locked a moment ago, so every key must have been updated.
    // A mismatch means a row the transaction was holding disappeared — there is
    // no correct way to continue from that, so it aborts the whole unit.
    if (updated !== deltas.length) {
      throw LedgerErrors.snapshotDrift({
        detail: `applied ${updated} of ${deltas.length} balance rows`,
      });
    }

    // Fire-and-forget, deliberately not `await`ed and deliberately placed
    // after every write has succeeded rather than inside the loop above.
    //
    // `applyEntries` runs inside the *caller's* transaction — the row lock
    // this method took is released only when that transaction commits, well
    // after this function returns. `notify()` writes its own row through its
    // own repository and, per `NotificationPort`'s own contract, never throws
    // and never blocks on a slow channel. Awaiting it here would hold the
    // caller's transaction (and the lock backing it) open for work that has
    // nothing to do with the ledger invariant this method exists to guarantee,
    // and a notification failure must never roll back money that has already
    // moved. The one thing this ordering does not buy is a guarantee that the
    // notification never precedes the enclosing transaction's commit — an
    // accepted, narrow race, given `notify()` is itself best-effort by design.
    this.notifyBalanceCrossings(organizationId, crossings).catch((error) => {
      this.logger.warn(`Balance-crossing notification failed: ${describeError(error)}`);
    });

    return prepared.map((entry, index) => this.toJournalEntry(entry, rows[index]));
  }

  async readJournal(
    organizationId: string,
    filter: JournalFilter = {},
    queryRunner?: QueryRunner,
  ): Promise<JournalEntry[]> {
    const rows = await this.entries.readJournal(organizationId, filter, queryRunner);
    return rows.map((row) => fromRow(row));
  }

  // ── balance.low / balance.zero ──────────────────────────────────────────

  /**
   * Emits `balance.low` / `balance.zero` for every account whose `available`
   * bucket crossed a threshold **downward** on this write.
   *
   * Only real, addressable accounts — a provider's or an agent's own CAIP
   * wallet — have an organization to notify; `LedgerAccountId`'s internal
   * accounts (`platform:fees`, `platform:insurance`, `platform:external`) are
   * the platform's own book and are skipped. The two events are independent
   * crossings, not mutually exclusive: a write that takes an account from
   * above the low-balance threshold straight to zero fires both, because both
   * are true statements a customer needs told.
   */
  private async notifyBalanceCrossings(
    organizationId: string,
    crossings: readonly BalanceCrossing[],
  ): Promise<void> {
    if (!this.notifications) {
      return;
    }

    for (const crossing of crossings) {
      if (!isAccountId(crossing.accountId) || crossing.before === crossing.after) {
        continue;
      }

      const crossedZero = crossing.before > 0n && crossing.after <= 0n;
      const thresholdAtomic = lowBalanceThresholdAtomic(crossing.decimals);
      const crossedLow = crossing.before >= thresholdAtomic && crossing.after < thresholdAtomic;

      if (!crossedZero && !crossedLow) {
        continue;
      }

      const asset = crossing.assetId as AssetId;
      const afterMoney = MoneyUtil.of(
        crossing.after < 0n ? 0n : crossing.after,
        asset,
        crossing.decimals,
      );
      const formatted = MoneyUtil.format(afterMoney, {
        symbol: getAssetMetadata(asset).symbol,
      });

      if (crossedZero) {
        await this.notifications.notify({
          organizationId,
          event: NotificationEvent.BALANCE_ZERO,
          title: 'Balance reached zero',
          body: `Your available balance has reached zero (${formatted}). Paid calls will fail until you add funds.`,
          subjectType: 'account_balance',
          subjectId: crossing.accountId,
          payload: { accountId: crossing.accountId, asset, available: afterMoney.amount },
          dedupeKey: `${crossing.accountId}:${asset}`,
        });
      }

      if (crossedLow) {
        await this.notifications.notify({
          organizationId,
          event: NotificationEvent.BALANCE_LOW,
          title: 'Balance running low',
          body: `Your available balance is running low (${formatted}). Add funds to avoid interrupted calls.`,
          subjectType: 'account_balance',
          subjectId: crossing.accountId,
          payload: { accountId: crossing.accountId, asset, available: afterMoney.amount },
          dedupeKey: `${crossing.accountId}:${asset}`,
        });
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private groupByBalance(prepared: readonly PreparedEntry[]): Map<string, BalanceGroup> {
    const groups = new Map<string, BalanceGroup>();

    for (const entry of prepared) {
      const key = rowKeyOf(entry.accountId, entry.money.asset);
      const delta = deltaOf(entry.entryType, MoneyUtil.toAtomic(entry.money));
      const existing = groups.get(key);

      if (!existing) {
        groups.set(key, {
          accountId: entry.accountId,
          assetId: entry.money.asset,
          decimals: entry.money.decimals,
          delta,
        });
        continue;
      }

      if (existing.decimals !== entry.money.decimals) {
        throw LedgerErrors.assetMismatch({
          expected: `${entry.money.asset}@${existing.decimals}`,
          actual: `${entry.money.asset}@${entry.money.decimals}`,
        });
      }
      existing.delta = addDelta(existing.delta, delta);
    }

    return groups;
  }

  /**
   * Refuses a batch that would drive a bucket below zero.
   *
   * `available` underflow is a caller-facing 409 — the account genuinely cannot
   * afford this, and a payment path is expected to handle it. `held` or
   * `pending` underflow is a 500: those buckets are only ever reduced by the
   * hold machinery, so a shortfall there means the ledger's own bookkeeping is
   * wrong and no caller can do anything sensible with the news.
   */
  private assertApplicable(group: BalanceGroup, current: BalanceDelta, next: BalanceDelta): void {
    if (next.available < 0n) {
      throw LedgerErrors.insufficientAvailableBalance({
        accountId: group.accountId,
        asset: group.assetId,
        required: (-group.delta.available).toString(),
        available: current.available.toString(),
      });
    }

    if (next.held < 0n || next.pending < 0n) {
      throw LedgerErrors.negativeBalance({
        accountId: group.accountId,
        asset: group.assetId,
        buckets: [next.held < 0n ? 'held' : null, next.pending < 0n ? 'pending' : null]
          .filter(Boolean)
          .join(', '),
        available: next.available.toString(),
        held: next.held.toString(),
        pending: next.pending.toString(),
      });
    }
  }

  private toRow(entry: PreparedEntry): Partial<LedgerEntryEntity> {
    return {
      id: entry.id,
      organizationId: entry.organizationId,
      accountId: entry.accountId,
      entryType: entry.entryType,
      amount: entry.money.amount,
      assetId: entry.money.asset,
      decimals: entry.money.decimals,
      intentId: entry.intentId ?? null,
      holdId: entry.holdId ?? null,
      batchId: entry.batchId,
      chainTxRef: entry.chainTxRef ?? null,
    };
  }

  private toJournalEntry(entry: PreparedEntry, row: Partial<LedgerEntryEntity>): JournalEntry {
    return {
      id: entry.id,
      // `seq` is assigned by Postgres and is not read back on the write path —
      // the writer never needs it, and returning it would cost a round trip on
      // every batch. `readJournal` carries the real value.
      seq: '',
      organizationId: entry.organizationId,
      accountId: entry.accountId,
      entryType: entry.entryType,
      money: entry.money,
      intentId: row.intentId ?? null,
      holdId: row.holdId ?? null,
      batchId: row.batchId ?? null,
      chainTxRef: row.chainTxRef ?? null,
      createdAt: new Date(),
    };
  }
}

interface BalanceGroup {
  readonly accountId: LedgerAccountId;
  readonly assetId: AssetId;
  readonly decimals: number;
  delta: BalanceDelta;
}

/** `available`, before and after one `applyEntries` call, for one balance row. */
interface BalanceCrossing {
  readonly accountId: LedgerAccountId;
  readonly assetId: AssetId;
  readonly decimals: number;
  readonly before: bigint;
  readonly after: bigint;
}

/**
 * {@link BALANCE_LOW_THRESHOLD_MAJOR_UNITS} (or its env override), scaled to
 * one asset's atomic units.
 *
 * Read from `process.env` directly rather than through `ConfigService` — the
 * same choice `asset-registry.ts`'s `resolveDevnetUsdcMint` makes — because
 * this value is read only from inside a fire-and-forget notification path,
 * not from anything `ConfigModule`-injected already reaches.
 */
function lowBalanceThresholdAtomic(decimals: number): bigint {
  const raw = process.env[BALANCE_LOW_THRESHOLD_MAJOR_UNITS_ENV];
  const majorUnits =
    raw && Number.isFinite(Number(raw)) && Number(raw) >= 0
      ? Number(raw)
      : BALANCE_LOW_THRESHOLD_MAJOR_UNITS;
  return BigInt(Math.round(majorUnits * 10 ** decimals));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rehydrates a stored row into the domain shape, `Money` and all. */
export function fromRow(row: LedgerEntryEntity): JournalEntry {
  const money: Money = MoneyUtil.of(row.amount, row.assetId as AssetId, row.decimals);
  return {
    id: row.id,
    seq: String(row.seq),
    organizationId: row.organizationId,
    accountId: row.accountId as LedgerAccountId,
    entryType: row.entryType as LedgerEntryType,
    money,
    intentId: row.intentId,
    holdId: row.holdId,
    batchId: row.batchId,
    chainTxRef: row.chainTxRef,
    createdAt: row.createdAt,
  };
}
