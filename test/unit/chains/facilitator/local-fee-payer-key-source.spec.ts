import { generateKeyPairSync } from 'node:crypto';

import { takeLocalFeePayerKeypair } from '@modules/chains/facilitator/signing/local-fee-payer-key-source';
import { LOCAL_FEE_PAYER_KEYPAIR_ENV } from '@modules/chains/facilitator/signing/signer.constants';

function keypairBytes(): { seed: Buffer; full: Buffer } {
  const pair = generateKeyPairSync('ed25519');
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16, 48);
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { seed, full: Buffer.concat([seed, pub]) };
}

describe('takeLocalFeePayerKeypair', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = {};
  });

  it('returns null when the variable is absent, so the file path stays usable', () => {
    expect(takeLocalFeePayerKeypair(env)).toBeNull();
  });

  it('returns null for an empty or whitespace value rather than throwing', () => {
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = '   ';
    expect(takeLocalFeePayerKeypair(env)).toBeNull();
  });

  it('parses the 64-byte solana-keygen JSON array', () => {
    const { full } = keypairBytes();
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = JSON.stringify(Array.from(full));

    expect(Buffer.from(takeLocalFeePayerKeypair(env)!)).toEqual(full);
  });

  it('parses a bare 32-byte seed array', () => {
    const { seed } = keypairBytes();
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = JSON.stringify(Array.from(seed));

    expect(Buffer.from(takeLocalFeePayerKeypair(env)!)).toEqual(seed);
  });

  it('parses hex, with or without the 0x prefix', () => {
    const { full } = keypairBytes();
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = full.toString('hex');
    expect(Buffer.from(takeLocalFeePayerKeypair(env)!)).toEqual(full);

    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = `0x${full.toString('hex')}`;
    expect(Buffer.from(takeLocalFeePayerKeypair(env)!)).toEqual(full);
  });

  it('DELETES the variable, so nothing can read it after boot', () => {
    const { full } = keypairBytes();
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = JSON.stringify(Array.from(full));

    takeLocalFeePayerKeypair(env);

    expect(LOCAL_FEE_PAYER_KEYPAIR_ENV in env).toBe(false);
  });

  it('deletes the variable even when the value is unparseable', () => {
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = 'not-a-keypair';

    expect(() => takeLocalFeePayerKeypair(env)).toThrow();
    expect(LOCAL_FEE_PAYER_KEYPAIR_ENV in env).toBe(false);
  });

  it('refuses a length that is neither 32 nor 64 bytes', () => {
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = JSON.stringify([1, 2, 3]);

    expect(() => takeLocalFeePayerKeypair(env)).toThrow(/32|64/);
  });

  it('never puts the offending value in the error message', () => {
    const secret = 'deadbeef'.repeat(9); // 72 hex chars — wrong length, and recognisable
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = secret;

    let message = '';
    try {
      takeLocalFeePayerKeypair(env);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('deadbeef');
    expect(message).toContain(LOCAL_FEE_PAYER_KEYPAIR_ENV);
  });

  it('does not leak the value through a JSON.parse error either', () => {
    env[LOCAL_FEE_PAYER_KEYPAIR_ENV] = '[1,2,cafebabe';

    let message = '';
    try {
      takeLocalFeePayerKeypair(env);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('cafebabe');
  });
});
