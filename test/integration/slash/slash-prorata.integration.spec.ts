import { randomUUID } from 'node:crypto';

import { getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DataSource } from 'typeorm';

import { EvmSlashExecutor } from '@modules/chains/evm/evm-slash-executor.service';
import {
  NamespaceSlashCapsReader,
  NamespaceSlashExecutor,
} from '@modules/chains/multiplex/namespace-slash-executor';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ChainNamespace } from '@modules/chains/ports/caip.types';
import { slashPartRequestId } from '@modules/slash/domain/prorata-slash';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

import {
  CHAIN,
  DEPLOYMENT,
  FakeStakeChain,
  MULTICALL,
  TREASURY,
} from '../../unit/chains/evm/helpers/fake-stake-chain';
import {
  buildProRataSlashServices,
  freshMigratedDatabase,
  ProRataSlashServices,
} from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * G7 on EVM, end to end over a real Postgres built from every migration:
 * a window-level SLA case is proposed as one verifier-signed attestation per
 * harmed agent (pro rata by the price of their DATA_FAIL calls), in ONE
 * Multicall3 batch, waits out both clocks, and executes — every due case's
 * parts in one batch — paying each agent 60% of its part and the treasury
 * 30%, with nothing booked to the ledger.
 *
 * The chain is `FakeStakeChain`, an emulator of the `X402Stake` rules the
 * executor depends on (signature recovery, replay lock, caps, 72h door,
 * 60/30 split). Everything else is production code.
 */
const DATABASE = 'x402_slash_prorata_test';
const USDG = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const VERIFIER_SECRET = new Uint8Array(32).fill(5);
const VERIFIER = privateKeyToAccount(toHex(VERIFIER_SECRET)).address;
const PROVIDER = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const PROVIDER_2 = '0x2222222222222222222222222222222222222223';
const A = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const B = `${CHAIN}:0x64fecbe18e8998cb2990bce631a042f8e2be1659`;
const C = `${CHAIN}:0xd30814fd3916fc7fc6ea87d4c429f7b0b7cc4d1d`;
const D = `${CHAIN}:0x1111111111111111111111111111111111111114`;
const HOUR = 3_600_000;

describe('pro-rata EVM slash, against a real database', () => {
  let dataSource: DataSource;
  let chain: FakeStakeChain;
  let services: ProRataSlashServices;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    // Every case left by an earlier test would be swept again by this one.
    await dataSource.query(
      `TRUNCATE slash_proposal_parts, slash_proposal_events, slash_proposals, sla_strikes,
         sla_window_calls, sla_windows, tool_bindings, payment_intents, provider_chain_enrolments
       CASCADE`,
    );
    chain = new FakeStakeChain(VERIFIER);
    chain.bond(PROVIDER, 180_000_000n, 20_000_000n, 1_000_000n);
    chain.bond(PROVIDER_2, 150_000_000n);
    const backend = new Secp256k1EnvSigner(
      [{ keyId: 'v1', chainId: CHAIN, secretKey: Uint8Array.from(VERIFIER_SECRET) }],
      'test',
    );
    const signer = {
      async sign(request: { payload: Uint8Array }) {
        const signature = await backend.sign('v1', request.payload);
        await chain.trustSignature(toHex(request.payload), toHex(signature));
        return { signature, publicKey: (await backend.getKey('v1')).publicKey };
      },
      async publicKey() {
        return (await backend.getKey('v1')).publicKey;
      },
    };
    const evm = new EvmSlashExecutor(
      new Map([[CHAIN, chain.client]]),
      new Map([[CHAIN, DEPLOYMENT]]),
      chain.relayer,
      { get: () => signer },
      'VerifierSigningService',
      {
        now: () => Number(chain.now) * 1000,
        batchSize: 20,
        multicall: new Map([[CHAIN, MULTICALL]]),
        executeDeferLimitMs: 3 * 24 * 3_600_000,
        receiptRetryDelayMs: 0,
      },
    );
    services = buildProRataSlashServices(
      dataSource,
      new NamespaceSlashExecutor(new Map([[ChainNamespace.EIP155, evm]])),
      new NamespaceSlashCapsReader(new Map([[ChainNamespace.EIP155, evm]])),
    );
  });

  const load = async (seeded: { organizationId: string; proposalId: string }) =>
    (await services.proposals.findOneScoped(seeded.organizationId, seeded.proposalId))!;

  const nowOf = () => new Date(Number(chain.now) * 1000);
  const multicallSends = () =>
    chain.sent.filter((tx) => getAddress(tx.to) === getAddress(MULTICALL));

  async function seedWindow(penalty: bigint, provider = PROVIDER) {
    return seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      stakeAuthority: `${CHAIN}:${provider}`,
      assetId: USDG,
      penalty,
      proposedAt: new Date(nowOf().getTime() - 60_000),
      agents: [
        { account: A, failed: [100_000n, 100_000n, 100_000n], passed: [100_000n] },
        { account: B, failed: [100_000n] },
        { account: C, failed: [50_000n, 50_000n] },
        // Served well: in the window, never a beneficiary.
        { account: D, failed: [], passed: [100_000n] },
        // A failure priced in another asset is not weighed in this one.
        { account: D, failed: [100_000n], assetId: ASSET_IDS.USDC_SOLANA_DEVNET },
      ],
    });
  }

  it('proposes one attestation per harmed agent, pro rata, in ONE batch, with deterministic ids', async () => {
    const seeded = await seedWindow(250_001n);

    const tally = await services.execution.proposeDue(nowOf());

    expect(tally).toEqual({ proposed: 1, refused: 0, failed: 0 });
    expect(multicallSends()).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);

    const parts = await services.partsRepository.findForEpoch(
      (await load(seeded)).organizationId,
      seeded.proposalId,
      0,
    );
    expect(parts.map((part) => [part.agentAccount, part.weightAmount, part.penaltyAmount])).toEqual(
      [
        // Agent order (code-unit order of the account): B 0x64…, A 0x97…, C 0xd3….
        [B, '100000', '50000'],
        [A, '300000', '150001'],
        [C, '100000', '50000'],
      ],
    );
    for (const part of parts) {
      expect(part.chainRequestId).toBe(
        slashPartRequestId(seeded.windowId, seeded.chainRequestId, part.agentAccount),
      );
      expect(part.chainStatus).toBe('PENDING');
      expect(part.capBinding).toBe('NONE');
      expect(part.beneficiaryAccount).toBe(part.agentAccount);
      expect(getAddress(chain.record(part.chainRequestId)!.beneficiary)).toBe(
        getAddress(part.agentAccount.split(':')[2]),
      );
    }

    // What `EvmSlashProposalWatcher` (review H-1) looks records up by: across
    // tenants, by on-chain request id.
    const known = await services.partsRepository.findByChainRequestIds([
      ...parts.map((part) => part.chainRequestId),
      'f'.repeat(64),
    ]);
    expect(
      known
        .map((part) => [part.chainRequestId, part.beneficiaryAccount, part.penaltyAmount])
        .sort(),
    ).toEqual(
      parts
        .map((part) => [part.chainRequestId, part.beneficiaryAccount, part.penaltyAmount])
        .sort(),
    );

    const proposal = await load(seeded);
    expect(proposal.chainStatus).toBe('PENDING');
    expect(proposal.chainReserved).toBe('250001');
    expect(proposal.beneficiaryAccount).toBeNull();
    expect(proposal.chainExecutableAt!.getTime()).toBe(nowOf().getTime() + 72 * HOUR);
  });

  it('is idempotent: a retried proposal re-reads its plan and adopts every record', async () => {
    const seeded = await seedWindow(250_001n);
    await services.execution.proposeDue(nowOf());
    const sends = chain.sent.length;
    const proposal = await load(seeded);

    const again = await services.parts.propose(proposal, PROVIDER);

    expect(again.adopted).toBe(true);
    expect(chain.sent.length).toBe(sends);
    const parts = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );
    expect(parts).toHaveLength(3);
  });

  it('waits out both clocks, then executes every due case in ONE batch and pays each agent 60% of its part', async () => {
    const first = await seedWindow(250_001n);
    const second = await seedWindow(100_000n, PROVIDER_2);
    await services.execution.proposeDue(nowOf());
    chain.sent.length = 0;

    // Undisputed past the response window → UPHELD.
    await services.lifecycle.sweepUndisputed(new Date(nowOf().getTime() + 49 * HOUR));
    // Not before the door.
    chain.now += BigInt(71 * 3600);
    expect(await services.execution.executeDue(nowOf())).toEqual({
      executed: 0,
      voided: 0,
      failed: 0,
    });
    expect(chain.sent).toHaveLength(0);

    chain.now += BigInt(2 * 3600);
    const tally = await services.execution.executeDue(nowOf());

    expect(tally).toEqual({ executed: 2, voided: 0, failed: 0 });
    expect(chain.sent).toHaveLength(1);
    expect(multicallSends()).toHaveLength(1);

    // First case 150001/50000/50000 + second case 60000/20000/20000 (3:1:1 of 100000).
    expect(chain.balanceOf(A.split(':')[2])).toBe(90_000n + 36_000n);
    expect(chain.balanceOf(B.split(':')[2])).toBe(30_000n + 12_000n);
    expect(chain.balanceOf(C.split(':')[2])).toBe(30_000n + 12_000n);
    expect(chain.balanceOf(TREASURY)).toBe(45_000n + 15_000n + 15_000n + 30_000n);

    const done = await load(first);
    expect(done).toMatchObject({
      status: 'EXECUTED',
      chainStatus: 'EXECUTED',
      appliedAmount: '250001',
      platformAmount: '75000',
    });
    const parts = await services.partsRepository.findForEpoch(done.organizationId, done.id, 0);
    expect(parts.map((part) => [part.chainStatus, part.agentAmount, part.platformAmount])).toEqual([
      ['EXECUTED', '30000', '15000'], // B
      ['EXECUTED', '90000', '45000'], // A
      ['EXECUTED', '30000', '15000'], // C
    ]);
    expect((await load(second)).status).toBe('EXECUTED');

    // Paid on chain to the agents: nothing is booked to the ledger.
    expect(services.ledgerDistributions).toEqual([]);
  });

  it('scales the whole plan to the per-attestation ceiling and records it', async () => {
    const seeded = await seedWindow(2_500_000n);
    await services.execution.proposeDue(nowOf());
    const proposal = await load(seeded);
    const parts = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );

    // penaltyAmount is 1 USDG: 3:1:1 scaled so A's share fits one attestation.
    expect(parts.map((part) => [part.uncappedShareAmount, part.penaltyAmount])).toEqual([
      ['500000', '333333'], // B
      ['1500000', '1000000'], // A
      ['500000', '333333'], // C
    ]);
    expect(new Set(parts.map((part) => part.capBinding))).toEqual(new Set(['PART_CEILING']));
    expect(parts[0].planCappedTotal).toBe('1666666');
    expect(proposal.chainStatus).toBe('PENDING');
  });

  it('reconciles a case from its parts after a crash between send and record', async () => {
    const seeded = await seedWindow(250_001n);
    await services.execution.proposeDue(nowOf());
    await services.lifecycle.sweepUndisputed(new Date(nowOf().getTime() + 49 * HOUR));
    chain.now += BigInt(73 * 3600);
    const proposal = await load(seeded);

    // A stranger executes every part (executeSlash is permissionless) while
    // this platform's row still says UPHELD and its parts say PENDING.
    for (const part of await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    )) {
      await chain.relayer.sendCall({
        chainId: CHAIN,
        to: `${CHAIN}:${DEPLOYMENT.stake}` as never,
        data: (await import('viem')).encodeFunctionData({
          abi: (await import('@modules/chains/evm/abi/x402.abi')).X402_STAKE_SLASH_ABI,
          functionName: 'executeSlash',
          args: [`0x${part.chainRequestId}`],
        }),
        gasLimit: 300_000n,
        purpose: 'stranger',
      });
    }

    const tally = await services.execution.executeDue(nowOf());

    // The batch's simulation sees SlashNotPending for every part; each is
    // read back, mirrored EXECUTED, and the case completes from the chain.
    expect(tally.executed).toBe(1);
    const done = await load(seeded);
    expect(done).toMatchObject({ status: 'EXECUTED', appliedAmount: '250001' });
  });

  it('refuses a zero part and a second plan for the same agent, at the database', async () => {
    const seeded = await seedWindow(250_001n);
    await services.execution.proposeDue(nowOf());
    const proposal = await load(seeded);

    const replanned = await services.partsRepository.insertPlan(
      proposal.organizationId,
      proposal.id,
      0,
      [
        {
          windowId: seeded.windowId,
          agentAccount: A,
          beneficiaryAccount: A,
          weightAmount: '1',
          uncappedShareAmount: '1',
          penaltyAmount: '1',
          planPenaltyAmount: '1',
          planCappedTotal: '1',
          capBinding: 'NONE',
          chainRequestId: 'f'.repeat(64),
        },
      ],
    );
    expect(replanned.find((part) => part.agentAccount === A)!.penaltyAmount).toBe('150001');

    await expect(
      dataSource.query(
        `INSERT INTO slash_proposal_parts (organization_id, proposal_id, chain_epoch, window_id,
           agent_account, beneficiary_account, weight_amount, uncapped_share_amount, penalty_amount,
           plan_penalty_amount, plan_capped_total, cap_binding, chain_request_id)
         VALUES ($1, $2, 1, $3, $4, $4, 1, 0, 0, 1, 1, 'NONE', $5)`,
        [proposal.organizationId, proposal.id, seeded.windowId, A, 'e'.repeat(64)],
      ),
    ).rejects.toThrow(/chk_slash_proposal_parts_penalty_positive/);
  });

  // S3(3): two planners racing must never leave a mixed plan.
  it('inserts a plan whole or not at all — a racing plan never mixes into the winner', async () => {
    const seeded = await seedWindow(250_001n);
    const proposal = await load(seeded);
    const row = (agent: string, penalty: string, id: string) => ({
      windowId: seeded.windowId,
      agentAccount: agent,
      beneficiaryAccount: agent,
      weightAmount: '1',
      uncappedShareAmount: penalty,
      penaltyAmount: penalty,
      planPenaltyAmount: '250001',
      planCappedTotal: '250001',
      capBinding: 'NONE',
      chainRequestId: id.repeat(64),
    });
    const winner = await services.partsRepository.insertPlan(
      proposal.organizationId,
      proposal.id,
      0,
      [row(A, '150001', '1'), row(B, '100000', '2')],
    );
    // The loser planned a different split, overlapping on A.
    const seen = await services.partsRepository.insertPlan(
      proposal.organizationId,
      proposal.id,
      0,
      [row(A, '125001', '3'), row(C, '125000', '4')],
    );

    expect(seen.map((part) => [part.agentAccount, part.penaltyAmount])).toEqual(
      winner.map((part) => [part.agentAccount, part.penaltyAmount]),
    );
    expect(seen.some((part) => part.agentAccount === C)).toBe(false);
  });

  // S3(5): a reservation a failed expire left behind is revisited by the reconciler.
  it('expires the still-pending part of an executed case on the reconcile pass', async () => {
    const seeded = await seedWindow(250_001n);
    await services.execution.proposeDue(nowOf());
    const proposal = await load(seeded);
    const parts = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );
    // The case executed with one part paid and one part left pending on chain.
    await dataSource.query(
      `UPDATE slash_proposals SET status = 'EXECUTED', chain_status = 'EXECUTED', executed_at = $2,
         applied_amount = 50000, platform_amount = 15000, earliest_execution_at = $2,
         chain_executable_at = $2
       WHERE id = $1`,
      [proposal.id, nowOf()],
    );
    await dataSource.query(
      `UPDATE slash_proposal_parts SET chain_status = 'EXECUTED', applied_amount = 50000,
         agent_amount = 30000, platform_amount = 15000, executed_at = now()
       WHERE id = $1`,
      [parts[0].id],
    );
    chain.revoked = true; // the remaining parts can never execute: expirable now

    await services.execution.reconcileExecuting(nowOf());

    const after = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );
    expect(after.map((part) => part.chainStatus)).toEqual(['EXECUTED', 'CANCELLED', 'CANCELLED']);
    for (const part of after.slice(1)) expect(chain.record(part.chainRequestId)?.status).toBe(3);
  });

  // Re-review residual 2: a straggler given up while its tx was in flight is paid when it lands.
  it('executes a REFUSED straggler whose record landed late, and the case records it', async () => {
    const seeded = await seedWindow(250_001n);
    await services.execution.proposeDue(nowOf());
    const proposal = await load(seeded);
    const parts = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );
    await services.lifecycle.sweepUndisputed(new Date(nowOf().getTime() + 49 * HOUR));
    chain.now += BigInt(73 * 3600);

    // The case executed while one part was given up on (its record landed later).
    await dataSource.query(
      `UPDATE slash_proposal_parts SET chain_status = 'REFUSED', chain_last_error = 'Straggler:transport'
        WHERE id = $1`,
      [parts[2].id],
    );
    expect((await services.execution.executeDue(nowOf())).executed).toBe(1);
    expect((await load(seeded)).appliedAmount).toBe('200001');
    expect(chain.record(parts[2].chainRequestId)?.status).toBe(1);

    await services.execution.reconcileExecuting(nowOf());

    const after = await services.partsRepository.findForEpoch(
      proposal.organizationId,
      proposal.id,
      0,
    );
    expect(after.map((part) => part.chainStatus)).toEqual(['EXECUTED', 'EXECUTED', 'EXECUTED']);
    expect(chain.record(parts[2].chainRequestId)?.status).toBe(2);
    expect(chain.balanceOf(C.split(':')[2])).toBe(30_000n);
    expect(await load(seeded)).toMatchObject({ appliedAmount: '250001', platformAmount: '75000' });
  });
});
