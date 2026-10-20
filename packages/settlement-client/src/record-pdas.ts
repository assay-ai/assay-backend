import { getBytesEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address, ProgramDerivedAddress, ReadonlyUint8Array } from '@solana/kit';

import { ASSAY_PAYMENT_PROGRAM_ADDRESS } from './generated/programs';

/**
 * The one PDA finder Codama does not render, and why it is hand-written.
 *
 * Every door onto a slash record names it through a path the generator will not
 * follow. `propose_slash` takes its arguments as a single `attestation` struct
 * and seeds the record from a field *inside* it:
 *
 *     #[account(seeds = [SLASH_RECORD_SEED, attestation.request_id.as_ref()], …)]
 *
 * The IDL records that faithfully — `{"kind": "arg", "path": "attestation.request_id"}`
 * — but `@codama/renderers-js` only resolves an `arg` seed whose path names a
 * top-level argument. `cancel_slash`, `execute_slash` and `expire_slash` are
 * worse: they seed the record from the record's own field (`{"kind": "account",
 * "path": "slash_record.request_id"}`), which cannot be resolved before the
 * account is known. So all four generated builders require `slashRecord` to be
 * passed in, and this is what computes it.
 *
 * Every pure const seed (`["config"]`, `["stake_vault"]`, …) is deliberately
 * NOT here: Codama renders those finders itself, and a second copy would be
 * the unchecked duplicate this package exists to abolish.
 *
 * **The seed bytes below are checked against the IDL by
 * `backend/test/unit/chains/solana/record-pda-seeds.spec.ts`.**
 */

/** `SLASH_RECORD_SEED` — `b"slash"`. */
const SLASH_RECORD_SEED = new Uint8Array([115, 108, 97, 115, 104]);

/** Exported for the seed test, which compares it with the IDL's own bytes. */
export const RECORD_PDA_SEEDS = {
  slashRecord: SLASH_RECORD_SEED as ReadonlyUint8Array,
} as const;

export type SlashRecordSeeds = {
  /** The attestation's `request_id`. One slash record per request id, ever. */
  requestId: ReadonlyUint8Array;
};

export async function findSlashRecordPda(
  seeds: SlashRecordSeeds,
  config: { programAddress?: Address | undefined } = {},
): Promise<ProgramDerivedAddress> {
  const { programAddress = ASSAY_PAYMENT_PROGRAM_ADDRESS } = config;
  return getProgramDerivedAddress({
    programAddress,
    seeds: [getBytesEncoder().encode(SLASH_RECORD_SEED), getBytesEncoder().encode(seeds.requestId)],
  });
}
