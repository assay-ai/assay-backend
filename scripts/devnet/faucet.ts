/**
 * `yarn devnet:faucet <address> [amount]` — top a devnet wallet's
 * USDC-standin balance up to `amount` tokens (default 100), idempotently.
 *
 * Composes four pieces that already exist and are tested on their own:
 * `parseFaucetArgs` (CLI parsing), `solanaConfig`/`assertMintAuthority`
 * (refuse before minting with the wrong key), and `setupDevnetMint` (the
 * idempotent mint + top-up itself). This file is only the sequencing.
 *
 * ## Why `SOLANA_DEVNET_USDC_MINT` is required here
 *
 * `setupDevnetMint` creates a brand new mint when `SOLANA_DEVNET_USDC_MINT`
 * is unset and no mint has been persisted yet (`lib/mint-setup.ts`). That is
 * fine for a from-scratch run bootstrapping its own state,
 * but the faucet's whole purpose is to top up *the* mint the rest of the
 * stack already points at. A faucet run that silently created a second mint would produce tokens the
 * router does not recognise, with no error anywhere near the mistake.
 */
import { readFileSync } from 'node:fs';

import { Connection, Keypair } from '@solana/web3.js';

import { assertMintAuthority } from './lib/assert-mint-authority';
import { parseFaucetArgs } from './lib/faucet-args';
import { setupDevnetMint } from './lib/mint-setup';
import { solanaConfig } from './lib/solana-cli';
import { DEVNET_TOKEN_DECIMALS } from './lib/token-decimals';

function formatTokenAmount(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const s = abs.toString().padStart(DEVNET_TOKEN_DECIMALS + 1, '0');
  const whole = s.slice(0, s.length - DEVNET_TOKEN_DECIMALS);
  const fraction = s.slice(s.length - DEVNET_TOKEN_DECIMALS);
  const trimmedFraction = fraction.replace(/0+$/, '');
  const amount = trimmedFraction === '' ? whole : `${whole}.${trimmedFraction}`;
  return `${negative ? '-' : ''}${amount}`;
}

function rpcHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return '(unparseable RPC URL)';
  }
}

async function main(): Promise<void> {
  const { recipient, targetAtomic } = parseFaucetArgs(process.argv.slice(2));

  const mint = process.env.SOLANA_DEVNET_USDC_MINT;
  if (!mint) {
    throw new Error(
      'REFUSING: SOLANA_DEVNET_USDC_MINT is not set.\n\n' +
        'Without it, setupDevnetMint would create a BRAND NEW mint and persist it — ' +
        'and a new mint would break routing silently. ' +
        'Set SOLANA_DEVNET_USDC_MINT in backend/.env to the mint this deployment already uses, then re-run.',
    );
  }

  const { keypairPath, rpcUrl } = solanaConfig();
  const signer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))),
  );
  const signerPubkey = signer.publicKey.toBase58();

  const connection = new Connection(rpcUrl, 'confirmed');
  await assertMintAuthority(connection, mint, signerPubkey, keypairPath);

  const result = await setupDevnetMint(recipient, targetAtomic);

  const balanceBefore = result.userBalanceAtomic - result.mintedThisRun;

  console.log(`cluster:          ${rpcHost(rpcUrl)}`);
  console.log(
    `mint:             ${result.mint} ${result.created ? '(created this run)' : '(reused)'}`,
  );
  console.log(`recipient:        ${recipient}`);
  console.log(
    `recipient ATA:    ${result.userAta} ${result.userAtaCreated ? '(created this run)' : '(reused)'}`,
  );
  console.log(`balance before:   ${formatTokenAmount(balanceBefore)} tokens`);
  console.log(`minted this run:  ${formatTokenAmount(result.mintedThisRun)} tokens`);
  console.log(`balance after:    ${formatTokenAmount(result.userBalanceAtomic)} tokens`);
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
