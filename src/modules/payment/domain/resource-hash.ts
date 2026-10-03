import { createHash } from 'node:crypto';

/**
 * `sha256(resource)` — the x402 `resource` as the settlement program sees it.
 *
 * The signed voucher carries a 32-byte hash rather than the string, because the
 * message is fixed-width and a `resource` is not. The backend still compares the
 * *string* against the tool's advertised resource in `VoucherService`; this hash
 * is what makes that comparison something the chain also enforces.
 *
 * ## Why this lives in the payment domain and not next to the encoder
 *
 * `test/unit/chains/solana/settlement-client-only.spec.ts` bans `createHash(` in
 * every file that touches the settlement program, on the correct assumption that
 * the only reason to hash something there is a hand-recomputed Anchor
 * discriminator. Computing the resource hash here — in a file that imports
 * nothing from the client and names nothing the program owns — keeps the ban
 * blunt, which is what its own header asks for.
 */
export const RESOURCE_HASH_PREFIX = 'sha256:';

/** `sha256:` followed by 64 lower-case hex digits. Same grammar as `REQUEST_HASH_RE`. */
export const RESOURCE_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function computeResourceHash(resource: string): string {
  return RESOURCE_HASH_PREFIX + createHash('sha256').update(resource, 'utf8').digest('hex');
}

/**
 * A `sha256:`-prefixed digest as the 32 raw bytes the signed message carries.
 *
 * Throws rather than padding or truncating: a short hash silently zero-padded
 * would be a message the buyer did not mean to sign, and the program would
 * refuse it as `MissingBuyerSignature` — sending the reader to look at key
 * registration rather than at a 31-byte digest.
 */
export function hashHexToBytes(prefixed: string): Uint8Array {
  if (!RESOURCE_HASH_RE.test(prefixed)) {
    throw new Error(`expected a "sha256:" digest of 64 hex characters, got "${prefixed}"`);
  }
  return Uint8Array.from(Buffer.from(prefixed.slice(RESOURCE_HASH_PREFIX.length), 'hex'));
}
