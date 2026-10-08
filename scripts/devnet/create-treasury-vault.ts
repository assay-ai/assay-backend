/**
 * `yarn devnet:create-vault` — create the platform's Squads v4 treasury
 * multisig on devnet, and print the two `.env` lines that point the backend at
 * it.
 *
 *     yarn devnet:create-vault                          # dry run, sends nothing
 *     yarn devnet:create-vault --execute --operator ~/.x402-keys/devnet-operator.json
 *
 * ## Why this script exists
 *
 * `SOLANA_VAULT_MULTISIG_CREATE_KEY` is unset, so `SquadsVaultService`
 * (`src/modules/chains/solana/squads-vault.service.ts`) throws
 * `vaultNotConfigured` from `deriveMultisigPda` — the very first thing every
 * vault read does. The reconciler therefore dies inside `getVaultBalance`
 * before it reaches a single drift comparison, and the alert it emits is
 * `reconciliation_blind` rather than a finding. The proof-of-reserves page is
 * blocked behind the same missing address. Nothing in `src/` can fix this:
 * creating a multisig is an admin action taken with a key the running service
 * deliberately does not hold (`docs/architecture.md` §"Signing Keys").
 *
 * ## THE CREATE KEY IS NOT THE MULTISIG — LOSING IT LOSES THE VAULT
 *
 * Squads v4 derives the multisig account from a **one-shot keypair** used only
 * as a PDA seed:
 *
 *     multisigPda = PDA(["multisig", "multisig", createKey], SQDS4ep…)
 *     vaultPda    = PDA(["multisig", multisigPda, "vault", u8(index)], SQDS4ep…)
 *
 * The create key signs exactly one transaction — the `multisig_create_v2` that
 * brings the multisig into existence — and is never used again. But its
 * **public key is the only input** from which the multisig address, and
 * therefore the vault address, can be re-derived. There is no on-chain index
 * from an admin wallet back to its multisigs. If the transaction lands and the
 * create key is lost, the multisig cannot be derived again, the backend can
 * never be configured to find it, and any funds sitting in its vault are
 * unreachable by this platform.
 *
 * So this script **writes the create key to disk before it sends anything**
 * (`.devnet/treasury-create-key.json`, beside the stake-account fixtures, and
 * gitignored for the same reason). A dry run writes nothing, which is why a
 * first dry run cannot print the addresses: a key that does not exist yet has
 * no public key and therefore no PDA. That is honest, not a gap.
 *
 * Back that file up somewhere other than this laptop before treating the vault
 * as real.
 *
 * ## Idempotent, and safe under a 429
 *
 * Public devnet rate-limits aggressively. Every step here reads chain state
 * first and skips what already exists, and the create key is persisted before
 * the first send — so the dangerous window (transaction submitted, confirmation
 * poll 429s, exit status unknown) resolves itself: the next run derives the
 * same multisig PDA, finds the account, and skips creation. A rate limit is
 * reported as "retry me" and exits `75`, distinct from a real failure's `1`.
 *
 * ## Devnet only
 *
 * Refused on any cluster whose **genesis hash** is not devnet's — not a string
 * match on the URL, which a mainnet proxy behind a devnet-looking hostname
 * would pass. A script that can create a mainnet treasury by accident is worse
 * than no script.
 */
// `.env` is loaded by `-r dotenv/config` in the package.json script entry,
// before this file or any of its imports run — the same ordering note
// `deposit.ts` and `setup-stake-accounts.ts` carry, and for the same reason:
// `@modules/chains/ports/asset-registry` reads `SOLANA_DEVNET_USDC_MINT` once,
// at import time.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  AccountRole,
  Address,
  address,
  AccountMeta,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU8Encoder,
  getUtf8Encoder,
  Instruction,
  KeyPairSigner,
} from '@solana/kit';
import type { AccountSignerMeta } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, parseAssetId } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_VAULT_INDEX,
  SQUADS_SEED_MULTISIG,
  SQUADS_SEED_PREFIX,
  SQUADS_SEED_VAULT,
  SQUADS_V4_PROGRAM_ADDRESS,
} from '@modules/chains/solana/squads-vault.constants';

import { createSender, loadKeypairSigner, Sender } from '../settlement/lib/sender';
import { solanaConfig } from './lib/solana-cli';

/**
 * The wallet that will be the multisig's only member, from
 * `$TREASURY_ADMIN_WALLET` (required).
 *
 * Named separately rather than taken from `--operator`, so that pointing the
 * script at the wrong keypair file is refused instead of quietly producing a
 * treasury nobody intended to control. The operator key must BE this wallet —
 * it signs the creation and pays the rent.
 */
const ADMIN_WALLET = process.env.TREASURY_ADMIN_WALLET ?? '';

/** 1-of-1: one member, and it must approve. */
const THRESHOLD = 1;

/** No delay between a proposal reaching threshold and being executable. */
const TIME_LOCK = 0;

/** Shown in the creation transaction's memo, so the account is identifiable on an explorer. */
const MEMO = 'x402 platform devnet treasury vault';

/** Exit code for "the cluster rate-limited us"; `1` stays reserved for real failures. */
const EXIT_RATE_LIMITED = 75;

const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;

const utf8Encoder = getUtf8Encoder();
const addressEncoder = getAddressEncoder();
const u8Encoder = getU8Encoder();

interface Options {
  readonly execute: boolean;
  readonly operatorPath: string | null;
  readonly createKeyPath: string | null;
  readonly outDir: string;
  readonly url: string | null;
  readonly vaultIndex: number;
}

function usage(): never {
  console.error(`usage:
  yarn devnet:create-vault [--execute] [options]

  --execute            actually send. Without it nothing is sent, NO keypair
                       file is written, and the script exits 0.
  --operator <path>    path to the operator keypair. It must be the admin
                       wallet named by $TREASURY_ADMIN_WALLET (required);
                       it signs the creation and pays the rent. Falls back to
                       $SOLANA_DEVNET_KEYPAIR, then $SOLANA_ADMIN_KEYPAIR, then
                       \`solana config get\`. Only ever a PATH — never paste a
                       key on a command line.
  --create-key <path>  path to the multisig's create key. Reused when the file
                       exists; generated there on --execute when it does not.
                       default <out-dir>/treasury-create-key.json
  --out-dir <dir>      where the create key lives. default ./.devnet
  --url <rpc>          override the cluster. Precedence is --url, then
                       $SOLANA_RPC_URL, then \`solana config get\`. Point this at
                       a private devnet endpoint when the public one 429s.
  --vault-index <n>    which vault of the multisig. default ${DEFAULT_VAULT_INDEX}
                       (this is SOLANA_VAULT_INDEX; changing it changes the
                       vault address, so it is almost always 0).

Devnet only — the cluster's genesis hash is checked, and mainnet is refused by
name. Exit ${EXIT_RATE_LIMITED} means the cluster rate-limited us and the run should simply be
repeated; nothing is lost, because the create key is written before the first
send and every step skips what already exists.`);
  process.exit(1);
}

function parseOptions(argv: readonly string[]): Options {
  let execute = false;
  let operatorPath: string | null = null;
  let createKeyPath: string | null = null;
  let outDir = join(process.cwd(), '.devnet');
  let url: string | null = null;
  let vaultIndex = DEFAULT_VAULT_INDEX;

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
      case '--create-key':
        createKeyPath = resolve(expandHome(requireValue(flag, value)));
        index += 1;
        break;
      case '--out-dir':
        outDir = resolve(expandHome(requireValue(flag, value)));
        index += 1;
        break;
      case '--url':
        url = requireValue(flag, value);
        index += 1;
        break;
      case '--vault-index':
        vaultIndex = requireVaultIndex(flag, value);
        index += 1;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`unknown flag '${flag}'`);
        usage();
    }
  }

  return { execute, operatorPath, createKeyPath, outDir, url, vaultIndex };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    console.error(`${flag} needs a value`);
    usage();
  }
  return value;
}

function requireVaultIndex(flag: string, value: string | undefined): number {
  const raw = requireValue(flag, value);
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    console.error(`${flag} takes an integer in [0, 255], got '${raw}'`);
    usage();
  }
  return parsed;
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

// ── the run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  // The SDK and the backend must agree on the program id, or every address
  // below is derived under one program and read under another.
  if (multisig.PROGRAM_ADDRESS !== SQUADS_V4_PROGRAM_ADDRESS) {
    console.error(
      `REFUSING: @sqds/multisig targets ${multisig.PROGRAM_ADDRESS} but ` +
        `squads-vault.constants.ts says ${SQUADS_V4_PROGRAM_ADDRESS}.`,
    );
    process.exit(1);
  }

  // `--url` > `$SOLANA_RPC_URL` > `solana config get`, the same precedence
  // `devnet:stake-accounts` uses: the CLI's cluster is a developer's working
  // state and is routinely repointed, while the env var is the cluster this
  // deployment reads. `--url` is on top so that a public-devnet 429 can be
  // stepped around without editing `.env`.
  const cli = solanaConfig();
  const rpcUrl = options.url ?? process.env.SOLANA_RPC_URL ?? cli.rpcUrl;
  const operatorPath =
    options.operatorPath ??
    expandHome(
      process.env.SOLANA_DEVNET_KEYPAIR ?? process.env.SOLANA_ADMIN_KEYPAIR ?? cli.keypairPath,
    );

  const sender = createSender(rpcUrl);
  const operator = await loadKeypairSigner(operatorPath);

  console.log(
    `mode        ${options.execute ? 'EXECUTE — this run sends transactions' : 'DRY RUN — nothing is sent, nothing is written'}`,
  );
  console.log(`cluster     ${redact(rpcUrl)}`);
  console.log(`program     ${SQUADS_V4_PROGRAM_ADDRESS}  (Squads v4)`);
  console.log(`operator    ${operator.address}  (${operatorPath})`);
  console.log(`vault index ${options.vaultIndex}`);

  await assertDevnet(sender);

  // ── 1. the operator must be the admin wallet ──────────────────────────────
  //
  // Checked before anything is derived or written, and in a dry run too: the
  // point of the gate is that an operator finds out they hold the wrong key
  // without having created a treasury nobody controls.
  if (!ADMIN_WALLET) {
    console.error('');
    console.error('REFUSING: TREASURY_ADMIN_WALLET is not set.');
    console.error('');
    console.error("Set it to the base58 address of the wallet that will be the multisig's only");
    console.error('member. The operator keypair must be that wallet.');
    process.exit(1);
  }
  if (String(operator.address) !== ADMIN_WALLET) {
    console.error('');
    console.error('REFUSING: the operator keypair is not the admin wallet.');
    console.error('');
    console.error(`  expected   ${ADMIN_WALLET}`);
    console.error(`  got        ${operator.address}`);
    console.error(`  from       ${operatorPath}`);
    console.error('');
    console.error("That wallet is the multisig's only member, its config authority and the");
    console.error('rent payer. Creating the multisig with any other key produces a treasury');
    console.error('this platform cannot spend from — and there is no way to undo it.');
    console.error('');
    console.error('Point --operator (or $SOLANA_DEVNET_KEYPAIR) at the admin keypair FILE.');
    process.exit(1);
  }
  const adminPubkey = new PublicKey(ADMIN_WALLET);

  // ── 2. the create key ─────────────────────────────────────────────────────
  const createKeyPath = options.createKeyPath ?? join(options.outDir, 'treasury-create-key.json');
  const createKey = await loadOrGenerateCreateKey(createKeyPath, options.execute);

  console.log('');
  console.log(`create key  ${createKeyPath}`);
  if (!createKey) {
    console.log('            DOES NOT EXIST YET — a dry run writes nothing, so there is no');
    console.log('            public key, and therefore no multisig PDA and no vault PDA to');
    console.log('            print. --execute generates it, writes it to disk, and only then');
    console.log('            sends. Everything below is what that run would do.');
  } else {
    console.log(`            ${createKey.address}  (base58 public key)`);
  }

  // ── 3. the addresses, derived twice ───────────────────────────────────────
  //
  // Once through `@sqds/multisig` (what the program will actually accept) and
  // once through the backend's own seed constants (what `SquadsVaultService`
  // will later derive). Printing an address the backend cannot reproduce would
  // make the `.env` lines below useless, so they are cross-checked rather than
  // trusted.
  let derived: DerivedAddresses | null = null;
  if (createKey) {
    derived = await deriveAddresses(createKey.address, options.vaultIndex);
    if (derived.multisigPda !== derived.multisigPdaFromBackendSeeds) {
      console.error('');
      console.error(
        'REFUSING: the SDK and squads-vault.constants.ts derive DIFFERENT multisig PDAs.',
      );
      console.error(`  @sqds/multisig            ${derived.multisigPda}`);
      console.error(`  squads-vault.constants.ts ${derived.multisigPdaFromBackendSeeds}`);
      process.exit(1);
    }
    if (derived.vaultPda !== derived.vaultPdaFromBackendSeeds) {
      console.error('');
      console.error('REFUSING: the SDK and squads-vault.constants.ts derive DIFFERENT vault PDAs.');
      console.error(`  @sqds/multisig            ${derived.vaultPda}`);
      console.error(`  squads-vault.constants.ts ${derived.vaultPdaFromBackendSeeds}`);
      process.exit(1);
    }

    console.log('');
    console.log(`multisig    ${derived.multisigPda}`);
    console.log(`vault       ${derived.vaultPda}  (index ${options.vaultIndex})`);
    console.log(`vault ATA   ${derived.vaultAta}`);
    console.log(`  for mint  ${derived.usdcMint}  (${ASSET_IDS.USDC_SOLANA_DEVNET})`);
    console.log('');
    console.log('            both PDAs derived twice — once by @sqds/multisig, once by');
    console.log("            squads-vault.constants.ts's own seeds — and they agree.");
  }

  // ── 4. what the chain already has ─────────────────────────────────────────
  const programConfig = await readProgramConfig(sender);
  const existingMultisig = derived ? await readMultisig(sender, derived.multisigPda) : null;
  const vaultAtaExists = derived ? await accountExists(sender, derived.vaultAta) : false;
  const operatorLamports = await withRetry(
    'read operator balance',
    async () => (await sender.rpc.getBalance(operator.address).send()).value,
  );

  console.log('');
  console.log(`treasury    ${programConfig.treasury}  (Squads ProgramConfig — not our choice)`);
  console.log(`create fee  ${sol(programConfig.multisigCreationFee)} SOL, paid to that treasury`);

  // ── 5. the plan ───────────────────────────────────────────────────────────
  console.log('');
  console.log('==> plan');
  console.log('');
  console.log(`  operator holds  ${sol(operatorLamports)} SOL`);
  console.log('');

  if (!createKey) {
    console.log('  · create key    GENERATE and WRITE to disk BEFORE sending anything');
    console.log('  · multisig      create 1-of-1');
    console.log(`      member         ${ADMIN_WALLET}  (all permissions)`);
    console.log(`      threshold      ${THRESHOLD}`);
    console.log(`      configAuthor.  ${ADMIN_WALLET}`);
    console.log(`      timeLock       ${TIME_LOCK}`);
    console.log('  · vault ATA     create (idempotent) so getVaultBalance can read it');
  } else if (existingMultisig) {
    console.log('  · create key    SKIP — already on disk, reused');
    console.log('  · multisig      SKIP — the account already exists on chain');
    console.log(`      threshold      ${existingMultisig.threshold}`);
    console.log(`      members        ${existingMultisig.members.length}`);
    console.log(
      vaultAtaExists
        ? '  · vault ATA     SKIP — already exists'
        : '  · vault ATA     create (idempotent) so getVaultBalance can read it',
    );
  } else {
    console.log('  · create key    SKIP — already on disk, reused');
    console.log('  · multisig      create 1-of-1 (no account at the derived PDA)');
    console.log(`      member         ${ADMIN_WALLET}  (all permissions)`);
    console.log(`      threshold      ${THRESHOLD}`);
    console.log(`      configAuthor.  ${ADMIN_WALLET}`);
    console.log(`      timeLock       ${TIME_LOCK}`);
    console.log(
      vaultAtaExists
        ? '  · vault ATA     SKIP — already exists'
        : '  · vault ATA     create (idempotent) so getVaultBalance can read it',
    );
  }

  if (!options.execute) {
    console.log('');
    if (derived) {
      printEnvLines(createKey!.address, options.vaultIndex, false);
    }
    console.log('');
    console.log('DRY RUN — nothing was sent and no keypair was written.');
    console.log('Re-run with --execute to apply the plan above.');
    return;
  }

  // ── 6. execute ────────────────────────────────────────────────────────────
  console.log('');
  console.log('==> executing');
  console.log('');

  // Not reachable with a null create key: `loadOrGenerateCreateKey` generates
  // and persists it under --execute before any of this runs. The assertion is
  // here so a future edit cannot make "send first, write the key after" a
  // reachable state.
  if (!createKey || !derived) {
    throw new Error('internal: --execute reached the send path without a create key');
  }

  if (!existingMultisig) {
    const instruction = multisig.instructions.multisigCreateV2({
      treasury: new PublicKey(programConfig.treasury),
      creator: adminPubkey,
      multisigPda: new PublicKey(derived.multisigPda),
      // A CONTROLLED multisig: the admin wallet can change the member set and
      // the threshold directly, without routing a config change through a
      // proposal. That is the right shape for a single-owner devnet treasury,
      // and it is reversible in the safe direction — `multisig_set_config_authority`
      // can hand control to the members later, whereas an autonomous multisig
      // can only be changed by proposal.
      configAuthority: adminPubkey,
      threshold: THRESHOLD,
      members: [{ key: adminPubkey, permissions: multisig.types.Permissions.all() }],
      timeLock: TIME_LOCK,
      // No rent collector: nothing here should be able to close the multisig's
      // accounts and sweep their rent.
      rentCollector: null,
      createKey: new PublicKey(createKey.address),
      memo: MEMO,
    });

    // Two signers beyond the fee payer's own signature: the create key (it is
    // a seed AND a required signer, which is what makes the address
    // unforgeable) and the creator, which is the same admin key paying the
    // fee. `signTransactionMessageWithSigners` collects both off the account
    // metas, which is why the converter attaches them there.
    await send(sender, operator, 'multisig_create_v2', [
      web3InstructionToKit(instruction, [createKey, operator]),
    ]);
  } else {
    skipped('multisig_create_v2 — the account already exists');
  }

  if (!vaultAtaExists) {
    // The vault's token account, not the vault itself. `getVaultBalance` calls
    // `getTokenAccountBalance` on this address, and the RPC errors rather than
    // returning zero when it does not exist — so without it the reconciler
    // trades one blind failure for another.
    await send(sender, operator, `vault ATA for ${derived.usdcMint}`, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: operator,
        owner: derived.vaultPda,
        mint: address(derived.usdcMint),
      }),
    ]);
  } else {
    skipped('vault ATA — already exists');
  }

  // ── 7. read it back ───────────────────────────────────────────────────────
  console.log('');
  console.log('==> verification, read back from chain through the same client');
  console.log('');

  const account = await readMultisig(sender, derived.multisigPda);
  if (!account) {
    console.error(`  FAILED: there is still no multisig account at ${derived.multisigPda}`);
    process.exitCode = 1;
    return;
  }

  let ok = true;
  console.log(`  multisig        ${derived.multisigPda}`);
  console.log(`  owner           ${account.owner}`);
  ok = check(ok, account.owner === SQUADS_V4_PROGRAM_ADDRESS, 'owned by the Squads v4 program');

  console.log(`  createKey       ${account.createKey}`);
  ok = check(
    ok,
    account.createKey === String(createKey.address),
    'createKey on chain is the key on disk',
  );

  console.log(`  threshold       ${account.threshold}`);
  ok = check(ok, account.threshold === THRESHOLD, `threshold is ${THRESHOLD}`);

  console.log(`  members         ${account.members.length}`);
  for (const member of account.members) {
    console.log(`    ${member.key}  permissions mask ${member.mask}`);
  }
  ok = check(
    ok,
    account.members.length === 1 && account.members[0].key === ADMIN_WALLET,
    `the only member is ${ADMIN_WALLET}`,
  );
  ok = check(
    ok,
    account.members.length === 1 &&
      account.members[0].mask === multisig.types.Permissions.all().mask,
    'that member holds Initiate + Vote + Execute',
  );

  console.log(`  configAuthority ${account.configAuthority}`);
  console.log(`  timeLock        ${account.timeLock}`);

  // The whole point of the run: the address the backend will derive from the
  // `.env` line printed below, recomputed here from the backend's own seed
  // constants and compared against the SDK's.
  const reDerived = await deriveAddresses(createKey.address, options.vaultIndex);
  console.log(`  vault (index ${options.vaultIndex}) ${reDerived.vaultPdaFromBackendSeeds}`);
  ok = check(
    ok,
    reDerived.vaultPdaFromBackendSeeds === reDerived.vaultPda,
    "squads-vault.constants.ts's seeds reproduce the SDK's vault PDA",
  );

  const ataNowExists = await accountExists(sender, reDerived.vaultAta);
  console.log(`  vault ATA       ${reDerived.vaultAta}`);
  ok = check(ok, ataNowExists, 'the vault token account exists, so getVaultBalance can read it');

  console.log('');
  console.log(
    `  https://explorer.solana.com/address/${derived.multisigPda}?cluster=devnet  (multisig)`,
  );
  console.log(`  https://explorer.solana.com/address/${derived.vaultPda}?cluster=devnet  (vault)`);

  console.log('');
  printEnvLines(createKey.address, options.vaultIndex, true);

  if (!ok) {
    console.log('');
    console.log('At least one verification above FAILED — do not paste the lines yet.');
    process.exitCode = 1;
  }
}

// ── steps ───────────────────────────────────────────────────────────────────

/**
 * Sends once. Deliberately NOT wrapped in `withRetry`.
 *
 * Reads are retried because repeating one costs nothing. A send is different:
 * a 429 raised anywhere after `sendTransaction` — during the confirmation
 * poll, say — leaves a transaction that may well have landed, and retrying it
 * would resubmit `multisig_create_v2` against an account that now exists. The
 * retry would then die on a simulation error about an account already in use,
 * which reads as a failure and is in fact a success reported backwards.
 *
 * So a rate limit here becomes `RateLimited` immediately, the operator re-runs
 * the same command, and the state read skips whatever landed. The create key
 * is already on disk, which is what makes that re-read possible at all.
 */
async function send(
  sender: Sender,
  feePayer: KeyPairSigner,
  label: string,
  instructions: readonly Instruction[],
): Promise<void> {
  let signature: string;
  try {
    signature = await sender.send(instructions, feePayer);
  } catch (error) {
    if (isRateLimited(error)) {
      throw new RateLimited(label, error);
    }
    throw error;
  }
  console.log(`  [ ok ] ${label}`);
  console.log(`         https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

function skipped(label: string): void {
  console.log(`  [skip] ${label}`);
}

function check(previous: boolean, condition: boolean, label: string): boolean {
  console.log(`  ${condition ? '[ ok ]' : '[FAIL]'} ${label}`);
  return previous && condition;
}

function printEnvLines(createKey: Address, vaultIndex: number, created: boolean): void {
  console.log(
    created
      ? 'Paste these into backend/.env (this script deliberately does not write it):'
      : 'These are the lines this run WOULD produce:',
  );
  console.log('');
  console.log(`  SOLANA_VAULT_MULTISIG_CREATE_KEY=${createKey}`);
  console.log(`  SOLANA_VAULT_INDEX=${vaultIndex}`);
}

/**
 * Refuse anything that is not devnet, and refuse mainnet by name.
 *
 * The genesis hash is the chain's identity — a `SOLANA_RPC_URL` pointing at a
 * mainnet proxy on a devnet-looking hostname would pass a string check on the
 * URL and fail this one.
 */
async function assertDevnet(sender: Sender): Promise<void> {
  const genesis = await withRetry('read genesis hash', () => sender.rpc.getGenesisHash().send());
  const caip2 = `solana:${genesis.slice(0, 32)}`;
  if (caip2 === CHAIN_IDS.SOLANA_MAINNET) {
    console.error('');
    console.error('REFUSING: this is MAINNET.');
    console.error('This script creates a treasury multisig and spends SOL. A mainnet treasury');
    console.error('is a deliberate, reviewed act — not something a devnet script does by');
    console.error('accident because an RPC url was left pointing at the wrong cluster.');
    process.exit(1);
  }
  if (caip2 !== CHAIN_IDS.SOLANA_DEVNET) {
    console.error('');
    console.error(`REFUSING: the cluster's genesis hash is ${genesis}, which is not devnet.`);
    console.error(`expected ${CHAIN_IDS.SOLANA_DEVNET}, got ${caip2}`);
    process.exit(1);
  }
  console.log(`chain       ${CHAIN_IDS.SOLANA_DEVNET}  (genesis ${genesis})`);
}

/**
 * The create key, reused when it exists.
 *
 * A dry run writes nothing — a preview that leaves files behind is not a
 * preview — so it returns `null` and the caller prints what it cannot know.
 * Under `--execute` the file is written **first**, before the caller sends
 * anything, because a landed `multisig_create_v2` whose create key was never
 * persisted produces a vault nobody can ever address again.
 */
async function loadOrGenerateCreateKey(
  path: string,
  execute: boolean,
): Promise<KeyPairSigner | null> {
  if (existsSync(path)) {
    return loadKeypairSigner(path);
  }
  if (!execute) {
    return null;
  }
  mkdirSync(resolve(path, '..'), { recursive: true });
  // `solana-keygen` rather than a hand-rolled ed25519 generation: it writes the
  // exact 64-byte JSON array `loadKeypairSigner`, `spl-token` and `solana` all
  // read, and the CLI is already a dependency of every other devnet script here.
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '-s', '-o', path]);
  console.log('');
  console.log(`generated   ${path}`);
  console.log('            WRITTEN TO DISK BEFORE ANY TRANSACTION IS SENT. Back it up:');
  console.log('            it is the only input from which this vault can be re-derived.');
  return loadKeypairSigner(path);
}

interface DerivedAddresses {
  readonly multisigPda: Address;
  readonly multisigPdaFromBackendSeeds: Address;
  readonly vaultPda: Address;
  readonly vaultPdaFromBackendSeeds: Address;
  readonly vaultAta: Address;
  readonly usdcMint: string;
}

async function deriveAddresses(createKey: Address, vaultIndex: number): Promise<DerivedAddresses> {
  const [sdkMultisig] = multisig.getMultisigPda({ createKey: new PublicKey(createKey) });
  const [sdkVault] = multisig.getVaultPda({ multisigPda: sdkMultisig, index: vaultIndex });

  // The backend's own derivation, from `squads-vault.constants.ts`'s seeds —
  // the same code path `SquadsVaultService.deriveMultisigPda` /
  // `deriveVaultPda` run.
  const [backendMultisig] = await getProgramDerivedAddress({
    programAddress: address(SQUADS_V4_PROGRAM_ADDRESS),
    seeds: [
      utf8Encoder.encode(SQUADS_SEED_PREFIX),
      utf8Encoder.encode(SQUADS_SEED_MULTISIG),
      addressEncoder.encode(createKey),
    ],
  });
  const [backendVault] = await getProgramDerivedAddress({
    programAddress: address(SQUADS_V4_PROGRAM_ADDRESS),
    seeds: [
      utf8Encoder.encode(SQUADS_SEED_PREFIX),
      addressEncoder.encode(backendMultisig),
      utf8Encoder.encode(SQUADS_SEED_VAULT),
      u8Encoder.encode(vaultIndex),
    ],
  });

  const usdcMint = parseAssetId(ASSET_IDS.USDC_SOLANA_DEVNET).assetReference;
  const [vaultAta] = await findAssociatedTokenPda({
    owner: address(sdkVault.toBase58()),
    mint: address(usdcMint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  return {
    multisigPda: address(sdkMultisig.toBase58()),
    multisigPdaFromBackendSeeds: backendMultisig,
    vaultPda: address(sdkVault.toBase58()),
    vaultPdaFromBackendSeeds: backendVault,
    vaultAta,
    usdcMint,
  };
}

interface MultisigAccount {
  readonly owner: string;
  readonly createKey: string;
  readonly configAuthority: string;
  readonly threshold: number;
  readonly timeLock: number;
  readonly members: readonly { key: string; mask: number }[];
}

/**
 * Reads and decodes the multisig, or `null` when the account does not exist.
 *
 * Decoded from the raw base64 the shared kit RPC returns rather than through
 * `Multisig.fromAccountAddress`, which wants a `@solana/web3.js` `Connection` —
 * a second RPC client against the same cluster, with its own retry behaviour
 * and its own idea of which endpoint is configured.
 */
async function readMultisig(sender: Sender, pda: Address): Promise<MultisigAccount | null> {
  const info = await withRetry(`read multisig ${pda}`, () =>
    sender.rpc.getAccountInfo(pda, { encoding: 'base64' }).send(),
  );
  if (!info.value) {
    return null;
  }
  const [decoded] = multisig.accounts.Multisig.deserialize(
    Buffer.from(info.value.data[0], 'base64'),
  );
  return {
    owner: String(info.value.owner),
    createKey: decoded.createKey.toBase58(),
    configAuthority: decoded.configAuthority.toBase58(),
    threshold: decoded.threshold,
    timeLock: decoded.timeLock,
    members: decoded.members.map((member) => ({
      key: member.key.toBase58(),
      mask: member.permissions.mask,
    })),
  };
}

/**
 * The Squads program's own global config.
 *
 * `treasury` is not a free choice: `multisig_create_v2` requires it to equal
 * the address stored here, because that is where the protocol's creation fee
 * goes. Passing our own key fails on-chain with `InvalidAccount`.
 */
async function readProgramConfig(
  sender: Sender,
): Promise<{ treasury: string; multisigCreationFee: bigint }> {
  const [pda] = multisig.getProgramConfigPda({});
  const pdaAddress = address(pda.toBase58());
  const info = await withRetry('read Squads ProgramConfig', () =>
    sender.rpc.getAccountInfo(pdaAddress, { encoding: 'base64' }).send(),
  );
  if (!info.value) {
    console.error('');
    console.error(`REFUSING: there is no Squads ProgramConfig at ${pdaAddress}.`);
    console.error('The Squads v4 program is not initialised on this cluster.');
    process.exit(1);
  }
  const [decoded] = multisig.accounts.ProgramConfig.deserialize(
    Buffer.from(info.value.data[0], 'base64'),
  );
  return {
    treasury: decoded.treasury.toBase58(),
    multisigCreationFee: BigInt(decoded.multisigCreationFee.toString()),
  };
}

async function accountExists(sender: Sender, account: Address): Promise<boolean> {
  const info = await withRetry(`read ${account}`, () =>
    sender.rpc.getAccountInfo(account, { encoding: 'base64' }).send(),
  );
  return info.value !== null;
}

/**
 * A `@solana/web3.js` `TransactionInstruction` → a `@solana/kit` `Instruction`,
 * with signers reattached.
 *
 * The inverse of `lib/kit-to-web3.ts`, and needed for the same reason: the
 * repo is on `@solana/kit` everywhere (one Solana SDK, by design) while
 * `@sqds/multisig` is built on web3.js v1 and gives no choice. Going kit-ward rather than web3-ward keeps this script on
 * the shared `createSender`, so it inherits the one confirmation loop, the one
 * simulation-first behaviour and the decoded program errors instead of opening
 * a second RPC connection with its own.
 *
 * The signer reattachment is the part that is not mechanical: a web3
 * `AccountMeta` records only `isSigner`, so converting it yields an address
 * that must sign and no way to produce that signature.
 * `signTransactionMessageWithSigners` collects signers off the account metas,
 * so the `KeyPairSigner` for each such account is put back where it looks.
 */
function web3InstructionToKit(
  instruction: TransactionInstruction,
  signers: readonly KeyPairSigner[],
): Instruction {
  const byAddress = new Map(signers.map((signer) => [String(signer.address), signer]));

  const accounts: (AccountMeta | AccountSignerMeta)[] = instruction.keys.map((key) => {
    const accountAddress = address(key.pubkey.toBase58());
    if (!key.isSigner) {
      return {
        address: accountAddress,
        role: key.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
      };
    }
    const role = key.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
    const signer = byAddress.get(String(accountAddress));
    if (!signer) {
      throw new Error(
        `instruction requires a signature from ${accountAddress}, but no signer for it was supplied`,
      );
    }
    return { address: accountAddress, role, signer };
  });

  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts,
    data: new Uint8Array(instruction.data),
  };
}

// ── rate limits ─────────────────────────────────────────────────────────────

/**
 * Public devnet 429s constantly, so every RPC **read** goes through here.
 * Sends do not — see `send` for why resubmitting one is the wrong repair.
 *
 * Retries only on a rate limit — a program error, a bad signature or a missing
 * account is a real answer and retrying it just delays the report. When the
 * retries run out the failure is raised as a `RateLimited`, which `main`'s
 * handler turns into "retry me" and exit 75 rather than a
 * failure the operator has to reason about, because re-running is genuinely
 * safe: the create key is on disk and every step reads chain state first.
 */
async function withRetry<T>(label: string, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isRateLimited(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(
          `  [429 ] ${label} — rate limited, retrying in ${delay}ms (${attempt}/${RETRY_ATTEMPTS - 1})`,
        );
        await new Promise((done) => setTimeout(done, delay));
      }
    }
  }
  throw new RateLimited(label, lastError);
}

class RateLimited extends Error {
  constructor(
    readonly label: string,
    readonly cause: unknown,
  ) {
    super(`rate limited on: ${label}`);
    this.name = 'RateLimited';
  }
}

/**
 * A 429 arrives in several shapes depending on where in the kit stack it was
 * raised — an HTTP status on a `SolanaError` context, a `statusCode` on a
 * transport error, or nothing but the word in a message. Rather than guess
 * which, the whole error chain is flattened to a string and matched. A false
 * positive costs a few seconds of backoff; a false negative reports a
 * transient rate limit as a hard failure, which is the outcome this exists to
 * prevent.
 */
function isRateLimited(error: unknown): boolean {
  const seen = new Set<unknown>();
  let text = '';
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { message?: unknown; statusCode?: unknown; cause?: unknown };
    text += ` ${String(candidate.message ?? '')} ${String(candidate.statusCode ?? '')}`;
    try {
      text += ` ${JSON.stringify(candidate)}`;
    } catch {
      // A bigint anywhere in an RPC error object makes JSON.stringify throw.
      // The message and statusCode above are already collected, so skipping
      // the serialisation loses nothing that matters here.
    }
    current = candidate.cause;
  }
  if (typeof error === 'string') {
    text += ` ${error}`;
  }
  return /\b429\b|too many requests|rate.?limit/i.test(text);
}

// ── formatting ──────────────────────────────────────────────────────────────

function sol(lamports: bigint): string {
  const text = lamports.toString().padStart(10, '0');
  const whole = text.slice(0, text.length - 9);
  const fraction = text.slice(text.length - 9).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** RPC urls routinely carry an API key in the query string; do not print it. */
function redact(url: string): string {
  return url.replace(/([?&](api-key|api_key|apikey|key)=)[^&]*/gi, '$1***');
}

main().catch((error: unknown) => {
  if (error instanceof RateLimited) {
    console.error('');
    console.error('RATE LIMITED — this is "retry me", not a failure.');
    console.error('');
    console.error(`  gave up on: ${error.label}`);
    console.error('');
    console.error('Nothing is in an unknown state. The create key is on disk, so the same');
    console.error('multisig PDA is derived on the next run; if the creation transaction did');
    console.error('land, the next run reads the account and skips creation.');
    console.error('');
    console.error('Re-run the same command. If the public endpoint keeps refusing, pass');
    console.error('--url <private devnet rpc>.');
    process.exit(EXIT_RATE_LIMITED);
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
