/**
 * `yarn devnet:escrow-rail-b` — the first end-to-end exercise of the per-buyer
 * escrow path (the program's escrow instructions and this backend's use of
 * them) against a live cluster.
 *
 *     yarn devnet:escrow-rail-b              # dry run: provisions nothing, sends nothing
 *     yarn devnet:escrow-rail-b --execute    # provisions and redeems for real
 *
 * ## Why this exists
 *
 * `scripts/devnet/acceptance-suite.ts` does not contain the string "escrow".
 * Its step 7 is a rail-A MCP call — no signature, no escrow, no voucher — so a
 * fully green acceptance run says nothing whatsoever about the per-buyer
 * escrow code. `scripts/settlement/exercise-all.ts` cannot help either: it still
 * calls `getSettlePaymentInstruction` and `getSlashInstruction`, two
 * instructions the program no longer has.
 *
 * Three claims in particular have never been tested against a running program,
 * and each one is invisible to the unit suite by construction:
 *
 * 1. **The 239 signed bytes.** `SolanaChainAdapter.buildVoucherMessage` is the
 *    only encoder in this repository, and `redeem_voucher` recomputes the same
 *    bytes from its own nine arguments. Nothing has ever compared the two. A
 *    disagreement of a single byte — a field at the wrong offset, a length
 *    prefix, an endianness — produces `MissingBuyerSignature` on chain *after*
 *    the call was served and the money held.
 * 2. **Codama's PDA defaults.** A constant-seed account left off a generated
 *    instruction builder is filled by `find<Name>Pda()` under the client's
 *    *compiled-in* `declare_id!`, not under `SOLANA_SETTLEMENT_PROGRAM_ID`.
 *    Those two addresses differ for this branch's whole life. It compiles, it
 *    type-checks, and every test that mocks the RPC passes. Only a real chain
 *    refuses it.
 * 3. **The buyer's own ceilings.** `set_escrow_limits` is the step the frontend
 *    has an intent for but no onboarding prompt, so in practice no buyer has
 *    ever armed an escrow. `max_voucher_amount` is enforced by the program, and
 *    this script proves it by crossing it deliberately.
 *
 * ## What it does NOT prove
 *
 * It does not exercise `EscrowSpendGateService` (`ESCROW_SPEND_GATE_ENABLED` is
 * off, and off is correct while rail A has no signature), it does not go
 * through `POST /deposits` or any HTTP surface, and it does not touch the
 * ledger mirror. It proves the **chain half**: that the bytes this backend
 * signs are the bytes the deployed program accepts, and that the accounts it
 * names are the accounts that program expects.
 *
 * ## Production code, not a re-implementation
 *
 * Every step that has a production path goes through it — `ESCROW_OPENER`,
 * `ESCROW_INTENT_BUILDER`, `VOUCHER_REDEEMER` and the chain adapter's own
 * `buildVoucherMessage`, all resolved out of the real Nest graph. A harness
 * that rebuilt the voucher bytes itself would prove only that it agrees with
 * itself, which is exactly the failure mode it exists to catch.
 *
 * The provider-side and funding steps have no production path (the platform
 * never opens a provider's stake, and a buyer funds an escrow from a wallet),
 * so those use the generated client directly and are clearly marked below.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  address,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  Instruction,
  KeyPairSigner,
  signBytes,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  fetchMaybeBuyerEscrow,
  fetchMaybeConfig,
  fetchMaybeProviderEarnings,
  fetchMaybeProviderStake,
  findConfigPda,
  findEscrowPda,
  findStakePda,
  findStakeVaultPda,
  getDepositStakeInstructionAsync,
  getOpenStakeInstructionAsync,
} from '@assay/settlement-client';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { ESCROW_OPENER, EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';
import {
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  ESCROW_INTENT_BUILDER,
  EscrowIntentBuilderPort,
  EscrowIntentKind,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import { computeResourceHash } from '@modules/payment/domain/resource-hash';
import { MoneyUtil } from '@utils/money.util';

import { bootAppContext } from './lib/app-context';
import { createSender, explainProgramError, loadKeypairSigner } from '../settlement/lib/sender';

const DECIMALS = 6;
const ONE_USDC = 1_000_000n;

/** What the escrow is funded with, and what the voucher spends out of it. */
const ESCROW_FUNDING = 25n * ONE_USDC;
const VOUCHER_AMOUNT = 2n * ONE_USDC;

/**
 * Deliberately below the funding and above the voucher, so one voucher passes
 * and a second, larger one is refused by the program rather than by any check
 * in this process. That contrast is the only thing that proves the ceiling is
 * enforced on chain: a limit nothing ever crosses is indistinguishable from a
 * limit that is never read.
 */
const MAX_VOUCHER_AMOUNT = 5n * ONE_USDC;
const MAX_PER_WINDOW = 20n * ONE_USDC;

/** Comfortably over any plausible `minimum_stake`, so `redeem_voucher`'s stake read passes. */
const PROVIDER_STAKE = 150n * ONE_USDC;

/** Rent plus fees for the buyer's own two signatures. */
const BUYER_SOL_LAMPORTS = 50_000_000n;

interface Report {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

const report: Report[] = [];

function record(step: string, ok: boolean, detail: string): void {
  report.push({ step, ok, detail });
  console.log(`${ok ? '[OK ]' : '[FAIL]'} ${step} — ${detail}`);
}

/**
 * A readable line out of anything thrown. `explainProgramError` handles the
 * generated client's own error shape and renders `{}` for everything else,
 * which is exactly what an `AppError` is.
 */
function describe(error: unknown): string {
  const viaClient = explainProgramError(error);
  if (viaClient && viaClient !== '{}') return viaClient;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause ? `${error.message} | cause: ${String(cause)}` : error.message;
  }
  return JSON.stringify(error);
}

function usdc(atomic: bigint): string {
  return `${(Number(atomic) / 1e6).toFixed(6)} USDC`;
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');

  let ctx: INestApplicationContext | null = null;
  try {
    ctx = await bootAppContext();
    const config = ctx.get(ConfigService);

    const rpcUrl = config.get<string>('SOLANA_RPC_URL');
    const programId = config.get<string>('SOLANA_SETTLEMENT_PROGRAM_ID');
    if (!rpcUrl || !programId) {
      throw new Error('SOLANA_RPC_URL and SOLANA_SETTLEMENT_PROGRAM_ID must both be set');
    }
    const programAddress = address(programId);

    const opener = ctx.get<EscrowOpenerPort>(ESCROW_OPENER);
    const intents = ctx.get<EscrowIntentBuilderPort>(ESCROW_INTENT_BUILDER);
    const redeemer = ctx.get<VoucherRedeemerPort>(VOUCHER_REDEEMER);
    // `ChainAdapterRegistry.resolve` rather than the raw `CHAIN_ADAPTERS` array:
    // it is what the domain uses, and it refuses a chain the adapter does not
    // list in `supportedChains` instead of silently handing back the first one.
    const adapter = ctx.get(ChainAdapterRegistry).resolve(CHAIN_IDS.SOLANA_DEVNET);

    const asset = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;
    const mint = address(asset.split('/token:')[1]);
    const chainId = CHAIN_IDS.SOLANA_DEVNET;

    const { rpc, send, confirm } = createSender(rpcUrl);

    // ── Keys ────────────────────────────────────────────────────────────────
    // The operator is the mint authority and the program's upgrade authority;
    // the buyer and provider are this harness's own, persisted so a re-run is
    // idempotent rather than a fresh escrow every time.
    const operator = await loadKeypairSigner(
      process.env.SOLANA_ADMIN_KEYPAIR ?? join(homedir(), '.x402-keys', 'devnet-operator.json'),
    );
    const buyer = await loadOrCreateSigner('rail-b-buyer');
    const provider = await loadOrCreateSigner('rail-b-provider');

    console.log(`\nprogram   ${programId}`);
    console.log(`operator  ${operator.address}`);
    console.log(`buyer     ${buyer.address}`);
    console.log(`provider  ${provider.address}`);
    console.log(`mint      ${mint}`);
    console.log(execute ? '\nmode: EXECUTE — this sends transactions\n' : '\nmode: DRY RUN\n');

    // ── 0. The program must be initialised under this id ─────────────────────
    const [configPda] = await findConfigPda({ programAddress });
    const onChainConfig = await fetchMaybeConfig(rpc, configPda);
    if (!onChainConfig.exists) {
      record('0 — config', false, `no Config at ${configPda} — run devnet:init-config first`);
      finish();
      return;
    }
    record(
      '0 — config',
      true,
      `Config live, stake_mint=${onChainConfig.data.stakeMint}, paused=${onChainConfig.data.paused}`,
    );
    if (onChainConfig.data.stakeMint !== mint) {
      record(
        '0 — mint',
        false,
        `config.stake_mint ${onChainConfig.data.stakeMint} != SOLANA_DEVNET_USDC_MINT ${mint}`,
      );
      finish();
      return;
    }
    const feesAccruedBefore = onChainConfig.data.feesAccrued;

    if (!execute) {
      console.log('dry run: stopping before the first transaction. Re-run with --execute.\n');
      finish();
      return;
    }

    // ── 1. Fund the buyer with SOL for its own two signatures ────────────────
    // No production path: a real buyer arrives already funded.
    const buyerLamports = (await rpc.getBalance(buyer.address).send()).value;
    if (buyerLamports < BUYER_SOL_LAMPORTS / 2n) {
      const sig = await send(
        [
          getTransferSolInstruction({
            source: operator,
            destination: buyer.address,
            amount: BUYER_SOL_LAMPORTS,
          }),
        ],
        operator,
      );
      await confirm(sig);
      record('1 — buyer SOL', true, `topped up to ~0.05 SOL (${sig.slice(0, 12)}…)`);
    } else {
      record('1 — buyer SOL', true, `already funded (${buyerLamports} lamports)`);
    }

    // ── 2. The provider needs a ProviderStake PDA ────────────────────────────
    // `redeem_voucher` binds `["stake", provider]`; with no stake account the
    // instruction cannot even be assembled. No production path: the platform
    // never opens a provider's stake — the provider does, from the console.
    const [stakePda] = await findStakePda({ provider: provider.address }, { programAddress });
    const existingStake = await fetchMaybeProviderStake(rpc, stakePda);
    if (!existingStake.exists) {
      // `stake` is optional on the generated builder, and an omitted
      // constant-seed account is filled by `findStakePda()` under the client's
      // *compiled-in* program id — not under `SOLANA_SETTLEMENT_PROGRAM_ID`.
      // Every PDA in this file is therefore passed explicitly, derived under
      // `programAddress`. The same applies to `config` and `stakeVault` below.
      const openIx = await getOpenStakeInstructionAsync({
        payer: operator,
        provider: provider.address,
        stake: stakePda,
      });
      const sig = await send([openIx], operator);
      await confirm(sig);
      record('2 — open_stake', true, `${stakePda} opened (${sig.slice(0, 12)}…)`);
    } else {
      record('2 — open_stake', true, `${stakePda} already open`);
    }

    const stakeNow = await fetchMaybeProviderStake(rpc, stakePda);
    const bonded = stakeNow.exists ? stakeNow.data.bonded : 0n;
    if (bonded < PROVIDER_STAKE) {
      const [operatorAta] = await findAssociatedTokenPda({
        owner: operator.address,
        mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const [stakeVault] = await findStakeVaultPda({ programAddress });
      const ixs: Instruction[] = [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: operator,
          owner: operator.address,
          mint,
        }),
        getMintToInstruction({
          mint,
          token: operatorAta,
          mintAuthority: operator,
          amount: PROVIDER_STAKE,
        }),
        await getDepositStakeInstructionAsync({
          funder: operator,
          funderTokenAccount: operatorAta,
          config: configPda,
          stake: stakePda,
          stakeVault,
          stakeMint: mint,
          amount: PROVIDER_STAKE,
        }),
      ];
      const sig = await send(ixs, operator);
      await confirm(sig);
      record('2b — deposit_stake', true, `bonded ${usdc(PROVIDER_STAKE)} (${sig.slice(0, 12)}…)`);
    } else {
      record('2b — deposit_stake', true, `already bonded ${usdc(bonded)}`);
    }

    // ── 3. Open the buyer's escrow — PRODUCTION PATH ─────────────────────────
    const buyerAccount = toAccountId(chainId, buyer.address) as AccountId;
    const opened = await opener.open(buyerAccount, asset);
    record(
      '3 — open_escrow',
      true,
      `escrow=${opened.escrowPda.split(':').pop()} ata=${opened.escrowTokenAccount
        .split(':')
        .pop()} ${opened.signature ? `(${opened.signature.slice(0, 12)}…)` : '(already open)'}`,
    );

    const [escrowPda] = await findEscrowPda({ buyer: buyer.address }, { programAddress });
    const [escrowAta] = await findAssociatedTokenPda({
      owner: escrowPda,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    // ── 4. The buyer arms its own ceilings — PRODUCTION PATH ─────────────────
    // The step the frontend has an intent for and no prompt to reach it. Until
    // it runs, `max_voucher_amount` is 0 and every redemption is refused.
    // Idempotent on purpose: the program refuses a no-op update with
    // `EscrowLimitsUnchanged` (6077), so a second run of this harness would
    // fail on a step that had already succeeded. Read first, write only on a
    // real change — the same thing a console would have to do.
    const armed = await fetchMaybeBuyerEscrow(rpc, escrowPda);
    if (
      armed.exists &&
      armed.data.maxVoucherAmount === MAX_VOUCHER_AMOUNT &&
      armed.data.maxPerWindow === MAX_PER_WINDOW
    ) {
      record(
        '4 — set_escrow_limits',
        true,
        `already armed: max_voucher=${usdc(MAX_VOUCHER_AMOUNT)} max_window=${usdc(MAX_PER_WINDOW)}`,
      );
    } else {
      const limitsIntent = await intents.buildIntent({
        kind: EscrowIntentKind.SET_LIMITS,
        account: buyerAccount,
        asset,
        amount: null,
        limits: { maxVoucherAmount: MAX_VOUCHER_AMOUNT, maxPerWindow: MAX_PER_WINDOW },
        destination: null,
      });
      const limitsSig = await signAndSend(limitsIntent.transactionBase64, buyer, rpcUrl);
      record(
        '4 — set_escrow_limits',
        true,
        `max_voucher=${usdc(MAX_VOUCHER_AMOUNT)} max_window=${usdc(
          MAX_PER_WINDOW,
        )} (${limitsSig.slice(0, 12)}…)`,
      );
    }

    // ── 5. Put money in the escrow ───────────────────────────────────────────
    // A real buyer signs a transfer built by `POST /deposits`; the operator is
    // the mint authority here, so it mints straight into the escrow's ATA.
    const escrowBalanceBefore = await tokenBalance(rpc, escrowAta);
    if (escrowBalanceBefore < ESCROW_FUNDING) {
      const sig = await send(
        [
          getMintToInstruction({
            mint,
            token: escrowAta,
            mintAuthority: operator,
            amount: ESCROW_FUNDING,
          }),
        ],
        operator,
      );
      await confirm(sig);
      record('5 — fund escrow', true, `minted ${usdc(ESCROW_FUNDING)} (${sig.slice(0, 12)}…)`);
    } else {
      record('5 — fund escrow', true, `already holds ${usdc(escrowBalanceBefore)}`);
    }

    // ── 6. Snapshot before ───────────────────────────────────────────────────
    const escrowBefore = await tokenBalance(rpc, escrowAta);
    // Lifetime totals, not deltas: `ProviderEarnings.balance` and
    // `Config.fees_accrued` both accumulate across runs, so only the difference
    // across this redemption says anything about this redemption.
    const earningsBefore = await fetchProviderEarnings(rpc, provider.address, programAddress);
    const escrowState = await fetchMaybeBuyerEscrow(rpc, escrowPda);
    const seq = escrowState.exists ? escrowState.data.seqHigh + 1n : 1n;
    record(
      '6 — snapshot',
      true,
      `escrow holds ${usdc(escrowBefore)}, next seq=${seq}, fees_accrued=${usdc(feesAccruedBefore)}`,
    );

    // ── 7. The voucher the buyer signs — PRODUCTION ENCODER ──────────────────
    const now = Math.floor(Date.now() / 1000);
    const voucher = {
      payer: buyerAccount,
      payTo: toAccountId(chainId, escrowPda) as AccountId,
      provider: toAccountId(chainId, provider.address) as AccountId,
      amount: MoneyUtil.of(VOUCHER_AMOUNT, asset, DECIMALS),
      resource: `https://x402.test/rail-b/${now}`,
      requestHash: `sha256:${'0'.repeat(64)}`,
      seq: seq.toString(),
      issuedAt: now,
      expiresAt: now + 240,
    };

    const message = adapter.buildVoucherMessage(voucher);
    record(
      '7 — encode',
      message.length === 239,
      `buildVoucherMessage produced ${message.length} bytes (the program expects 239)`,
    );

    const rawSignature = await signBytes(buyer.keyPair.privateKey, message);
    const signature = getBase58Decoder().decode(rawSignature);

    // ── 8. Redeem — PRODUCTION PATH ──────────────────────────────────────────
    const request: RedeemVoucherRequest = {
      payer: voucher.payer,
      provider: voucher.provider,
      amount: voucher.amount,
      asset,
      // The request carries the HASH; `buildVoucherMessage` takes the raw
      // resource and hashes it itself. Passing the URL here is a 32-byte field
      // holding a URL — the client refuses it with "expected exactly 32 bytes".
      resourceHash: computeResourceHash(voucher.resource),
      requestHash: voucher.requestHash,
      seq: voucher.seq,
      issuedAt: voucher.issuedAt,
      expiresAt: voucher.expiresAt,
      signature,
    };

    try {
      const outcome = await redeemer.redeem(request);
      // `redeem` REPORTS a refusal, it does not throw one — a `try/catch` alone
      // reads `UNREDEEMABLE` as success. The kind is the assertion.
      record(
        '8 — redeem_voucher',
        outcome.kind === RedeemOutcomeKind.REDEEMED,
        `kind=${outcome.kind} sig=${outcome.signature?.slice(0, 16) ?? 'none'} programError=${
          outcome.programError ?? 'none'
        }`,
      );
      if (outcome.kind !== RedeemOutcomeKind.REDEEMED) {
        finish();
        return;
      }
    } catch (error) {
      // `explainProgramError` renders `{}` for an `AppError` whose useful text
      // is on `.message` and whose cause carries the chain's own logs, so both
      // are printed here rather than trusting one formatter.
      record('8 — redeem_voucher', false, describe(error));
      console.error('\nfull error:', error);
      finish();
      return;
    }

    // ── 9. Did the money actually move? ──────────────────────────────────────
    const escrowAfter = await tokenBalance(rpc, escrowAta);
    const [earningsPdaOnly] = await findStakePda(
      { provider: provider.address },
      { programAddress },
    );
    void earningsPdaOnly;
    const configAfter = await fetchMaybeConfig(rpc, configPda);
    const earnings = await fetchProviderEarnings(rpc, provider.address, programAddress);

    const debited = escrowBefore - escrowAfter;
    record(
      '9 — escrow debited',
      debited === VOUCHER_AMOUNT,
      `escrow ${usdc(escrowBefore)} → ${usdc(escrowAfter)} (moved ${usdc(debited)}, voucher was ${usdc(
        VOUCHER_AMOUNT,
      )})`,
    );

    const feesAfter = configAfter.exists ? configAfter.data.feesAccrued : 0n;
    const feeDelta = feesAfter - feesAccruedBefore;
    const earningsDelta = earnings - earningsBefore;
    record(
      '9b — split',
      earningsDelta + feeDelta === debited,
      `provider +${usdc(earningsDelta)}, platform +${usdc(feeDelta)}, sum ${usdc(
        earningsDelta + feeDelta,
      )} vs debited ${usdc(debited)}`,
    );

    // ── 10. The ceiling is enforced by the program, not by us ────────────────
    const overLimit = {
      ...voucher,
      amount: MoneyUtil.of(MAX_VOUCHER_AMOUNT + ONE_USDC, asset, DECIMALS),
      seq: (seq + 1n).toString(),
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 240,
    };
    const overMessage = adapter.buildVoucherMessage(overLimit);
    const overSig = getBase58Decoder().decode(
      await signBytes(buyer.keyPair.privateKey, overMessage),
    );
    const overOutcome = await redeemer.redeem({
      ...request,
      amount: overLimit.amount,
      seq: overLimit.seq,
      issuedAt: overLimit.issuedAt,
      expiresAt: overLimit.expiresAt,
      signature: overSig,
    });
    record(
      '10 — ceiling refused',
      overOutcome.kind !== RedeemOutcomeKind.REDEEMED,
      `kind=${overOutcome.kind} programError=${overOutcome.programError ?? 'none'}`,
    );

    // A refusal that is terminal must be REPORTED as terminal. `redeem()`'s own
    // `UNREDEEMABLE_ERRORS` set lists `VoucherExceedsPerCallLimit`, so this
    // should be `UNREDEEMABLE` and the buyer should get their money back on
    // this pass. It comes back `RETRY` with `programError: null` because
    // `extractCustomErrorCode` cannot read a preflight refusal: kit's
    // `SolanaError` carries the Anchor code at `cause.context.code` and the
    // "custom program error: 0x…" text only inside `context.logs[]`, and the
    // walker visits neither. Left asserting the correct behaviour rather than
    // the observed one — a harness that lowers its bar to stay green is the
    // failure it exists to prevent.
    record(
      '10c — refusal is terminal',
      overOutcome.kind === RedeemOutcomeKind.UNREDEEMABLE,
      `expected UNREDEEMABLE (VoucherExceedsPerCallLimit is in UNREDEEMABLE_ERRORS), got ${
        overOutcome.kind
      } with programError=${overOutcome.programError ?? 'null'}`,
    );

    // The refusal has to be believed on chain, not on the return value: a pass
    // that only reads `kind` would also pass if the program had accepted the
    // voucher and the reporting were wrong. `seq_high` is the witness — the
    // program raises it on every accepted redemption and on nothing else.
    const escrowFinal = await tokenBalance(rpc, escrowAta);
    const escrowStateFinal = await fetchMaybeBuyerEscrow(rpc, escrowPda);
    record(
      '10b — nothing moved',
      escrowFinal === escrowAfter &&
        escrowStateFinal.exists &&
        escrowStateFinal.data.seqHigh === seq,
      `escrow still ${usdc(escrowFinal)}, seq_high=${
        escrowStateFinal.exists ? escrowStateFinal.data.seqHigh : 'n/a'
      } (unchanged at ${seq} means the over-limit voucher never landed)`,
    );

    finish();
  } catch (error) {
    // Without this the `finally` below would swallow the throw and exit 0 with
    // an empty report — a silent green run, which is the one outcome a harness
    // must never be able to produce.
    record('UNCAUGHT', false, describe(error));
    console.error(error);
    finish();
  } finally {
    await ctx?.close().catch(() => undefined);
    // `RedisCacheModule` registers no `onModuleDestroy`, so its client keeps the
    // event loop alive and the process hangs here with every assertion already
    // printed. Exiting explicitly is the documented workaround — but stdout to a
    // pipe is asynchronous in Node, so flush before exiting or the whole report
    // is discarded at the moment it is needed.
    const code = report.length === 0 || report.some((r) => !r.ok) ? 1 : 0;
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(code);
  }
}

function finish(): void {
  const failed = report.filter((r) => !r.ok);
  console.log('\n─────────────────────────────────────────────');
  console.log(`${report.length - failed.length}/${report.length} checks passed`);
  failed.forEach((f) => console.log(`  FAILED: ${f.step} — ${f.detail}`));
  console.log('');
}

// ── helpers ────────────────────────────────────────────────────────────────

async function loadOrCreateSigner(name: string): Promise<KeyPairSigner> {
  const { loadOrCreateKeypair } = await import('./lib/keystore');
  const web3 = loadOrCreateKeypair(name);
  return createKeyPairSignerFromBytes(web3.secretKey);
}

async function tokenBalance(
  rpc: { getTokenAccountBalance(a: Address): { send(): Promise<{ value: { amount: string } }> } },
  ata: Address,
): Promise<bigint> {
  try {
    const res = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

async function fetchProviderEarnings(
  rpc: Parameters<typeof fetchMaybeProviderEarnings>[0],
  provider: Address,
  programAddress: Address,
): Promise<bigint> {
  const { findEarningsPda } = await import('@assay/settlement-client');
  const [pda] = await findEarningsPda({ provider }, { programAddress });
  const acc = await fetchMaybeProviderEarnings(rpc, pda);
  return acc.exists ? acc.data.balance : 0n;
}

/**
 * Signs a base64 transaction the intent builder produced, as the buyer, and
 * sends it. The builder returns exactly what `POST /escrow/limits-intent`
 * hands a browser wallet, so this is the wallet's half and nothing more.
 */
async function signAndSend(
  transactionBase64: string,
  signer: KeyPairSigner,
  rpcUrl: string,
): Promise<string> {
  const {
    getBase64EncodedWireTransaction,
    getTransactionDecoder,
    partiallySignTransaction,
    createSolanaRpc,
  } = await import('@solana/kit');

  const bytes = Uint8Array.from(Buffer.from(transactionBase64, 'base64'));
  const decoded = getTransactionDecoder().decode(bytes);
  const signed = await partiallySignTransaction([signer.keyPair], decoded);

  const rpc = createSolanaRpc(rpcUrl);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();

  for (let i = 0; i < 40; i += 1) {
    const status = await rpc.getSignatureStatuses([sig]).send();
    const value = status.value[0];
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
      if (value.err) throw new Error(`transaction failed: ${JSON.stringify(value.err)}`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`transaction ${sig} not confirmed in 40s`);
}

void main().catch((error) => {
  console.error('\nescrow-rail-b failed:', error);
  process.exit(1);
});
