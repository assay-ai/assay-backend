import { randomUUID } from 'node:crypto';

import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DataSource } from 'typeorm';

import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { EvmSlashExecutor } from '@modules/chains/evm/evm-slash-executor.service';
import {
  NamespaceSlashCapsReader,
  NamespaceSlashExecutor,
} from '@modules/chains/multiplex/namespace-slash-executor';
import { ChainNamespace } from '@modules/chains/ports/caip.types';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { ArbitrationOutcome, DisputeClaimType } from '@modules/slash/domain/arbitration';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

import {
  FAKE_ARBITER,
  CHAIN,
  DEPLOYMENT,
  FakeStakeChain,
  MULTICALL,
} from '../../unit/chains/evm/helpers/fake-stake-chain';
import {
  buildProRataSlashServices,
  freshMigratedDatabase,
  ProRataSlashServices,
  TEST_SLASH_CONFIG,
} from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * A suspension, and what it does about the record standing on chain — over a
 * real Postgres built from every migration and the `X402Stake` emulator.
 *
 * A case is proposed on chain about a minute after the provider is told, so a
 * suspended case usually has a `Pending` record with the provider's stake
 * reserved, and `executeSlash` is permissionless once the timelock passes. The
 * suspension has to ask for the cancel, the lifecycle has to repair a request
 * that was lost or raced, and an execution that beats the cancel has to be
 * recorded as what it was.
 */
const DATABASE = 'x402_suspend_chain_cancel_test';
const USDG = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const VERIFIER_SECRET = new Uint8Array(32).fill(5);
const VERIFIER = privateKeyToAccount(toHex(VERIFIER_SECRET)).address;
const PROVIDER = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const PROVIDER_2 = '0x2222222222222222222222222222222222222223';
const A = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const B = `${CHAIN}:0x64fecbe18e8998cb2990bce631a042f8e2be1659`;
const HOUR = 3_600_000;
const PENALTY = 200_000n;
const NOTE = 'n'.repeat(120);

describe('suspending a case with a record standing on chain, against a real database', () => {
  let dataSource: DataSource;
  let chain: FakeStakeChain;
  let evm: EvmSlashExecutor;
  let services: ProRataSlashServices;
  let arbitration: ArbitrationService;
  /** The same arbitration service with no chain half: the request that is never made. */
  let arbitrationWithoutChain: ArbitrationService;
  let adjudicator: OperatorSession;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status)
       VALUES ($1, 'ops-adj', 'ops-adj', 'ops-adj@example.test', $2::jsonb, 'ACTIVE')`,
      [id, JSON.stringify([OperatorRole.ADJ])],
    );
    adjudicator = {
      operatorId: id,
      subject: 'ops-adj',
      displayName: 'ops-adj',
      email: 'ops-adj@example.test',
      roles: [OperatorRole.ADJ],
      authorityLimitMinor: null,
    };
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE slash_proposal_parts, slash_proposal_events, slash_proposals, sla_strikes,
         sla_window_calls, sla_windows, tool_bindings, payment_intents, provider_chain_enrolments,
         disputes
       CASCADE`,
    );
    chain = new FakeStakeChain(VERIFIER);
    chain.bond(PROVIDER, 180_000_000n);
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
    evm = new EvmSlashExecutor(
      new Map([[CHAIN, chain.client]]),
      new Map([[CHAIN, DEPLOYMENT]]),
      chain.relayer,
      { get: () => signer },
      'VerifierSigningService',
      {
        now: () => Number(chain.now) * 1000,
        batchSize: 20,
        multicall: new Map([[CHAIN, MULTICALL]]),
        executeDeferLimitMs: 3 * 24 * HOUR,
        receiptRetryDelayMs: 0,
      },
    );
    services = buildProRataSlashServices(
      dataSource,
      new NamespaceSlashExecutor(new Map([[ChainNamespace.EIP155, evm]])),
      new NamespaceSlashCapsReader(new Map([[ChainNamespace.EIP155, evm]])),
    );
    arbitration = arbitrationOver(services.execution);
    arbitrationWithoutChain = arbitrationOver(null);
  });

  function arbitrationOver(execution: SlashExecutionService | null): ArbitrationService {
    const notifications = { notify: async () => ({ deliveredNow: false }) } as never;
    return new ArbitrationService(
      services.proposals,
      new DisputeRepository(dataSource),
      new SlaStrikeRepository(dataSource),
      services.lifecycle,
      new OverrideLogService(dataSource, new OverrideLogEntryRepository(dataSource)),
      notifications,
      TEST_SLASH_CONFIG,
      execution,
    );
  }

  const nowOf = () => new Date(Number(chain.now) * 1000);

  async function seed(options: { provider?: string; respondByAt?: Date } = {}) {
    return seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      stakeAuthority: `${CHAIN}:${options.provider ?? PROVIDER}`,
      assetId: USDG,
      penalty: PENALTY,
      proposedAt: new Date(nowOf().getTime() - 60_000),
      respondByAt: options.respondByAt,
      agents: [
        { account: A, failed: [100_000n] },
        { account: B, failed: [100_000n] },
      ],
    });
  }

  /** A case in `PROPOSED` whose record already stands on chain. */
  async function standing(options: Parameters<typeof seed>[0] = {}) {
    const seeded = await seed(options);
    await services.execution.proposeDue(nowOf());
    expect((await row(seeded.proposalId)).chain_status).toBe('PENDING');
    return seeded;
  }

  const row = async (id: string) =>
    (
      (await dataSource.query(
        `SELECT status, chain_status, chain_executable_at, executed_at, applied_amount,
                execution_signature
           FROM slash_proposals WHERE id = $1`,
        [id],
      )) as {
        status: string;
        chain_status: string;
        chain_executable_at: Date | null;
        executed_at: Date | null;
        applied_amount: string | null;
        execution_signature: string | null;
      }[]
    )[0];

  const events = async (proposalId: string) =>
    (await dataSource.query(
      `SELECT kind, detail FROM slash_proposal_events WHERE proposal_id = $1
        ORDER BY occurred_at, id`,
      [proposalId],
    )) as { kind: string; detail: Record<string, unknown> }[];

  const suspend = (
    service: ArbitrationService,
    seeded: { organizationId: string; proposalId: string },
  ) =>
    service.suspend(
      adjudicator,
      seeded.organizationId,
      seeded.proposalId,
      'OPERATOR_HOLD',
      'held while the mapping is checked',
    );

  it('asks for the on-chain cancel, and the cancel transaction can then be built', async () => {
    const seeded = await standing();
    const sends = chain.sent.length;

    await suspend(arbitration, seeded);

    expect(await row(seeded.proposalId)).toMatchObject({
      status: 'CANCELLED',
      chain_status: 'CANCEL_REQUESTED',
    });
    expect((await events(seeded.proposalId)).map((event) => event.kind)).toEqual(
      expect.arrayContaining(['CANCELLED', 'CHAIN_CANCEL_REQUESTED']),
    );

    const parts = await services.partsRepository.findForEpoch(
      seeded.organizationId,
      seeded.proposalId,
      0,
    );
    const intent = await services.execution.buildCancelIntent(
      seeded.organizationId,
      seeded.proposalId,
    );
    expect(intent).toMatchObject({ admin: FAKE_ARBITER, signerRole: 'ARBITER' });
    expect(parts.map((part) => part.chainRequestId)).toContain(intent.requestId);

    // Requested and built — nothing was signed or sent, and the record stands.
    expect(chain.sent).toHaveLength(sends);
    for (const part of parts) expect(chain.record(part.chainRequestId)?.status).toBe(1);
    // The admin-cancel sweep now watches it; this platform will not execute it.
    expect(await services.execution.sweepAdminCancels(nowOf())).toEqual({
      mirrored: 0,
      expired: 0,
      waiting: 1,
    });
    chain.now += BigInt(73 * 3600);
    expect(await services.execution.executeDue(nowOf())).toEqual({
      executed: 0,
      voided: 0,
      failed: 0,
    });
  });

  it('asks for nothing when no record stands on chain, and none is proposed afterwards', async () => {
    const seeded = await seed();

    await suspend(arbitration, seeded);

    expect(await row(seeded.proposalId)).toMatchObject({
      status: 'CANCELLED',
      chain_status: 'NONE',
    });
    expect(await services.execution.proposeDue(nowOf())).toEqual({
      proposed: 0,
      refused: 0,
      failed: 0,
    });
    expect(chain.sent).toHaveLength(0);
    await expect(
      services.execution.buildCancelIntent(seeded.organizationId, seeded.proposalId),
    ).rejects.toMatchObject({ errorCode: SlashErrorCode.SLASH_INVALID_TRANSITION });
  });

  describe('the repair tick', () => {
    it('asks for the cancel of a suspended case whose request was lost', async () => {
      const seeded = await standing();
      await suspend(arbitrationWithoutChain, seeded);
      expect(await row(seeded.proposalId)).toMatchObject({
        status: 'CANCELLED',
        chain_status: 'PENDING',
      });
      // Watched by nothing, which is the gap.
      expect(await services.execution.sweepAdminCancels(nowOf())).toEqual({
        mirrored: 0,
        expired: 0,
        waiting: 0,
      });

      expect(await services.execution.requestCancelsForClosedCases()).toBe(1);

      expect((await row(seeded.proposalId)).chain_status).toBe('CANCEL_REQUESTED');
      // Idempotent: nothing left to find, and one timeline entry.
      expect(await services.execution.requestCancelsForClosedCases()).toBe(0);
      expect(
        (await events(seeded.proposalId)).filter(
          (event) => event.kind === 'CHAIN_CANCEL_REQUESTED',
        ),
      ).toHaveLength(1);
      await expect(
        services.execution.buildCancelIntent(seeded.organizationId, seeded.proposalId),
      ).resolves.toMatchObject({ admin: FAKE_ARBITER });
    });

    it('does the same for an overturned case', async () => {
      // The emulator's clock is not the wall clock, and an objection is filed
      // against the wall clock: keep the response window open for it.
      const seeded = await standing({ respondByAt: new Date(Date.now() + HOUR) });
      await arbitrationWithoutChain.fileDispute(seeded.organizationId, seeded.proposalId, {
        claimType: DisputeClaimType.AGENT_GRIEFING,
        reason: 'one agent sent every failing call',
        evidence: [],
        openedBy: 'provider@example.test',
      });
      await arbitrationWithoutChain.decide(adjudicator, seeded.organizationId, seeded.proposalId, {
        outcome: ArbitrationOutcome.OVERTURNED_GRIEFING,
        reasonCodes: ['SINGLE_AGENT_CONCENTRATION'],
        note: NOTE,
      });
      expect(await row(seeded.proposalId)).toMatchObject({
        status: 'OVERTURNED',
        chain_status: 'PENDING',
      });

      expect(await services.execution.requestCancelsForClosedCases()).toBe(1);

      expect((await row(seeded.proposalId)).chain_status).toBe('CANCEL_REQUESTED');
    });

    it('leaves a live case and a case the chain itself voided alone', async () => {
      const live = await standing();
      const voided = await standing({ provider: PROVIDER_2 });
      // The chain-void path's own shape: CANCELLED by the chain at execution
      // time with the record left PENDING on purpose.
      await dataSource.query(
        `UPDATE slash_proposals
            SET status = 'CANCELLED', resolution_kind = 'AUTO_CHAIN_VOIDED', resolved_at = now()
          WHERE id = $1`,
        [voided.proposalId],
      );

      expect(await services.execution.requestCancelsForClosedCases()).toBe(0);

      expect((await row(live.proposalId)).chain_status).toBe('PENDING');
      expect((await row(voided.proposalId)).chain_status).toBe('PENDING');
    });
  });

  it('ends CANCEL_REQUESTED when the suspension lands while the proposal is in flight', async () => {
    const seeded = await seed();
    const propose = services.parts.propose.bind(services.parts);
    jest.spyOn(services.parts, 'propose').mockImplementation(async (proposal, provider) => {
      const result = await propose(proposal, provider);
      // The record is on chain; the mirror is not written yet. The suspension
      // finds PROPOSING and has nothing to cancel.
      await suspend(arbitration, seeded);
      expect(await row(seeded.proposalId)).toMatchObject({
        status: 'CANCELLED',
        chain_status: 'PROPOSING',
      });
      return result;
    });

    await services.execution.proposeDue(nowOf());

    const saved = await row(seeded.proposalId);
    expect(saved).toMatchObject({ status: 'CANCELLED', chain_status: 'CANCEL_REQUESTED' });
    expect(saved.chain_executable_at).not.toBeNull();
    await expect(
      services.execution.buildCancelIntent(seeded.organizationId, seeded.proposalId),
    ).resolves.toMatchObject({ admin: FAKE_ARBITER });
  });

  it('records a third party executing the suspended case before the cancel was signed', async () => {
    const seeded = await standing();
    await suspend(arbitration, seeded);
    const parts = await services.partsRepository.findForEpoch(
      seeded.organizationId,
      seeded.proposalId,
      0,
    );

    // Nobody signs the cancel; the timelock passes; anyone may execute.
    chain.now += BigInt(73 * 3600);
    for (const part of parts) {
      await evm.executeProposal({
        chainId: CHAIN,
        requestId: part.chainRequestId,
        provider: PROVIDER,
        beneficiary: part.beneficiaryAccount.split(':')[2],
      });
    }

    await services.execution.sweepAdminCancels(nowOf());

    const saved = await row(seeded.proposalId);
    // The suspension stands, and the money that moved is on the row beside it.
    expect(saved).toMatchObject({
      status: 'CANCELLED',
      chain_status: 'EXECUTED',
      applied_amount: PENALTY.toString(),
      execution_signature: null,
    });
    expect(saved.executed_at).not.toBeNull();
    const closure = (await events(seeded.proposalId)).find(
      (event) => event.kind === 'EXECUTED_AFTER_CLOSURE',
    );
    expect(closure?.detail).toMatchObject({
      applied: PENALTY.toString(),
      caseStatus: 'CANCELLED',
    });
    // Out of the admin-cancel sweep for good.
    expect(await services.execution.sweepAdminCancels(nowOf())).toEqual({
      mirrored: 0,
      expired: 0,
      waiting: 0,
    });
  });
});
