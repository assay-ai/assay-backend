import { createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import {
  AwsKmsSigner,
  KmsKeyRef,
  KmsSigningClient,
} from '@modules/verification/signing/backends/aws-kms.signer';
import { SignerBackend } from '@modules/verification/signing/ports/signer.port';

import { itSatisfiesTheSignerPortContract } from './signer-port.contract';

/**
 * The second `SignerPort` implementation, and the reason the first one's
 * guarantees are now facts rather than claims.
 *
 * `docs/architecture.md` §"Signing Keys" says moving off the environment variable
 * is a new class and a line of wiring. This is the class. It runs the same
 * contract suite the env backend does, against a KMS that behaves the way AWS
 * documents — which is what makes the claim checkable.
 *
 * The fake below is a real signer: it holds an ed25519 keypair and produces
 * genuine signatures, so the contract's verify step exercises the whole path.
 * A fake that returned 64 arbitrary bytes would pass "returns 64 bytes" and
 * prove nothing.
 */
describe('AwsKmsSigner', () => {
  const KEY_A = 'verifier-2026-08';
  const KEY_B = 'verifier-2027-02';
  const ARN_A = 'arn:aws:kms:eu-west-1:111122223333:key/aaaaaaaa-1111-2222-3333-444444444444';
  const ARN_B = 'arn:aws:kms:eu-west-1:111122223333:key/bbbbbbbb-1111-2222-3333-444444444444';

  itSatisfiesTheSignerPortContract({
    curve: 'ed25519',
    name: 'AwsKmsSigner',
    keyIds: [KEY_A, KEY_B],
    build: () =>
      new AwsKmsSigner(
        fakeKms([
          { keyId: KEY_A, arn: ARN_A },
          { keyId: KEY_B, arn: ARN_B },
        ]),
        [
          { keyId: KEY_A, arn: ARN_A },
          { keyId: KEY_B, arn: ARN_B },
        ],
      ),
  });

  it('signs the RAW message, never a digest', async () => {
    // `ED25519_PH_SHA_512` over a DIGEST is Ed25519**ph** — a different scheme
    // with a different domain separator, which Solana's sig-verify instruction
    // rejects. Getting this wrong yields 64 well-formed bytes that no verifier
    // accepts, and it surfaces on-chain rather than here.
    const kms = fakeKms([{ keyId: KEY_A, arn: ARN_A }]);
    const spy = jest.spyOn(kms, 'sign');
    const signer = new AwsKmsSigner(kms, [{ keyId: KEY_A, arn: ARN_A }]);

    await signer.sign(KEY_A, Buffer.from('attestation bytes'));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' }),
    );
  });

  it('reports the ARN as the backend reference', async () => {
    const signer = build();

    const handle = await signer.getKey(KEY_A);

    expect(handle.backend).toBe(SignerBackend.KMS);
    expect(handle.backendRef).toBe(ARN_A);
  });

  it('fetches each public key once and caches it', async () => {
    // KMS charges per call and a key's public half never changes; the signing
    // path would otherwise make a network round trip per signature just to
    // report an address it already knew.
    const kms = fakeKms([{ keyId: KEY_A, arn: ARN_A }]);
    const spy = jest.spyOn(kms, 'getPublicKey');
    const signer = new AwsKmsSigner(kms, [{ keyId: KEY_A, arn: ARN_A }]);

    await signer.getKey(KEY_A);
    await signer.getKey(KEY_A);
    await signer.listKeys();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a KMS key that is not an Ed25519 key', async () => {
    // An RSA or P-256 key returns a longer SPKI whose trailing 32 bytes are
    // meaningless. Enrolling those on-chain produces a verifier that can never
    // verify anything, and the failure would look like a chain problem.
    const kms = fakeKms([{ keyId: KEY_A, arn: ARN_A }], { keySpec: 'RSA_4096' });
    const signer = new AwsKmsSigner(kms, [{ keyId: KEY_A, arn: ARN_A }]);

    await expect(signer.getKey(KEY_A)).rejects.toThrow(/not ECC_NIST_EDWARDS25519/);
  });

  it('refuses a signature that is not 64 bytes', async () => {
    // 64 bytes is the only shape the program accepts. A truncated response
    // journalled as a real signature is worse than an error.
    const kms = fakeKms([{ keyId: KEY_A, arn: ARN_A }]);
    jest.spyOn(kms, 'sign').mockResolvedValue({ Signature: new Uint8Array(32) });
    const signer = new AwsKmsSigner(kms, [{ keyId: KEY_A, arn: ARN_A }]);

    await expect(signer.sign(KEY_A, Buffer.from('x'))).rejects.toThrow(
      /KMS returned 32 bytes .* is 64/,
    );
  });

  it('holds no key material of its own, because it cannot', async () => {
    // The property the whole seam is for: with KMS there is nothing to hold.
    // The env backend has to work to be able to say this; here it is free.
    const signer = build();
    await signer.listKeys();

    expect(JSON.stringify(signer)).not.toMatch(/seed|secret|private/i);
  });

  function build(): AwsKmsSigner {
    const refs: KmsKeyRef[] = [
      { keyId: KEY_A, arn: ARN_A },
      { keyId: KEY_B, arn: ARN_B },
    ];
    return new AwsKmsSigner(fakeKms(refs), refs);
  }
});

/**
 * A KMS that actually signs.
 *
 * Mirrors the two calls AWS documents: `GetPublicKey` returns a DER SPKI and a
 * `KeySpec`, `Sign` returns a raw 64-byte Ed25519 signature over the message.
 */
function fakeKms(refs: readonly KmsKeyRef[], options?: { keySpec?: string }): KmsSigningClient {
  const keys = new Map(
    refs.map((ref) => {
      const { privateKey } = generateKeyPairSync('ed25519');
      return [ref.arn, privateKey];
    }),
  );

  return {
    async getPublicKey({ KeyId }) {
      const privateKey = keys.get(KeyId);
      if (!privateKey) {
        throw new Error(`NotFoundException: ${KeyId}`);
      }
      return {
        PublicKey: new Uint8Array(
          createPublicKey(privateKey).export({
            format: 'der',
            type: 'spki',
          }),
        ),
        KeySpec: options?.keySpec ?? 'ECC_NIST_EDWARDS25519',
      };
    },
    async sign({ KeyId, Message }) {
      const privateKey = keys.get(KeyId);
      if (!privateKey) {
        throw new Error(`NotFoundException: ${KeyId}`);
      }
      return { Signature: new Uint8Array(nodeSign(null, Buffer.from(Message), privateKey)) };
    },
  };
}
