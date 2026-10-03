import { generateKeyPairSync, sign } from 'node:crypto';

import { address, Address, getBase58Decoder } from '@solana/kit';

import { checkSignatures } from '@modules/chains/facilitator/verification/rules/signature-validity.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { DecodedSvmPayload } from '@modules/chains/facilitator/verification/svm-instruction.types';
import { FEE_PAYER } from './helpers/svm-test-fixtures';

const keyPair = generateKeyPairSync('ed25519');
const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
const PAYER: Address = address(getBase58Decoder().decode(rawPublicKey));

const MESSAGE_BYTES = new TextEncoder().encode('a fake compiled transaction message');

function payloadWith(signatures: ReadonlyMap<Address, Uint8Array | null>): DecodedSvmPayload {
  return {
    feePayer: FEE_PAYER,
    instructions: [],
    signatures,
    messageBytes: MESSAGE_BYTES,
    rawTransactionBase64: 'irrelevant',
  };
}

describe('checkSignatures', () => {
  it('accepts a genuine payer signature with the fee payer slot still unsigned', () => {
    const signature = sign(null, Buffer.from(MESSAGE_BYTES), keyPair.privateKey);
    const payload = payloadWith(
      new Map([
        [FEE_PAYER, null],
        [PAYER, signature],
      ]),
    );
    expect(checkSignatures(payload)).toBeNull();
  });

  it('rejects a required non-fee-payer signer with no signature at all', () => {
    const payload = payloadWith(
      new Map([
        [FEE_PAYER, null],
        [PAYER, null],
      ]),
    );
    expect(checkSignatures(payload)).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE);
  });

  it('rejects a signature that does not verify against the message bytes — the "bad signature" case', () => {
    const wrongMessage = sign(
      null,
      Buffer.from('a different message entirely'),
      keyPair.privateKey,
    );
    const payload = payloadWith(
      new Map([
        [FEE_PAYER, null],
        [PAYER, wrongMessage],
      ]),
    );
    expect(checkSignatures(payload)).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE);
  });

  it('rejects a signature genuinely produced by a different key', () => {
    const otherKeyPair = generateKeyPairSync('ed25519');
    const forgedSignature = sign(null, Buffer.from(MESSAGE_BYTES), otherKeyPair.privateKey);
    const payload = payloadWith(
      new Map([
        [FEE_PAYER, null],
        [PAYER, forgedSignature],
      ]),
    );
    expect(checkSignatures(payload)).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE);
  });

  it('does not require the fee payer to have signed yet', () => {
    const signature = sign(null, Buffer.from(MESSAGE_BYTES), keyPair.privateKey);
    const payload = payloadWith(new Map([[PAYER, signature]]));
    expect(checkSignatures(payload)).toBeNull();
  });
});
