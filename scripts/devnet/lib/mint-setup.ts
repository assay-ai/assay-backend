/**
 * Idempotent devnet USDC-standin mint (6 decimals) and user funding.
 *
 * Circle's real devnet USDC mint
 * (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) is behind a captcha
 * faucet with no programmatic path to fund a test wallet. `SOLANA_DEVNET_USDC_MINT`
 * (`src/modules/chains/ports/asset-registry.ts`) exists precisely so a devnet
 * deployment can point at a mint it actually controls — this is that mint.
 *
 * Account existence is always checked directly against chain state
 * (`Connection.getAccountInfo`) before shelling out to `spl-token`, rather
 * than trusted from a previous run's CLI output: `spl-token create-account`
 * is not itself idempotent (it exits non-zero — "Account already exists" —
 * on a second call), so re-running this script without the check would fail
 * on every run after the first.
 */
import { join } from 'node:path';

import { Connection, PublicKey } from '@solana/web3.js';
import { address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { KEYSTORE_DIR, loadOrCreateKeypair, loadState, saveState } from './keystore';
import { solanaConfig, splToken } from './solana-cli';
import { DEVNET_TOKEN_DECIMALS } from './token-decimals';

const DECIMALS = DEVNET_TOKEN_DECIMALS;

export interface MintSetupResult {
  readonly mint: string;
  readonly created: boolean;
  readonly userAta: string;
  readonly userAtaCreated: boolean;
  readonly mintedThisRun: bigint;
  readonly userBalanceAtomic: bigint;
}

interface SplTokenAddressOutput {
  readonly address?: string;
}

/**
 * Creates (or reuses) the devnet mint, then tops the user's balance up to
 * `targetAtomicBalance` if it is short — re-running the script never mints
 * more than needed to reach the target, so a second run does not silently
 * inflate the test wallet's balance every time.
 */
export async function setupDevnetMint(
  userPubkey: string,
  targetAtomicBalance: bigint,
): Promise<MintSetupResult> {
  const { keypairPath, rpcUrl } = solanaConfig();
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintKeypairPath = join(KEYSTORE_DIR, 'devnet-usdc-mint.json');

  const envOverride = process.env.SOLANA_DEVNET_USDC_MINT;
  let mint: string;
  let created = false;

  if (envOverride) {
    mint = envOverride;
  } else {
    const persisted = loadState<{ mint: string }>('devnet-usdc-mint-address');
    if (persisted) {
      mint = persisted.mint;
    } else {
      // Passing our own persisted keypair file makes the mint address
      // itself reproducible across runs, the same idempotency approach as
      // `keystore.ts` uses everywhere else in this script. `spl-token` reads
      // the same JSON secret-key-array format `loadOrCreateKeypair` writes.
      loadOrCreateKeypair('devnet-usdc-mint');
      const result = splToken([
        'create-token',
        mintKeypairPath,
        '--decimals',
        String(DECIMALS),
        '--mint-authority',
        keypairPath,
        '--fee-payer',
        keypairPath,
        '-u',
        rpcUrl,
      ]) as SplTokenAddressOutput;
      if (!result.address) {
        throw new Error(`spl-token create-token did not return an address: ${JSON.stringify(result)}`);
      }
      mint = result.address;
      saveState('devnet-usdc-mint-address', { mint });
      created = true;
    }
  }

  const [userAtaAddress] = await findAssociatedTokenPda({
    owner: address(userPubkey),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const userAta = userAtaAddress as unknown as string;

  const existingAta = await connection.getAccountInfo(new PublicKey(userAta));
  let userAtaCreated = false;
  if (!existingAta) {
    splToken(['create-account', mint, '--owner', userPubkey, '--fee-payer', keypairPath, '-u', rpcUrl]);
    userAtaCreated = true;
  }

  const before = await readAtomicBalance(connection, userAta);
  let mintedThisRun = 0n;
  if (before < targetAtomicBalance) {
    const shortfall = targetAtomicBalance - before;
    const shortfallTokens = formatAtomicAsTokenAmount(shortfall, DECIMALS);
    splToken([
      'mint',
      mint,
      shortfallTokens,
      userAta,
      '--mint-authority',
      keypairPath,
      '--fee-payer',
      keypairPath,
      '-u',
      rpcUrl,
    ]);
    mintedThisRun = shortfall;
  }

  const after = await readAtomicBalance(connection, userAta);

  return {
    mint,
    created,
    userAta,
    userAtaCreated,
    mintedThisRun,
    userBalanceAtomic: after,
  };
}

async function readAtomicBalance(connection: Connection, tokenAccount: string): Promise<bigint> {
  const { value } = await connection.getTokenAccountBalance(new PublicKey(tokenAccount));
  return BigInt(value.amount);
}

function formatAtomicAsTokenAmount(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals);
  return fraction.replace(/0+$/, '') === '' ? whole : `${whole}.${fraction}`;
}
