/**
 * `yarn devnet:deposit` — the treasury vault and deposit reproducibility proof.
 *
 * Phases 1-4 need only devnet RPC + the `solana`/`spl-token` CLIs and are
 * always run: they are what actually prove the Squads vault and the devnet
 * USDC-standin mint are real, idempotent, on-chain artefacts. Phase 5
 * onward needs the self-hosted facilitator (`FACILITATOR_URL`, default
 * `http://127.0.0.1:3100`) actually running — if it is not reachable, this
 * script says so plainly and exits non-zero rather than pretending the
 * deposit path was exercised.
 *
 * Idempotent and re-runnable: every keypair and every piece of on-chain
 * state is persisted under `scripts/devnet/.keys/` (gitignored) and reused
 * on the next run rather than recreated.
 */
// `.env` is loaded by `-r dotenv/config` in the `devnet:deposit` script
// entry (package.json), **before** this file or any of its imports run.
// Loading it here instead would be too late: TypeScript's CommonJS output
// hoists every `import` to a `require()` executed before this file's own
// top-level statements, so `SOLANA_DEVNET_USDC_MINT` (read once, at import
// time, by `src/modules/chains/ports/asset-registry.ts`) would already have
// resolved its default before a same-file `dotenv.config()` call ran.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { getDataSourceToken } from '@nestjs/typeorm';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { address, createKeyPairSignerFromBytes } from '@solana/kit';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';

import { AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { MoneyUtil } from '@shared/utils/money.util';

import { bootAppContext } from './lib/app-context';
import { loadOrCreateKeypair, loadState, saveState } from './lib/keystore';
import { buildDepositPayload } from './lib/build-deposit-payload';
import { setupDevnetMint } from './lib/mint-setup';
import { solanaConfig, solanaBalanceSol } from './lib/solana-cli';
import { setupSquadsVault } from './lib/squads-setup';

const SOLANA_DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const DEPOSIT_AMOUNT_ATOMIC = 5_000_000n; // 5.000000 token — the platform minimum
const USER_TARGET_BALANCE_ATOMIC = 5_000_000n; // keep the user well-funded across re-runs
const EXPLORER_URL = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const { keypairPath, rpcUrl } = solanaConfig();
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))),
  );
  const connection = new Connection(rpcUrl, 'confirmed');

  section('1. Devnet user wallet');
  const userKeypair = loadOrCreateKeypair('devnet-user');
  const userPubkey = userKeypair.publicKey;
  console.log(`user address:        ${userPubkey.toBase58()}`);
  console.log(
    `user SOL balance:    ${solanaBalanceSol(userPubkey.toBase58())} SOL (expected: 0 — the user never pays gas)`,
  );

  section('2. Devnet USDC-standin mint + user funding');
  const mintResult = await setupDevnetMint(userPubkey.toBase58(), USER_TARGET_BALANCE_ATOMIC);
  console.log(
    `mint:                ${mintResult.mint} ${mintResult.created ? '(created this run)' : '(reused)'}`,
  );
  console.log(`user ATA:            ${mintResult.userAta}`);
  console.log(`minted this run:     ${mintResult.mintedThisRun.toString()} atomic units`);
  console.log(`user token balance:  ${mintResult.userBalanceAtomic.toString()} atomic units`);

  section('3. Squads v4 multisig + treasury vault');
  const mintPubkey = new PublicKey(mintResult.mint);
  const squads = await setupSquadsVault(connection, payer, mintPubkey);
  console.log(`multisig create_key: ${squads.createKey.toBase58()}`);
  console.log(
    `multisig PDA:        ${squads.multisigPda.toBase58()} ${squads.multisigCreated ? '(created this run)' : '(reused)'}`,
  );
  if (squads.multisigCreateSignature) {
    console.log(`  tx: ${EXPLORER_URL(squads.multisigCreateSignature)}`);
  }
  console.log(`vault PDA:           ${squads.vaultPda.toBase58()}`);
  console.log(
    `vault USDC ATA:      ${squads.vaultAta.toBase58()} ${squads.vaultAtaCreated ? '(created this run)' : '(reused)'}`,
  );
  if (squads.vaultAtaCreateSignature) {
    console.log(`  tx: ${EXPLORER_URL(squads.vaultAtaCreateSignature)}`);
  }
  console.log(
    `\nSet SOLANA_VAULT_MULTISIG_CREATE_KEY=${squads.createKey.toBase58()} (and SOLANA_VAULT_INDEX=0, ` +
      `already the default) for the backend to derive this same vault.`,
  );

  // `SOLANA_DEVNET_USDC_MINT` is read once, at module load, by
  // `src/modules/chains/ports/asset-registry.ts` — before this process even
  // knows what phase 2 minted. If `.env` (loaded by `-r dotenv/config`,
  // before any of this file's imports run) does not already agree with the
  // mint phase 2 just used, the app's `ASSET_IDS.USDC_SOLANA_DEVNET` and this
  // script's `asset` constant below would silently name two different
  // assets, and `DepositService.assertDepositAssetIsSettlementAsset` would
  // refuse every deposit. Fail loudly here instead of leaving that as an opaque
  // `PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET` three phases later.
  if (process.env.SOLANA_DEVNET_USDC_MINT !== mintResult.mint) {
    console.error(
      `\nSOLANA_DEVNET_USDC_MINT in backend/.env is ` +
        `"${process.env.SOLANA_DEVNET_USDC_MINT ?? '(unset)'}" but this run's mint is ` +
        `"${mintResult.mint}". Set SOLANA_DEVNET_USDC_MINT=${mintResult.mint} in backend/.env ` +
        'and re-run — phases 1-3 above already completed and persisted, so the re-run reuses them.',
    );
    process.exitCode = 1;
    return;
  }

  section('4. Application boot + ledger state before');
  const app = await bootAppContext();
  let exitCode = 0;
  try {
    const ledger = app.get(LedgerService);
    const depositService = app.get(DepositService);

    const asset = `${SOLANA_DEVNET}/token:${mintResult.mint}` as AssetId;

    const demo = loadState<{ organizationId: string; agentId: string }>('devnet-demo-ids') ?? {
      organizationId: randomUUID(),
      agentId: randomUUID(),
    };
    saveState('devnet-demo-ids', demo);

    const agentAccount = toAccountId(SOLANA_DEVNET, userPubkey.toBase58());

    const before = await ledger.getBalance(demo.organizationId, agentAccount, asset);
    const journalBefore = await ledger.readJournal(demo.organizationId, {
      accountId: agentAccount,
    });
    console.log(`organizationId:      ${demo.organizationId}`);
    console.log(`agent ledger account:${agentAccount}`);
    console.log(
      `balance before:      available=${before.available.amount} held=${before.held.amount} pending=${before.pending.amount}`,
    );
    console.log(`journal entries before: ${journalBefore.length}`);
    for (const entry of journalBefore.slice(-5)) {
      console.log(
        `  [${entry.seq}] ${entry.entryType} ${entry.money.amount} tx=${entry.chainTxRef ?? '-'}`,
      );
    }

    section('5. Deposit intent + x402 payload');
    let settledTxSig: string | null = null;
    let observedAmount: string | null = null;
    try {
      const { intent, requirements } = await depositService.createDeposit({
        organizationId: demo.organizationId,
        agentId: demo.agentId,
        agentAccount,
        chainId: SOLANA_DEVNET,
        amount: MoneyUtil.of(DEPOSIT_AMOUNT_ATOMIC, asset, 6),
      });
      console.log(`deposit intent id:   ${intent.id}`);
      console.log(`requested amount:    ${intent.requestedAmount.amount} atomic units`);
      console.log(`x402 payTo (vault ATA, chain-native): ${requirements.payTo}`);
      console.log(`x402 extra.feePayer: ${String(requirements.extra?.feePayer)}`);
      console.log(`x402 extra.memo:     ${String(requirements.extra?.memo)}`);

      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string') {
        throw new Error('facilitator did not advertise extra.feePayer in the 402 requirements');
      }

      const userSigner = await createKeyPairSignerFromBytes(userKeypair.secretKey);
      const payload = await buildDepositPayload({
        // This script calls `DepositService` in process, so nothing hands it a
        // blockhash — see `DepositLifetime`. The HTTP path (the acceptance
        // suite) is given one on the `POST /deposits` response and passes that
        // instead.
        lifetime: { rpcUrl },
        userSigner,
        userAta: address(mintResult.userAta),
        vaultAta: address(squads.vaultAta.toBase58()),
        mint: address(mintResult.mint),
        decimals: 6,
        amountAtomic: DEPOSIT_AMOUNT_ATOMIC,
        feePayer: address(feePayer),
        memo: intent.id,
      });
      console.log(
        `built partially-signed legacy transaction (base64, ${payload.transactionBase64.length} chars)`,
      );

      section('6. Settle through the facilitator');
      const settled = await depositService.settleDeposit(demo.organizationId, intent.id, {
        x402Version: 2,
        scheme: 'exact',
        network: SOLANA_DEVNET,
        payload: { transaction: payload.transactionBase64 },
      });

      settledTxSig = settled.chainTxRef;
      observedAmount = settled.settledAmount?.amount ?? null;
      console.log(`intent status:       ${settled.status}`);
      console.log(`transaction:         ${settledTxSig}`);
      if (settledTxSig) {
        console.log(`explorer:            ${EXPLORER_URL(settledTxSig)}`);
      }
      console.log(`observed amount:     ${observedAmount} atomic units`);
    } catch (error) {
      console.error('\n--- DEPOSIT PATH DID NOT COMPLETE ---');
      console.error(
        (error as Error).message ||
          `Could not reach the facilitator at ${process.env.FACILITATOR_URL ?? 'http://127.0.0.1:3100'}. ` +
            'The facilitator must be running for phases 5-7. Phases 1-4 above completed and are real on-chain state.',
      );
      exitCode = 1;
    }

    if (settledTxSig && observedAmount) {
      section('7. Ledger state after + assertion');
      await ledger.flush();
      const after = await ledger.getBalance(demo.organizationId, agentAccount, asset);
      console.log(
        `balance after:       available=${after.available.amount} held=${after.held.amount} pending=${after.pending.amount}`,
      );
      const pendingDelta = MoneyUtil.toAtomic(after.pending) - MoneyUtil.toAtomic(before.pending);
      console.log(`pending delta:       ${pendingDelta.toString()} (expected: ${observedAmount})`);

      if (pendingDelta.toString() !== observedAmount) {
        console.error(
          'ASSERTION FAILED: ledger pending delta does not equal the observed on-chain amount',
        );
        exitCode = 1;
      } else {
        console.log('ASSERTION PASSED: ledger pending delta equals the observed on-chain amount.');
      }
    }
  } finally {
    // See `test/integration/bootstrap/di-wiring.integration.spec.ts` for why
    // `app.close()` alone does not release the Postgres/Redis handles.
    const dataSource = app.get<DataSource>(getDataSourceToken('postgres'), { strict: false });
    const redis = app.get<Redis>(REDIS_CACHE_CLIENT, { strict: false });
    await app.close().catch(() => undefined);
    await dataSource?.destroy().catch(() => undefined);
    redis?.disconnect();
  }

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
