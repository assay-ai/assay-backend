import { hashTypedData, TypedDataDomain } from 'viem';

export interface SetLimitsMessage {
  readonly buyer: `0x${string}`;
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  /**
   * `Escrow.authNonce` — **one counter shared by both `*BySig` doors**, not two.
   * A `setLimitsBySig` that lands first invalidates a `requestWithdrawBySig`
   * signed against the same value, and that is the contract's behaviour rather
   * than a bug to route around.
   */
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface RequestWithdrawMessage {
  readonly buyer: `0x${string}`;
  readonly amount: bigint;
  /** `Escrow.authNonce`, the same counter `SetLimits` consumes. */
  readonly nonce: bigint;
  readonly deadline: bigint;
}

/** Field order is the typehash — see the note in `voucher.ts`. */
export const SET_LIMITS_TYPES = {
  SetLimits: [
    { name: 'buyer', type: 'address' },
    { name: 'maxVoucherAmount', type: 'uint64' },
    { name: 'maxPerWindow', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/** Field order is the typehash — see the note in `voucher.ts`. */
export const REQUEST_WITHDRAW_TYPES = {
  RequestWithdraw: [
    { name: 'buyer', type: 'address' },
    { name: 'amount', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function setLimitsTypedData(message: SetLimitsMessage, domain: TypedDataDomain) {
  return { domain, types: SET_LIMITS_TYPES, primaryType: 'SetLimits' as const, message };
}

export function requestWithdrawTypedData(message: RequestWithdrawMessage, domain: TypedDataDomain) {
  return {
    domain,
    types: REQUEST_WITHDRAW_TYPES,
    primaryType: 'RequestWithdraw' as const,
    message,
  };
}

export const hashSetLimits = (m: SetLimitsMessage, d: TypedDataDomain): `0x${string}` =>
  hashTypedData(setLimitsTypedData(m, d));

export const hashRequestWithdraw = (m: RequestWithdrawMessage, d: TypedDataDomain): `0x${string}` =>
  hashTypedData(requestWithdrawTypedData(m, d));

/**
 * **There is deliberately no `withdrawBySig` encoder**, and none may be
 * added.
 *
 * `withdraw()` on chain is `msg.sender`-only, pays `msg.sender` and takes no
 * destination — the relayer cannot call it for a buyer even if it wanted to.
 * That is the design: `requestWithdraw` has already served the one-hour delay
 * by the time `withdraw` is callable, so a phished `withdrawBySig` signature
 * would drain the escrow with no remaining brake.
 */
