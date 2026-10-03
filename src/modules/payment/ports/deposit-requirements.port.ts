import { ChainId } from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';

/**
 * Everything a client needs to build a deposit transfer itself, per chain.
 *
 * ## Why this is not `UnsignedChainTransaction`
 *
 * Because a deposit is genuinely not one. The other two public surfaces —
 * stake intents and escrow intents — hand the wallet a **compiled** transaction
 * the backend built. A deposit is the opposite: the browser builds the SPL
 * transfer, signs it as the token owner only, and leaves the fee-payer slot
 * empty so the facilitator can pay the gas. There is no `transactionBase64`
 * here because the backend never compiles one. Reusing the transaction union
 * would have meant returning a transaction field that is always absent, which
 * is the shape a discriminated public response exists to refuse.
 *
 * ## Why it is a union, and what the second member is for
 *
 * The first member is Solana-shaped in every field: `payTo` is an SPL
 * associated token account, `feePayer` is the facilitator's fee-payer
 * separation, `memo` is the SPL memo that binds the transfer to the intent, and
 * `blockhash` is a lifetime. On EVM none of those exist. The discriminant was
 * declared with one member so that the second could be **appended** rather than
 * reshaping a public response body a second time; this is that append.
 *
 * Restated because it is the mistake that costs a buyer their money:
 * **a bare transfer to the pooled EVM contract credits nobody and is lost.**
 * So {@link Eip155DepositRequirements} has no `payTo` at all — see it.
 */
export type DepositRequirements = SolanaDepositRequirements | Eip155DepositRequirements;

export type SolanaDepositRequirements = {
  readonly namespace: 'solana';
  readonly chainId: ChainId;
  /**
   * This buyer's own escrow associated token account, chain-native.
   * The backend opened the escrow if it did not exist; the client must not
   * derive its own — it was the pooled treasury vault's ATA before per-buyer
   * escrows and is never that again.
   */
  readonly payTo: string;
  /** The bare mint address, chain-native — this goes into an SPL transfer instruction. */
  readonly asset: string;
  /** Atomic units, as advertised in the `402` requirements. */
  readonly amount: string;
  /** The mint's scale, so the browser can render what it is about to sign. Display only. */
  readonly decimals: number;
  /** The facilitator, which pays the gas and signs last. The client leaves this slot empty. */
  readonly feePayer: string;
  /** The memo binding this transfer to this intent — always equal to `depositId`. */
  readonly memo: string;
  readonly blockhash: string;
  /** Decimal string: a `u64`, and JSON has no such number. */
  readonly lastValidBlockHeight: string;
};

/**
 * What the browser needs to fund an `eip155` escrow — **a contract call, not a
 * destination**.
 *
 * ## There is deliberately no `payTo`
 *
 * A plain ERC-20 `transfer` into `X402Escrow` moves the tokens and
 * credits **nobody** — the contract's per-buyer accounting only moves inside
 * `depositFor`, and there is no contract-level remedy afterwards. A field named
 * `payTo` carrying the escrow address would be an invitation to do exactly
 * that, and the Solana member's `payTo` *is* a send-to address, so a client
 * that read the field without reading the discriminant would be reading the two
 * as the same thing. The union's second member therefore names the contract as
 * {@link contract} and never as a payee. The shape refuses the mistake; a
 * comment would only describe it.
 *
 * ## Two transactions, in this order
 *
 * 1. `approve(spender, amount)` on {@link asset} — the ERC-20 allowance the
 *    escrow will pull against. {@link spender} is the escrow contract and is
 *    carried separately from {@link contract} because "who I approve" and "who
 *    I call" are one address today by construction, not by definition: a
 *    Permit2 path changes the first and not the second, and a client
 *    that had collapsed them would approve the wrong contract.
 * 2. `depositFor(buyer, amount)` on {@link contract}.
 *
 * ## There is no blockhash, no fee payer and no memo
 *
 * An EVM transaction's lifetime is its nonce and its gas price, both of which
 * the wallet supplies; there is nothing for the backend to fetch and nothing to
 * expire. Gas is the buyer's — or the relayer's, through the separate gas-grant
 * path (`EvmGasGrantService`) — and never a co-signature, because EVM has no
 * fee-payer separation. And `depositFor(address,uint64)` has no free field, so
 * there is nowhere for a deposit id to go: the binding this response can offer
 * is the buyer address and the amount, which is what `EvmChainAdapter`
 * .`assertPayloadBoundToIntent` checks and all it can check.
 */
export type Eip155DepositRequirements = {
  readonly namespace: 'eip155';
  readonly chainId: ChainId;
  /**
   * The escrow contract to **call**. Never a transfer destination — see the
   * type comment. Chain-native `0x`, checksummed.
   */
  readonly contract: string;
  /** The function to call on {@link contract}, spelled as its Solidity signature. */
  readonly method: 'depositFor(address,uint64)';
  /** The address to `approve` the allowance to, before calling {@link method}. */
  readonly spender: string;
  /** `depositFor`'s first argument: the address this deposit credits. */
  readonly buyer: string;
  /** The bare ERC-20 token address, chain-native — this is what is approved. */
  readonly asset: string;
  /** Atomic units, as advertised in the `402` requirements. `depositFor`'s second argument. */
  readonly amount: string;
  /** The token's scale, so the browser can render what it is about to sign. Display only. */
  readonly decimals: number;
  /**
   * Always `true`, and stated on the wire rather than only in a doc. A client
   * that renders a "send to" address from this member has already lost the
   * buyer's money; this is the field that says so where a UI author is looking.
   */
  readonly plainTransferCreditsNobody: true;
};

export interface DepositRequirementsInput {
  /** The chain the intent was created on — never a configured default. */
  readonly chainId: ChainId;
  /** The x402 requirements `DepositService.createDeposit` already built. */
  readonly requirements: PaymentRequirements;
  /** The registered scale of the deposit asset, from the asset registry. */
  readonly decimals: number;
}

/**
 * Build the `POST /deposits` response body's `requirements`, on the far side of
 * the `chains/` boundary.
 *
 * The consuming domain declares the interface and `chains/solana/` supplies the
 * implementation — the same arrangement `OnChainStakeReaderPort` and
 * `EscrowIntentBuilderPort` already have, and the reason `DepositsController`
 * imports nothing from `chains/solana/` and no longer reads a blockhash itself.
 */
export interface DepositRequirementsBuilderPort {
  build(input: DepositRequirementsInput): Promise<DepositRequirements>;
}

/** DI token for the bound {@link DepositRequirementsBuilderPort}. */
export const DEPOSIT_REQUIREMENTS_BUILDER = 'DEPOSIT_REQUIREMENTS_BUILDER';
