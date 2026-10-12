import { ChainId, ChainNamespace, namespaceOf } from '@modules/chains/ports/caip.types';

import { VerificationErrors } from '../../errors/verification.errors';

/**
 * Which signature scheme a chain's verifier accepts.
 *
 * The `SignerPort` itself is curve-agnostic — `sign(keyId, bytes) → bytes` over
 * opaque bytes, which is why it survived the second namespace untouched. What
 * is *not* curve-agnostic is which key may sign for which chain, and that is
 * the one thing nothing checked before multichain support: with a single chain the question
 * could not be asked wrong.
 *
 * ## Why this is a total function over the namespace and not a config value
 *
 * `eip155`'s `ecrecover` verifies secp256k1 and nothing else; the Solana
 * settlement program's `ed25519_program` verifies ed25519 and nothing else.
 * Neither is a deployment choice, so neither belongs in a deployment's
 * configuration where an operator could get it wrong. A third namespace is a
 * loud throw rather than a default, because "which curve does this new chain
 * use" is a question with a real answer that somebody has to write down.
 *
 * ## What the gate buys
 *
 * `VerifierKeyDirectory.resolveSignableKey(chainId)` asserts the resolved
 * handle's curve against this. Without it, a directory row naming an EVM chain
 * and a `keyId` that the ed25519 backend happens to hold produces a 64-byte
 * ed25519 signature that is submitted to `ecrecover`, where it is not a
 * malformed signature — it is a well-formed one belonging to a stranger. The
 * chain answers `VerifierNotRegistered`, and the investigation starts at the
 * registry rather than at the misrouted key.
 */
export type SigningCurve = 'ed25519' | 'secp256k1';

export function curveForChain(chainId: ChainId): SigningCurve {
  switch (namespaceOf(chainId)) {
    case ChainNamespace.SOLANA:
      return 'ed25519';
    case ChainNamespace.EIP155:
      return 'secp256k1';
    default:
      throw VerificationErrors.signingKeyNotSignable({
        keyId: '(none resolved)',
        reason: `no signature scheme is declared for the CAIP-2 namespace of ${chainId}`,
      });
  }
}
