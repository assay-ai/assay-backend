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
 *   them). Ten minutes covers a slow signer without leaving a `CREATED` row —
 *   counted in `pendingDeposits` — around for long.
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
