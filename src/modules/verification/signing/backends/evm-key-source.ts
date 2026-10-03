import { ChainId, isChainId } from '@modules/chains/ports/caip.types';

import { VerificationErrors } from '../../errors/verification.errors';
import { curveForChain } from '../domain/key-curve';
import { EVM_VERIFIER_SIGNING_KEYS_ENV } from '../signing.constants';
import { assertKeyIdUnseen, parseEntries, readKeyId, takeOnceFromEnv } from './env-key-source';

/**
 * One secp256k1 key's material, on its way from `process.env` into
 * `Secp256k1EnvSigner` and nowhere else.
 *
 * The 32-byte scalar, and — unlike the ed25519 source — the **chain it is
 * provisioned for**. `EVM_VERIFIER_SIGNING_KEYS` requires it because an EVM
 * deployment can plausibly serve two chains at once, and a key that did not
 * say which one would have to be guessed at by the directory. The ed25519
 * variable has shipped without it and is not changed; see
 * `SignerKeyHandle.chainId`.
 */
export interface EvmSigningKeySource {
  readonly keyId: string;
  readonly chainId: ChainId;
  /** The 32-byte secp256k1 private scalar. Zeroed once the key is loaded. */
  readonly secretKey: Uint8Array;
}

/**
 * Read `EVM_VERIFIER_SIGNING_KEYS` and remove it from `process.env`.
 *
 * Everything true of `takeEnvSigningKeys` is true here, because it is the same
 * function underneath: deleted before the first thing that can throw, parsed
 * once, cached by variable name, and no error path quotes what it was handed.
 * `JSON.parse`'s own message contains the offending input, so it is caught and
 * replaced rather than re-raised — a boot failure on a malformed key must not
 * print the key.
 */
export function takeEvmSigningKeys(
  env: NodeJS.ProcessEnv,
  variable: string = EVM_VERIFIER_SIGNING_KEYS_ENV,
): readonly EvmSigningKeySource[] {
  const parsed = takeOnceFromEnv(env, variable, (raw) => {
    const entries = parseEntries(raw, variable);
    const seen = new Set<string>();
    return entries.map((entry, index) => {
      const keyId = readKeyId(entry, index);
      assertKeyIdUnseen(seen, keyId);
      return {
        keyId,
        chainId: readChainId(entry, keyId),
        secretKey: readScalar(entry, keyId),
      };
    });
  });

  // Every caller gets its OWN scalar, because `Secp256k1EnvSigner.importKey`
  // zeroes what it is handed once it has copied the material into the signer.
  // Without this copy it zeroes the *cached* array, and the next container in
  // the same process is given 32 zero bytes and refuses to boot with
  // `key "…" is not a valid secp256k1 scalar` — a message that names the key
  // rather than the sharing. `SERVICE_TYPE=all` runs six bootstraps in one
  // process, so this is the ordinary local shape, and it is precisely the shape
  // the cluster never has: one service type per pod, one container, no second
  // reader. See the incident recorded on `takeOnceFromEnv` — same class, and
  // the cache that fixed it for ed25519 is what this one travels through.
  //
  // This does not widen exposure. The cache already keeps the parsed material
  // resident for the life of the process by design, and the raw string is still
  // deleted from `process.env` before anything can throw.
  return parsed.map((source) => ({ ...source, secretKey: Uint8Array.from(source.secretKey) }));
}

// ── Internals ──────────────────────────────────────────────────────────────

function readChainId(entry: unknown, keyId: string): ChainId {
  const chainId = (entry as { chainId?: unknown })?.chainId;
  if (typeof chainId !== 'string' || !isChainId(chainId)) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" has no CAIP-2 chainId — e.g. "eip155:46630"`,
    });
  }
  // The one thing a chain id in THIS variable can be wrong about in a way that
  // still parses: naming a chain whose verifier is ed25519. Refused at boot,
  // where it is a configuration mistake, rather than at the first signature,
  // where it is a chain rejecting an attestation for no visible reason.
  if (curveForChain(chainId) !== 'secp256k1') {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" names ${chainId}, whose verifier is not secp256k1`,
    });
  }
  return chainId;
}

/**
 * The 32-byte scalar, hex.
 *
 * Only hex, and only 32 bytes. The ed25519 parser also accepts a 64-byte
 * `solana-keygen` array because that is a shape an operator genuinely has in
 * hand; there is no equivalent for secp256k1 — every tool that emits one emits
 * `0x`-prefixed hex — so accepting a second encoding here would be surface with
 * no operator behind it.
 */
function readScalar(entry: unknown, keyId: string): Uint8Array {
  const secret = (entry as { secretKey?: unknown })?.secretKey;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" has no secretKey`,
    });
  }

  const hex = secret.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" is not hex`,
    });
  }
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (bytes.length !== 32) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" is ${bytes.length} bytes; a secp256k1 scalar is 32`,
    });
  }
  return bytes;
}
