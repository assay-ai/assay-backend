import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { Logger } from '@nestjs/common';

import { LocalKeypairFeePayerSigner } from '@modules/chains/facilitator/signing/local-keypair-fee-payer.signer';
import { FacilitatorErrorCode } from '@modules/chains/facilitator/errors/facilitator.errors';
import { BaseError } from '@shared/errors/base.error';

/** A `solana-keygen`-shaped keypair file: 64 bytes, JSON array of numbers. */
function writeKeypairFile(dir: string): { path: string; address: string } {
  const keyPair = generateKeyPairSync('ed25519');
  const seed = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16, 48);
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const bytes = Buffer.concat([seed, rawPublicKey]);
  const path = join(dir, 'fee-payer.json');
  writeFileSync(path, JSON.stringify(Array.from(bytes)));
  return { path, address: getBase58Decoder().decode(rawPublicKey) };
}

describe('LocalKeypairFeePayerSigner', () => {
  let dir: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'facilitator-local-signer-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses to construct when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    const { path } = writeKeypairFile(dir);
    const sendTransaction = jest.fn();

    let thrown: unknown;
    try {
      new LocalKeypairFeePayerSigner(path, { sendTransaction } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseError);
    expect((thrown as BaseError).errorCode).toBe(
      FacilitatorErrorCode.FACILITATOR_LOCAL_SIGNER_FORBIDDEN_IN_PRODUCTION,
    );
  });

  it('accepts the keypair inline as bytes, resolving the same address as the file', async () => {
    process.env.NODE_ENV = 'development';
    const { path, address: expectedAddress } = writeKeypairFile(dir);
    const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')));
    const sendTransaction = jest.fn();

    const signer = new LocalKeypairFeePayerSigner(bytes, { sendTransaction } as never);

    expect(await signer.getFeePayerAddress()).toBe(expectedAddress);
  });

  it('accepts a bare 32-byte seed, which kit loads through a different factory', async () => {
    process.env.NODE_ENV = 'development';
    const { path, address: expectedAddress } = writeKeypairFile(dir);
    const seed = new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))).slice(0, 32);
    const sendTransaction = jest.fn();

    const signer = new LocalKeypairFeePayerSigner(seed, { sendTransaction } as never);

    expect(await signer.getFeePayerAddress()).toBe(expectedAddress);
  });

  it('constructs outside production and resolves its own address', async () => {
    process.env.NODE_ENV = 'development';
    const { path, address: expectedAddress } = writeKeypairFile(dir);
    const sendTransaction = jest.fn();

    const signer = new LocalKeypairFeePayerSigner(path, { sendTransaction } as never);

    expect(await signer.getFeePayerAddress()).toBe(expectedAddress);
  });

  it('signs an unsigned fee-payer slot and submits the fully-signed transaction', async () => {
    process.env.NODE_ENV = 'development';
    const { path, address: feePayerAddress } = writeKeypairFile(dir);

    const unsignedMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayerAddress), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 100n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            {
              programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
              accounts: [],
              data: new Uint8Array(),
            },
          ],
          m,
        ),
    );
    const unsignedBase64 = getBase64Decoder().decode(
      getTransactionEncoder().encode(compileTransaction(unsignedMessage)),
    );

    const sendTransaction = jest
      .fn()
      .mockReturnValue({ send: async () => 'onchain-signature-from-rpc' });
    const signer = new LocalKeypairFeePayerSigner(path, { sendTransaction } as never);

    const result = await signer.signAndSend(unsignedBase64);

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [submittedBase64, config] = sendTransaction.mock.calls[0];
    expect(typeof submittedBase64).toBe('string');
    expect(config).toMatchObject({ encoding: 'base64' });
    expect(result.signature).toBeTruthy();
    expect(result.signedTransaction).toBe(submittedBase64);
  });

  it('logs loudly at construction that this is not the production path', () => {
    process.env.NODE_ENV = 'development';
    const { path } = writeKeypairFile(dir);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    new LocalKeypairFeePayerSigner(path, { sendTransaction: jest.fn() } as never);

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).match(/not.*production/i))).toBe(true);
    warnSpy.mockRestore();
  });
});
