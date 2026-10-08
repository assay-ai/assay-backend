/**
 * `yarn devnet:stake-accounts` — open and fund the two devnet `ProviderStake`
 * accounts that the routing stake-gate check needs in order to mean anything.
 *
 *     yarn devnet:stake-accounts                        # dry run, sends nothing
 *     yarn devnet:stake-accounts --execute --operator ~/keys/x402-admin.json
 *
 * ## Why this script exists
 *
 * The check is *"a provider below the stake minimum is dropped from routing,
 * using real on-chain state on devnet"*. At `PROVIDER_STAKE_SOURCE_MODE=chain`
 * that check is **vacuous unless real stake accounts exist**: a provider with no
 * `ProviderStake` PDA is absent from `OnChainProviderStakeSource`, absent becomes
 * `STAKE_UNKNOWN`, and `evaluateStakeGate` fails closed. With zero stake accounts
 * in existence the check "passes" by excluding everybody, and proves nothing
 * about stake.
 *
 * Proving a stake authority (`POST /providers/me/stake-authority`) does **not**
 * open an account either — it writes the enrolment's
 * `stake_authority_account_id` (`providers.stake_authority` before multichain
 * support), which is the
 * *seed* the PDA is derived from, not the PDA. Something has to call `open_stake`
 * and `deposit_stake`, on both sides of the floor. That is this script.
 *
 * ## Why the shape differs from `scripts/settlement/exercise-all.ts`
 *
 * `exercise-all.ts` is a smoke test: it proves the generated client's *encoding*
 * against a live cluster, throws its provider key away at the end of the run, and
 * uses the admin as `open_stake`'s `payer` because it does not care who owns the
 * rent. Three of those choices are wrong here, and the differences are the point:
 *
 *   - **The provider pays for its own accounts.** `open_stake`'s `payer` is the
 *     provider itself, and so is the ATA's. In the product path a provider is a
 *     third party who opens their own stake account; an operator-funded PDA is a
 *     rent-exempt balance the platform can never reclaim and a shape no provider
 *     will ever reproduce. The operator's only job here is to hand out the SOL
 *     and mint the test token — both devnet-only conveniences.
 *   - **The keypairs are persisted, not ephemeral.** These two accounts are
 *     fixtures the check refers to by address, and a second run that
 *     generated fresh keys would orphan the funded accounts from the first.
 *   - **Nothing is sent on the first invocation.** This spends real devnet SOL
 *     and mints a real supply, so `--execute` is opt-in.
 *
 * ## Idempotent
 *
 * Every step is a top-up against what the chain already says: SOL is transferred
 * only up to the target balance, `open_stake` is skipped when the PDA exists,
 * tokens are minted only to cover the shortfall, and `deposit_stake` deposits
 * only the difference between `bonded` and the target. Running it twice is safe
 * and the second run says what it skipped.
 */
// `.env` is loaded by `-r dotenv/config` in the package.json script entry, before
// this file or any of its imports run — the same ordering note `deposit.ts`
// carries, and for the same reason: `@modules/chains` reads env at import time.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { Address, address, Instruction, KeyPairSigner, unwrapOption } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  fetchMaybeMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  fetchMaybeConfig,
  fetchMaybeProviderStake,
  findConfigPda,
  findStakePda,
  findStakeVaultPda,
  getDepositStakeInstructionAsync,
  getOpenStakeInstructionAsync,
} from '@x402/settlement-client';

import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { loadMinimumStakeParameters } from '@modules/provider/services/provider-stake.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { createSender, loadKeypairSigner, Sender } from '../settlement/lib/sender';
import { solanaConfig } from './lib/solana-cli';

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** `8 + 32 + 10×8 + 1`, from the IDL's `ProviderStake`. Used to price the rent. */
const PROVIDER_STAKE_ACCOUNT_BYTES = 121n;
/** An SPL token account is a fixed 165 bytes. */
const TOKEN_ACCOUNT_BYTES = 165n;

/**
 * How much SOL each provider is topped up to.
 *
 * It has to cover the `ProviderStake` rent (~0.00173 SOL), its ATA's rent
 * (~0.00204 SOL) and three transaction fees. `0.02` leaves roughly 5× headroom,
 * which is the right trade on devnet: an under-funded provider fails halfway
 * through with an opaque `insufficient lamports`, and the SOL is free.
 */
const DEFAULT_PROVIDER_SOL = '0.02';

/** `--above`, as a multiple of the floor. Comfortably clear of the bar. */
const ABOVE_FLOOR_MULTIPLE = 10n;
/** `--below`, as a fraction of the floor. Comfortably under it. */
const BELOW_FLOOR_DIVISOR = 5n;

interface Options {
  readonly execute: boolean;
  readonly operatorPath: string | null;
  readonly outDir: string;
  readonly aboveAtomic: bigint | null;
  readonly belowAtomic: bigint | null;
  readonly minimumAtomic: bigint | null;
  readonly providerLamports: bigint;
}

/** One provider fixture: its key, its accounts, and what the chain currently says. */
interface Fixture {
  readonly role: 'above' | 'below';
  readonly keypairPath: string;
  /** `null` in a dry run when the key has not been generated yet — see `generateOnExecute`. */
  readonly signer: KeyPairSigner | null;
  readonly targetAtomic: bigint;
}

/** A resolved fixture — everything a dry run could not know is filled in. */
interface ResolvedFixture extends Fixture {
  readonly signer: KeyPairSigner;
  readonly stakePda: Address;
  readonly ata: Address;
  readonly lamports: bigint;
  readonly stakeExists: boolean;
  readonly bonded: bigint;
  readonly tokenBalance: bigint;
}

function usage(): never {
  console.error(`usage:
  yarn devnet:stake-accounts [--execute] [options]

  --execute              actually send. Without it nothing is sent and no file
                         is written; the plan is printed and the script exits 0.
  --operator <path>      path to the operator keypair (the settlement program's
                         admin AND the stake mint's authority). Falls back to
                         $SOLANA_DEVNET_KEYPAIR, then to \`solana config get\`.
                         Only ever a PATH — never paste a key on a command line.
  --out-dir <dir>        where the two provider keypairs live.
                         default ./.devnet
  --minimum <atomic>     override the stake floor. Default comes from the
                         backend's own PROVIDER_MINIMUM_STAKE_FLOOR.
  --above <atomic>       what the "above" provider bonds. Default ${ABOVE_FLOOR_MULTIPLE}× the floor.
  --below <atomic>       what the "below" provider bonds. Default 1/${BELOW_FLOOR_DIVISOR} of the floor.
  --sol <amount>         SOL each provider is topped up to. default ${DEFAULT_PROVIDER_SOL}

The cluster is $SOLANA_RPC_URL (devnet only — mainnet is refused outright) and
the program is $SOLANA_SETTLEMENT_PROGRAM_ID. Both are printed before anything
is sent.`);
  process.exit(1);
}

function parseOptions(argv: readonly string[]): Options {
  let execute = false;
  let operatorPath: string | null = null;
  let outDir = join(process.cwd(), '.devnet');
  let aboveAtomic: bigint | null = null;
  let belowAtomic: bigint | null = null;
  let minimumAtomic: bigint | null = null;
  let providerLamports = solToLamports(DEFAULT_PROVIDER_SOL);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--execute':
        execute = true;
        break;
      case '--operator':
        operatorPath = expandHome(requireValue(flag, value));
        index += 1;
        break;
      case '--out-dir':
        outDir = resolve(expandHome(requireValue(flag, value)));
        index += 1;
        break;
      case '--above':
        aboveAtomic = requireAtomic(flag, value);
        index += 1;
        break;
      case '--below':
        belowAtomic = requireAtomic(flag, value);
        index += 1;
        break;
      case '--minimum':
        minimumAtomic = requireAtomic(flag, value);
        index += 1;
        break;
      case '--sol':
        providerLamports = solToLamports(requireValue(flag, value));
        index += 1;
        break;
      default:
        console.error(`unknown flag '${flag}'`);
        usage();
    }
  }

  return {
    execute,
    operatorPath,
    outDir,
    aboveAtomic,
    belowAtomic,
    minimumAtomic,
    providerLamports,
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    console.error(`${flag} needs a value`);
    usage();
  }
  return value;
}

function requireAtomic(flag: string, value: string | undefined): bigint {
  const raw = requireValue(flag, value);
  if (!/^\d+$/.test(raw)) {
    console.error(`${flag} takes atomic units as a whole number, got '${raw}'`);
    usage();
  }
  return BigInt(raw);
}

/**
 * `~` is expanded here as well as by the shell.
 *
 * `SOLANA_DEVNET_KEYPAIR=~/.config/solana/id.json` in a `.env` file is a literal
 * tilde — dotenv does no expansion — and the failure is an ENOENT naming a path
 * that looks perfectly correct.
 */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function solToLamports(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    console.error(`--sol takes a decimal SOL amount, got '${value}'`);
    usage();
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0').slice(0, 9));
}

// ── the run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const programId = process.env.SOLANA_SETTLEMENT_PROGRAM_ID;
  if (!programId) {
    console.error('SOLANA_SETTLEMENT_PROGRAM_ID is not set. It is in .env.example.');
    process.exit(1);
  }
  const programAddress = address(programId);

  // `SOLANA_RPC_URL` wins over `solana config get`, the same precedence
  // `verifier:registry` uses: the CLI's cluster is a developer's working state
  // and is routinely pointed at a local validator, while the env var is the
  // cluster this deployment reads. Opening stake accounts on a different chain
  // from the one the router queries surfaces as "provider excluded" with no clue
  // why — which is exactly the symptom this script exists to remove.
  const cli = solanaConfig();
  const rpcUrl = process.env.SOLANA_RPC_URL ?? cli.rpcUrl;
  const operatorPath =
    options.operatorPath ??
    expandHome(
      process.env.SOLANA_DEVNET_KEYPAIR ?? process.env.SOLANA_ADMIN_KEYPAIR ?? cli.keypairPath,
    );

  const sender = createSender(rpcUrl);
  const operator = await loadKeypairSigner(operatorPath);

  console.log(
    `mode       ${options.execute ? 'EXECUTE — this run sends transactions' : 'DRY RUN — nothing is sent, nothing is written'}`,
  );
  console.log(`cluster    ${rpcUrl}`);
  console.log(`program    ${programAddress}`);
  console.log(`operator   ${operator.address}  (${operatorPath})`);

  await assertDevnet(sender);

  // ── 1. Config, and the mint it names ──────────────────────────────────────
  //
  // The mint is read off `Config`, never hard-coded. `deposit_stake` constrains
  // the vault to `config.stake_mint`, so a mint chosen here would fail every
  // deposit on a cluster that has already been initialised — and would fail with
  // a seeds/has-one error rather than with anything that names the mistake.
  const [configPda] = await findConfigPda({ programAddress });
  const config = await fetchMaybeConfig(sender.rpc, configPda);
  if (!config.exists) {
    console.error('');
    console.error(`there is no Config account at ${configPda}.`);
    console.error('Run `yarn verifier:registry init-config <stake-mint>` first — the stake mint,');
    console.error(
      'the vault and the unbonding period all come from it, and open_stake/deposit_stake',
    );
    console.error('constrain themselves against it.');
    process.exit(1);
  }
  const stakeMint = config.data.stakeMint;
  const [vaultPda] = await findStakeVaultPda({ programAddress });

  console.log(`config     ${configPda}`);
  console.log(`stake mint ${stakeMint}  (from Config — not this script's choice)`);
  console.log(`vault      ${vaultPda}`);

  const mint = await fetchMaybeMint(sender.rpc, stakeMint);
  if (!mint.exists) {
    console.error(
      `Config names ${stakeMint} as the stake mint, but there is no mint account there.`,
    );
    process.exit(1);
  }
  const mintAuthority = unwrapOption(mint.data.mintAuthority);

  // ── 2. the floor, from the backend's own config ───────────────────────────
  //
  // `loadMinimumStakeParameters` is the function `ProviderStakeService` and
  // `ToolModule.ROUTER_CONFIG` both call, so the number this script bonds against
  // cannot drift from the number the gate enforces. A `ConfigService` with no
  // internal config reads `process.env`, which `-r dotenv/config` has already
  // populated from `.env`.
  const parameters = loadMinimumStakeParameters(new ConfigService());
  const floorAtomic = options.minimumAtomic ?? MoneyUtil.toAtomic(parameters.floor);
  const floorSource = options.minimumAtomic
    ? '--minimum'
    : 'PROVIDER_MINIMUM_STAKE_FLOOR (backend config)';

  // A mint whose scale differs from the floor's would make every amount below
  // wrong by orders of magnitude, silently and in the permissive direction.
  if (mint.data.decimals !== parameters.floor.decimals) {
    console.error('');
    console.error(
      `the stake mint has ${mint.data.decimals} decimals but the backend's stake floor is ` +
        `denominated at ${parameters.floor.decimals}. Every amount below would be wrong by ` +
        `10^${Math.abs(mint.data.decimals - parameters.floor.decimals)}. Refusing.`,
    );
    process.exit(1);
  }

  const aboveAtomic = options.aboveAtomic ?? floorAtomic * ABOVE_FLOOR_MULTIPLE;
  const belowAtomic = options.belowAtomic ?? floorAtomic / BELOW_FLOOR_DIVISOR;
  if (aboveAtomic < floorAtomic) {
    console.error(
      `--above (${aboveAtomic}) is below the floor (${floorAtomic}); that is not the fixture.`,
    );
    process.exit(1);
  }
  if (belowAtomic >= floorAtomic) {
    console.error(
      `--below (${belowAtomic}) is at or above the floor (${floorAtomic}); that is not the fixture.`,
    );
    process.exit(1);
  }

  console.log('');
  console.log(
    `floor      ${token(floorAtomic, mint.data.decimals)}  (${floorAtomic} atomic, from ${floorSource})`,
  );
  console.log(`above      ${token(aboveAtomic, mint.data.decimals)}  (${aboveAtomic} atomic)`);
  console.log(`below      ${token(belowAtomic, mint.data.decimals)}  (${belowAtomic} atomic)`);
  console.log('');
  console.log(
    'note       the floor is only the FLAT half of the bar. The router enforces\n' +
      `           max(floor, ${parameters.priceMultiple}× price) PER BINDING, so any binding priced\n` +
      `           above ${token(floorAtomic / BigInt(parameters.priceMultiple), mint.data.decimals)} raises its own minimum above this floor.\n` +
      '           Price the checked binding at or below that, or raise --above.',
  );

  // ── 3. the two provider keypairs ──────────────────────────────────────────
  const fixtures = await loadFixtures(options, aboveAtomic, belowAtomic);

  // ── 4. what the chain already has ─────────────────────────────────────────
  const resolved: ResolvedFixture[] = [];
  for (const fixture of fixtures) {
    if (fixture.signer) {
      resolved.push(await resolveFixture(sender, programAddress, stakeMint, fixture));
    }
  }

  const stakeRent = await rentExempt(sender, PROVIDER_STAKE_ACCOUNT_BYTES);
  const ataRent = await rentExempt(sender, TOKEN_ACCOUNT_BYTES);
  const operatorLamports = (await sender.rpc.getBalance(operator.address).send()).value;

  // ── 5. the plan ───────────────────────────────────────────────────────────
  console.log('');
  console.log('==> plan');
  console.log('');

  let solToSend = 0n;
  let tokensToMint = 0n;

  for (const fixture of fixtures) {
    console.log(`  ${fixture.role} provider  (${fixture.keypairPath})`);
    if (!fixture.signer) {
      // A key that does not exist yet has no address, so no PDA, no ATA and no
      // on-chain state to diff against. The cost is still knowable — it is the
      // full target on both axes, because nothing has been paid yet — and it is
      // added to the totals so a first dry run does not report "0 SOL, 0 tokens"
      // for a run that will spend both.
      solToSend += options.providerLamports;
      tokensToMint += fixture.targetAtomic;
      console.log('    · key            WILL BE GENERATED (a dry run writes nothing)');
      console.log(
        `    · fund SOL       transfer ${sol(options.providerLamports)} SOL (a new key holds none)`,
      );
      console.log(`    · open_stake     open, provider pays ${sol(stakeRent)} SOL rent`);
      console.log(
        `    · mint tokens    mint ${token(fixture.targetAtomic, mint.data.decimals)} (ATA rent ${sol(ataRent)} SOL, paid by the provider)`,
      );
      console.log(
        `    · deposit_stake  deposit ${token(fixture.targetAtomic, mint.data.decimals)} → bonded ${token(fixture.targetAtomic, mint.data.decimals)}`,
      );
      console.log('');
      continue;
    }
    const state = resolved.find((entry) => entry.role === fixture.role)!;
    console.log(`    · address        ${state.signer.address}`);
    console.log(`    · stake pda      ${state.stakePda}`);
    console.log(`    · ata            ${state.ata}`);

    const solShortfall = shortfall(state.lamports, options.providerLamports);
    solToSend += solShortfall;
    console.log(
      solShortfall === 0n
        ? `    · fund SOL       SKIP — holds ${sol(state.lamports)} SOL, target is ${sol(options.providerLamports)}`
        : `    · fund SOL       transfer ${sol(solShortfall)} SOL (holds ${sol(state.lamports)}, target ${sol(options.providerLamports)})`,
    );
    console.log(
      state.stakeExists
        ? `    · open_stake     SKIP — the PDA exists, bonded=${token(state.bonded, mint.data.decimals)}`
        : `    · open_stake     open, provider pays ${sol(stakeRent)} SOL rent`,
    );

    const depositShortfall = shortfall(state.bonded, state.targetAtomic);
    const mintShortfall = shortfall(state.tokenBalance, depositShortfall);
    tokensToMint += mintShortfall;
    console.log(
      mintShortfall === 0n
        ? `    · mint tokens    SKIP — the ATA holds ${token(state.tokenBalance, mint.data.decimals)}, enough for the deposit`
        : `    · mint tokens    mint ${token(mintShortfall, mint.data.decimals)} (ATA rent ${sol(ataRent)} SOL, paid by the provider)`,
    );
    console.log(
      depositShortfall === 0n
        ? `    · deposit_stake  SKIP — bonded ${token(state.bonded, mint.data.decimals)} already reaches ${token(state.targetAtomic, mint.data.decimals)}`
        : `    · deposit_stake  deposit ${token(depositShortfall, mint.data.decimals)} → bonded ${token(state.targetAtomic, mint.data.decimals)}`,
    );
    console.log('');
  }

  console.log(`  operator pays   ${sol(solToSend)} SOL in transfers, plus ~0.00002 SOL in fees`);
  console.log(`  operator mints  ${token(tokensToMint, mint.data.decimals)} of ${stakeMint}`);
  console.log(`  operator holds  ${sol(operatorLamports)} SOL`);

  // ── 6. the gate that would otherwise fail halfway through ─────────────────
  //
  // Deliberately AFTER the plan and BEFORE the first send. Minting is step five
  // of six: without this check the SOL is already spent and both stake accounts
  // are already open when the run dies on the mint, leaving devnet holding two
  // half-built fixtures and the operator guessing which steps to redo. Checking
  // it in a dry run is also the only way an operator finds out they have the
  // wrong key without spending anything.
  if (mintAuthority !== operator.address) {
    console.error('');
    console.error('REFUSING: the operator keypair is not the stake mint authority.');
    console.error('');
    console.error(`  stake mint       ${stakeMint}  (Config.stake_mint)`);
    console.error(
      `  mint authority   ${mintAuthority ?? '<none — the mint authority has been revoked>'}`,
    );
    console.error(`  operator         ${operator.address}`);
    console.error(`  operator file    ${operatorPath}`);
    console.error('');
    console.error('Step 5 mints the stake token, so this run would open and fund both stake');
    console.error('accounts and then fail — leaving two half-built fixtures on devnet.');
    console.error('');
    console.error("Point --operator (or $SOLANA_DEVNET_KEYPAIR) at the mint authority's keypair");
    console.error('file. Pass the PATH; never paste key material on a command line.');
    process.exit(1);
  }

  if (!options.execute) {
    console.log('');
    console.log('DRY RUN — nothing was sent and no keypair was written.');
    console.log('Re-run with --execute to apply the plan above.');
    return;
  }

  // ── 7. execute ────────────────────────────────────────────────────────────
  console.log('');
  console.log('==> executing');
  console.log('');

  for (const state of resolved) {
    const solShortfall = shortfall(state.lamports, options.providerLamports);
    if (solShortfall > 0n) {
      await send(sender, operator, `${state.role}: fund ${sol(solShortfall)} SOL`, [
        getTransferSolInstruction({
          source: operator,
          destination: state.signer.address,
          amount: solShortfall,
        }),
      ]);
    } else {
      skipped(`${state.role}: fund SOL — already at target`);
    }

    if (!state.stakeExists) {
      // `payer: provider`, not `payer: operator`. See the file header — this is
      // the one place the product path and `exercise-all.ts` genuinely differ.
      await send(sender, state.signer, `${state.role}: open_stake`, [
        await getOpenStakeInstructionAsync(
          { payer: state.signer, provider: state.signer.address },
          { programAddress },
        ),
      ]);
    } else {
      skipped(`${state.role}: open_stake — the PDA already exists`);
    }

    const depositShortfall = shortfall(state.bonded, state.targetAtomic);
    const mintShortfall = shortfall(state.tokenBalance, depositShortfall);
    if (mintShortfall > 0n) {
      // Two signers in one transaction: the provider pays for its own ATA, the
      // operator is the mint authority and the fee payer. `signTransactionMessageWithSigners`
      // collects both from the instruction account metas, so this needs no
      // partial-signing dance.
      await send(
        sender,
        operator,
        `${state.role}: mint ${token(mintShortfall, mint.data.decimals)}`,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: state.signer,
            owner: state.signer.address,
            mint: stakeMint,
          }),
          getMintToInstruction({
            mint: stakeMint,
            token: state.ata,
            mintAuthority: operator,
            amount: mintShortfall,
          }),
        ],
      );
    } else {
      skipped(`${state.role}: mint — the ATA already covers the deposit`);
    }

    if (depositShortfall > 0n) {
      await send(
        sender,
        state.signer,
        `${state.role}: deposit_stake ${token(depositShortfall, mint.data.decimals)}`,
        [
          await getDepositStakeInstructionAsync(
            {
              funder: state.signer,
              funderTokenAccount: state.ata,
              stake: state.stakePda,
              stakeMint,
              amount: depositShortfall,
            },
            { programAddress },
          ),
        ],
      );
    } else {
      skipped(`${state.role}: deposit_stake — bonded already reaches the target`);
    }
  }

  // ── 8. read it back ───────────────────────────────────────────────────────
  console.log('');
  console.log('==> verification, read back from chain through the same client');
  console.log('');

  for (const state of resolved) {
    const account = await fetchMaybeProviderStake(sender.rpc, state.stakePda);
    console.log(`  ${state.role}`);
    console.log(`    provider    ${state.signer.address}`);
    console.log(`    stake pda   ${state.stakePda}`);
    if (!account.exists) {
      console.log('    state       NO ACCOUNT — the run did not produce the fixture');
      process.exitCode = 1;
      continue;
    }
    console.log(
      `    bonded      ${account.data.bonded}  (${token(account.data.bonded, mint.data.decimals)})` +
        `  ${account.data.bonded >= floorAtomic ? 'ABOVE the floor' : 'BELOW the floor'}`,
    );
    console.log(`    unbonding   ${account.data.unbonding}`);
    console.log(`    pending     ${account.data.pendingSlash}  (reserved by a live proposal)`);
    console.log('');
  }

  // The two lines the stake-gate check needs. The enrolment's
  // `stake_authority_account_id` is what
  // `OnChainProviderStakeSource` derives the PDA from, so until these are on the
  // two provider rows the chain source cannot answer for either of them and both
  // are excluded — which is the vacuous pass this script exists to prevent.
  console.log("  Apply these for the stake-gate check — set each provider's enrolment");
  console.log('  (POST /providers/me/stake-authority, or the column directly) and run at');
  console.log('  PROVIDER_STAKE_SOURCE_MODE=chain:');
  console.log('');
  for (const state of resolved) {
    console.log(
      `  ${state.role.padEnd(5)} provider_chain_enrolments.stake_authority_account_id = ` +
        `${toAccountId(CHAIN_IDS.SOLANA_DEVNET, String(state.signer.address))}`,
    );
  }
}

// ── steps ───────────────────────────────────────────────────────────────────

async function send(
  sender: Sender,
  feePayer: KeyPairSigner,
  label: string,
  instructions: readonly Instruction[],
): Promise<void> {
  const signature = await sender.send(instructions, feePayer);
  console.log(`  [ ok ] ${label}`);
  console.log(`         https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

function skipped(label: string): void {
  console.log(`  [skip] ${label}`);
}

/**
 * Refuse anything that is not devnet, and refuse mainnet by name.
 *
 * The genesis hash is the chain's identity — an `SOLANA_RPC_URL` pointing at a
 * mainnet proxy on a devnet-looking hostname would pass a string check on the
 * URL and fail this one.
 */
async function assertDevnet(sender: Sender): Promise<void> {
  const genesis = await sender.rpc.getGenesisHash().send();
  const caip2 = `solana:${genesis.slice(0, 32)}`;
  if (caip2 === CHAIN_IDS.SOLANA_MAINNET) {
    console.error('');
    console.error('REFUSING: this is MAINNET. The script mints tokens and spends SOL.');
    process.exit(1);
  }
  if (caip2 !== CHAIN_IDS.SOLANA_DEVNET) {
    console.error('');
    console.error(`REFUSING: the cluster's genesis hash is ${genesis}, which is not devnet.`);
    console.error(`expected ${CHAIN_IDS.SOLANA_DEVNET}, got ${caip2}`);
    process.exit(1);
  }
  console.log(`chain      ${CHAIN_IDS.SOLANA_DEVNET}  (genesis ${genesis})`);
}

/**
 * The two provider keypairs, reused when they exist.
 *
 * A dry run deliberately writes nothing: a preview that leaves files behind is
 * not a preview. The cost is that a first dry run cannot print the addresses —
 * which is honest, because a key that does not exist has no PDA and no plan.
 */
async function loadFixtures(
  options: Options,
  aboveAtomic: bigint,
  belowAtomic: bigint,
): Promise<readonly Fixture[]> {
  const roles = [
    { role: 'above' as const, file: 'provider-above.json', targetAtomic: aboveAtomic },
    { role: 'below' as const, file: 'provider-below.json', targetAtomic: belowAtomic },
  ];

  const fixtures: Fixture[] = [];
  for (const { role, file, targetAtomic } of roles) {
    const keypairPath = join(options.outDir, file);
    if (!existsSync(keypairPath)) {
      if (!options.execute) {
        fixtures.push({ role, keypairPath, signer: null, targetAtomic });
        continue;
      }
      mkdirSync(options.outDir, { recursive: true });
      // `solana-keygen` rather than a hand-rolled ed25519 generation: it writes
      // the exact 64-byte JSON array `loadKeypairSigner`, `spl-token` and
      // `solana` all read, and the CLI is already a dependency of every other
      // devnet script here.
      execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '-s', '-o', keypairPath]);
      console.log(`generated  ${keypairPath}`);
    }
    fixtures.push({
      role,
      keypairPath,
      signer: await loadKeypairSigner(keypairPath),
      targetAtomic,
    });
  }
  return fixtures;
}

async function resolveFixture(
  sender: Sender,
  programAddress: Address,
  stakeMint: Address,
  fixture: Fixture,
): Promise<ResolvedFixture> {
  const signer = fixture.signer!;
  const [stakePda] = await findStakePda({ provider: signer.address }, { programAddress });
  const [ata] = await findAssociatedTokenPda({
    mint: stakeMint,
    owner: signer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const stake = await fetchMaybeProviderStake(sender.rpc, stakePda);
  const balance = await sender.rpc.getBalance(signer.address).send();

  return {
    ...fixture,
    signer,
    stakePda,
    ata,
    lamports: balance.value,
    stakeExists: stake.exists,
    bonded: stake.exists ? stake.data.bonded : 0n,
    tokenBalance: await tokenBalanceOf(sender, ata),
  };
}

/** `0` for an ATA that does not exist yet — the RPC errors rather than returning zero. */
async function tokenBalanceOf(sender: Sender, account: Address): Promise<bigint> {
  try {
    const { value } = await sender.rpc.getTokenAccountBalance(account).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

async function rentExempt(sender: Sender, bytes: bigint): Promise<bigint> {
  return sender.rpc.getMinimumBalanceForRentExemption(bytes).send();
}

// ── formatting ──────────────────────────────────────────────────────────────

function shortfall(current: bigint, target: bigint): bigint {
  return current >= target ? 0n : target - current;
}

function sol(lamports: bigint): string {
  return scaled(lamports, 9);
}

function token(atomic: bigint, decimals: number): string {
  return scaled(atomic, decimals);
}

function scaled(atomic: bigint, decimals: number): string {
  const text = atomic.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
