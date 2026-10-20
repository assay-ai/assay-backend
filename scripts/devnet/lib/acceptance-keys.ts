/**
 * Fresh, funded devnet `KeyPairSigner`s for the acceptance suite.
 *
 * By the suite's identity rule, the provider and buyer roles each get a brand-new keypair generated
 * per run rather than one loaded from a file — unlike `setup-stake-accounts.ts`'s
 * persisted provider fixtures, nothing here is meant to be referred to by
 * address across runs.
 *
 * `generateFundedSigner` is the raw-key path scripts/devnet already uses for
 * the same reason `setup-stake-accounts.ts` does: this is operator tooling
 * signing with keys that must never reach `src/` (see `docs/architecture.md`
 * §"Signing Keys"). Calling it moves **real devnet SOL and devnet USDC-standin
 * tokens** from the configured operator key to the new address — that is the
 * point, not a side effect to guard against.
 */
import { generateKeyPairSigner, KeyPairSigner } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

import { createSender, loadKeypairSigner, Sender } from '../../settlement/lib/sender';
import { setupDevnetMint } from './mint-setup';
import { solanaConfig } from './solana-cli';
import { DEVNET_TOKEN_DECIMALS } from './token-decimals';

/** 0.05 SOL — fees + rent (an ATA, a few transactions), not stake itself. */
const SOL_FUNDING_LAMPORTS = 50_000_000n;

/**
 * A brand-new devnet keypair, funded with enough SOL for fees/rent and
 * `usdcTokens` of the devnet USDC-standin mint. Never touches a browser or
 * Privy — this is the raw-key path `scripts/devnet/setup-stake-accounts.ts`
 * already uses for the same reason.
 */
export async function generateFundedSigner(
  sender: Sender,
  operator: KeyPairSigner,
  usdcTokens: number,
): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();

  await sender.send(
    [
      getTransferSolInstruction({
        source: operator,
        destination: signer.address,
        amount: SOL_FUNDING_LAMPORTS,
      }),
    ],
    operator,
  );

  if (usdcTokens > 0) {
    const atomic = BigInt(usdcTokens) * 10n ** BigInt(DEVNET_TOKEN_DECIMALS);
    await setupDevnetMint(signer.address, atomic);
  }

  return signer;
}

/** The operator keypair and a `Sender` bound to it, read from `solana config get`. */
export async function bootSender(): Promise<{ sender: Sender; operator: KeyPairSigner }> {
  const config = solanaConfig();
  const operator = await loadKeypairSigner(config.keypairPath);
  const sender = createSender(config.rpcUrl, 'confirmed');
  return { sender, operator };
}
