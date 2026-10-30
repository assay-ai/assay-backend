/**
 * A send the node REFUSED, so the transaction was definitely not broadcast.
 *
 * `eth_sendRawTransaction` failing is usually "outcome unknown": a timeout or a
 * dropped connection says nothing about whether the node took the bytes. A
 * JSON-RPC refusal from the node's own admission checks is the exception. The
 * node rejected the transaction before adding it to its pool, so nobody else
 * can mine it. Each refusal below is classified as definitely not broadcast,
 * and the reasoning for each is written next to it:
 *
 * - `INSUFFICIENT_FUNDS`: `insufficient funds for gas * price + value`. The
 *   pool checks `gasLimit × maxFeePerGas + value` against the sender's balance
 *   before it admits anything. (This is the 2026-10-29 incident.)
 * - `NONCE_TOO_LOW`: the nonce was read at `pending` just before signing, so
 *   another transaction took it in between. Our bytes cannot be mined, because
 *   their nonce is already used.
 * - `NONCE_TOO_HIGH`: the pool refuses a nonce gap and keeps nothing.
 * - `INTRINSIC_GAS_TOO_LOW`: the gas limit does not cover the intrinsic cost.
 *   On Nitro that cost includes the L1 data fee. The transaction can never be
 *   valid, so it is refused outright.
 * - `FEE_CAP_TOO_LOW`: `maxFeePerGas` is below the block basefee. Refused
 *   before admission.
 * - `REPLACEMENT_UNDERPRICED`: a DIFFERENT transaction holds this nonce in the
 *   pool, and ours was refused. Our hash is not in the pool.
 *
 * Not a refusal, on purpose: **`already known`** (or `known transaction`). The
 * node already HAS these exact bytes, so the transaction WAS broadcast.
 * `EvmRelayer` treats it as a successful broadcast and waits for the receipt
 * of the hash it computed. Every other failure (a transport error, an HTTP
 * status, a code with no recognised reason) stays "outcome unknown" and is
 * rethrown as it came.
 *
 * `hash` is the keccak of the signed bytes when they were signed, and `null`
 * when the relayer refused before signing (its own balance pre-check). A hash
 * handed to `beforeBroadcast` and then refused is recorded but never reached
 * the chain. A caller that saw the recorded refs grow MUST read this error as
 * "not broadcast" rather than "may have landed".
 */
export type EvmSendRefusal =
  | 'INSUFFICIENT_FUNDS'
  | 'NONCE_TOO_LOW'
  | 'NONCE_TOO_HIGH'
  | 'INTRINSIC_GAS_TOO_LOW'
  | 'FEE_CAP_TOO_LOW'
  | 'REPLACEMENT_UNDERPRICED';

/** What a node's answer to `eth_sendRawTransaction` means for the broadcast. */
export type EvmSendAnswer = EvmSendRefusal | 'ALREADY_KNOWN';

export class EvmSendRejectedError extends Error {
  /** Always false. A field rather than a convention, so a caller can read it. */
  readonly broadcast = false as const;

  constructor(
    readonly reason: EvmSendRefusal,
    readonly hash: `0x${string}` | null,
    detail?: string,
  ) {
    super(
      `the node refused the transaction (${reason}); it was not broadcast` +
        (detail ? `: ${detail}` : ''),
    );
    this.name = 'EvmSendRejectedError';
  }
}

/**
 * The node's message, matched against a fixed vocabulary. The order matters:
 * `replacement transaction underpriced` is checked before anything looser.
 * Both geth and Nitro use these phrases, with the same JSON-RPC code (-32000)
 * for all of them, so only the message can tell them apart.
 */
const ANSWERS: readonly (readonly [RegExp, EvmSendAnswer])[] = [
  [/already known|known transaction/i, 'ALREADY_KNOWN'],
  [/replacement transaction underpriced/i, 'REPLACEMENT_UNDERPRICED'],
  [/insufficient funds/i, 'INSUFFICIENT_FUNDS'],
  [/nonce too low/i, 'NONCE_TOO_LOW'],
  [/nonce too high/i, 'NONCE_TOO_HIGH'],
  [/intrinsic gas too low/i, 'INTRINSIC_GAS_TOO_LOW'],
  [/(max fee per gas|fee cap|maxfeepergas)[^.]*less than[^.]*base ?fee/i, 'FEE_CAP_TOO_LOW'],
];

/**
 * Classifies one node message. Used by the sanctioned transport, which keeps
 * the tag and drops the message (the node's prose never reaches a log line),
 * and by {@link sendAnswerOf} for a client that keeps the message.
 */
export function classifySendMessage(message: string | undefined | null): EvmSendAnswer | null {
  if (!message) return null;
  for (const [pattern, answer] of ANSWERS) {
    if (pattern.test(message)) return answer;
  }
  return null;
}

/**
 * What an `eth_sendRawTransaction` failure says about the broadcast, or `null`
 * when it says nothing (outcome unknown). Walks the error's `cause` chain,
 * because viem wraps a transport error in its own RPC error class. A
 * `sendAnswer` tag set by the sanctioned transport wins over message text.
 */
export function sendAnswerOf(error: unknown): EvmSendAnswer | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const node = current as {
      sendAnswer?: unknown;
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    if (typeof node.sendAnswer === 'string') return node.sendAnswer as EvmSendAnswer;
    for (const text of [node.details, node.shortMessage, node.message]) {
      const answer = classifySendMessage(typeof text === 'string' ? text : null);
      if (answer !== null) return answer;
    }
    current = node.cause;
  }
  return null;
}

/** Whether `error` is a refusal the node made, so nothing was broadcast. */
export function isSendRejected(error: unknown): error is EvmSendRejectedError {
  return error instanceof EvmSendRejectedError;
}

/** Whether `error` is a refusal for lack of ETH. Every further send fails the same way. */
export function isInsufficientFunds(error: unknown): boolean {
  return error instanceof EvmSendRejectedError && error.reason === 'INSUFFICIENT_FUNDS';
}
