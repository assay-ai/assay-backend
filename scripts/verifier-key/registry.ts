/**
 * `yarn verifier:registry <register|revoke|show|init-config> …` — the operator
 * tool for the on-chain verifier allowlist.
 *
 * ## Why this is a script and not an endpoint
 *
 * It signs with the **admin** key, and the admin key is what decides which
 * signing keys the settlement program will accept. If the service that holds
 * the verifier signing key could also enrol keys, compromising that one service
 * would be enough to mint a verifier and slash every provider. Denying that is
 * the reason `VerifierRegistryPort` has no `register` method. So enrolment lives out here,
 * behind a keypair file this codebase never loads at runtime.
 *
 * ## Every byte on the wire comes from the generated client
 *
 * This script used to build its own instruction data: `sha256("global:register_verifier")`
 * for the discriminator, a hand-packed `[u8; 32]` label, a `writeBigInt64LE` for
 * the expiry, and a hand-written account list in the order `register_verifier.rs`
 * happened to declare. That was a second, unchecked copy of the program's
 * interface living in a script nobody re-reads — and the one instruction it
 * encodes decides who may take a provider's stake.
 *
 * It now calls `getRegisterVerifierInstructionAsync` from
 * `@x402/settlement-client`, which is Codama output rendered from the program's
 * IDL. Discriminator, argument encoding, account order, signer and writable
 * flags, and the PDA seeds are all the program's own, and `yarn client:check`
 * fails the build if they stop being.
 *
 * The cross-check that used to justify the hand-rolled version still holds and
 * is now free: the program re-derives every PDA itself under its `seeds`
 * constraints, so a drift between the two fails the transaction with
 * `ConstraintSeeds` rather than writing somewhere else.
 */
import { Address, address, KeyPairSigner, ReadonlyUint8Array } from '@solana/kit';
import {
  fetchMaybeVerifierKey,
  findConfigPda,
  findStakeVaultPda,
  findVerifierKeyPda,
  getInitializeConfigInstructionAsync,
  getRegisterVerifierInstructionAsync,
  getRevokeVerifierInstructionAsync,
  VerifierStatus,
} from '@x402/settlement-client';

import { createSender, loadKeypairSigner, Sender } from '../settlement/lib/sender';
import { solanaConfig } from '../devnet/lib/solana-cli';

const DAY_SECONDS = 86_400;
const LABEL_BYTES = 32;

function usage(): never {
  console.error(`usage:
  yarn verifier:registry show      <verifier-address>
  yarn verifier:registry register  <verifier-address> <label> <days-valid>
  yarn verifier:registry revoke    <verifier-address>
  yarn verifier:registry init-config <stake-mint>      # one-time, per cluster

The admin keypair is whatever \`solana config get\` points at. The cluster is
its RPC URL. Both are printed before anything is sent.`);
  process.exit(1);
}

interface Context {
  readonly programAddress: Address;
  readonly sender: Sender;
  readonly admin: KeyPairSigner;
  readonly config: Address;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const programId = process.env.SOLANA_SETTLEMENT_PROGRAM_ID;
  if (!programId) {
    console.error('SOLANA_SETTLEMENT_PROGRAM_ID is not set. It is in .env.example.');
    process.exit(1);
  }

  // `SOLANA_RPC_URL` wins over `solana config get`. The CLI's cluster is a
  // developer's working state and is routinely pointed at a local validator;
  // the env var is the cluster this *deployment* reads, and enrolling a
  // verifier on a different chain from the one the platform checks against is a
  // failure that surfaces as "not in the registry" with no clue why.
  const cli = solanaConfig();
  const rpcUrl = process.env.SOLANA_RPC_URL ?? cli.rpcUrl;
  const keypairPath = process.env.SOLANA_ADMIN_KEYPAIR ?? cli.keypairPath;

  const programAddress = address(programId);
  const admin = await loadKeypairSigner(keypairPath);
  const [config] = await findConfigPda({ programAddress });

  console.log(`program  ${programId}`);
  console.log(`cluster  ${rpcUrl}`);
  console.log(`admin    ${admin.address}`);
  console.log('');

  const context: Context = {
    programAddress,
    sender: createSender(rpcUrl),
    admin,
    config,
  };

  switch (command) {
    case 'show':
      return show(context, args[0] ?? usage());
    case 'register':
      return register(context, args);
    case 'revoke':
      return revoke(context, args[0] ?? usage());
    case 'init-config':
      return initConfig(context, args[0] ?? usage());
    default:
      usage();
  }
}

// ── commands ────────────────────────────────────────────────────────────────

async function show(context: Context, verifier: string): Promise<void> {
  const [pda] = await findVerifierKeyPda(
    { verifier: address(verifier) },
    { programAddress: context.programAddress },
  );
  const account = await fetchMaybeVerifierKey(context.sender.rpc, pda);
  if (!account.exists) {
    console.log(`${verifier} is NOT in the registry`);
    console.log(`pda           ${pda}`);
    return;
  }

  const key = account.data;
  console.log(`verifier      ${key.verifier}`);
  console.log(`status        ${VerifierStatus[key.status]}`);
  console.log(`label         ${decodeLabel(key.label)}`);
  console.log(`registered    ${iso(key.registeredAt)}`);
  console.log(`expires       ${iso(key.expiresAt)}`);
  console.log(`revoked       ${key.revokedAt === 0n ? '—' : iso(key.revokedAt)}`);
  console.log(`pda           ${pda}`);
}

async function register(context: Context, args: readonly string[]): Promise<void> {
  const [verifier, label, days] = args;
  if (!verifier || !label || !days) {
    usage();
  }
  if (Buffer.byteLength(label, 'utf8') > LABEL_BYTES) {
    console.error(
      `label must be at most ${LABEL_BYTES} bytes, "${label}" is ${Buffer.byteLength(label)}`,
    );
    process.exit(1);
  }

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Number(days) * DAY_SECONDS);

  const instruction = await getRegisterVerifierInstructionAsync(
    {
      admin: context.admin,
      verifier: address(verifier),
      label: labelBytes(label),
      expiresAt,
    },
    { programAddress: context.programAddress },
  );

  const signature = await context.sender.send([instruction], context.admin);
  const [pda] = await findVerifierKeyPda(
    { verifier: address(verifier) },
    { programAddress: context.programAddress },
  );

  console.log(`registered  ${verifier}`);
  console.log(`label       ${label}`);
  console.log(`expires     ${iso(expiresAt)}`);
  console.log(`pda         ${pda}`);
  console.log(`tx          ${signature}`);
  console.log('');
  console.log('This key can sign immediately: the program has no activation');
  console.log('delay, so a registered key is usable from this transaction on.');
}

async function revoke(context: Context, verifier: string): Promise<void> {
  const [pda] = await findVerifierKeyPda(
    { verifier: address(verifier) },
    { programAddress: context.programAddress },
  );

  const instruction = await getRevokeVerifierInstructionAsync(
    { admin: context.admin, verifierKey: pda },
    { programAddress: context.programAddress },
  );

  const signature = await context.sender.send([instruction], context.admin);

  console.log(`revoked  ${verifier}`);
  console.log(`tx       ${signature}`);
  console.log('');
  console.log('This is one-way. The account is not closed, so the key can never be');
  console.log('re-registered — rotation means a new keypair, which it does anyway.');
}

/**
 * One-time per cluster. Here rather than in a separate script because the
 * allowlist is admin-only and `Config` is where the admin is recorded.
 *
 * The key that signs here becomes the admin recorded in `Config`. Check
 * `solana config get` before `--execute`; there is no `close_config` to undo
 * it with.
 *
 * The instruction's nine arguments: the treasury, the unbonding period, four bps
 * figures, the minimum stake, the penalty ceiling and the verifier's daily cap.
 * No delays — `SLASH_DELAY_SECONDS` and `WITHDRAW_DELAY_SECONDS` are program
 * constants, and the other four delays this instruction used to take are gone
 * with the mechanisms that used them. The values below are the intended
 * defaults rather than the program's floors: a floor is what the program will
 * *accept*, not what a deployment should *choose*.
 *
 * `scripts/devnet/initialize-config.ts` is the flag-driven sibling of this
 * function; this one exists so that bringing a cluster up is one tool.
 */
async function initConfig(context: Context, stakeMint: string): Promise<void> {
  const existing = await context.sender.rpc
    .getAccountInfo(context.config, { encoding: 'base64' })
    .send();
  if (existing.value) {
    console.log(`config already initialised at ${context.config}`);
    return;
  }

  // The platform's fee destination. Defaults to the admin so a devnet bring-up
  // is one command, and is overridable because on mainnet the two must not be
  // the same key.
  const treasury = address(process.env.SOLANA_TREASURY ?? context.admin.address);

  // Derived against the id this script was pointed at. Codama would otherwise
  // fill this in under the client's compiled-in `declare_id!()`.
  const [stakeVault] = await findStakeVaultPda({ programAddress: context.programAddress });

  const instruction = await getInitializeConfigInstructionAsync(
    {
      admin: context.admin,
      config: context.config,
      stakeMint: address(stakeMint),
      stakeVault,
      treasury,
      unbondingPeriodSeconds: BigInt(14 * DAY_SECONDS),
      // The platform's cut of every redeemed voucher. Program ceiling 3000.
      takeRateBps: 500,
      // 60 / 30 / 10 — the agent, the platform and the provider's own retained
      // share.
      slashAgentBps: 6000,
      slashPlatformBps: 3000,
      // 10% of a provider's stake in any rolling 24h. Program ceiling 5000.
      slashCapBps: 1000,
      minimumStake: 100_000_000n,
      penaltyAmount: 1_000_000n,
      verifierDailyCap: 100_000_000n,
    },
    { programAddress: context.programAddress },
  );

  const signature = await context.sender.send([instruction], context.admin);

  console.log(`config       ${context.config}`);
  console.log(`vault        ${stakeVault}`);
  console.log(`treasury     ${treasury}`);
  console.log(`tx           ${signature}`);
  console.log('');
  console.log('NEXT: create ATA(treasury, stake_mint) by hand. `redeem_voucher`');
  console.log('pays the platform fee into it and the program never creates it.');
}

// ── plumbing ────────────────────────────────────────────────────────────────

/** `[u8; 32]` — a fixed-size Borsh array has no length prefix. NUL-padded. */
function labelBytes(label: string): Uint8Array {
  const bytes = new Uint8Array(LABEL_BYTES);
  bytes.set(Buffer.from(label, 'utf8').subarray(0, LABEL_BYTES));
  return bytes;
}

function decodeLabel(bytes: ReadonlyUint8Array): string {
  const view = Uint8Array.from(bytes);
  const end = view.indexOf(0);
  return Buffer.from(end === -1 ? view : view.subarray(0, end)).toString('utf8');
}

function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
