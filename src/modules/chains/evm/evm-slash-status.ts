import { SlashRecordStatus } from '@modules/slash/ports/slash-executor.port';

/**
 * The five discriminants of `enum SlashStatus` in assay-evm's `src/Types.sol`.
 * `Disputed = 4` is the dispute upgrade's (D-19), appended last so every
 * stored discriminant kept its meaning; a Stake that predates the upgrade never
 * reports it.
 */
export type EvmSlashStatusValue = 0 | 1 | 2 | 3 | 4;

/**
 * MAP, NEVER CAST.
 *
 * Anchor: `Pending = 0, Executed = 1, Cancelled = 2`. EVM: `None = 0,
 * Pending = 1, Executed = 2, Cancelled = 3` — because a Solidity `mapping`
 * returns a zero-valued struct for a key never written, so `None` has to BE
 * zero or an unproposed request id reads back as `Pending`.
 *
 * A numeric cast turns an executed judgement on one chain into a cancelled one
 * on the other, silently, and the value is a `uint8` on both so nothing
 * type-checks. `Number()`, `as` and arithmetic on a status are forbidden
 * anywhere a slash status crosses this boundary — the operator console, the
 * reconciler, `slash_proposals`.
 */
const FROM_EVM: Readonly<Record<number, SlashRecordStatus | null>> = {
  0: null, // `None` — the untouched mapping slot. Not a state; the absence of one.
  1: 'PENDING',
  2: 'EXECUTED',
  3: 'CANCELLED',
  // D-19: the provider called `disputeSlash` inside the delay. Not terminal —
  // the arbiter's `upholdSlash` returns it to `Pending` (executable from that
  // moment), `cancelSlash` or `expireSlash` ends it.
  4: 'DISPUTED',
};

/**
 * The chain's number as this codebase's name, or `null` for `None`.
 *
 * `null` is a first-class answer and is **not** an error: it is what a mapping
 * says about a request id nobody has proposed against. Throwing on it would
 * make "no such proposal" indistinguishable from "the RPC is broken"; returning
 * `PENDING` would report a judgement nobody made.
 */
export function slashStatusFromEvm(value: number): SlashRecordStatus | null {
  // `Number.isInteger` before the lookup: `1.5` and `NaN` are not `in FROM_EVM`
  // either, but the refusal has to name the enum rather than depend on a
  // property test that happens to be false for them.
  if (!Number.isInteger(value) || !(value in FROM_EVM)) {
    throw new Error(`unknown EVM SlashStatus ${value}; the enum has five members`);
  }
  return FROM_EVM[value];
}

/**
 * The name as the chain's number.
 *
 * An exhaustive `switch` with **no `default`**, so adding a member to
 * `SlashRecordStatus` is a compile error rather than a runtime surprise — and
 * `None` is unreachable from here by construction, because this codebase has no
 * name for it.
 */
export function slashStatusToEvm(status: SlashRecordStatus): 1 | 2 | 3 | 4 {
  switch (status) {
    case 'PENDING':
      return 1;
    case 'EXECUTED':
      return 2;
    case 'CANCELLED':
      return 3;
    case 'DISPUTED':
      return 4;
  }
}

/** `enum CancelReason` in `Types.sol`, named. `DisputeUnresolved = 3` is D-19's. */
export type EvmCancelReason =
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'VERIFIER_UNAVAILABLE'
  | 'DISPUTE_UNRESOLVED';

const CANCEL_REASON_FROM_EVM: Readonly<Record<number, EvmCancelReason>> = {
  0: 'WITHDRAWN', // `cancelSlash` — the admin's, or (D-19) the arbiter's
  1: 'EXPIRED', // `expireSlash` after `executableAt + 7 d`
  2: 'VERIFIER_UNAVAILABLE', // `expireSlash` on a key that can no longer sign
  3: 'DISPUTE_UNRESOLVED', // `expireSlash` on a `Disputed` record after `disputedAt + 30 d`
};

/**
 * `SlashCancelled.reason`, by name. Same discipline as the status: map, never
 * cast, and refuse a number the enum does not have.
 */
export function cancelReasonFromEvm(value: number): EvmCancelReason {
  if (!Number.isInteger(value) || !(value in CANCEL_REASON_FROM_EVM)) {
    throw new Error(`unknown EVM CancelReason ${value}; the enum has four members`);
  }
  return CANCEL_REASON_FROM_EVM[value];
}
