import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

import { getBase58Encoder, ReadonlyUint8Array } from '@solana/kit';

import { X402InvalidReason, X402_INVALID_REASON } from '../../facilitator.wire';
import { DecodedSvmPayload } from '../svm-instruction.types';

/**
 * Not one of the six named facilitator rules, and necessary anyway: those six
 * police *content* (does this transaction pay the right amount to the right
 * place), and every one of them is meaningless against a transaction nobody
 * actually authorised. x402's `invalid_exact_svm_payload_signature` reason
 * exists in `facilitator.wire.ts` precisely because a client can submit a
 * payload whose payer never signed — this is the check that produces that
 * reason. It also doubles as the "bad signature" rejection case the facilitator
 * evidence script demonstrates.
 *
 * The fee payer's own slot is skipped deliberately: it is expected unsigned
 * when this runs — signing it is the facilitator's job, done *after* every
 * check here passes, never before.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function checkSignatures(payload: DecodedSvmPayload): X402InvalidReason | null {
  for (const [signer, signature] of payload.signatures) {
    if (signer === payload.feePayer) {
      continue;
    }

    if (!signature || !verifies(signer, payload.messageBytes, signature)) {
      return X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE;
    }
  }

  return null;
}

function verifies(
  signerAddress: string,
  messageBytes: ReadonlyUint8Array,
  signature: ReadonlyUint8Array,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(getBase58Encoder().encode(signerAddress)),
      ]),
      format: 'der',
      type: 'spki',
    });

    return verifyEd25519(null, Buffer.from(messageBytes), publicKey, Buffer.from(signature));
  } catch {
    // A malformed signature is a failed verification, not a 500 — the
    // question asked is "is this signed?", and the answer is no.
    return false;
  }
}
