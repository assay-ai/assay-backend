import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  AccountBalance,
  AppendEntryInput,
  CreateHoldInput,
  HoldResolution,
  JournalEntry,
  LedgerAccountId,
  LedgerHold,
  SettlementCredit,
} from './ledger.types';

/**
 * The contract the rest of the platform sees.
 *
 * It is written as a port rather than left implicit in the service classes for
 * one reason: the settlement, payment and provider domains will be built
 * against it before the Redis cache and the reconciler exist, and the shape
 * they build against must not change when those land.
 */
export interface LedgerPort {
  // ── Journal ──────────────────────────────────────────────────────────────

  /**
   * Writes one entry immediately, in its own transaction, and returns it.
   *
   * Rejects with `LEDGER_INSUFFICIENT_AVAILABLE_BALANCE` if the entry would
   * take a bucket below zero.
   */
  appendNow(input: AppendEntryInput): Promise<JournalEntry>;

  readJournal(
    organizationId: string,
    filter?: { accountId?: LedgerAccountId; asset?: AssetId; intentId?: string },
  ): Promise<JournalEntry[]>;

  // ── Balances ─────────────────────────────────────────────────────────────

  /** Reads the snapshot — the fast path. */
  getBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance>;

  /** Recomputes the balance from the journal, ignoring the snapshot entirely. */
  rebuildBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance>;

  /**
   * Folds the whole journal and compares it against every stored snapshot.
   *
   * The snapshot is allowed to exist only because this can prove it right.
   */
  verifySnapshots(organizationId: string): Promise<SnapshotVerification>;

  // ── Holds ────────────────────────────────────────────────────────────────

  /**
   * Reserves `money` against `available`.
   *
   * Serialised per `(organization, account, asset)` by a row lock, so two
   * concurrent calls against a balance that funds only one leave exactly one
   * winner and one `LEDGER_INSUFFICIENT_AVAILABLE_BALANCE`.
   */
  createHold(input: CreateHoldInput): Promise<LedgerHold>;

  /** Returns the reservation. Idempotent: releasing twice releases once. */
  releaseHold(organizationId: string, holdId: string): Promise<HoldResolution>;

  /** Consumes the reservation. Idempotent; refuses a released hold. */
  commitHold(organizationId: string, holdId: string): Promise<HoldResolution>;

  /**
   * Consumes the reservation and, in the same transaction, pays the two
   * entries that replace it — `PROVIDER_CREDIT` under the provider's own
   * organization and `PLATFORM_FEE` under `INTERNAL_ACCOUNTS.PLATFORM_FEES`
   * See `LedgerHoldService.commitHoldAndCredit` for why this is not
   * `commitHold` followed by two `append`s. Idempotent: `applied: false` on a
   * hold that was already committed, and the credits are not paid twice.
   */
  commitHoldAndCredit(
    organizationId: string,
    holdId: string,
    credit: SettlementCredit,
  ): Promise<HoldResolution>;

  getHold(organizationId: string, holdId: string): Promise<LedgerHold>;

  // ── Balances (listing) ──────────────────────────────────────────────────

  /** Every snapshot row an organization holds, one balance per asset. */
  listBalances(organizationId: string): Promise<AccountBalance[]>;
}

export interface SnapshotVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly drifts: readonly SnapshotDrift[];
}

export interface SnapshotDrift {
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly asset: AssetId;
  readonly stored: { available: Money; held: Money; pending: Money } | null;
  readonly rebuilt: { available: Money; held: Money; pending: Money };
}
