import { AccountId, AssetId, isAccountId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * The vocabulary of the journal.
 *
 * Every movement of value in the platform is one of these, and nothing else
 * writes to `ledger_entries`. Adding a member here is adding a way for money to
 * move, so each one must also declare its effect in `LEDGER_ENTRY_EFFECTS` —
 * the compiler refuses a member without one.
 *
 * The hold-open entry is often called `HOLD`; it is `HOLD_CREATE` here so the
 * three hold verbs read as one family at a grep, and so `HOLD` never reads
 * ambiguously as "the hold" (the row) versus "the opening of a hold" (the
 * entry).
 */
export enum LedgerEntryType {
  /** Agent funds observed on-chain but not yet final — spendable by nobody. */
  DEPOSIT_PENDING = 'DEPOSIT_PENDING',
  /** A pending deposit reached finality; `pending` becomes `available`. */
  DEPOSIT_CONFIRM = 'DEPOSIT_CONFIRM',
  /** A pending deposit was reorganised away; `pending` is withdrawn. */
  DEPOSIT_REJECT = 'DEPOSIT_REJECT',
  /** Funds that arrived already final — credited straight to `available`. */
  DEPOSIT = 'DEPOSIT',

  /** Reserve for an in-flight call: `available` → `held`. */
  HOLD_CREATE = 'HOLD_CREATE',
  /** Call failed or errored: `held` → `available`, agent made whole. */
  HOLD_RELEASE = 'HOLD_RELEASE',
  /** Call passed: `held` is consumed and leaves the account. */
  HOLD_COMMIT = 'HOLD_COMMIT',

  PROVIDER_CREDIT = 'PROVIDER_CREDIT',
  PLATFORM_FEE = 'PLATFORM_FEE',
  SLASH_DISTRIBUTION = 'SLASH_DISTRIBUTION',
  PROMOTIONAL_CREDIT = 'PROMOTIONAL_CREDIT',

  /** Provider earnings leaving to their own wallet. */
  PAYOUT = 'PAYOUT',
  /** Agent balance leaving to their own wallet. */
  WITHDRAWAL = 'WITHDRAWAL',

  /**
   * A buyer's balance moving from the pooled Squads treasury vault into that
   * buyer's own `["escrow", buyer]` PDA.
   *
   * It exists for **exactly one migration** and has no writer in ordinary
   * operation: the cutover is a human runbook driven through Squads, and this
   * is the entry a human's confirmed signature is booked as. It is not a
   * deposit — folding it into `DEPOSIT` would make the deposit history lie
   * about where the money came from — and it is not a withdrawal, because the
   * money never leaves the platform's custody.
   *
   * Its effect is the zero delta: the buyer's balance does not change, only
   * where it is custodied. What the entry buys is a row in the journal naming
   * the transaction that moved it, so the reconciler can join the pooled
   * vault's outflow to each escrow's inflow.
   */
  MIGRATION_TRANSFER = 'MIGRATION_TRANSFER',
}

/**
 * The lifecycle of a hold. `OPEN` is the only non-terminal state, and the only
 * one from which value can still move.
 */
export enum LedgerHoldStatus {
  OPEN = 'OPEN',
  RELEASED = 'RELEASED',
  COMMITTED = 'COMMITTED',
}

/**
 * The three buckets a balance splits into.
 *
 * `available` is what may be spent or held. `held` is reserved against an
 * in-flight call and is spendable by nobody until the hold resolves. `pending`
 * is inbound value that has been observed but not finalised — it belongs to the
 * account and shows in its total, but cannot be reserved against.
 *
 * A delta is signed; a *balance* never is. Every bucket of every account is
 * `>= 0`, enforced in Postgres by a CHECK constraint as the last line of
 * defence under the application check.
 */
export interface BalanceDelta {
  readonly available: bigint;
  readonly held: bigint;
  readonly pending: bigint;
}

export const ZERO_DELTA: BalanceDelta = { available: 0n, held: 0n, pending: 0n };

/** A balance as the caller sees it — three `Money` values on one asset. */
export interface AccountBalance {
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly asset: AssetId;
  readonly decimals: number;
  readonly available: Money;
  readonly held: Money;
  readonly pending: Money;
  /** `available + held + pending` — what the account owns in total. */
  readonly total: Money;
}

/**
 * A written journal entry, as read back.
 *
 * `seq` is a gapless-per-insert BIGSERIAL and is the only total order over the
 * journal: `createdAt` has microsecond ties under batch insert, and a UUID
 * primary key has no order at all. A rebuild reads by `seq`.
 */
export interface JournalEntry {
  readonly id: string;
  readonly seq: string;
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly entryType: LedgerEntryType;
  readonly money: Money;
  readonly intentId: string | null;
  readonly holdId: string | null;
  readonly batchId: string | null;
  readonly chainTxRef: string | null;
  readonly createdAt: Date;
}

/** Everything the caller supplies; the ledger owns `id`, `seq` and `createdAt`. */
export interface AppendEntryInput {
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly entryType: LedgerEntryType;
  readonly money: Money;
  readonly intentId?: string | null;
  readonly holdId?: string | null;
  readonly chainTxRef?: string | null;
}

export interface CreateHoldInput {
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly money: Money;
  /** The call this hold is reserved for. At most one open hold per intent. */
  readonly intentId: string;
  readonly expiresAt?: Date;
}

export interface LedgerHold {
  readonly id: string;
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly money: Money;
  readonly status: LedgerHoldStatus;
  readonly intentId: string;
  readonly createEntryId: string;
  readonly resolveEntryId: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * What `commitHoldAndCredit` writes alongside the `HOLD_COMMIT`.
 *
 * The settlement flow is `PASS →
 * HOLD_COMMIT + PROVIDER_CREDIT + PLATFORM_FEE`, in one transaction, or the
 * held value leaves the agent's book with nothing replacing it on the
 * provider's or the platform's — a reserves breach the 5-minute reconciler
 * pages on, not a bookkeeping nicety.
 *
 * `providerOrganizationId` is `payment_intents.provider_id` — the load-bearing
 * assumption `ProviderProfileService` and `ProviderPayoutsService` already
 * rest on: **`providerId === organizationId`**. There is still no second id to
 * key a provider's ledger rows by, so this reuses the one the rest of the
 * provider domain already trusts rather than inventing a second identifier
 * with no row behind it.
 */
export interface SettlementCredit {
  /** The provider's own organization id — see the class comment above. */
  readonly providerOrganizationId: string;
  /** `payment_intents.provider_account` — CAIP-10, non-null exactly when `providerId` is. */
  readonly providerAccountId: LedgerAccountId;
  /** `payment_intents.provider_amount`. `providerAmount + platformFee` must equal the committed hold. */
  readonly providerAmount: Money;
  readonly platformFee: Money;
  /** The intent both credits are attributed to. */
  readonly intentId: string;
  /**
   * **REQUIRED.** The transaction that actually moved the money.
   *
   * On rail B that is the `redeem_voucher` signature; on rail A it is whatever
   * the settling path can name. It is not decoration: it is what makes a
   * `HOLD_COMMIT` a statement about a transaction rather than about an
   * intention, and it is what the reconciler joins on when a buyer's escrow
   * and the mirror disagree.
   *
   * Required rather than optional on purpose — an optional ref is an optional
   * ref, and the first caller that omits it puts the mirror back to being the
   * source of truth by accident.
   */
  readonly chainTxRef: string;
}

/**
 * The `chainTxRef` a **rail-A** commit carries.
 *
 * The ref is required so that no code path can retire a hold without
 * naming the transaction that moved the money. A rail-A commit moves money
 * only in the books, so it has no transaction of its own to name. A NULL there
 * would be indistinguishable from a rail-B commit whose signature somebody
 * forgot to record, so the absence is written down explicitly instead —
 * greppable, and impossible to mistake for a signature.
 *
 * The value keeps its original spelling: `ledger_entries` is append-only, and
 * the rows already written carry it.
 */
export const RAIL_A_BOOK_CREDIT_TX_REF = 'legacy:pooled-vault-no-chain-transfer';

/**
 * The outcome of resolving a hold.
 *
 * `applied` is false when the hold was already in the requested terminal state:
 * the call is a no-op and **no second journal entry was written**. Releasing
 * twice must not return the money twice, and the caller — a retrying worker —
 * must be able to tell "I did it" from "it was already done" without either
 * being an error.
 */
export interface HoldResolution {
  readonly hold: LedgerHold;
  readonly applied: boolean;
}

/**
 * An account identifier in the ledger: CAIP-10 for anything with a wallet, or
 * one of the platform's own internal accounts.
 *
 * Platform fees are a real liability and must sit in the journal like any
 * other, but they have no chain address to be named by.
 *
 * **`INSURANCE_RESERVE` has no writer and no expected one.** It
 * was declared alongside a belief that a slashed penalty's third share funded
 * a reserve; it does not — that share is never taken from the provider's stake
 * at all (see `settlement/domain/ledger-book.ts`). The constant is kept rather
 * than deleted because shadow mode is the one thing that could still
 * need a platform-underwriting account, but nothing today credits or debits
 * it, and slashing never will.
 */
export type LedgerAccountId = AccountId | InternalAccountId;

export type InternalAccountId = (typeof INTERNAL_ACCOUNTS)[keyof typeof INTERNAL_ACCOUNTS];

export const INTERNAL_ACCOUNTS = {
  PLATFORM_FEES: 'platform:fees',
  INSURANCE_RESERVE: 'platform:insurance',
  /** Counterparty for value that has left the platform's books entirely. */
  EXTERNAL: 'platform:external',
} as const;

const INTERNAL_ACCOUNT_VALUES: ReadonlySet<string> = new Set(Object.values(INTERNAL_ACCOUNTS));

export function isLedgerAccountId(value: unknown): value is LedgerAccountId {
  return typeof value === 'string' && (isAccountId(value) || INTERNAL_ACCOUNT_VALUES.has(value));
}

/** The composite key a balance is kept under. */
export interface BalanceKey {
  readonly organizationId: string;
  readonly accountId: LedgerAccountId;
  readonly asset: AssetId;
}

/** Stable, sortable rendering of a `BalanceKey` — used to order lock acquisition. */
export function balanceKeyOf(key: BalanceKey): string {
  return `${key.organizationId}|${key.accountId}|${key.asset}`;
}
