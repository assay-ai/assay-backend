/** SPL Memo v2 — the program whose instruction data binds a payment to its intent. */
export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * How long a Solana `exact` authorization may live.
 *
 * Not a tunable: it follows the blockhash lifetime (~60–90s), which the chain
 * decides and we do not. Base advertises 300 for the same field because
 * `validBefore` is freely chosen there.
 */
export const SOLANA_MAX_TIMEOUT_SECONDS = 60;

/** x402 scheme this adapter advertises and accepts. */
export const SOLANA_PAYMENT_SCHEME = 'exact';

/**
 * Version tag on the canonical payout-proof message.
 *
 * **A withdrawal-authorization message used to lead this file** —
 * `WITHDRAWAL_MESSAGE_VERSION`, `'x402-withdrawal/v1'` — before per-buyer escrows moved
 * the buyer's exit onto a chain transaction the buyer signs directly
 * (`EscrowIntentBuilderPort`; see `ChainAdapter`'s class comment on
 * `buildPayoutProofMessage`). There is no off-chain withdrawal authorization
 * left to distinguish this tag from.
 *
 * Distinct from the voucher's own domain tag, for the confusion that already
 * refuses to allow: "sign this to prove you own this wallet" must never
 * verify as "sign this to pay", in either direction. A payout-proof signature
 * has no value to move, so the failure mode of skipping this would be quieter
 * than a payment's — no funds at risk on its own — but it would still let a
 * signature obtained for one purpose satisfy a security check it was never
 * meant to.
 */
export const PAYOUT_PROOF_MESSAGE_VERSION = 'x402-payout-proof/v1';

/**
 * Version tag on the stake-authority proof.
 *
 * The same argument as the voucher domain tag and `PAYOUT_PROOF_MESSAGE_VERSION`
 * make for themselves: a signature meaning "I control the wallet that opened
 * this stake account" must never verify as "pay" or "this is where you send
 * my earnings". The payout-proof pairing is the closest and the most
 * dangerous — two proofs of key control side by side, differing only in what
 * they authorise — which is why
 * `test/unit/chains/solana/stake-authority-message.spec.ts` asserts both
 * directions against `PAYOUT_PROOF_MESSAGE_VERSION`.
 *
 * What that pair does and does not prove, since the value of this constant
 * is the thing it guards:
 *
 * - It **proves** that a signature collected for one purpose does not satisfy
 *   the other, in the plainest form the assertion can take, and it is what
 *   fails loudly — three tests at once — if the two tags are ever made equal.
 * - It does **not** catch a tag that is a *prefix* of another. The tag leads
 *   the message and is newline-delimited, so two messages are equal exactly
 *   when their two tags are: the two directions are logically equivalent, and
 *   neither is sensitive to a prefix. Verified by mutation — setting this to
 *   `'x402-payout-proof/v1X'` leaves both cross directions green, and the
 *   whole unit suite fails in exactly one place: the
 *   `expect(text).not.toContain(PAYOUT_PROOF_MESSAGE_VERSION)` assertion in
 *   that spec's `leads the message with the version tag`. Nothing else covers
 *   a prefix collision, so that assertion is not the redundant one it looks
 *   like.
 */
export const STAKE_AUTHORITY_MESSAGE_VERSION = 'x402-stake-authority/v1';

/** DI token for the Solana JSON-RPC client. */
/**
 * DI token: the **one** `solana:` chain this deployment serves, as a `ChainId`.
 *
 * Every Solana service here is bound to one `SOLANA_RPC_URL` and
 * one program id, so it already serves exactly one cluster — but until the
 * signing surface went per-chain nothing had to *name* it, and the name was
 * only ever implicit in the RPC URL. `SolanaSlashExecutor` now needs it to say
 * which chain's verifier key it is asking for.
 *
 * Derived from `ENABLED_CHAINS`, and **`null` when that names zero or two**
 * Solana chains — the same shape as `SETTLEMENT_PROGRAM_ID`, and for the same
 * reason: the absence becomes a call-time failure in the one service that
 * needs it rather than a boot failure in every process. Two clusters behind
 * one RPC client is a configuration this deployment has always accepted, so
 * refusing it at boot would remove something that worked.
 *
 * Deliberately not defaulted to devnet — `solana:5eykt4Us…` and
 * `solana:EtWTRABZ…` differ by a mainnet.
 */
export const SOLANA_CHAIN_ID = 'SOLANA_CHAIN_ID';

export const SOLANA_RPC = 'SOLANA_RPC';

/**
 * DI token for the websocket subscriptions client — the `wss://` sibling of
 * `SOLANA_RPC`, provided separately because it is a different transport with a
 * different failure mode and only the watcher needs it.
 */
export const SOLANA_RPC_SUBSCRIPTIONS = 'SOLANA_RPC_SUBSCRIPTIONS';
