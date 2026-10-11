import { AccountId, ChainId } from '../../ports/caip.types';

/**
 * The EVM relayer — a NEW port, not a generalised `FeePayerSignerPort`.
 *
 * The two are not the same operation wearing different names. A Solana fee
 * payer **co-signs a transaction the user also signed**; an EVM relayer **sends
 * its own transaction carrying the user's signature as data**. Collapsing them
 * produces a port whose methods mean different things depending on the
 * namespace, which is the leak the `ChainAdapter` abstraction avoids everywhere
 * else. `FeePayerSignerPort` is also Solana-TYPED at the signature level
 * (`signAndSend(rawTransactionBase64)`, `Address` from `@solana/kit`), so there
 * is nothing to reuse even if the semantics matched.
 *
 * ## Why the relayer key satisfies "a leaked env key must not cost users money"
 *
 * **It can never move USDG.** Every money-moving path in `X402Escrow` is
 * authorised by `msg.sender == buyer`, by a buyer's EIP-712 signature, or by a
 * registered verifier's attestation plus a 72-hour timelock. The relayer
 * appears in none of them — only as the *sender* of a call whose authority
 * comes from someone else's signature. `withdraw()` is `msg.sender`-only and
 * pays `msg.sender`, and there is no `withdrawBySig`, by design: the
 * owner is the only party who can take money out, which is what makes a Ledger
 * a sufficient upgrade later.
 *
 * **A leak costs exactly the ETH float in that key**, a number the platform
 * chooses. Target **≤ 0.05 ETH**, topped up on a schedule, and
 * {@link EvmRelayerPort.balanceWei} exists so that the float is observable
 * without anybody reading the key.
 *
 * **A leaked relayer key cannot replay a meta-transaction.** Each `*BySig`
 * carries `escrow.authNonce` and a `deadline`, both inside the signed struct,
 * so re-sending one is a transaction that reverts and costs the attacker gas.
 *
 * ## Why `sendValue` has no calldata parameter
 *
 * It is the only door the withdraw gas grant may use, and a grant that could carry
 * calldata could call `transfer` on USDG — from an account the buyer has
 * approved nothing to, but with the platform's own name on it. The absence is
 * the guarantee: there is no argument to fill in, so no reviewer has to check
 * that nobody did. A `data` field added here "for symmetry" removes the control
 * entirely, and nothing else replaces it.
 */

export interface EvmRelayedCall {
  readonly chainId: ChainId;
  readonly to: AccountId;
  readonly data: `0x${string}`;
  /**
   * Chosen by the caller, never estimated here.
   *
   * `eth_estimateGas` on a batch that is about to revert returns nothing
   * useful, and a relayer that estimated would turn "this redemption is
   * invalid" into "the RPC said no" at a point where the caller can no longer
   * tell the two apart. The caller knows what it is sending and what it costs.
   */
  readonly gasLimit: bigint;
  /** For the journal and the alert. Never used to choose behaviour. */
  readonly purpose: string;
  /**
   * Give the send up, unsent, when it waited in the chain's queue longer than
   * the relayer's `maxQueueWaitMs` (`ChainErrors.relayNotSent`). For a caller
   * that must bound how long the outcome can stay unknown (`evm-relayer-timing.ts`).
   */
  readonly boundQueueWait?: boolean;
}

/** A bare value transfer. NOTE THE ABSENCE OF A CALLDATA FIELD. */
export interface EvmValueTransfer {
  readonly chainId: ChainId;
  readonly to: AccountId;
  readonly wei: bigint;
  readonly purpose: string;
}

export interface EvmRelayResult {
  readonly hash: string;
  readonly status: 'SUCCESS' | 'REVERTED';
  /**
   * The `Errors.sol` name, or `UNKNOWN_REVERT:0x…`. **Never null on REVERTED.**
   *
   * `null` there would let a caller read "we do not know why it failed" as "it
   * did not fail" — the two are one `if (!result.revertReason)` apart, and the
   * money-moving branch is the one that runs.
   */
  readonly revertReason: string | null;
  readonly gasUsed: bigint;
  readonly blockNumber: bigint;
}

export interface EvmRelayerPort {
  readonly name: string;
  address(chainId: ChainId): Promise<AccountId>;
  balanceWei(chainId: ChainId): Promise<bigint>;
  sendCall(call: EvmRelayedCall): Promise<EvmRelayResult>;
  sendValue(transfer: EvmValueTransfer): Promise<EvmRelayResult>;
}

export const EVM_RELAYER = 'EVM_RELAYER';
