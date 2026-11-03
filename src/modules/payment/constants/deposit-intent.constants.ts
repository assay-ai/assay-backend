import { CronExpression } from '@nestjs/schedule';

import { ChainId, ChainNamespace, parseChainId } from '@modules/chains/ports/caip.types';

/**
 * How long a deposit intent may sit unfunded before the sweep expires it —
 * per chain namespace, because what bounds it is the chain's, not a business
 * rule.
 *
 * - **solana — 90 seconds.** A payment authorization cannot outlive the ~60
 *   second blockhash the client's transaction is signed over
 *   (`SOLANA_MAX_TIMEOUT_SECONDS`). 90 seconds is that bound plus a margin for
 *   request latency and clock skew between this process and the chain — not a
 *   second, independent deadline.
 * - **eip155 — 10 minutes.** An EVM transaction has no blockhash lifetime (its
 *   lifetime is the wallet's nonce and gas price), so nothing on chain expires
 *   and the intent's own `expiresAt` is the only clock. What it must cover is
 *   the buyer: two wallet prompts (`approve`, wait for it to be mined, then
 *   `depositFor`) plus the embedded wallet's session refresh before the first
 *   prompt, which is slow on a cold tab. 90 seconds expired real deposits
 *   mid-flow (BUG-PROD-DEPOSIT-01: a successful retry already used 66 of
 *   them). Ten minutes covers a slow signer without leaving a `CREATED` row
 *   around for long.
 *
 * A longer window weakens nothing else: the intent is still single use (the
 * `CREATED -> SETTLING` CAS and the per-transaction claim), still bound to its
 * organization, buyer and amount, and only an observed on-chain transfer
 * credits it.
 */
export const DEPOSIT_INTENT_TTL_MS: Readonly<Record<ChainNamespace, number>> = {
  [ChainNamespace.SOLANA]: 90 * 1000,
  [ChainNamespace.EIP155]: 10 * 60 * 1000,
};

/**
 * `DEPOSIT_INTENT_TTL_MS` for the chain an intent is on. A namespace with no
 * entry is refused rather than given a guessed lifetime: the bound has to be
 * reasoned about per chain.
 */
export function depositIntentTtlMs(chainId: ChainId): number {
  const namespace = parseChainId(chainId).namespace;
  const ttl = (DEPOSIT_INTENT_TTL_MS as Readonly<Record<string, number>>)[namespace];
  if (ttl === undefined) {
    throw new Error(`No deposit intent lifetime is defined for chain namespace "${namespace}"`);
  }
  return ttl;
}

/** The sweep runs on the scheduler, which is a single instance by design. */
export const DEPOSIT_INTENT_EXPIRY_SWEEP_CRON = CronExpression.EVERY_MINUTE;

/** Deposit intents expired per pass — same bounding reasoning as the payment-intent sweep. */
export const DEPOSIT_INTENT_EXPIRY_SWEEP_BATCH = 200;

/** Written to `status_reason` so the row itself says who moved it and why. */
export const DEPOSIT_INTENT_EXPIRY_REASON =
  'expiry sweep: expiresAt elapsed before the deposit settled';

/**
 * The finality sweep (`DEPOSIT_PENDING` -> `DEPOSIT_CONFIRM` /
 * `DEPOSIT_REJECT`). Every 5 seconds: on eip155 a deposit is credited at the
 * sequencer's soft confirmation (`EVM_DEPOSIT_CONFIRMATIONS`), so this cadence
 * is the whole wait a buyer sees; a pass with nothing pending is one query.
 */
export const DEPOSIT_FINALITY_SWEEP_CRON = '*/5 * * * * *';

/** Settled deposits re-checked per pass — same bounding reasoning as the expiry sweep. */
export const DEPOSIT_FINALITY_SWEEP_BATCH = 200;

/** The x402 `resource` a deposit intent advertises — never a real MCP tool. */
export function depositResource(intentId: string): string {
  return `deposit:${intentId}`;
}

/**
 * How long `settleDeposit` keeps re-reading the chain for a transaction the
 * facilitator has already submitted, before calling it unobserved.
 *
 * The facilitator returns as soon as the RPC *accepts* the transaction, which
 * is before it is confirmed — so the first read almost always misses. Measured
 * on devnet: 25 USDC had moved into the vault and the immediate
 * `getTransaction` at `confirmed` still answered "not found", which marked the
 * deposit FAILED with the money already gone.
 *
 * 20s is comfortably longer than devnet's observed ~211 ms block time takes to
 * confirm, and short enough that a genuinely dead transaction still fails a
 * request rather than hanging it. It is a hard bound — a read still in flight
 * at the deadline is abandoned, and the pause between reads never runs past
 * it — so the window ends at 20s, not at 20s plus one slow read
 * (BUG-PROD-BUY-MONEY-02: 20s checked only between reads answered after 21.5s).
 *
 * Worst case against the web app's 30s request timeout: on
 * `/deposits/:id/broadcast` the window is the only wait — before it, two
 * intent reads and one CAS write; after it, one CAS write — so the request
 * answers in about 20s plus a few database round trips. On `/settle` the
 * facilitator's `verify` and `settle` run first; at their measured ~1.5s the
 * request stays near 22s, which leaves them about 10s before the client gives
 * up. A facilitator call is bounded by its own `FACILITATOR_TIMEOUT_MS`, not
 * by this window.
 */
export const DEPOSIT_OBSERVE_TIMEOUT_MS = 20 * 1000;

/** Gap between those reads. Short — the whole point is to catch confirmation. */
export const DEPOSIT_OBSERVE_POLL_MS = 750;

/**
 * How long the watcher waits after a vault-account notification before
 * sweeping, so a burst becomes one pass.
 *
 * One transaction can move the account more than once and a payout batch moves
 * it many times in a row; every notification means the same thing, so acting on
 * each would be the same query repeated against the same rows. Short enough
 * that it is not what anyone notices next to the 0–5 minutes it replaces.
 *
 * **Unused since per-buyer escrows.** `DepositFinalityWatcher` is disabled
 * unconditionally — see its class comment — and no longer debounces
 * anything. Kept, not deleted, in case a per-buyer accelerator is built on
 * this same shape later.
 */
export const DEPOSIT_WATCH_DEBOUNCE_MS = 1_000;

/**
 * DI token for the CAIP-2 chain whose vault account the watcher subscribes to,
 * from `DEPOSIT_WATCH_CHAIN_ID`.
 *
 * Configured rather than inferred. The chain is otherwise only ever derived
 * from an *asset* on a request (`parseAssetId`), and there is no request here —
 * so the alternative was sniffing `SOLANA_RPC_URL` for the word "devnet",
 * which is the kind of guess that is right until the day it silently is not.
 * Unset means the watcher does not run and the sweep behaves exactly as it did
 * before it existed.
 *
 * **Unused since per-buyer escrows**, for the same reason as
 * `DEPOSIT_WATCH_DEBOUNCE_MS` above.
 */
export const DEPOSIT_WATCH_CHAIN_ID = 'DEPOSIT_WATCH_CHAIN_ID';

/**
 * The smallest deposit, in US dollars. The console has always refused below
 * this ("Minimum $5.00"); the API now does too, so a script or a direct call
 * cannot open an escrow and pay a deposit's network cost for cents. Settlement
 * assets are pegged USD-1:1 (`assertChainMetadata`), so the atomic minimum is
 * this many whole units of the asset.
 */
export const DEPOSIT_MINIMUM_USD = 5;

/**
 * How far before the time bound a buyer-broadcast transaction may have been
 * mined and still be claimed: clock skew between this server and the chain's
 * block timestamps, plus a wallet that broadcast a moment before the response
 * creating the intent arrived.
 *
 * The bound itself is the earliest unsettled deposit intent of the same buyer
 * account created within {@link DEPOSIT_TX_BOUND_LOOKBACK_MS} (see
 * `DepositService.settleDepositByBroadcast`), not only the intent the hash is
 * reported on: the portal re-reports a hash on a fresh intent after the first
 * one expired, and that deposit was made inside the first intent. Anything
 * older is a deposit made outside every intent, and is refused
 * (`PAYMENT_DEPOSIT_TRANSACTION_PREDATES_INTENT`).
 */
export const DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS = 60 * 1000;

/** How far back an unsettled intent still anchors the time bound above. */
export const DEPOSIT_TX_BOUND_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Open deposit intents one agent may hold: `CREATED` or `SETTLING`, still
 * inside the intent's lifetime (`expires_at` in the future). Every intent is a
 * row on the person's funding screen and a chain read when reported; a
 * looping key otherwise creates them without bound. An older `SETTLING` row
 * (stuck, and retried by the finality job) does not lock anyone out.
 */
export const DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT = 5;

/**
 * How long the finality sweep keeps a pending deposit the escrow does not
 * cover before it raises a WARN alert (`deposit_pending_uncovered`), measured
 * from the first pass that saw it uncovered. Covers the platform's own booking
 * lag (a redemption landed before its `HOLD_COMMIT`, a withdrawal claimed
 * before the booker ran). The deposit is never rejected for being uncovered:
 * it stays pending (never spendable), is re-checked with a back-off, and
 * becomes spendable once a check finds the escrow covers it. An operator
 * decides the rest. Also the grace after which `POST /deposits` refuses a new
 * intent for that account (`PAYMENT_DEPOSIT_ESCROW_SHORTFALL`).
 */
export const DEPOSIT_UNCOVERED_ALERT_AFTER_MS = 15 * 60 * 1000;

/**
 * Back-off of an uncovered deposit in the finality queue (H-1, round 3): the
 * next check is as far away as the deposit has been uncovered so far, within
 * these bounds, so the interval doubles from 30 s up to 10 min.
 */
export const DEPOSIT_UNCOVERED_BACKOFF_MIN_MS = 30 * 1000;
export const DEPOSIT_UNCOVERED_BACKOFF_MAX_MS = 10 * 60 * 1000;

/** How long one uncovered deposit's alert stays quiet after paging. */
export const DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * A `SETTLING` intent untouched for this long is no longer owned by a live
 * request (the longest one, observation included, answers within about 30 s)
 * and is resumed by the finality job (`DepositService.resumeStuckSettling`).
 */
export const DEPOSIT_SETTLING_STALE_MS = 2 * 60 * 1000;

/**
 * A stuck `SETTLING` intent whose transaction the chain still does not know
 * (no receipt) is failed after this long. Its hash is not burned: a
 * transaction that lands later is named by the reconciler
 * (`ESCROW_UNCREDITED_DEPOSIT`) and can be reported again. One that never
 * recorded a transaction is NOT failed: past this long it is alerted for
 * operator review (`deposit_settling_needs_review`), since nothing can tell
 * whether its deposit landed.
 */
export const DEPOSIT_SETTLING_GIVE_UP_MS = 60 * 60 * 1000;

/**
 * Stuck `SETTLING` intents resumed per pass, and how long one resume pass may
 * run before it stops and leaves the rest to the next (M-1, round 3). Each
 * read is capped at `DEPOSIT_OBSERVE_TIMEOUT_MS`; during an RPC outage a
 * bigger batch only multiplies reads against a failing endpoint.
 */
export const DEPOSIT_SETTLING_RESUME_BATCH = 20;
export const DEPOSIT_SETTLING_RESUME_BUDGET_MS = 60 * 1000;
