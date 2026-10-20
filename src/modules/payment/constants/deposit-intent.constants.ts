import { CronExpression } from '@nestjs/schedule';

/**
 * How long a deposit intent may sit unfunded before the sweep expires it.
 *
 * On Solana a payment authorization
 * cannot outlive the ~60 second blockhash the client's transaction is signed
 * over (`SOLANA_MAX_TIMEOUT_SECONDS`). 90 seconds is that bound plus a margin
 * for request latency and clock skew between this process and the chain —
 * not a second, independent deadline. The bound is chain-dependent, so once
 * another chain's deposits use it this stops being a single constant.
 */
export const DEPOSIT_INTENT_TTL_MS = 90 * 1000;

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
 * request rather than hanging it.
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
