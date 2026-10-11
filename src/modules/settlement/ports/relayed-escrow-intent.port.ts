import { AccountId } from '@modules/chains/ports/caip.types';

import { EscrowDelegationKind } from './escrow-delegation.port';
import { EscrowIntentKind } from './escrow-intent-builder.port';

/**
 * The two doors a **relayer** may push on a buyer's behalf, and the third that
 * it may not.
 *
 * `EscrowIntentKind.WITHDRAW` is deliberately excluded at the type level rather
 * than refused at runtime. `withdraw()` is `msg.sender`-only, pays
 * `msg.sender`, and there is no `withdrawBySig` in the contract, in the ABI or
 * in the bytecode — so a relayed withdrawal is not a thing that can
 * exist, and the compiler is a better place to say so than a `default:` branch
 * somebody can delete. Widening this alias is the one change that would make a
 * phished signature drain an escrow with no remaining brake.
 */
export type RelayedEscrowIntentKind =
  | EscrowIntentKind.SET_LIMITS
  | EscrowIntentKind.REQUEST_WITHDRAW
  | EscrowDelegationKind.AUTHORIZE_DELEGATE
  | EscrowDelegationKind.REVOKE_DELEGATE;

interface RelayedEscrowIntentBase {
  /**
   * The buyer, **from the session** — never from the request body.
   *
   * This is the address the call is encoded for. A caller-supplied buyer would
   * let one session spend the platform's gas submitting a request signed by
   * somebody else; `WithdrawalService.submitRelayedIntent` refuses that by name
   * one layer up, and encoding from the session here is what makes the refusal
   * redundant rather than load-bearing.
   */
  readonly account: AccountId;
  /** `Escrow.authNonce` as it stood when the request was issued. */
  readonly nonce: bigint;
  /** Unix seconds, on the CHAIN's clock — see `EvmEscrowIntentBuilder.deadline`. */
  readonly deadline: bigint;
  /** `r || s || v`, 65 bytes, exactly as the wallet produced it. */
  readonly signature: string;
}

export interface RelayedSetLimitsIntent extends RelayedEscrowIntentBase {
  readonly kind: EscrowIntentKind.SET_LIMITS;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
}

export interface RelayedRequestWithdrawIntent extends RelayedEscrowIntentBase {
  readonly kind: EscrowIntentKind.REQUEST_WITHDRAW;
  readonly amount: bigint;
}

/**
 * Agent payment delegation: the payer authorises a DELEGATE key to sign
 * vouchers within caps until `validUntil` (`authorizeDelegateBySig`).
 * `delegate` is a bare 0x address, as signed.
 */
export interface RelayedAuthorizeDelegateIntent extends RelayedEscrowIntentBase {
  readonly kind: EscrowDelegationKind.AUTHORIZE_DELEGATE;
  readonly delegate: string;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly validUntil: bigint;
}

/** The payer withdraws a delegate's authority (`revokeDelegateBySig`). */
export interface RelayedRevokeDelegateIntent extends RelayedEscrowIntentBase {
  readonly kind: EscrowDelegationKind.REVOKE_DELEGATE;
  readonly delegate: string;
}

export type RelayedEscrowIntent =
  | RelayedSetLimitsIntent
  | RelayedRequestWithdrawIntent
  | RelayedAuthorizeDelegateIntent
  | RelayedRevokeDelegateIntent;

/**
 * Everything a relayed request carries **except** who it is for.
 *
 * Written as a union of two `Omit`s rather than `Omit<RelayedEscrowIntent,
 * 'account'>`, because `Omit` over a union is not distributive: it collapses to
 * the keys the members share, which here is the base alone — `maxVoucherAmount`
 * and `amount` both vanish and the discriminant stops discriminating. The
 * compiler reports that as "property does not exist" at the call site, which
 * reads like the caller's mistake.
 *
 * A controller builds one of these from a validated body; `account` is added by
 * `WithdrawalService` from the session, which is the only place it may come
 * from.
 */
export type RelayedEscrowIntentFields =
  | Omit<RelayedSetLimitsIntent, 'account'>
  | Omit<RelayedRequestWithdrawIntent, 'account'>
  | Omit<RelayedAuthorizeDelegateIntent, 'account'>
  | Omit<RelayedRevokeDelegateIntent, 'account'>;

/** What landed, as the chain reported it. Every figure is a decimal string. */
export interface RelayedEscrowSubmission {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly gasUsed: string;
}

/**
 * The **submit** half of a relayed escrow request — the verb
 * `EscrowIntentBuilderPort` refuses to grow, given its own port instead.
 *
 * ## Why it is a second port and not a method on the builder
 *
 * `EscrowIntentBuilderPort`'s comment states the rule it exists to make
 * structural: *"no `send`, no `submit`, no `signature` and no signer parameter
 * anywhere in its surface"* — because two of the doors it builds are the
 * buyer's defence against this platform, and a backend that could sign either
 * could raise the ceiling and then spend to it. Adding `submit` there would
 * repeal that sentence for the sake of one fewer file.
 *
 * The rule survives here because **this port cannot produce a signature**: the
 * `signature` is an input, it comes from the wallet, and there is no method on
 * this interface that returns signable bytes, a digest or a key. What the
 * platform contributes is gas, and gas is not authority.
 *
 * ## What an implementation must never do
 *
 * Take calldata. The request above carries *fields* — an amount, a pair of
 * limits, a nonce, a deadline — and the implementation encodes the call from
 * them against its own vendored ABI. A `data: 0x…` parameter here would make
 * the relayer an arbitrary-call oracle that anybody with a session can aim,
 * which is exactly the capability `EvmValueTransfer`'s missing calldata field
 * denies on the value path. The two absences are the same control.
 *
 * ## Namespaces
 *
 * `eip155` only. Solana's buyer doors are transactions the buyer signs and
 * sends with their own SOL — there is no meta-transaction to relay, so
 * `NamespaceRelayedEscrowIntent` has no Solana member and a Solana account is
 * refused `CHAIN_UNSUPPORTED` rather than answered with a stub that could never
 * work.
 */
export interface RelayedEscrowIntentPort {
  submit(intent: RelayedEscrowIntent): Promise<RelayedEscrowSubmission>;
}

export const RELAYED_ESCROW_INTENT = 'RELAYED_ESCROW_INTENT';
