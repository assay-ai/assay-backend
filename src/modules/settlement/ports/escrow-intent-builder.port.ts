import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { EscrowLimits } from '@modules/chains/ports/escrow.types';
import { Money } from '@modules/chains/ports/money.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';

/**
 * The four transactions a **buyer's own wallet** signs against their escrow:
 * `set_escrow_limits`, `request_withdraw`,
 * `withdraw`.
 */
export enum EscrowIntentKind {
  SET_LIMITS = 'SET_LIMITS',
  REQUEST_WITHDRAW = 'REQUEST_WITHDRAW',
  WITHDRAW = 'WITHDRAW',
}

export interface EscrowIntentRequest {
  readonly kind: EscrowIntentKind;
  /** The buyer's CAIP-10 — from the session, never from the request body. */
  readonly account: AccountId;
  readonly asset: AssetId;
  /** REQUEST_WITHDRAW only. `0` cancels a standing request. */
  readonly amount: Money | null;
  /** SET_LIMITS only. Both required together; `0` means refuse every redeem. */
  readonly limits: EscrowLimits | null;
  /** WITHDRAW only. The token account the buyer wants paid; defaults to their own ATA. */
  readonly destination: AccountId | null;
}

/**
 * The bytes a buyer's wallet is handed are now
 * {@link import('@modules/chains/ports/unsigned-chain-transaction').UnsignedChainTransaction}
 * — the same union `StakeIntentBuilderPort` returns.
 *
 * `UnsignedEscrowTransaction` used to be declared here and its own doc comment
 * admitted what it was: *"field-for-field `UnsignedStakeTransaction`'s shape."*
 * Two identical declarations of one wire contract in two modules is one
 * contract that can drift, and the copy that drifts is the one nobody is
 * looking at.
 *
 * The rule this port exists to make structural is unchanged, and is why it
 * still has no `send`, no `submit`, no `signature` and no signer parameter:
 * two of these four doors are the buyer's defence against **this platform**.
 * `withdraw` takes their money out of reach and `set_escrow_limits` is the
 * ceiling that exists because the platform writes the 402. A backend
 * that could sign either could raise the ceiling and then spend to it.
 */

/**
 * The **build-but-never-sign** half of a buyer's escrow lifecycle, kept on the
 * far side of the `chains/` boundary — the same shape `StakeIntentBuilderPort`
 * already has for a provider's stake, and the same rule applies one degree
 * more sharply: two of these four doors are the buyer's defence against
 * *this platform*. `withdraw` takes their money out of reach, and
 * `set_escrow_limits` is the ceiling that exists precisely because the
 * platform writes the 402 and therefore picks the number the buyer's agent is
 * asked to sign. A backend that could sign either could raise the ceiling and
 * then spend to it — so this port has no `send`, no `submit`, no `signature`
 * and no signer parameter anywhere in its surface.
 */
export interface EscrowIntentBuilderPort {
  /**
   * `Config.stake_mint` as a CAIP-19 asset plus its scale — the escrow's own
   * mint, read from the chain rather than configured locally, for the same
   * reason `StakeIntentBuilderPort.stakeAsset` gives.
   */
  escrowAsset(account: AccountId): Promise<{ readonly asset: AssetId; readonly decimals: number }>;

  /**
   * `Config.withdraw_delay_seconds` — how long a buyer's `request_withdraw`
   * waits before `withdraw` will pay it. Read from the chain on Solana, never
   * configured locally: `MIN/MAX_WITHDRAW_DELAY_SECONDS` bound it on chain and
   * an admin `update_config` can move it inside that range at any time, so a
   * local copy is a number that can silently disagree with the one the
   * program enforces — the same argument `StakeIntentBuilderPort.stakeAsset`
   * makes about `Config.stake_mint`.
   *
   * **`chainId` is required, and originally it was not.** The delay is a per-chain
   * quantity — on `eip155` it is `Constants.sol`'s compile-time
   * `WITHDRAW_DELAY_SECONDS = 3600`, with no getter and nothing on chain that
   * can move it — so a zero-argument version of this method has no answer once
   * two chains are served. It is a required parameter rather than an optional
   * one so the compiler finds every caller instead of one of them discovering
   * it as a countdown from the wrong chain.
   *
   * The EVM statement of the same fact is `assay-evm/docs/divergences.md`: it is
   * "read from the chain" only where the chain has somewhere to read it from.
   */
  withdrawDelaySeconds(chainId: ChainId): Promise<number>;

  buildIntent(request: EscrowIntentRequest): Promise<UnsignedChainTransaction>;
}

export const ESCROW_INTENT_BUILDER = 'ESCROW_INTENT_BUILDER';
