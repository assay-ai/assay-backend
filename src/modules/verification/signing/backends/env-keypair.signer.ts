import { createPrivateKey, createPublicKey, webcrypto } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { VerificationErrors } from '../../errors/verification.errors';
import { ENV_SIGNER_WARNING, ENV_SIGNING_KEY_SOURCES } from '../signing.constants';
import { SignerBackend, SignerKeyHandle, SignerPort } from '../ports/signer.port';
import { EnvSigningKeySource } from './env-key-source';

/**
 * `SignerPort` backed by key material supplied through the environment.
 *
 * **The MVP custody path, and a deliberate divergence from the security
 * model**, which says no private key material is ever in an environment
 * variable. It is; the reasoning and the
 * conditions are recorded in `docs/architecture.md` §"Signing keys". The short
 * version is that a KMS is an operational dependency the MVP does not have yet,
 * and the risk it buys down is bounded by the on-chain controls that *did* ship
 * — the allowlist, the expiry, the 72-hour timelock and the slash cap — none of
 * which depend on where the key is stored.
 *
 * ## What the env backend does to earn the name
 *
 * "It is in an environment variable" is where most implementations of this
 * stop. Four things here are not free, and each closes a specific way key
 * material escapes a Node process:
 *
 * 1. **The variable is deleted at boot** (`env-key-source.ts`). Nothing that
 *    dumps `process.env` afterwards — a crash reporter, a diagnostics route, a
 *    child process — can find it, because it is not there.
 * 2. **The key is imported as a non-extractable `CryptoKey`.** After
 *    `importKey(..., extractable: false, ...)` the material is held by the
 *    runtime and there is no API, in this process, that returns it. Not
 *    "no caller does" — *there is no call*. This is the property that makes the
 *    port's no-`exportKey` rule true at runtime rather than by convention, and
 *    it is why logging this object is harmless: a `CryptoKey` prints as its
 *    algorithm and usages.
 * 3. **Every intermediate buffer is zeroed.** The seed and the PKCS#8 wrapper
 *    exist for the length of one import and are overwritten, so a heap snapshot
 *    taken later does not contain them.
 * 4. **No parse error quotes its input.** Node's `JSON.parse` puts the offending
 *    text in its message; re-raising that on a malformed key would print the key
 *    into the boot log. See `env-key-source.ts` §Internals.
 *
 * What it does *not* do, and cannot: the material passes through this process's
 * memory during boot, so anyone who can read the process — a debugger, a core
 * dump, `/proc/pid/mem` — can reach it. That gap is exactly what a KMS closes
 * and nothing at this layer can. It is the reason the seam exists.
 */
@Injectable()
export class EnvKeypairSigner implements SignerPort {
  readonly backend = SignerBackend.ENV;

  private readonly logger = new Logger(EnvKeypairSigner.name);

  /**
   * `keyId` → the non-extractable signing key and its public half.
   *
   * A `#private` field, and it would be safe as a public one: the value is a
   * `CryptoKey` whose material the runtime will not surrender. The private
   * field is for the reader, so that nothing here reads as though the material
   * were reachable.
   */
  readonly #keys: Promise<ReadonlyMap<string, LoadedKey>>;

  constructor(
    @Inject(ENV_SIGNING_KEY_SOURCES) sources: readonly EnvSigningKeySource[],
    // Which key this instance holds, for the banner only. Optional so the
    // verifier's own registration is unchanged; another env-held key (such as
    // an exposure authority) passes its own sentence rather than inheriting one
    // that is false of it.
    @Optional() @Inject(ENV_SIGNER_WARNING) warning?: string,
  ) {
    this.logger.warn('================================================================');
    for (const line of (warning ?? DEFAULT_ENV_SIGNER_WARNING).split('\n')) {
      this.logger.warn(line);
    }
    this.logger.warn('================================================================');

    this.#keys = this.load(sources);
    // A rejected promise nobody has awaited yet is an unhandled rejection that
    // kills the process with a stack trace instead of the error. Boot failures
    // here are configuration mistakes and have to read like one.
    void this.#keys.catch(() => undefined);
  }

  async listKeys(): Promise<readonly SignerKeyHandle[]> {
    return [...(await this.#keys).values()].map((key) => key.handle);
  }

  async getKey(keyId: string): Promise<SignerKeyHandle> {
    return (await this.resolve(keyId)).handle;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const key = await this.resolve(keyId);
    const signature = await webcrypto.subtle.sign('Ed25519', key.signingKey, message);
    return new Uint8Array(signature);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolve(keyId: string): Promise<LoadedKey> {
    const key = (await this.#keys).get(keyId);
    if (!key) {
      throw VerificationErrors.signingKeyUnknown({ keyId, backend: this.backend });
    }
    return key;
  }

  private async load(
    sources: readonly EnvSigningKeySource[],
  ): Promise<ReadonlyMap<string, LoadedKey>> {
    const keys = new Map<string, LoadedKey>();
    for (const source of sources) {
      keys.set(source.keyId, await importKey(source));
    }
    this.logger.log(
      `Loaded ${keys.size} env signing key(s): ${[...keys.keys()].join(', ') || '(none)'}`,
    );
    return keys;
  }
}

/**
 * What an operator sees when the verifier key is held in-process.
 *
 * It is the loudest statement in the codebase that the env backend falls short
 * of the production target (a KMS), and softening it to cover a second key
 * would have cost exactly the specificity that makes it worth printing.
 */
const DEFAULT_ENV_SIGNER_WARNING = [
  'VERIFIER_SIGNER_BACKEND=env — the verifier signing key is held in',
  'THIS process. The production target is a KMS-backed signer.',
  'See docs/architecture.md §"Signing Keys". Anyone who',
  'can read this process can sign attestations until it is closed.',
].join('\n');

interface LoadedKey {
  readonly handle: SignerKeyHandle;
  readonly signingKey: webcrypto.CryptoKey;
}

/**
 * DER prefix that turns a bare 32-byte ed25519 seed into a PKCS#8 document.
 *
 * WebCrypto imports ed25519 private keys as PKCS#8 and nothing else, and this
 * header is fully determined by the algorithm — there is no field in it that
 * depends on the key. Hard-coding it avoids pulling in an ASN.1 encoder to
 * produce sixteen constant bytes.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An SPKI-encoded ed25519 public key is a 12-byte header and the 32-byte key. */
const SPKI_ED25519_HEADER_LENGTH = 12;

async function importKey(source: EnvSigningKeySource): Promise<LoadedKey> {
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, source.seed]);
  try {
    const publicKey = derivePublicKey(pkcs8);
    assertClaimedPublicKeyMatches(source, publicKey);

    const signingKey = await webcrypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
    await assertKeyPairAgrees(source.keyId, signingKey, publicKey);

    return {
      handle: {
        keyId: source.keyId,
        backend: SignerBackend.ENV,
        // The variable's *name*. It is a locator and it appears in logs; the
        // value it once held is gone by the time this object exists.
        backendRef: 'env:VERIFIER_SIGNING_KEYS',
        publicKey,
        // Intrinsic: this class imports PKCS#8 ed25519 and signs with
        // `webcrypto.subtle.sign('Ed25519', …)`. There is no configuration that
        // could make it produce anything else.
        curve: 'ed25519',
        // `VERIFIER_SIGNING_KEYS` entries are `{ keyId, secretKey }` and name no
        // chain. Deliberately not defaulted — see `SignerKeyHandle.chainId`:
        // `solana:5eykt4Us…` and `solana:EtWTRABZ…` differ by a mainnet, and a
        // default here would pick one of them for every deployment that has not
        // said.
        chainId: null,
      },
      signingKey,
    };
  } finally {
    // Both hold the seed. From here the only copy is inside the runtime's
    // non-extractable key.
    pkcs8.fill(0);
    source.seed.fill(0);
  }
}

function derivePublicKey(pkcs8: Buffer): Uint8Array {
  const spki = createPublicKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  ).export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(SPKI_ED25519_HEADER_LENGTH));
}

/**
 * A 64-byte key carries a public half. Trusting it rather than checking it is
 * how a deployment ends up signing with one key while telling the on-chain
 * registry about another — the registry entry would be for a key that signs
 * nothing, every attestation would be rejected as unknown-verifier, and the
 * error would point at the chain rather than at the paste that caused it.
 */
function assertClaimedPublicKeyMatches(source: EnvSigningKeySource, derived: Uint8Array): void {
  if (!source.claimedPublicKey) {
    return;
  }
  if (Buffer.compare(source.claimedPublicKey, derived) !== 0) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${source.keyId}" carries a public half that does not match its private half`,
    });
  }
}

/**
 * Sign something and verify it, at boot, before the key is ever used for real.
 *
 * The failure this catches is silent and expensive: a key that produces
 * signatures nobody can verify still *works*, in the sense that `sign` returns
 * 64 bytes. It is discovered when the on-chain program rejects an attestation
 * — during an incident, on the path that takes money — rather than here, where
 * it is a boot failure with a key id in it.
 */
async function assertKeyPairAgrees(
  keyId: string,
  signingKey: webcrypto.CryptoKey,
  publicKey: Uint8Array,
): Promise<void> {
  const probe = Buffer.from(`verifier-signing-key-selftest:${keyId}`);
  const signature = await webcrypto.subtle.sign('Ed25519', signingKey, probe);
  const verifier = await webcrypto.subtle.importKey('raw', publicKey, 'Ed25519', true, ['verify']);
  const agrees = await webcrypto.subtle.verify('Ed25519', verifier, signature, probe);
  if (!agrees) {
    throw VerificationErrors.signingKeyMaterialInvalid({
      reason: `key "${keyId}" failed its boot self-test — it signs, but not verifiably`,
    });
  }
}
