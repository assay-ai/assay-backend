/**
 * How long one relayed send can take, from config (BUG-D1-07 review, finding 2).
 *
 * The relayer serialises every send of a chain through one queue (voucher
 * redemption batches, gas grants, slashes, relayed buyer requests) and then
 * waits for the receipt. A caller that must know when the outcome of a send is
 * settled — the admission pause around a relayed tightening — bounds it with
 * {@link relayedSendBudgetMs}, which is computed from the same two settings the
 * relayer itself obeys, so the two cannot drift apart.
 */

/** How long `waitForTransactionReceipt` waits, in ms. Passed to viem explicitly. */
export const EVM_RELAYER_RECEIPT_TIMEOUT_MS_ENV = 'EVM_RELAYER_RECEIPT_TIMEOUT_MS';

/**
 * How long a send that asks for it may wait in the chain's queue before it is
 * given up WITHOUT being broadcast, in ms.
 */
export const EVM_RELAYER_MAX_QUEUE_WAIT_MS_ENV = 'EVM_RELAYER_MAX_QUEUE_WAIT_MS';

/** viem's own default, made explicit. */
export const DEFAULT_EVM_RELAYER_RECEIPT_TIMEOUT_MS = 180_000;

export const DEFAULT_EVM_RELAYER_MAX_QUEUE_WAIT_MS = 120_000;

/**
 * The RPC calls of one send besides the receipt wait (nonce, fees, broadcast,
 * the revert-reason re-run), each bounded by the transport's own timeout and
 * retries. Generous on purpose: too long only keeps a pause a little longer.
 */
export const EVM_RELAYER_SEND_RPC_ALLOWANCE_MS = 60_000;

export interface EvmRelayerTiming {
  readonly receiptTimeoutMs: number;
  readonly maxQueueWaitMs: number;
}

export const DEFAULT_EVM_RELAYER_TIMING: EvmRelayerTiming = {
  receiptTimeoutMs: DEFAULT_EVM_RELAYER_RECEIPT_TIMEOUT_MS,
  maxQueueWaitMs: DEFAULT_EVM_RELAYER_MAX_QUEUE_WAIT_MS,
};

/** The two settings, from `get` (a `ConfigService.get` or `process.env` lookup). */
export function readEvmRelayerTiming(get: (key: string) => string | undefined): EvmRelayerTiming {
  return {
    receiptTimeoutMs: positiveMs(
      get(EVM_RELAYER_RECEIPT_TIMEOUT_MS_ENV),
      EVM_RELAYER_RECEIPT_TIMEOUT_MS_ENV,
      DEFAULT_EVM_RELAYER_RECEIPT_TIMEOUT_MS,
    ),
    maxQueueWaitMs: positiveMs(
      get(EVM_RELAYER_MAX_QUEUE_WAIT_MS_ENV),
      EVM_RELAYER_MAX_QUEUE_WAIT_MS_ENV,
      DEFAULT_EVM_RELAYER_MAX_QUEUE_WAIT_MS,
    ),
  };
}

/**
 * The longest a send that bounds its queue wait can take before its outcome is
 * known: the queue wait, every RPC call of the send, and the receipt wait.
 * After this the send has either answered or timed out.
 */
export function relayedSendBudgetMs(timing: EvmRelayerTiming): number {
  return timing.maxQueueWaitMs + EVM_RELAYER_SEND_RPC_ALLOWANCE_MS + timing.receiptTimeoutMs;
}

function positiveMs(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds, got ${raw}`);
  }
  return value;
}
