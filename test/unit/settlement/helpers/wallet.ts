import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';

import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';

/**
 * A real ed25519 keypair, addressed the way Solana addresses one.
 *
 * These specs sign with actual cryptography rather than stubbing
 * `verifyWithdrawalSignature`. The claim under test — *a session token is not
 * enough to withdraw* — is only as strong as the verification behind it, and a
 * stubbed verifier would let a test pass against a service that never checks
 * anything. So the adapter's real implementation runs, against keys generated
 * here, and the forgery cases are genuine forgeries.
 */
export interface TestWallet {
  readonly address: string;
  readonly account: AccountId;
  /** base58 ed25519 signature over `message`, exactly as a wallet would produce. */
  sign(message: Uint8Array): string;
}

export function createWallet(chainId: ChainId = CHAIN_IDS.SOLANA_MAINNET): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  // A DER SPKI ed25519 key is a 12-byte header followed by the 32 raw bytes,
  // which is what a Solana address encodes.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = getBase58Decoder().decode(raw);

  return {
    address,
    account: toAccountId(chainId, address),
    sign: (message: Uint8Array) =>
      getBase58Decoder().decode(signEd25519(null, Buffer.from(message), privateKey)),
  };
}
