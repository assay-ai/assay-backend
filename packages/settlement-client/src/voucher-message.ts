import { getAddressEncoder } from '@solana/kit';
import type { Address, ReadonlyUint8Array } from '@solana/kit';

/**
 * The exact 240 bytes a **buyer** signs to authorise one payment out of their
 * own escrow — the second signed message in this program that is not in the
 * IDL, and the first one signed by somebody who is not the platform.
 *
 * `redeem_voucher` recomputes these bytes from its instruction argument and
 * refuses without an ed25519 precompile instruction in the same transaction
 * proving `voucher.payer` signed them. `attestation.rs`'s `Voucher::signed_message`
 * is the authority for every offset below.
 *
 * ## The layout, and the one place it is easy to get wrong
 *
 * ```text
 * offset len  field
 *   0   16   b"assay:voucher:v2"
 *  16   32   program id      (the DEPLOYED id — see below)
 *  48   32   payer           (the buyer)
 *  80   32   pay_to          (= the escrow PDA of payer)
 * 112   32   provider
 * 144    8   amount        u64 LE   the EXACT price, not a ceiling
 * 152   32   resource_hash sha256(resource)
 * 184   32   request_hash
 * 216    8   seq           u64 LE   1-based
 * 224    8   issued_at     i64 LE
 * 232    8   expires_at    i64 LE
 * total 240
 * ```
 *
 * **`issued_at` comes before `expires_at`**, matching the program's own
 * `Voucher` struct — `seq`, `issued_at`, `expires_at`. It is worth stating
 * because `issued_at` was added later and an older layout had the last two the
 * other way round. Writing them in that order would produce a signature over
 * bytes the program never recomputes, so every redemption
 * would die with `MissingBuyerSignature` after the call had been served and the
 * buyer's money held.
 *
 * ## Why `programAddress` is required here and optional in `attestation-message.ts`
 *
 * The program id sits at offset 16..48, inside the signed bytes. Its sibling
 * defaults to `X402_PAYMENT_PROGRAM_ADDRESS`, which is `declare_id!()` — the
 * address the program was *built* for. A redeploy under a **new** id makes the
 * built id and the deployed id differ, and a default here would have every
 * buyer sign bytes naming a program that is not the one about to check them.
 * The failure is silent and total: the call is served, the money is held, and
 * every redemption dies with `MissingBuyerSignature`. So there is no default.
 * The caller passes `SETTLEMENT_PROGRAM_ID` — the deployed address — or it does
 * not build.
 *
 * ## Hand-written, and what checks it
 *
 * Same argument as `attestation-message.ts`: the wire format of a signature
 * must not move when a derive macro changes, and these offsets are what an
 * auditor diffs against `Voucher::signed_message`. The chain checks it
 * immediately and unambiguously — one wrong byte is a refusal, never a
 * mis-parsed field. `backend/test/unit/chains/solana/voucher-message.spec.ts`
 * pins every offset, and
 * `backend/test/unit/chains/solana/settlement-client-only.spec.ts` names this
 * file as one of exactly two allowed to write program bytes by hand.
 */

const VOUCHER_DOMAIN_BYTES = utf8('assay:voucher:v2');

/** `b"assay:voucher:v2"` — 16 bytes, and the first 16 of every voucher message. */
export const VOUCHER_DOMAIN = VOUCHER_DOMAIN_BYTES as ReadonlyUint8Array;

/** `VOUCHER_MESSAGE_LEN` — 16 + 32 + 32 + 32 + 32 + 8 + 32 + 32 + 8 + 8 + 8. */
export const VOUCHER_MESSAGE_LENGTH = 240;

export interface VoucherMessageFields {
  /** The buyer. The key whose ed25519 signature the program proves. */
  readonly payer: Address;
  /** The buyer's escrow PDA. Checked against the escrow account's own address. */
  readonly payTo: Address;
  /** Who gets paid. Seeds `ProviderEarnings` and `ProviderTerms`. */
  readonly provider: Address;
  /** The **exact** price in the stake mint's base units. Not a ceiling. */
  readonly amount: bigint;
  /** `sha256(resource)`, exactly 32 bytes. */
  readonly resourceHash: ReadonlyUint8Array;
  /** The request this voucher pays for, exactly 32 bytes. */
  readonly requestHash: ReadonlyUint8Array;
  /** This buyer's monotonic payment counter, 1-based. */
  readonly seq: bigint;
  /** Unix seconds, on the client's clock. Bounds the window's width. */
  readonly issuedAt: bigint;
  /** Unix seconds. The program adds `REDEEM_GRACE_SECONDS` on top. */
  readonly expiresAt: bigint;
  /** The **deployed** program id. Required — see the module doc. */
  readonly programAddress: Address;
}

export function voucherMessage(fields: VoucherMessageFields): Uint8Array {
  const out = new Uint8Array(VOUCHER_MESSAGE_LENGTH);
  out.set(VOUCHER_DOMAIN_BYTES, 0);
  out.set(addressBytes(fields.programAddress), 16);
  out.set(addressBytes(fields.payer), 48);
  out.set(addressBytes(fields.payTo), 80);
  out.set(addressBytes(fields.provider), 112);
  out.set(u64le(fields.amount), 144);
  out.set(fixed(fields.resourceHash, 32), 152);
  out.set(fixed(fields.requestHash, 32), 184);
  out.set(u64le(fields.seq), 216);
  out.set(i64le(fields.issuedAt), 224);
  out.set(i64le(fields.expiresAt), 232);
  return out;
}

// ── primitives ──────────────────────────────────────────────────────────────

function utf8(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function addressBytes(value: Address): Uint8Array {
  return Uint8Array.from(getAddressEncoder().encode(value));
}

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
