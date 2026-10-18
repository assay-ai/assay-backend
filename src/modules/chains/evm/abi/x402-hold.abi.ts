import { parseAbi } from 'viem';

/**
 * The "redeem into hold" surface of the X402Escrow / X402Config UUPS upgrade
 * (G3.B1, analysis §5). Coded against the spec, ahead of the contract: the
 * contract work must match these signatures exactly. Kept out of
 * `x402.abi.ts`, whose entries are pinned to the compiled artifacts
 * (`abi-selectors.spec.ts`), until that build exists.
 *
 * ```solidity
 * enum HeldStatus { None, Held, Collected, Refunded }       // uint8 0..3
 * struct HeldPayment {
 *   address provider; uint64 amount; uint16 takeRateBps; HeldStatus status; uint64 collectableAt;
 * }
 * ```
 */
export const X402_ESCROW_HOLD_ABI = parseAbi([
  'function held(address payer, uint64 seq) view returns ((address provider, uint64 amount, uint16 takeRateBps, uint8 status, uint64 collectableAt))',
  'function totalHeld() view returns (uint128)',
  'function collectHeld(address payer, uint64 seq)',
  'function collectHeldBatch(address[] payers, uint64[] seqs)',
  'function refundHeld(address payer, uint64 seq)',
  'function refundHeldBatch(address[] payers, uint64[] seqs)',
  'event PaymentHeld(address indexed payer, uint64 indexed seq, address indexed provider, uint64 amount, uint64 collectableAt)',
  'event HeldCollected(address indexed payer, uint64 indexed seq, address indexed provider, uint64 providerAmount, uint64 fee)',
  'event HeldRefunded(address indexed payer, uint64 indexed seq, uint64 amount)',
]);

export const X402_CONFIG_HOLD_ABI = parseAbi([
  'function collectHoldSeconds() view returns (uint64)',
  'event CollectHoldSet(uint64 previous, uint64 next)',
]);

/** `HeldStatus` as the contract numbers it. */
export const HELD_STATUS_BY_INDEX = ['NONE', 'HELD', 'COLLECTED', 'REFUNDED'] as const;
