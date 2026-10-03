/**
 * `initialize_config` on a freshly deployed program.
 *
 * `exercise-all.ts` already drives this instruction, but it drives every door
 * as a smoke test and creates its own throwaway mint along the way. Bringing a
 * real deployment up is a different job: the mint is one an operator made and
 * intends to keep, the admin is the deploy authority rather than a generated
 * key, and the whole thing must be safe to re-run against a cluster where the
 * config already exists.
 *
 * `init` is one-shot by construction — the program's own account constraint
 * refuses a second attempt with "already in use", which is the correct answer
 * and not a client defect. So this script reads the account first and reports
 * what is there rather than making the operator interpret an Anchor error.
 *
 * Dry-run by default, like every other script under `scripts/devnet/`: there is
 * no `close_config`, so the admin and the stake mint are fixed by this one
 * call and cannot be re-pointed afterwards.
 *
 * ## The ten arguments, and the four that are gone
 *
 * Lean v3 folded the economics into `Config` and moved the delays into program
 * constants. `initialize_config` takes exactly ten arguments — the treasury,
 * the redeemer, the unbonding period, four bps figures, the minimum stake, the
 * penalty ceiling and the verifier's daily cap — and **no delays at all**.
 * `--slash-delay-hours`, `--verifier-activation-hours`, `--withdraw-delay-hours`,
 * `--earnings-delay-hours` and `--exposure-max-hours` are therefore gone: three
 * of those fields no longer exist, and the other two are `SLASH_DELAY_SECONDS`
 * and `WITHDRAW_DELAY_SECONDS`, which only a program upgrade can move.
 */

import { resolve } from 'path';

import { Address, address, createSolanaRpc } from '@solana/kit';

import { createSender, loadKeypairSigner } from '../settlement/lib/sender';

import {
  findConfigPda,
  findStakeVaultPda,
  getConfigDecoder,
  getInitializeConfigInstructionAsync,
  SLASH_DELAY_SECONDS,
  WITHDRAW_DELAY_SECONDS,
} from '@x402/settlement-client';

const DAY = 24 * 60 * 60;

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
}

async function main(): Promise<void> {
  const programAddress = address(
    arg('--program') ?? process.env.SOLANA_SETTLEMENT_PROGRAM_ID ?? '',
  );
  const mint = arg('--mint');
  const operatorPath = arg('--operator') ?? process.env.SOLANA_DEVNET_KEYPAIR ?? '';
  const url = arg('--url') ?? 'https://api.devnet.solana.com';
  const execute = process.argv.includes('--execute');

  const redeemer = arg('--redeemer');

  if (!programAddress || !mint || !operatorPath || !redeemer) {
    console.log(`
Initialise a freshly deployed settlement program's Config.

  yarn devnet:init-config --program <id> --mint <mint> --operator <path> \\
                          --redeemer <pubkey> [--execute]

  --redeemer <pubkey>           REQUIRED. The ONLY key redeem_voucher accepts
                                as rent_payer. This is the backend's fee payer
                                (FEE_PAYER_SIGNER): under 'local' the account
                                in LOCAL_FEE_PAYER_KEYPAIR, under 'kora' the
                                node's own fee payer. Get it wrong and every
                                redemption is refused NotRedeemer (6053) —
                                movable afterwards with update_config, unlike
                                the admin and the mint.
  --treasury <pubkey>           default: the operator (the admin)
  --unbonding-days <n>          default 14   (program floor: 11, ceiling: 30)
  --take-rate-bps <n>           default 500  (program ceiling: 3000)
  --slash-agent-bps <n>         default 6000
  --slash-platform-bps <n>      default 3000 (agent + platform must be <= 10000)
  --slash-cap-bps <n>           default 1000 (program ceiling: 5000)
  --minimum-stake <minor>       default 100000000
  --penalty-amount <minor>      default 1000000
  --verifier-daily-cap <minor>  default 100000000

The delays are program constants and take no flag:
  slash proposal -> execution   ${SLASH_DELAY_SECONDS / 3600}h  (SLASH_DELAY_SECONDS)
  buyer withdrawal              ${WITHDRAW_DELAY_SECONDS / 3600}h   (WITHDRAW_DELAY_SECONDS)
`);
    throw new Error('--program, --mint, --operator and --redeemer are all required');
  }

  if (!url.includes('devnet')) {
    throw new Error(`refusing a non-devnet cluster: ${url}`);
  }

  const unbondingDays = Number(arg('--unbonding-days') ?? 14);
  const takeRateBps = Number(arg('--take-rate-bps') ?? 500);
  const slashAgentBps = Number(arg('--slash-agent-bps') ?? 6000);
  const slashPlatformBps = Number(arg('--slash-platform-bps') ?? 3000);
  const slashCapBps = Number(arg('--slash-cap-bps') ?? 1000);
  const minimumStake = BigInt(arg('--minimum-stake') ?? '100000000');
  const penaltyAmount = BigInt(arg('--penalty-amount') ?? '1000000');
  const verifierDailyCap = BigInt(arg('--verifier-daily-cap') ?? '100000000');

  // `loadKeypairSigner` is the repo's one way of turning a keypair file into a
  // signer. Re-implementing it here would be a second place the file format is
  // assumed.
  const operator = await loadKeypairSigner(expandHome(operatorPath));
  const treasury = address(arg('--treasury') ?? operator.address);

  const rpc = createSolanaRpc(url);
  const [configPda] = await findConfigPda({ programAddress });

  console.log(`cluster    ${url}`);
  console.log(`program    ${programAddress}`);
  console.log(`config     ${configPda}`);
  console.log(`admin      ${operator.address}`);
  console.log(`treasury   ${treasury}`);
  console.log(`redeemer   ${redeemer}`);
  console.log(`mint       ${mint}`);
  console.log(`unbonding  ${unbondingDays} days`);
  console.log(`take rate  ${takeRateBps} bps`);
  console.log(`split      ${slashAgentBps} agent / ${slashPlatformBps} platform bps`);
  console.log(`slash cap  ${slashCapBps} bps per 24h`);
  console.log(`min stake  ${minimumStake}`);
  console.log(`penalty    ${penaltyAmount} ceiling`);
  console.log(`daily cap  ${verifierDailyCap} per verifier`);
  console.log(`delays     ${SLASH_DELAY_SECONDS}s slash / ${WITHDRAW_DELAY_SECONDS}s withdraw`);
  console.log(`           (program constants — not arguments, not stored on Config)`);
  console.log('');

  const existing = await rpc.getAccountInfo(configPda, { encoding: 'base64' }).send();
  if (existing.value) {
    const decoded = getConfigDecoder().decode(
      Uint8Array.from(Buffer.from(existing.value.data[0], 'base64')),
    );
    console.log('Config already exists — nothing to do.');
    console.log(`  admin              ${decoded.admin}`);
    console.log(`  treasury           ${decoded.treasury}`);
    console.log(`  redeemer           ${decoded.redeemer}`);
    console.log(`  stakeMint          ${decoded.stakeMint}`);
    console.log(`  unbondingSeconds   ${decoded.unbondingPeriodSeconds}`);
    console.log(`  takeRateBps        ${decoded.takeRateBps}`);
    console.log(`  minimumStake       ${decoded.minimumStake}`);
    if (decoded.stakeMint !== (mint as Address)) {
      console.log('');
      console.log(`WARNING: the existing stakeMint is NOT ${mint}.`);
      console.log('There is no `close_config`, so this cannot be re-pointed —');
      console.log('a different mint needs a different program deployment.');
    }
    return;
  }

  if (!execute) {
    console.log('DRY RUN — pass --execute to send. This cannot be undone:');
    console.log('there is no `close_config`, so the admin and the stake mint');
    console.log('are fixed by this one call. Everything else is movable with');
    console.log('`update_config`.');
    return;
  }

  // Every PDA is derived against `programAddress` — the id this script was
  // pointed at — and passed in. Omitting them lets the generated builder fill
  // them in from the client's compiled-in `declare_id!()`, which is a different
  // program the moment `--program` names a fresh deployment.
  const [stakeVault] = await findStakeVaultPda({ programAddress });

  const instruction = await getInitializeConfigInstructionAsync(
    {
      admin: operator,
      config: configPda,
      stakeMint: address(mint),
      stakeVault,
      treasury,
      redeemer: address(redeemer),
      unbondingPeriodSeconds: BigInt(unbondingDays * DAY),
      takeRateBps,
      slashAgentBps,
      slashPlatformBps,
      slashCapBps,
      minimumStake,
      penaltyAmount,
      verifierDailyCap,
    },
    { programAddress },
  );

  const sender = createSender(url);
  const signature = await sender.send([instruction], operator);

  console.log(`OK  initialised`);
  console.log(`    signature ${signature}`);
  console.log('');
  console.log('NEXT: create the treasury ATA for the stake mint by hand.');
  console.log('`redeem_voucher` pays the platform fee into');
  console.log(`ATA(${treasury}, ${mint}) and the program does NOT create it —`);
  console.log('every redemption fails with AccountNotInitialized until it exists.');
}

main().catch((error: unknown) => {
  console.error('');
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
