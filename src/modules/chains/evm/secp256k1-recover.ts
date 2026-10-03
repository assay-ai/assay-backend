import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, hexToBytes, keccak256 } from 'viem';

/**
 * `ecrecover`, off chain, synchronously, with the contract's four checks.
 *
 * ## Why not viem
 *
 * `recoverAddress` is `async` — not because recovery is asynchronous, but
 * because viem reaches `@noble/curves` through a dynamic `import()`. The
 * `ChainAdapter` port's three `verify*` methods are **synchronous**, and making
 * them `async` is a domain-wide signature change there is no reason
 * to make (every caller, every fake, every test). So the primitive is called
 * directly here, in one file, and everything above it stays synchronous. viem
 * would run the same code.
 *
 * ## The four checks, and why each is enforced off chain too
 *
 * They are `ECDSA.tryRecover`'s, restated. The contract enforces them;
 * so does this, because a `true` here is what makes the platform hold money
 * against a voucher *before* any redemption is attempted.
 *
 *  - **`v ∈ {27, 28}`.** Anything else is not a recovery id this scheme emits.
 *  - **`0 < s <= secp256k1n/2`.** A high-`s` signature is a DIFFERENT 65-byte
 *    string over the same digest. It cannot double-spend — `seq` closes that on
 *    chain — but it breaks any off-chain idempotency keyed on the signature
 *    string, and `payment_intents.voucher_signature` is such a key today.
 *  - **`0 < r < n`.** Enforced by the curve library's own `Signature`
 *    constructor, which refuses an out-of-range scalar rather than reducing it.
 *  - **the recovered address is never `address(0)`.** On chain `ecrecover`
 *    returns the zero address for garbage; here a failure is `null` and the
 *    caller answers `false`. The zero address is explicitly refused anyway, so
 *    that no future caller can compare against a zero it derived itself.
 *
 * A malformed input is `null`, never a throw: the caller asked "who signed
 * this?", and "nobody" is an answer, not a fault.
 */

/** `secp256k1n / 2` — the low-`s` bound, written as `Types.sol` does. */
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** 65 bytes: `r || s || v`, hex, `0x`-prefixed. Nothing else is a signature. */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function recoverEvmSigner(digest: `0x${string}`, signature: string): string | null {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    return null;
  }

  const bytes = hexToBytes(signature as `0x${string}`);
  const r = bytesToBigInt(bytes.subarray(0, 32));
  const s = bytesToBigInt(bytes.subarray(32, 64));
  const v = bytes[64];

  if (v !== 27 && v !== 28) {
    return null;
  }
  if (s === 0n || s > SECP256K1_HALF_N) {
    return null;
  }
  if (r === 0n) {
    return null;
  }

  try {
    const recovered = new secp256k1.Signature(r, s)
      .addRecoveryBit(v - 27)
      .recoverPublicKey(digest.slice(2))
      .toRawBytes(false);
    // Drop the 0x04 uncompressed prefix; an EVM address is the last 20 bytes of
    // the keccak of the remaining 64.
    const address = `0x${keccak256(recovered.subarray(1)).slice(-40)}`;
    if (address === ZERO_ADDRESS) {
      return null;
    }
    return getAddress(address);
  } catch {
    // An `r` or `s` outside the curve order, or a point that is not on the
    // curve, both land here. Neither is a signature.
    return null;
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
