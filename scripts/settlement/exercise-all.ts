/**
 * Call every instruction the settlement program has, from the backend, through
 * the generated typed client.
 *
 *     yarn settlement:exercise localnet
 *     yarn settlement:exercise devnet
 *
 * ## What this is for
 *
 * `yarn client:check` proves the generated client matches the IDL. The IDL gate
 * in the contract repo proves the IDL matches the program source. Neither proves
 * the composition *works* — that the account order Codama rendered is the order
 * the deployed program expects, that the Borsh arguments land in the right
 * fields, that the PDAs derive to the accounts the program's `seeds` constraints
 * re-derive. A drift gate is a proof about files; this is a proof about a chain.
 *
 * So: fifteen instructions, fifteen results, against a real cluster.
 *
 * ## How to read the results
 *
 * Two outcomes count as the client being right, and they are reported
 * differently because they mean different things:
 *
 *   `landed`  — the transaction confirmed. The program accepted the encoding
 *               and did the thing.
 *   `refused` — the program decoded the instruction and then declined on one of
 *               its own rules, by name. This still proves the encoding: an
 *               instruction whose discriminator or arguments were wrong fails
 *               with `InstructionFallbackNotFound` or a Borsh error, not with
 *               `UnbondingPeriodNotElapsed`.
 *
 * Anything else is a failure and the script exits non-zero.
 *
 * Two instructions are expected to be `refused` on a healthy run, and it is
 * worth knowing why before you read it as a defect:
 *
 *   `withdraw_stake`     — `MIN_UNBONDING_PERIOD_SECONDS` is 11 days. There is
 *                          no way to make this land in a smoke run and no way to
 *                          shorten it: the program's floor applies to the
 *                          admin's own `update_config`. Refusal *is* the
 *                          demonstration.
 *   `initialize_*`       — only on a cluster where they have already run. `init`
 *                          is one-shot by design. On a fresh localnet both land.
 */
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Address, address, getAddressDecoder, Instruction, KeyPairSigner } from '@solana/kit';
import { Ed25519Program, TransactionInstruction } from '@solana/web3.js';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  fetchMaybeConfig,
  fetchMaybeEconomicsConfig,
  fetchMaybeProviderStake,
  findConfigPda,
  findEconomicsPda,
  findStakePda,
  findStakeVaultPda,
  findSettlementRecordPda,
  findSlashRecordPda,
  findTermsPda,
  findVerifierKeyPda,
  getDepositStakeInstructionAsync,
  getInitializeConfigInstructionAsync,
  getInitializeEconomicsInstructionAsync,
  getOpenStakeInstructionAsync,
  getRecordExposureInstructionAsync,
  getRegisterVerifierInstructionAsync,
  getRequestUnstakeInstructionAsync,
  getReverseSlashInstructionAsync,
  getRevokeVerifierInstructionAsync,
  getSetProviderTermsInstructionAsync,
  getSettlePaymentInstructionAsync,
  getSlashInstructionAsync,
  getUpdateConfigInstructionAsync,
  getUpdateEconomicsInstructionAsync,
  getWithdrawStakeInstructionAsync,
  ResponseClass,
  reversalAttestationMessage,
  settlementAttestationMessage,
  slashAttestationMessage,
} from '@x402/settlement-client';

import { createSender, loadKeypairSigner } from './lib/sender';

const DAY = 86_400;
const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);

// ── the run's report ────────────────────────────────────────────────────────

type Outcome = 'landed' | 'refused' | 'failed';

interface Result {
  readonly order: number;
  readonly instruction: string;
  readonly discriminator: string;
  readonly accounts: number;
  readonly dataBytes: number;
  readonly outcome: Outcome;
  readonly detail: string;
}

const results: Result[] = [];
let order = 0;

/**
 * Send one instruction and record what the chain said.
 *
 * `expectRefusal` names the program error a step is *supposed* to hit. Naming it
 * rather than tolerating any refusal is the difference between "this rule fired"
 * and "something went wrong and we carried on".
 */
async function step(
  instruction: string,
  build: () => Promise<Instruction>,
  send: (ix: Instruction) => Promise<string>,
  options: { expectRefusal?: readonly string[] } = {},
): Promise<Result> {
  order += 1;
  const ix = await build();
  const data = ix.data ?? new Uint8Array();
  const discriminator = Buffer.from(data.subarray(0, 8)).toString('hex');
  const shape = {
    order,
    instruction,
    discriminator,
    accounts: (ix.accounts ?? []).length,
    dataBytes: data.length,
  };

  let result: Result;
  try {
    const signature = await send(ix);
    result = { ...shape, outcome: 'landed', detail: signature };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expected = (options.expectRefusal ?? []).find((name) => message.includes(name));
    if (expected) {
      result = { ...shape, outcome: 'refused', detail: expected };
    } else {
      result = { ...shape, outcome: 'failed', detail: firstLine(message) };
    }
  }

  results.push(result);
  const mark = result.outcome === 'failed' ? 'FAIL' : result.outcome === 'landed' ? ' ok ' : 'note';
  console.log(
    `[${mark}] ${String(order).padStart(2)}. ${instruction.padEnd(20)} ` +
      `${discriminator}  ${String(shape.accounts).padStart(2)} accts  ` +
      `${String(shape.dataBytes).padStart(3)}B  ${truncate(result.detail, 60)}`,
  );
  return result;
}

function firstLine(message: string): string {
  return message.split('\n')[0];
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

// ── the verifier's signing key ──────────────────────────────────────────────

/**
 * A real ed25519 keypair, in memory, used to sign attestations.
 *
 * In production this is `SignerPort` and the key never leaves it — see
 * `docs/architecture.md` §"Signing Keys". Here it is generated per run and thrown
 * away, because the point being demonstrated is the *encoding* of the three
 * signed instructions, and a run that reused the deployment's real verifier key
 * would be a script that reads it.
 */
function mintVerifierKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  return {
    address: address(getAddressDecoder().decode(raw)),
    publicKey: raw,
    sign: (message: Uint8Array) => new Uint8Array(signEd25519(null, message, privateKey)),
  };
}

/**
 * The ed25519 precompile instruction that carries a signature into the
 * transaction.
 *
 * Built with `@solana/web3.js`'s `Ed25519Program` and converted to the kit
 * shape, rather than by packing the precompile's offsets struct here. The
 * precompile is not this program and has no IDL, so there is no generated
 * builder for it — but there is a maintained one in an SDK already in the tree,
 * and "no generated client exists" is not a licence to hand-write the one
 * encoding in this transaction that the program's whole security argument rests
 * on.
 */
function ed25519VerifyInstruction(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Instruction {
  return web3ToKit(
    Ed25519Program.createInstructionWithPublicKey({
      publicKey,
      message,
      signature,
    }),
  );
}

/** Kit account roles: 0 readonly, 1 writable, 2 readonly signer, 3 writable signer. */
function web3ToKit(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((key) => ({
      address: address(key.pubkey.toBase58()),
      role: (key.isWritable ? 1 : 0) | (key.isSigner ? 2 : 0),
    })),
    data: new Uint8Array(instruction.data),
  } as Instruction;
}

// ── the signed messages ─────────────────────────────────────────────────────
//
// From `@x402/settlement-client`, not from here. They are the one part of the
// program's interface that is not in the IDL, so they are hand-written — but in
// exactly one file, which is reviewed and tested, rather than re-derived by each
// caller. See `packages/settlement-client/src/attestation-message.ts`.

interface Attestation {
  readonly requestId: Uint8Array;
  readonly provider: Address;
  readonly beneficiary: Address;
  readonly status: number;
  readonly penalty: bigint;
  readonly amount: bigint;
  readonly policy: Uint8Array;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

// ── cluster plumbing ────────────────────────────────────────────────────────

function clusterUrl(cluster: string): string {
  switch (cluster) {
    case 'localnet':
      return 'http://127.0.0.1:8899';
    case 'devnet':
      return process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
    case 'mainnet':
      throw new Error('this script writes state and spends stake; it does not run on mainnet');
    default:
      throw new Error(`unknown cluster '${cluster}' — expected localnet or devnet`);
  }
}

function cli(args: readonly string[], url: string): string {
  return execFileSync('solana', [...args, '-u', url], { encoding: 'utf8' });
}

function splToken(args: readonly string[], url: string): any {
  return JSON.parse(
    execFileSync('spl-token', [...args, '-u', url, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

// ── the run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cluster = process.argv[2] ?? 'localnet';
  const url = clusterUrl(cluster);
  const programId = process.env.SOLANA_SETTLEMENT_PROGRAM_ID;
  if (!programId) {
    throw new Error('SOLANA_SETTLEMENT_PROGRAM_ID is not set. It is in .env.example.');
  }
  const programAddress = address(programId);
  const sender = createSender(url);

  const adminPath =
    process.env.SOLANA_ADMIN_KEYPAIR ??
    execFileSync('solana', ['config', 'get'], { encoding: 'utf8' })
      .split('\n')
      .find((line) => line.startsWith('Keypair Path:'))!
      .replace('Keypair Path:', '')
      .trim();
  const admin = await loadKeypairSigner(adminPath);

  console.log(`cluster    ${cluster} (${url})`);
  console.log(`program    ${programAddress}`);
  console.log(`admin      ${admin.address}`);

  // The provider is a separate key because `open_stake`, `deposit_stake`,
  // `request_unstake` and `withdraw_stake` all require the provider's own
  // signature — the program has no admin path to any of them, which is half of
  // the separation of powers that keeps the platform from moving a provider's
  // stake, and would be invisible if one key did everything here.
  const providerPath = join(mkdtempSync(join(tmpdir(), 'x402-exercise-')), 'provider.json');
  execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '-s', '-o', providerPath]);
  const provider = await loadKeypairSigner(providerPath);
  const agent = await freshKeypair();
  const treasuryAddress = await freshKeypair();
  const verifier = mintVerifierKey();

  console.log(`provider   ${provider.address}`);
  console.log(`agent      ${agent}`);
  console.log(`verifier   ${verifier.address}`);

  const [configPda] = await findConfigPda({ programAddress });

  console.log('');
  console.log('==> funding and mint setup');
  cli(['transfer', provider.address, '1', '--allow-unfunded-recipient'], url);

  // The stake mint is not this script's choice when a `Config` already exists:
  // `deposit_stake`, `slash` and `withdraw_stake` all constrain the vault to
  // `config.stake_mint`, so a freshly minted token would fail every one of them
  // on a cluster that has already been initialised. Devnet has been; a fresh
  // localnet has not.
  const existingConfig = await fetchMaybeConfig(sender.rpc, configPda);
  const mint = existingConfig.exists
    ? String(existingConfig.data.stakeMint)
    : setupMint(url, adminPath);
  console.log(
    `mint       ${mint}` +
      (existingConfig.exists
        ? '  (from the existing Config — not this run’s choice)'
        : '  (created)'),
  );

  const providerAta = await ata(mint, provider.address);
  const adminAta = await ata(mint, admin.address);
  ensureTokenAccount(mint, provider.address, url, adminPath);
  ensureTokenAccount(mint, admin.address, url, adminPath);
  mintTo(mint, providerAta, url, adminPath);
  mintTo(mint, adminAta, url, adminPath);
  console.log(`provider   ata ${providerAta}`);
  const [economicsPda] = await findEconomicsPda({ programAddress });
  const [vaultPda] = await findStakeVaultPda({ programAddress });
  const [stakePda] = await findStakePda({ provider: provider.address }, { programAddress });
  const [termsPda] = await findTermsPda({ provider: provider.address }, { programAddress });
  const [verifierPda] = await findVerifierKeyPda(
    { verifier: verifier.address },
    { programAddress },
  );

  console.log('');
  console.log('==> fifteen instructions');
  console.log('');

  const send = (ix: Instruction) => sender.send([ix], admin);
  const sendAs = (signer: KeyPairSigner) => (ix: Instruction) => sender.send([ix], signer);

  // 1 ─ initialize_config
  await step(
    'initialize_config',
    () =>
      getInitializeConfigInstructionAsync(
        {
          admin,
          stakeMint: address(mint),
          exposureAuthority: admin.address,
          unbondingPeriodSeconds: BigInt(14 * DAY),
          exposureMaxAgeSeconds: BigInt(DAY),
        },
        { programAddress },
      ),
    send,
    // `init` is one-shot. On a cluster where the config already exists the
    // program's own account constraint refuses it, which is the correct answer
    // and not a client defect.
    { expectRefusal: ['already in use'] },
  );

  // 2 ─ initialize_economics
  await step(
    'initialize_economics',
    () =>
      getInitializeEconomicsInstructionAsync(
        {
          admin,
          treasury: treasuryAddress,
          takeRateBps: 1_000,
          slashAgentBps: 6_000,
          slashPlatformBps: 3_000,
          slashCapBps: 1_000,
          minimumStake: 10n * UNIT,
          penaltyAmount: 1n * UNIT,
        },
        { programAddress },
      ),
    send,
    { expectRefusal: ['already in use'] },
  );

  // The treasury is read back rather than assumed. `initialize_economics` is
  // one-shot, so on a cluster where it already ran the treasury is whatever that
  // run chose — and settling to the wrong one fails as `ConstraintHasOne` rather
  // than as anything informative.
  //
  // It must also not be the admin: `settle_payment` pays *out of* the payer's
  // token account and *into* the treasury's, and Anchor refuses the same account
  // twice as mutable (`ConstraintDuplicateMutableAccount`, 2040) before the
  // handler runs. That is a real constraint of the program, found here rather
  // than in production.
  const economicsAfterInit = await fetchMaybeEconomicsConfig(sender.rpc, economicsPda);
  const treasury = economicsAfterInit.exists ? economicsAfterInit.data.treasury : treasuryAddress;
  ensureTokenAccount(mint, treasury, url, adminPath);
  console.log(`treasury   ${treasury}`);
  console.log('');

  // 3 ─ register_verifier
  await step(
    'register_verifier',
    () =>
      getRegisterVerifierInstructionAsync(
        {
          admin,
          verifier: verifier.address,
          label: label('exercise-all'),
          expiresAt: BigInt(now() + 30 * DAY),
        },
        { programAddress },
      ),
    send,
  );

  // 4 ─ open_stake  (provider signs)
  await step(
    'open_stake',
    () =>
      getOpenStakeInstructionAsync(
        { payer: admin, provider: provider.address },
        { programAddress },
      ),
    send,
  );

  // 5 ─ deposit_stake
  //
  // The signer is a *funder*, not the provider — the program lets anyone add to
  // a provider's bond, which is why `stake` has to be passed rather than derived
  // from the signer. Exercised with the provider funding their own stake, which
  // is the ordinary case.
  await step(
    'deposit_stake',
    () =>
      getDepositStakeInstructionAsync(
        {
          funder: provider,
          funderTokenAccount: providerAta,
          stake: stakePda,
          stakeMint: address(mint),
          amount: 100n * UNIT,
        },
        { programAddress },
      ),
    sendAs(provider),
  );

  // 6 ─ record_exposure  (the exposure authority, which initialize_config set to admin)
  await step(
    'record_exposure',
    () =>
      getRecordExposureInstructionAsync(
        { exposureAuthority: admin, stake: stakePda, exposed: 5n * UNIT },
        { programAddress },
      ),
    send,
  );

  // 7 ─ set_provider_terms
  await step(
    'set_provider_terms',
    () =>
      getSetProviderTermsInstructionAsync(
        {
          admin,
          provider: provider.address,
          takeRateBps: { __option: 'Some', value: 500 },
          minimumStake: { __option: 'None' },
          penaltyAmount: { __option: 'Some', value: 2n * UNIT },
          slashSplit: { __option: 'None' },
          slashCapBps: { __option: 'None' },
        },
        { programAddress },
      ),
    send,
  );

  // 8 ─ update_economics
  await step(
    'update_economics',
    () =>
      getUpdateEconomicsInstructionAsync(
        {
          admin,
          treasury: { __option: 'None' },
          takeRateBps: { __option: 'Some', value: 1_200 },
          slashAgentBps: { __option: 'None' },
          slashPlatformBps: { __option: 'None' },
          slashCapBps: { __option: 'None' },
          minimumStake: { __option: 'None' },
          penaltyAmount: { __option: 'None' },
        },
        { programAddress },
      ),
    send,
  );

  // 9 ─ update_config
  await step(
    'update_config',
    () =>
      getUpdateConfigInstructionAsync(
        {
          admin,
          adminArg: { __option: 'None' },
          exposureAuthority: { __option: 'None' },
          unbondingPeriodSeconds: { __option: 'Some', value: BigInt(12 * DAY) },
          exposureMaxAgeSeconds: { __option: 'None' },
        },
        { programAddress },
      ),
    send,
  );

  // 10 ─ settle_payment  (a PASS judgement, with the verifier's signature)
  const settleRequestId = requestId('settle');
  const [settlementRecordPda] = await findSettlementRecordPda(
    { requestId: settleRequestId },
    { programAddress },
  );
  const settleAttestation: Attestation = {
    requestId: settleRequestId,
    provider: provider.address,
    beneficiary: agent,
    status: 0, // PASS
    penalty: 0n,
    amount: 10n * UNIT,
    policy: policyHash('exercise'),
    issuedAt: BigInt(now() - 60),
    expiresAt: BigInt(now() + DAY),
  };
  await step(
    'settle_payment',
    () =>
      getSettlePaymentInstructionAsync(
        {
          payer: admin,
          terms: termsPda,
          verifierKey: verifierPda,
          settlementRecord: settlementRecordPda,
          source: adminAta,
          provider: provider.address,
          treasury,
          stakeMint: address(mint),
          requestId: settleRequestId,
          providerArg: provider.address,
          status: ResponseClass.Pass,
          amount: settleAttestation.amount,
          policy: settleAttestation.policy,
          issuedAt: settleAttestation.issuedAt,
          expiresAt: settleAttestation.expiresAt,
        },
        { programAddress },
      ),
    (ix) => {
      const message = settlementAttestationMessage({ ...settleAttestation, programAddress });
      return sender.send(
        [ed25519VerifyInstruction(verifier.publicKey, message, verifier.sign(message)), ix],
        admin,
      );
    },
  );

  // 11 ─ slash  (a DATA_FAIL judgement — the only class that may touch stake)
  const slashRequestId = requestId('slash');
  const [slashRecordPda] = await findSlashRecordPda(
    { requestId: slashRequestId },
    { programAddress },
  );
  const slashAttestation: Attestation = {
    requestId: slashRequestId,
    provider: provider.address,
    beneficiary: agent,
    status: 3, // DATA_FAIL
    penalty: 2n * UNIT,
    amount: 0n,
    policy: policyHash('exercise'),
    issuedAt: BigInt(now() - 60),
    expiresAt: BigInt(now() + DAY),
  };
  await step(
    'slash',
    () =>
      getSlashInstructionAsync(
        {
          payer: admin,
          stake: stakePda,
          terms: termsPda,
          verifierKey: verifierPda,
          slashRecord: slashRecordPda,
          beneficiary: agent,
          treasury,
          stakeMint: address(mint),
          requestId: slashRequestId,
          provider: provider.address,
          beneficiaryArg: agent,
          status: ResponseClass.DataFail,
          penalty: slashAttestation.penalty,
          policy: slashAttestation.policy,
          issuedAt: slashAttestation.issuedAt,
          expiresAt: slashAttestation.expiresAt,
        },
        { programAddress },
      ),
    (ix) => {
      const message = slashAttestationMessage({ ...slashAttestation, programAddress });
      return sender.send(
        [ed25519VerifyInstruction(verifier.publicKey, message, verifier.sign(message)), ix],
        admin,
      );
    },
  );

  // 12 ─ reverse_slash  (the arbitration path, gated on the same signature)
  const reversalAttestation: Attestation = {
    ...slashAttestation,
    issuedAt: BigInt(now() - 30),
    expiresAt: BigInt(now() + DAY),
  };
  await step(
    'reverse_slash',
    () =>
      getReverseSlashInstructionAsync(
        {
          payer: admin,
          stake: stakePda,
          verifierKey: verifierPda,
          slashRecord: slashRecordPda,
          // The stake comes back out of somebody's pocket, and the program makes
          // that explicit: the restorer signs and their token account is debited.
          // A reversal that silently minted the stake back would be a second way
          // to move money without anyone agreeing to it.
          restorer: admin,
          restorerTokenAccount: adminAta,
          stakeMint: address(mint),
          requestId: slashRequestId,
          provider: provider.address,
          issuedAt: reversalAttestation.issuedAt,
          expiresAt: reversalAttestation.expiresAt,
        },
        { programAddress },
      ),
    (ix) => {
      const message = reversalAttestationMessage({ ...reversalAttestation, programAddress });
      return sender.send(
        [ed25519VerifyInstruction(verifier.publicKey, message, verifier.sign(message)), ix],
        admin,
      );
    },
  );

  // 13 ─ request_unstake  (provider signs)
  await step(
    'request_unstake',
    () => getRequestUnstakeInstructionAsync({ provider, amount: 20n * UNIT }, { programAddress }),
    sendAs(provider),
  );

  // 14 ─ withdraw_stake  (provider signs; the 11-day floor makes this a refusal)
  await step(
    'withdraw_stake',
    () =>
      getWithdrawStakeInstructionAsync(
        {
          provider,
          destination: providerAta,
          stakeMint: address(mint),
          amount: 20n * UNIT,
        },
        { programAddress },
      ),
    sendAs(provider),
    { expectRefusal: ['UnbondingPeriodNotElapsed', 'The unbonding period has not elapsed yet'] },
  );

  // 15 ─ revoke_verifier  (last: one-way, and everything above needs the key)
  await step(
    'revoke_verifier',
    () =>
      getRevokeVerifierInstructionAsync({ admin, verifierKey: verifierPda }, { programAddress }),
    send,
  );

  // ── the state those instructions produced ────────────────────────────────

  console.log('');
  console.log('==> reading the resulting state back through the same client');
  const config = await fetchMaybeConfig(sender.rpc, configPda);
  const economics = await fetchMaybeEconomicsConfig(sender.rpc, economicsPda);
  const stake = await fetchMaybeProviderStake(sender.rpc, stakePda);

  if (config.exists) {
    console.log(
      `config      admin=${config.data.admin} unbonding=${config.data.unbondingPeriodSeconds}s`,
    );
    console.log(
      `            staked=${config.data.totalStaked} deposited=${config.data.totalDeposited} ` +
        `withdrawn=${config.data.totalWithdrawn} slashed=${config.data.totalSlashed}`,
    );
    const identity =
      config.data.totalStaked ===
      config.data.totalDeposited - config.data.totalWithdrawn - config.data.totalSlashed;
    console.log(
      `            total_staked == deposited - withdrawn - slashed : ${identity ? 'HOLDS' : 'VIOLATED'}`,
    );
    if (!identity) {
      throw new Error("the program's headline accounting identity does not hold");
    }
  }
  if (economics.exists) {
    console.log(
      `economics   take=${economics.data.takeRateBps}bps split=${economics.data.slashAgentBps}/` +
        `${economics.data.slashPlatformBps} cap=${economics.data.slashCapBps}bps ` +
        `penalty=${economics.data.penaltyAmount}`,
    );
  }
  if (stake.exists) {
    console.log(
      `stake       bonded=${stake.data.bonded} unbonding=${stake.data.unbonding} ` +
        `exposed=${stake.data.exposed} slashed=${stake.data.totalSlashed}`,
    );
  }
  console.log(`vault       ${vaultPda}`);

  // ── report ───────────────────────────────────────────────────────────────

  console.log('');
  console.log('  #  instruction           discriminator     accts  data  outcome   detail');
  console.log('  ─  ────────────────────  ────────────────  ─────  ────  ────────  ──────');
  for (const r of results) {
    console.log(
      `  ${String(r.order).padStart(2)} ${r.instruction.padEnd(21)} ${r.discriminator}  ` +
        `${String(r.accounts).padStart(5)}  ${String(r.dataBytes).padStart(4)}  ` +
        `${r.outcome.padEnd(8)}  ${r.detail}`,
    );
  }

  const failed = results.filter((r) => r.outcome === 'failed');
  const landed = results.filter((r) => r.outcome === 'landed').length;
  const refused = results.filter((r) => r.outcome === 'refused').length;

  console.log('');
  console.log(
    `${results.length} instructions: ${landed} landed, ${refused} refused by a program rule, ${failed.length} failed`,
  );

  if (failed.length > 0) {
    console.log('');
    for (const f of failed) {
      console.log(`FAILED  ${f.instruction}: ${f.detail}`);
    }
    process.exit(1);
  }
  if (results.length !== 15) {
    console.log(`expected 15 instructions, ran ${results.length}`);
    process.exit(1);
  }

  // ── helpers that need the run's context ──────────────────────────────────

  async function ata(mintAddress: string, owner: Address): Promise<Address> {
    const [derived] = await findAssociatedTokenPda({
      mint: address(mintAddress),
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return derived;
  }

  async function freshKeypair(): Promise<Address> {
    const path = join(mkdtempSync(join(tmpdir(), 'x402-agent-')), 'agent.json');
    execFileSync('solana-keygen', ['new', '--no-bip39-passphrase', '-s', '-o', path]);
    const signer = await loadKeypairSigner(path);
    return signer.address;
  }

  /** `spl-token create-account` is not idempotent — it exits non-zero the second time. */
  function ensureTokenAccount(
    mintAddress: string,
    owner: Address,
    rpcUrl: string,
    feePayer: string,
  ): void {
    try {
      splToken(
        ['create-account', mintAddress, '--owner', String(owner), '--fee-payer', feePayer],
        rpcUrl,
      );
    } catch {
      // Already exists, which is the only expected failure here and is what we
      // wanted anyway.
    }
  }

  /** Best effort: on a cluster where the admin is not the mint authority this is a no-op. */
  function mintTo(mintAddress: string, account: Address, rpcUrl: string, feePayer: string): void {
    try {
      splToken(['mint', mintAddress, '1000', String(account), '--fee-payer', feePayer], rpcUrl);
    } catch {
      // Not the mint authority. The balances already on chain have to do.
    }
  }

  function setupMint(rpcUrl: string, feePayer: string): string {
    const existing = process.env.X402_EXERCISE_MINT;
    if (existing) {
      return existing;
    }
    const created = splToken(
      ['create-token', '--decimals', String(DECIMALS), '--fee-payer', feePayer],
      rpcUrl,
    );
    const mintAddress = created.commandOutput?.address ?? created.address;
    splToken(['create-account', mintAddress, '--fee-payer', feePayer], rpcUrl);
    return mintAddress;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function label(text: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(Buffer.from(text, 'utf8').subarray(0, 32));
  return bytes;
}

function policyHash(text: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(Buffer.from(text, 'utf8').subarray(0, 32));
  return bytes;
}

function requestId(text: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(Buffer.from(`${text}-${Date.now()}`, 'utf8').subarray(0, 32));
  return bytes;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
