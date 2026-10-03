import { createHash, webcrypto } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1';

import { SigningCurve } from '@modules/verification/signing/domain/key-curve';
import { SignerPort } from '@modules/verification/signing/ports/signer.port';

/**
 * The contract every `SignerPort` implementation must satisfy — run against all
 * of them, not written once per backend.
 *
 * ## Why this file exists
 *
 * `docs/architecture.md` §"Signing Keys" makes a promise: moving the verifier key
 * from an environment variable to AWS KMS, Turnkey, Vault or Privy is a new
 * class and one line of wiring. A seam with one implementation cannot support
 * that promise — it is untested by construction, and the first real backend is
 * where you find out which of the port's guarantees were accidents of the env
 * implementation.
 *
 * So the guarantees live here, and adding a backend means running this suite
 * against it. A backend that cannot pass this is a backend that would have
 * broken a call site.
 *
 * ## What is being guaranteed
 *
 * The security-relevant one is the last: **no method returns private key
 * material.** It is asserted against the object's own shape rather than by
 * reading the interface, because TypeScript is erased at runtime and the thing
 * that actually leaks is a method somebody added to a class.
 */
export interface SignerContractSubject {
  readonly name: string;
  /** A fresh signer holding exactly the keys named in {@link keyIds}. */
  build(): Promise<SignerPort> | SignerPort;
  readonly keyIds: readonly [string, string];
  /**
   * Added with multichain support. The port is curve-agnostic — `sign(keyId, bytes) → bytes` over
   * opaque bytes, which is why it survived the curve swap untouched — but its
   * CONTRACT SUITE was not: it asserted 64-byte signatures and 32-byte public
   * keys, both ed25519 facts, and verified with `webcrypto.subtle`'s Ed25519.
   * Naming the curve here keeps the suite one suite instead of two, and makes
   * "which shape does this backend produce" a thing the fixture states rather
   * than a thing the assertions assume.
   */
  readonly curve: SigningCurve;
}

/**
 * The bytes handed to `sign`, shaped for the curve.
 *
 * ed25519 signs a message of any length. secp256k1, as every EVM verifier uses
 * it, signs a **32-byte digest** — `ecrecover` takes one — and
 * `Secp256k1EnvSigner` refuses anything else rather than hashing on the
 * caller's behalf, because a signer that quietly hashes produces a signature
 * over something the caller did not compute and cannot check. So the contract
 * gives each backend a payload it is allowed to sign; the sha256 here is a way
 * to get 32 deterministic bytes out of a label, and nothing about it is an
 * EIP-712 digest.
 */
function payloadFor(curve: SigningCurve, label: string): Uint8Array {
  return curve === 'ed25519'
    ? Uint8Array.from(Buffer.from(label))
    : Uint8Array.from(createHash('sha256').update(label).digest());
}

/** What each curve's `sign` and `publicKey` measure, in bytes. */
const SHAPES: Readonly<Record<SigningCurve, { signature: number; publicKey: number }>> = {
  ed25519: { signature: 64, publicKey: 32 },
  // `r || s || v`, and the uncompressed SEC1 key `0x04 || X || Y`.
  secp256k1: { signature: 65, publicKey: 65 },
};

export function itSatisfiesTheSignerPortContract(subject: SignerContractSubject): void {
  describe(`${subject.name} satisfies the SignerPort contract`, () => {
    const [firstKey, secondKey] = subject.keyIds;

    it('signs bytes so that the signature verifies against the reported public key', async () => {
      const signer = await subject.build();
      const message = payloadFor(subject.curve, 'an attestation, one day');
      const expected = SHAPES[subject.curve];

      const signature = await signer.sign(firstKey, message);
      const handle = await signer.getKey(firstKey);

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature).toHaveLength(expected.signature);
      expect(handle.publicKey).toHaveLength(expected.publicKey);
      expect(handle.curve).toBe(subject.curve);
      await expect(verifyFor(subject.curve)(handle.publicKey, signature, message)).resolves.toBe(
        true,
      );
    });

    it('signs with the key it was asked for and not some current key', async () => {
      // The directory decides which key is current, not the backend. A backend
      // that quietly substituted its own idea of "the active key" would make a
      // rotation unobservable from the outside.
      const signer = await subject.build();
      const message = payloadFor(subject.curve, 'bound to a specific key');

      const signature = await signer.sign(secondKey, message);
      const second = await signer.getKey(secondKey);
      const first = await signer.getKey(firstKey);
      const verify = verifyFor(subject.curve);

      await expect(verify(second.publicKey, signature, message)).resolves.toBe(true);
      await expect(verify(first.publicKey, signature, message)).resolves.toBe(false);
    });

    it('lists every key it holds, retired ones included', async () => {
      // Rotation is only non-disruptive if the outgoing key stays resolvable
      // through the cutover, and an incident review has to map a months-old
      // journal line back to a public key.
      const signer = await subject.build();

      const keys = await signer.listKeys();

      expect(keys.map((k) => k.keyId).sort()).toEqual([...subject.keyIds].sort());
    });

    it('reports its own backend on every handle', async () => {
      const signer = await subject.build();

      const handle = await signer.getKey(firstKey);

      expect(handle.backend).toBe(signer.backend);
      expect(handle.backendRef).toEqual(expect.any(String));
      expect(handle.backendRef.length).toBeGreaterThan(0);
    });

    it('names the key it does not have rather than returning nothing', async () => {
      const signer = await subject.build();

      // Also an ORDERING assertion for a curve whose signer validates the
      // payload's length: the unknown key must be reported before the payload
      // is looked at, or an operator debugging a typo'd key id is told about
      // the digest instead.
      await expect(signer.sign('no-such-key', payloadFor(subject.curve, 'x'))).rejects.toThrow(
        /no-such-key/,
      );
      await expect(signer.getKey('no-such-key')).rejects.toThrow(/no-such-key/);
    });

    it('returns promises from every method, so a remote backend is not a rewrite', async () => {
      // The one design decision that would make the swap a rewrite of every
      // caller rather than a change of provider. Asserted on `getKey` in
      // particular: it is the method most tempting to make synchronous.
      const signer = await subject.build();

      const key = signer.getKey(firstKey);
      const keys = signer.listKeys();
      const signature = signer.sign(firstKey, payloadFor(subject.curve, 'x'));

      expect(key).toBeInstanceOf(Promise);
      expect(keys).toBeInstanceOf(Promise);
      expect(signature).toBeInstanceOf(Promise);
      // Awaited, not dropped. A floating promise here is a REJECTION nobody
      // handles the moment a backend refuses this payload, and an unhandled
      // rejection kills the worker instead of failing the test — which is how
      // a mutation gets reported as "the suite crashed" rather than as the
      // assertion that caught it.
      await Promise.all([key, keys, signature]);
    });

    it('exposes no method that could return private key material', async () => {
      // The invariant the whole port exists to hold. A KMS *cannot* implement
      // an export, so the day one of these appears on a backend is the day the
      // swap stops being a configuration change — and it will appear on the env
      // backend first, because there it is easy.
      const signer = await subject.build();
      const surface = [
        ...Object.getOwnPropertyNames(signer),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(signer)),
      ];

      for (const forbidden of [
        'exportKey',
        'export',
        'getSecret',
        'getSecretKey',
        'getPrivateKey',
        'privateKey',
        'secretKey',
        'seed',
        'keyMaterial',
      ]) {
        expect(surface).not.toContain(forbidden);
      }
    });

    it('puts no key material on the handle it hands out', async () => {
      const signer = await subject.build();

      const handle = await signer.getKey(firstKey);

      // The public key is the only key-shaped thing a handle may carry.
      // `curve` and `chainId` joined it with multichain support — both are metadata about which
      // key this is, and neither is material.
      expect(Object.keys(handle).sort()).toEqual(
        ['backend', 'backendRef', 'chainId', 'curve', 'keyId', 'publicKey'].sort(),
      );
    });
  });
}

type Verifier = (
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
) => Promise<boolean>;

/**
 * Verification is done by a DIFFERENT library from the one that signed, for
 * both curves: `webcrypto.subtle` against the env backend's own WebCrypto key
 * is the closest this gets to a round trip, and @noble against a signature the
 * env backend produced with @noble would be the same expression twice. The
 * secp256k1 branch below therefore does a real `ecrecover`-shaped check — it
 * recovers a public key from `r || s || v` and compares points — rather than
 * calling `secp256k1.verify`, which would accept a signature carrying any `v`
 * at all, including the one that recovers a stranger.
 */
function verifyFor(curve: SigningCurve): Verifier {
  return curve === 'ed25519' ? verifyEd25519 : verifySecp256k1;
}

async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey('raw', publicKey, 'Ed25519', true, ['verify']);
  return webcrypto.subtle.verify('Ed25519', key, signature, message);
}

async function verifySecp256k1(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 65) {
    return false;
  }
  const v = signature[64];
  if (v !== 27 && v !== 28) {
    return false;
  }
  try {
    const recovered = new secp256k1.Signature(
      BigInt(`0x${Buffer.from(signature.subarray(0, 32)).toString('hex')}`),
      BigInt(`0x${Buffer.from(signature.subarray(32, 64)).toString('hex')}`),
    )
      .addRecoveryBit(v - 27)
      .recoverPublicKey(message)
      .toRawBytes(false);
    return Buffer.compare(recovered, publicKey) === 0;
  } catch {
    return false;
  }
}
