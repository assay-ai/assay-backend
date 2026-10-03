import { ReadonlyUint8Array } from '@solana/kit';

/**
 * The Compute Budget program's instruction discriminants
 * (`solana-compute-budget-interface`). Not exposed by any `@solana-program/*`
 * package we depend on, so decoded by hand from the two shapes this facilitator
 * ever needs to recognise — the program accepts no accounts for either.
 */
const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

function view(data: ReadonlyUint8Array): DataView {
  return new DataView(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

/** `null` when `data` is not a well-formed `SetComputeUnitLimit` instruction. */
export function decodeSetComputeUnitLimit(data: ReadonlyUint8Array): number | null {
  if (data.length !== 5 || data[0] !== SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR) {
    return null;
  }
  return view(data).getUint32(1, true);
}

/** `null` when `data` is not a well-formed `SetComputeUnitPrice` instruction. */
export function decodeSetComputeUnitPrice(data: ReadonlyUint8Array): bigint | null {
  if (data.length !== 9 || data[0] !== SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR) {
    return null;
  }
  return view(data).getBigUint64(1, true);
}
