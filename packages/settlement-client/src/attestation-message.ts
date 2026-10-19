import { getAddressEncoder } from '@solana/kit';
import type { Address, ReadonlyUint8Array } from '@solana/kit';

import { ASSAY_PAYMENT_PROGRAM_ADDRESS } from './generated/programs';

/**
 * The exact bytes a verifier signs — the one part of the program's interface
 * that is not in the IDL and cannot be generated.
 *
 * `propose_slash` takes an attestation and refuses to act without an ed25519
 * precompile instruction in the same transaction proving that a registered
 * verifier signed **these** bytes. The
 * program recomputes them from the instruction arguments and compares. So this
 * file is not a decoder of anything the program sends; it is the other half of a
 * signature scheme, and `programs/x402-payment/src/attestation.rs` in
 * assay-solana (`signed_message`) is the authority for every offset below.
 *
 * ## Why it is hand-written, and what checks it
 *
 * The signed message is not an instruction and not an account, so it appears
 * nowhere in the IDL and Codama renders nothing for it. There is no generator to
 * defer to.
 *
 * What checks it is the chain, immediately and unambiguously: an encoding that
 * differs from the program's by one byte produces a signature over the wrong
 * message, and the program refuses with `MissingVerifierSignature` rather than
 * acting on a mis-parsed field. There is no failure mode where a wrong encoding
 * slashes the wrong provider — the domain tags and the fixed lengths see to
 * that. `backend/test/unit/chains/solana/attestation-message.spec.ts` pins the
 * layout so a change is deliberate, and
 * `backend/scripts/settlement/exercise-all.ts` lands the instruction against a
 * real cluster, which is the end-to-end proof.
 *
 * The durable fix is for the program to export the domain tags and message
 * lengths as `#[constant]`, which would put them in the IDL and make this
 * mechanically checkable like the PDA seeds already are. That is a program
 * change and has not been made yet.
 *
 * ## Two tags, two lengths, and both are load-bearing
 *
 * There are exactly two signed messages in the program: the verifier's slash
 * attestation (211 bytes, here) and the buyer's voucher (240 bytes, in
 * `voucher-message.ts`). The domain separators stop a signature produced for one
 * door being replayed at another — a `DATA_FAIL` judgement must not be walkable
 * round to the paying door, and a `PASS` must not be walkable round to the
 * slashing one. The lengths are deliberately distinct so that the program's
 * `data.len()` check rejects a cross-kind message before any field comparison
 * happens; `attestation.rs` asserts that inequality at compile time.
 *
 * The cancel and reversal attestations are gone: the program has no `reverse_slash`
 * at all, and `cancel_slash` is authorised by the admin's own signature rather
 * than by a verifier's over a message.
 */

const SLASH_DOMAIN = utf8('assay:slash-attestation:v1');

/** `ATTESTATION_MESSAGE_LEN` — 26 + 32 + 32 + 32 + 32 + 1 + 8 + 32 + 8 + 8. */
export const SLASH_MESSAGE_LENGTH = 211;

export const ATTESTATION_DOMAINS = {
  slash: SLASH_DOMAIN as ReadonlyUint8Array,
} as const;

/**
 * How a verified call came out, as the *signed* byte.
 *
 * Written out rather than taken from the generated `ResponseClass` enum, because
 * `signed_message` serialises the discriminant explicitly for exactly this
 * reason: reordering the Rust enum must not silently change what a signature
 * means. Kept in step by `attestation-message.spec.ts`, which asserts the two
 * agree.
 */
export const SIGNED_RESPONSE_CLASS = {
  pass: 0,
  systemError: 1,
  requestError: 2,
  dataFail: 3,
} as const;

export interface SlashAttestationFields {
  readonly requestId: ReadonlyUint8Array;
  readonly provider: Address;
  readonly beneficiary: Address;
  readonly status: number;
  readonly penalty: bigint;
  readonly policy: ReadonlyUint8Array;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly programAddress?: Address;
}

export function slashAttestationMessage(fields: SlashAttestationFields): Uint8Array {
  const out = new Uint8Array(SLASH_MESSAGE_LENGTH);
  out.set(SLASH_DOMAIN, 0);
  out.set(addressBytes(fields.programAddress ?? ASSAY_PAYMENT_PROGRAM_ADDRESS), 26);
  out.set(fixed(fields.requestId, 32), 58);
  out.set(addressBytes(fields.provider), 90);
  out.set(addressBytes(fields.beneficiary), 122);
  out[154] = fields.status;
  out.set(u64le(fields.penalty), 155);
  out.set(fixed(fields.policy, 32), 163);
  out.set(i64le(fields.issuedAt), 195);
  out.set(i64le(fields.expiresAt), 203);
  return out;
}

// ── primitives ──────────────────────────────────────────────────────────────

function utf8(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function addressBytes(value: Address): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(value));
}

/**
 * A `[u8; N]` field, refusing anything that is not exactly N bytes.
 *
 * Padding a short `request_id` or truncating a long one would produce a message
 * the caller did not mean to sign, and the program would compare it against the
 * argument it was handed and refuse — correctly, but with
 * `MissingVerifierSignature`, which sends the reader looking at key registration
 * rather than at the caller's 31-byte id.
 */
function fixed(bytes: ReadonlyUint8Array, length: number): Uint8Array {
  if (bytes.length !== length) {
    throw new Error(`expected exactly ${length} bytes, got ${bytes.length}`);
  }
  return Uint8Array.from(bytes);
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}
