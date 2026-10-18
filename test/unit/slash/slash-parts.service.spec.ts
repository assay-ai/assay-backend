import { Logger } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { ChainId } from '@modules/chains/ports/caip.types';
import { chainErrorName } from '@modules/slash/domain/chain-slash-outcome';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { SlashCaps } from '@modules/slash/ports/slash-caps-reader.port';
import { ProRataSlashConfig } from '@modules/slash/constants/slash.constants';
import {
  oneByOne,
  SlashExecutionRequest,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalRequest,
  SlashProposalResult,
  SlashRecordSnapshot,
} from '@modules/slash/ports/slash-executor.port';
import { SlashPartsService } from '@modules/slash/services/slash-parts.service';

const CHAIN = 'eip155:46630' as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const T0 = new Date('2026-10-11T10:00:00Z');
const X0 = new Date('2026-10-14T10:00:00Z');
const agent = (n: number) => `${CHAIN}:0x${n.toString(16).padStart(40, '0')}`;

const revert = (name: string) =>
  ChainErrors.transactionFailed({ reason: name, customErrorCode: null, programErrorName: name });

class FakeParts {
  rows: SlashProposalPartEntity[] = [];
  async findForEpoch(organizationId: string, proposalId: string, chainEpoch: number) {
    return this.rows
      .filter((row) => row.proposalId === proposalId && row.chainEpoch === chainEpoch)
      .sort((a, b) => (a.agentAccount < b.agentAccount ? -1 : 1))
      .map((row) => ({ ...row }) as SlashProposalPartEntity);
  }
  async insertPlan(organizationId: string, proposalId: string, chainEpoch: number, rows: object[]) {
    if (this.rows.some((row) => row.proposalId === proposalId && row.chainEpoch === chainEpoch)) {
      return this.findForEpoch(organizationId, proposalId, chainEpoch);
    }
    rows.forEach((row, i) =>
      this.rows.push({
        id: `part-${this.rows.length + i}`,
        organizationId,
        proposalId,
        chainEpoch,
        chainProposedAt: null,
        chainExecutableAt: null,
        chainReserved: null,
        appliedAmount: null,
        agentAmount: null,
        platformAmount: null,
        executedAt: null,
        executionSignature: null,
        cancelledAt: null,
        chainLastError: null,
        proposeAttempts: 0,
        ...row,
      } as unknown as SlashProposalPartEntity),
    );
    return this.findForEpoch(organizationId, proposalId, chainEpoch);
  }
  async updatePart(organizationId: string, id: string, patch: object) {
    const row = this.rows.find((candidate) => candidate.id === id)!;
    Object.assign(row, patch);
  }
}

/** Every door scripted per request id; default: succeed. */
class ScriptedExecutor implements SlashExecutorPort {
  readonly proposeFails = new Map<string, unknown>();
  readonly executeFails = new Map<string, unknown>();
  readonly records = new Map<string, SlashRecordSnapshot>();
  readonly batches: { kind: string; size: number }[] = [];
  readonly expired: string[] = [];
  readonly executeRequests: SlashExecutionRequest[] = [];
  recordFor: ((requestId: string) => SlashRecordSnapshot | null) | null = null;

  async propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    const failure = this.proposeFails.get(request.beneficiary);
    if (failure) throw failure;
    return {
      signature: 'batch-tx',
      status: 'PENDING',
      proposedAt: T0,
      executableAt: X0,
      reservedMinor: request.penaltyMinor,
      adopted: false,
    };
  }
  async executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult> {
    const failure = this.executeFails.get(request.beneficiary);
    if (failure) throw failure;
    return {
      signature: 'exec-tx',
      appliedMinor: '100',
      agentAmountMinor: '60',
      platformAmountMinor: '30',
      executedAt: X0,
    };
  }
  async proposeBatch(requests: readonly SlashProposalRequest[]) {
    this.batches.push({ kind: 'propose', size: requests.length });
    return oneByOne(requests, (request) => this.propose(request));
  }
  async executeBatch(requests: readonly SlashExecutionRequest[]) {
    this.executeRequests.push(...requests);
    this.batches.push({ kind: 'execute', size: requests.length });
    return oneByOne(requests, (request) => this.executeProposal(request));
  }
  async buildCancel(): Promise<never> {
    throw new Error('unused');
  }
  async expire(request: { requestId: string }) {
    this.expired.push(request.requestId);
    return { signature: 'expire-tx', cancelledAt: X0 };
  }
  async readRecord(requestId: string) {
    return this.records.get(requestId) ?? this.recordFor?.(requestId) ?? null;
  }
  async settlementTreasury(): Promise<never> {
    throw new Error('unused');
  }
}

const CAPS: SlashCaps = {
  penaltyCeilingMinor: 1_000_000n,
  windowAllowanceMinor: 20_000_000n,
  freeStakeMinor: 199_000_000n,
  verifierDailyCapMinor: 500_000_000n,
  agentBps: 6000,
  platformBps: 3000,
};

function build(
  weights: [string, string][],
  config: ProRataSlashConfig = {
    dustReportBelowMinor: 0n,
    stragglerMaxAttempts: 3,
    stragglerDeadlineMs: 24 * 3_600_000,
  },
  paidOverride: [string, string][] | null = null,
) {
  const parts = new FakeParts();
  const executor = new ScriptedExecutor();
  const windowCalls = {
    sumFailedPriceByAgent: async () =>
      weights.map(([agentAccount, spend]) => ({
        organizationId: 'agent-org',
        agentAccount,
        spend,
      })),
    // C5: what each payer paid for its failed calls (here, what it was weighed by).
    failedCallPaymentsByAgent: async () =>
      (paidOverride ?? weights).map(([agentAccount, paid]) => ({
        agentAccount,
        failedCalls: '1',
        paid,
        redeemed: '0',
      })),
  };
  const service = new SlashPartsService(parts as never, windowCalls as never, executor, config, {
    readCaps: async () => CAPS,
  });
  const proposal = {
    id: 'case-1',
    organizationId: 'provider-org',
    assetId: ASSET,
    windowId: '6f1c9b2e-0000-4000-8000-000000000001',
    chainEpoch: 0,
    chainRequestId: 'c'.repeat(64),
    penaltyAmount: '300',
    toolId: 'tool-1',
  } as SlashProposalEntity;
  return { parts, executor, service, proposal };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('SlashPartsService.appliesTo', () => {
  const { service } = build([]);
  it('partitions EVM window cases only', () => {
    expect(service.appliesTo({ assetId: ASSET, windowId: 'w' })).toBe(true);
    expect(service.appliesTo({ assetId: ASSET, windowId: null })).toBe(false);
    expect(
      service.appliesTo({
        assetId:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
        windowId: 'w',
      }),
    ).toBe(false);
  });
});

describe('SlashPartsService.propose', () => {
  it('plans once, proposes every part in one batch, and folds the parts into one record', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);

    const result = await service.propose(proposal, '0xprovider');

    expect(executor.batches).toEqual([{ kind: 'propose', size: 2 }]);
    expect(parts.rows.map((row) => [row.agentAccount, row.penaltyAmount, row.chainStatus])).toEqual(
      [
        [agent(1), '200', 'PENDING'],
        [agent(2), '100', 'PENDING'],
      ],
    );
    expect(result).toMatchObject({ status: 'PENDING', reservedMinor: '300', executableAt: X0 });
  });

  it('C5: signs a genuine multiplier-2 case whose 60% shares are more than the payers paid', async () => {
    // Failed spend 100 + 50 = 150; the formula penalty is 2 × 150 = 300, split
    // 200/100. The beneficiaries' 60% (120, 60) exceed what they paid (100,
    // 50) — by design of the formula, so the case must still be signed.
    const { service, proposal, executor } = build([
      [agent(1), '100'],
      [agent(2), '50'],
    ]);
    await expect(service.propose(proposal, '0xprovider')).resolves.toMatchObject({
      status: 'PENDING',
    });
    expect(executor.batches).toEqual([{ kind: 'propose', size: 2 }]);
  });

  it('C5: refuses a part that exceeds the payer’s formula share', async () => {
    // The plan (weights 200/100) gives agent 1 a part of 200, but its vouchers
    // for the failed calls say it paid 100 of 300: its formula share is 100.
    const { service, proposal, executor } = build(
      [
        [agent(1), '200'],
        [agent(2), '100'],
      ],
      undefined,
      [
        [agent(1), '100'],
        [agent(2), '200'],
      ],
    );
    await expect(service.propose(proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: 'SLASH_BENEFICIARY_EVIDENCE_REFUSED',
      message: expect.stringContaining(
        'part 200 is more than the 100 the penalty formula gives it',
      ),
    });
    expect(executor.batches).toEqual([]);
  });

  it('C5: refuses to sign for a beneficiary that paid no voucher for a failed call', async () => {
    const { service, proposal, executor } = build([[agent(1), '300']], undefined, []);
    await expect(service.propose(proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: 'SLASH_BENEFICIARY_EVIDENCE_REFUSED',
      message: expect.stringContaining('paid no voucher for a failed call'),
    });
    expect(executor.batches).toEqual([]);
  });

  it('C5: reports the evidence per part: paid, formula share and payout', async () => {
    const { service, proposal, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    const evidence = await service.beneficiaryEvidenceOf(proposal, parts.rows as never, 6000);
    expect(
      evidence.map((row) => [
        row.payer,
        row.paidMinor,
        row.formulaShareMinor,
        row.shareMinor,
        row.ok,
      ]),
    ).toEqual([
      [agent(1), '200', '200', '120', true],
      [agent(2), '100', '100', '60', true],
    ]);
  });

  it('C5: allows one minor unit of rounding per part, and no more', async () => {
    const { service, proposal } = build([[agent(1), '300']]);
    const part = (penalty: string) =>
      ({
        chainRequestId: 'a'.repeat(64),
        agentAccount: agent(1),
        beneficiaryAccount: agent(1),
        penaltyAmount: penalty,
      }) as never;
    const [within] = await service.beneficiaryEvidenceOf(proposal, [part('301')], 6000);
    const [beyond] = await service.beneficiaryEvidenceOf(proposal, [part('302')], 6000);
    expect([within.ok, beyond.ok]).toEqual([true, false]);
  });

  it('merges two spellings of one EVM account into one beneficiary', async () => {
    const upper = `${CHAIN}:0x${'AB'.repeat(20)}`;
    const lower = `${CHAIN}:0x${'ab'.repeat(20)}`;
    const { service, proposal, parts } = build([
      [upper, '100'],
      [lower, '200'],
    ]);
    await service.propose(proposal, '0xprovider');
    expect(parts.rows.map((row) => [row.agentAccount, row.weightAmount])).toEqual([[lower, '300']]);
  });

  it('marks a part the chain refused for good as REFUSED and goes on with the rest', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    executor.proposeFails.set(agent(2).split(':')[2], revert('MissingBeneficiary'));

    const result = await service.propose(proposal, '0xprovider');

    expect(parts.rows.map((row) => row.chainStatus)).toEqual(['PENDING', 'REFUSED']);
    expect(parts.rows[1].chainLastError).toBe('MissingBeneficiary');
    expect(result.reservedMinor).toBe('200');
  });

  it('keeps the case proposing on a transient failure and re-sends only the missing part', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    executor.proposeFails.set(agent(2).split(':')[2], new Error('rpc timeout'));

    await expect(service.propose(proposal, '0xprovider', T0)).rejects.toThrow('rpc timeout');
    expect(parts.rows.map((row) => row.chainStatus)).toEqual(['PENDING', 'NONE']);

    executor.proposeFails.clear();
    await service.propose(proposal, '0xprovider', T0);
    expect(executor.batches).toEqual([
      { kind: 'propose', size: 2 },
      { kind: 'propose', size: 1 },
    ]);
  });

  it('voids nothing on its own when every part is refused — the refusal goes to the state machine', async () => {
    const { service, proposal, executor } = build([[agent(1), '200']]);
    executor.proposeFails.set(agent(1).split(':')[2], revert('VerifierRevoked'));
    const error = await service.propose(proposal, '0xprovider').catch((caught) => caught);
    expect(chainErrorName(error)).toBe('VerifierRevoked');
  });

  it('refuses, by name, a window with no harmed agent', async () => {
    const { service, proposal } = build([]);
    const error = await service.propose(proposal, '0xprovider').catch((caught) => caught);
    expect(error.errorCode).toBe(SlashErrorCode.SLASH_NO_HARMED_AGENTS);
  });

  it('keeps a small but payable share and only reports it as dust', async () => {
    // b's part is 5 units: payable (≥ 2), but its 60% (3) is under the
    // configured 10-unit report line. Kept, and only logged.
    const weights: [string, string][] = [
      [agent(1), '2995'],
      [agent(2), '5'],
    ];
    const kept = build(weights, {
      dustReportBelowMinor: 10n,
      stragglerMaxAttempts: 3,
      stragglerDeadlineMs: 24 * 3_600_000,
    });
    kept.proposal.penaltyAmount = '3000';
    await kept.service.propose(kept.proposal, '0xprovider');
    expect(kept.parts.rows.map((row) => row.penaltyAmount)).toEqual(['2995', '5']);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('less than 10 minor units'),
    );
  });

  it('leaves out an agent who paid on another chain', async () => {
    const { service, proposal, parts } = build([
      [agent(1), '200'],
      ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:Agent111', '500'],
    ]);
    await service.propose(proposal, '0xprovider');
    expect(parts.rows.map((row) => row.agentAccount)).toEqual([agent(1)]);
  });
});

describe('SlashPartsService.executeMany', () => {
  async function proposed(weights: [string, string][]) {
    const built = build(weights);
    await built.service.propose(built.proposal, '0xprovider');
    return built;
  }

  it('executes every case’s parts in ONE batch and sums what the chain paid', async () => {
    const one = await proposed([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    const outcomes = await one.service.executeMany([
      { proposal: one.proposal, provider: '0xprovider' },
    ]);
    expect(one.executor.batches.at(-1)).toEqual({ kind: 'execute', size: 2 });
    expect(outcomes.get('case-1')).toEqual({
      ok: true,
      result: expect.objectContaining({
        appliedMinor: '200',
        agentAmountMinor: '120',
        platformAmountMinor: '60',
      }),
    });
  });

  it('never lets a case with money moved be voided or returned as untouched', async () => {
    const one = await proposed([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    one.executor.executeFails.set(agent(2).split(':')[2], revert('SlashCapExceeded'));

    const outcome = (
      await one.service.executeMany([{ proposal: one.proposal, provider: '0xprovider' }])
    ).get('case-1')!;

    expect(outcome.ok).toBe(false);
    // Unnamed: the state machine leaves it EXECUTING for the reconciler.
    expect(chainErrorName(outcome.error)).toBeNull();
    expect(one.parts.rows.map((row) => row.chainStatus)).toEqual(['EXECUTED', 'PENDING']);
  });

  it('returns a WAIT refusal as is when nothing of the case executed', async () => {
    const one = await proposed([[agent(1), '200']]);
    one.executor.executeFails.set(agent(1).split(':')[2], revert('SlashCapExceeded'));
    const outcome = (
      await one.service.executeMany([{ proposal: one.proposal, provider: '0xprovider' }])
    ).get('case-1')!;
    expect(chainErrorName(outcome.error)).toBe('SlashCapExceeded');
  });

  it('expires a dead part beside an executed sibling and completes the case on what was paid', async () => {
    const one = await proposed([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    one.executor.executeFails.set(agent(2).split(':')[2], revert('VerifierRevoked'));

    const outcome = (
      await one.service.executeMany([{ proposal: one.proposal, provider: '0xprovider' }])
    ).get('case-1')!;

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.appliedMinor).toBe('100');
    expect(one.executor.expired).toHaveLength(1);
    expect(one.parts.rows.map((row) => row.chainStatus)).toEqual(['EXECUTED', 'CANCELLED']);
  });

  it('hands the VOID refusal to the state machine when every part is dead', async () => {
    const one = await proposed([[agent(1), '200']]);
    one.executor.executeFails.set(agent(1).split(':')[2], revert('VerifierRevoked'));
    const outcome = (
      await one.service.executeMany([{ proposal: one.proposal, provider: '0xprovider' }])
    ).get('case-1')!;
    expect(chainErrorName(outcome.error)).toBe('VerifierRevoked');
  });

  it('reads the record, not the error, when a part was moved by somebody else', async () => {
    const one = await proposed([[agent(1), '200']]);
    one.executor.executeFails.set(agent(1).split(':')[2], revert('SlashNotPending'));
    one.executor.records.set(one.parts.rows[0].chainRequestId, {
      status: 'EXECUTED',
      // The part's own penalty (the case's 300 on one agent): the same judgement.
      penaltyMinor: '300',
      appliedMinor: '200',
      agentAmountMinor: '120',
      platformAmountMinor: '60',
      reservedMinor: '200',
      proposedAt: T0,
      executableAt: X0,
      executedAt: X0,
      cancelledAt: null,
    });
    const outcome = (
      await one.service.executeMany([{ proposal: one.proposal, provider: '0xprovider' }])
    ).get('case-1')!;
    expect(outcome.result).toMatchObject({ appliedMinor: '200', agentAmountMinor: '120' });
  });
});

describe('review fixes — SlashPartsService', () => {
  const pendingRecord = (penalty: string): SlashRecordSnapshot => ({
    status: 'PENDING',
    penaltyMinor: penalty,
    appliedMinor: '0',
    agentAmountMinor: '0',
    platformAmountMinor: '0',
    reservedMinor: penalty,
    proposedAt: T0,
    executableAt: X0,
    executedAt: null,
    cancelledAt: null,
  });

  // S1-1: a refusal is not trusted while a record may already be on chain.
  it('re-reads slashRecordOf before marking a part REFUSED, and adopts what is there', async () => {
    const { service, proposal, executor, parts } = build([[agent(1), '200']]);
    executor.proposeFails.set(agent(1).split(':')[2], revert('PenaltyExceedsMaximum'));
    executor.recordFor = (requestId) => (requestId ? pendingRecord('300') : null);

    const result = await service.propose(proposal, '0xprovider');

    expect(parts.rows[0].chainStatus).toBe('PENDING');
    expect(result.status).toBe('PENDING');
  });

  it('re-reads REFUSED parts in readRecord, so a late-landing record is never left behind', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    executor.proposeFails.set(agent(2).split(':')[2], revert('MissingBeneficiary'));
    await service.propose(proposal, '0xprovider');
    expect(parts.rows[1].chainStatus).toBe('REFUSED');

    // The earlier, slow transaction lands after all.
    executor.records.set(parts.rows[1].chainRequestId, pendingRecord('100'));
    const view = await service.readRecord(proposal, '0xprovider');

    expect(parts.rows[1].chainStatus).toBe('PENDING');
    expect(view?.reservedMinor).toBe('300');
  });

  it('R2-8: keeps the cancel reason a chain read observed on the part', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    const cancelledAt = new Date('2026-10-16T00:00:00Z');
    executor.records.set(parts.rows[0].chainRequestId, {
      ...pendingRecord('200'),
      status: 'CANCELLED',
      cancelledAt,
      cancelReason: 'WITHDRAWN',
    });
    // Unknown on chain: nothing is invented.
    executor.records.set(parts.rows[1].chainRequestId, {
      ...pendingRecord('100'),
      status: 'CANCELLED',
    });

    await service.readRecord(proposal, '0xprovider');

    expect(parts.rows[0]).toMatchObject({
      chainStatus: 'CANCELLED',
      cancelReason: 'WITHDRAWN',
      cancelledAt,
    });
    expect(parts.rows[1].chainStatus).toBe('CANCELLED');
    expect(parts.rows[1].cancelReason ?? null).toBeNull();
  });

  // S2-1: one never-proposable part must not hold the case in PROPOSING for ever.
  it('gives up on a straggler after the attempt cap and lets the case proceed', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    executor.proposeFails.set(agent(2).split(':')[2], new Error('rpc timeout'));

    for (let attempt = 1; attempt < 3; attempt += 1) {
      await expect(service.propose(proposal, '0xprovider', T0)).rejects.toThrow('rpc timeout');
    }
    const result = await service.propose(proposal, '0xprovider', T0);

    expect(parts.rows[1].chainStatus).toBe('REFUSED');
    expect(parts.rows[1].chainLastError).toMatch(/^Straggler/);
    expect(result).toMatchObject({ status: 'PENDING', reservedMinor: '200' });
  });

  it('gives up on a straggler once its siblings’ door is near, whatever the attempt count', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    executor.proposeFails.set(agent(2).split(':')[2], new Error('rpc timeout'));
    await expect(service.propose(proposal, '0xprovider', T0)).rejects.toThrow('rpc timeout');

    const nearTheDoor = new Date(X0.getTime() - 3_600_000);
    const result = await service.propose(proposal, '0xprovider', nearTheDoor);

    expect(parts.rows[1].chainStatus).toBe('REFUSED');
    expect(result.status).toBe('PENDING');
  });

  // S2-2: every part of one case shares one atomic group.
  it('hands the executor one atomic group per case', async () => {
    const { service, proposal, executor } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    await service.executeMany([{ proposal, provider: '0xprovider' }]);
    expect(new Set(executor.executeRequests.map((request) => request.atomicGroup))).toEqual(
      new Set(['case-1']),
    );
  });

  // S3(5): a reservation left behind by a failed expire is revisited.
  it('expires the pending parts of a case that already executed', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    parts.rows[0].chainStatus = 'EXECUTED';
    Object.assign(parts.rows[0], {
      appliedAmount: '200',
      agentAmount: '120',
      platformAmount: '60',
      executedAt: X0,
    });
    // Dead: its verifier key was revoked, so it can never execute — and that
    // is exactly what makes expireSlash allowed now.
    executor.records.set(parts.rows[1].chainRequestId, {
      ...pendingRecord('100'),
      verifierCanSign: false,
    });
    executor.executeFails.set(agent(2).split(':')[2], revert('VerifierRevoked'));

    const swept = await service.sweepStrandedParts([{ proposal, provider: '0xprovider' }], X0);

    expect(swept).toMatchObject({ expired: 1, waiting: 0 });
    expect(parts.rows[1].chainStatus).toBe('CANCELLED');
  });

  // Residual 1: one match rule for every record read back.
  it('refuses to mirror a record at our request id whose terms differ', async () => {
    const { service, proposal, executor, parts } = build([[agent(1), '200']]);
    executor.proposeFails.set(agent(1).split(':')[2], new Error('rpc timeout'));
    executor.recordFor = () => ({ ...pendingRecord('999'), beneficiary: agent(1).split(':')[2] });

    await service.propose(proposal, '0xprovider', T0).catch(() => undefined);

    expect(parts.rows[0].chainStatus).toBe('REFUSED');
    expect(parts.rows[0].chainLastError).toBe('RecordMismatch:penalty');
  });

  // Residual 2: a straggler given up while its tx was in flight is executed when it lands.
  it('executes a REFUSED straggler whose record landed later and is due', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    Object.assign(parts.rows[0], {
      chainStatus: 'EXECUTED',
      appliedAmount: '200',
      agentAmount: '120',
      platformAmount: '60',
      executedAt: X0,
    });
    Object.assign(parts.rows[1], { chainStatus: 'REFUSED', chainLastError: 'Straggler:transport' });
    executor.records.set(parts.rows[1].chainRequestId, {
      ...pendingRecord('100'),
      verifierCanSign: true,
    });

    const swept = await service.sweepStrandedParts([{ proposal, provider: '0xprovider' }], X0);

    expect(swept).toMatchObject({ executed: 1, expired: 0 });
    expect(parts.rows[1].chainStatus).toBe('EXECUTED');
    expect(executor.expired).toHaveLength(0);
  });

  // Residual 4: no expireSlash before it can succeed, and no noise.
  it('does not try to expire a pending part before the chain would allow it', async () => {
    const { service, proposal, executor, parts } = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await service.propose(proposal, '0xprovider');
    Object.assign(parts.rows[0], {
      chainStatus: 'EXECUTED',
      appliedAmount: '200',
      agentAmount: '120',
      platformAmount: '60',
      executedAt: X0,
    });
    // Live key, door not open yet: neither executable nor expirable.
    executor.records.set(parts.rows[1].chainRequestId, {
      ...pendingRecord('100'),
      verifierCanSign: true,
    });
    const before = new Date(X0.getTime() - 3_600_000);

    const swept = await service.sweepStrandedParts([{ proposal, provider: '0xprovider' }], before);

    expect(swept).toMatchObject({ expired: 0, executed: 0, waiting: 1 });
    expect(executor.expired).toHaveLength(0);
    expect(executor.executeRequests).toHaveLength(0);
    expect(parts.rows[1].chainLastError).toBeNull();
  });
});

describe('review H-2 — the stored plan is checked against the evidence before signing', () => {
  async function tampered(edit: (part: SlashProposalPartEntity) => void) {
    const ctx = build([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    // A plan stored by an earlier attempt that never reached the chain.
    ctx.executor.proposeFails.set(agent(1).split(':')[2], revert('Transport'));
    ctx.executor.proposeFails.set(agent(2).split(':')[2], revert('Transport'));
    await ctx.service.propose(ctx.proposal, '0xprovider').catch(() => undefined);
    ctx.executor.proposeFails.clear();
    ctx.executor.batches.length = 0;
    for (const row of ctx.parts.rows) row.chainStatus = 'NONE';
    edit(ctx.parts.rows[0]);
    return ctx;
  }

  it('signs nothing when a stored beneficiary was changed', async () => {
    const ctx = await tampered((part) => {
      part.beneficiaryAccount = agent(99);
    });
    await expect(ctx.service.propose(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_PLAN_EVIDENCE_MISMATCH,
    });
    expect(ctx.executor.batches).toEqual([]);
  });

  it('signs nothing when a stored penalty was raised', async () => {
    const ctx = await tampered((part) => {
      part.penaltyAmount = (BigInt(part.penaltyAmount) + 1n).toString();
    });
    await expect(ctx.service.propose(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_PLAN_EVIDENCE_MISMATCH,
    });
    expect(ctx.executor.batches).toEqual([]);
  });

  it('still signs an untouched stored plan', async () => {
    const ctx = await tampered(() => undefined);
    await expect(ctx.service.propose(ctx.proposal, '0xprovider')).resolves.toMatchObject({
      status: 'PENDING',
    });
    expect(ctx.executor.batches).toEqual([{ kind: 'propose', size: 2 }]);
  });
});

/**
 * B11: a case asked to be cancelled with no part standing (a case opened
 * before the parts model has no parts at all). The case's own record is read;
 * what is not Pending or Disputed is closed with a timeline entry and refused
 * with 409 SLASH_NOTHING_STANDING rather than a 503.
 */
describe('SlashPartsService.buildCancel — nothing standing', () => {
  const record = (status: SlashRecordSnapshot['status']): SlashRecordSnapshot => ({
    status,
    penaltyMinor: '300',
    appliedMinor: '0',
    agentAmountMinor: '0',
    platformAmountMinor: '0',
    reservedMinor: status === 'PENDING' || status === 'DISPUTED' ? '300' : '0',
    proposedAt: T0,
    executableAt: X0,
    executedAt: null,
    cancelledAt: null,
  });

  function withCaseStore(weights: [string, string][] = []) {
    const ctx = build(weights);
    const updates: { criteria: object; patch: object }[] = [];
    const events: { kind: string; detail: Record<string, unknown> }[] = [];
    let chainStatus = 'CANCEL_REQUESTED';
    const proposals = {
      update: jest.fn(
        async (criteria: { chainStatus?: string }, patch: { chainStatus?: string }) => {
          updates.push({ criteria, patch });
          if (criteria.chainStatus && criteria.chainStatus !== chainStatus) return { affected: 0 };
          if (patch.chainStatus) chainStatus = patch.chainStatus;
          return { affected: 1 };
        },
      ),
    };
    const alerts = { emit: jest.fn(async () => undefined) };
    const lifecycle = {
      appendEventDirect: jest.fn(
        async (entry: { kind: string; detail: Record<string, unknown> }) => {
          events.push(entry);
        },
      ),
    };
    const service = new SlashPartsService(
      ctx.parts as never,
      {} as never,
      ctx.executor,
      { dustReportBelowMinor: 0n, stragglerMaxAttempts: 3, stragglerDeadlineMs: 1 },
      { readCaps: async () => CAPS },
      proposals as never,
      lifecycle as never,
      alerts as never,
    );
    const proposal = {
      ...ctx.proposal,
      status: 'CANCELLED',
      chainStatus: 'CANCEL_REQUESTED',
      chainProposedAt: null,
    } as SlashProposalEntity;
    let built: string[] = [];
    ctx.executor.buildCancel = (async (request: { requestId: string }) => {
      built.push(request.requestId);
      return { transaction: 'tx' } as never;
    }) as never;
    return {
      ...ctx,
      planner: ctx.service,
      service,
      proposal,
      updates,
      events,
      alerts,
      built: () => built,
      chainStatus: () => chainStatus,
      reset: () => (built = []),
    };
  }

  it('no parts and the record is no longer pending: 409, closed, with an event', async () => {
    const ctx = withCaseStore();
    ctx.executor.records.set(ctx.proposal.chainRequestId, record('CANCELLED'));

    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
      statusCode: 409,
    });
    expect(ctx.chainStatus()).toBe('CANCELLED');
    expect(ctx.updates[0].criteria).toMatchObject({
      organizationId: 'provider-org',
      id: 'case-1',
      chainStatus: 'CANCEL_REQUESTED',
      chainEpoch: 0,
    });
    expect(ctx.events).toEqual([
      expect.objectContaining({
        kind: 'CHAIN_CANCELLED',
        detail: expect.objectContaining({
          requestId: ctx.proposal.chainRequestId,
          chainRecord: 'CANCELLED',
        }),
      }),
    ]);
    expect(ctx.built()).toEqual([]);
  });

  it('no parts and no record ever written: closed, and the 409 says so', async () => {
    const ctx = withCaseStore();
    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
    });
    expect(ctx.chainStatus()).toBe('CANCELLED');
    expect(ctx.events[0].detail.chainRecord).toBe('NOT_FOUND');
  });

  // I2: our own mirror says a record landed; a missing slot is an anomaly, not "nothing stands".
  it('no record, but chain_proposed_at set: refused, not closed, RecordMissing noted', async () => {
    const ctx = withCaseStore();
    const landed = { ...ctx.proposal, chainProposedAt: T0 } as SlashProposalEntity;
    await expect(ctx.service.buildCancel(landed, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
      publicContext: { chainStatus: 'NOT_FOUND', closed: false },
    });
    expect(ctx.chainStatus()).toBe('CANCEL_REQUESTED');
    expect(ctx.events).toEqual([]);
    expect(ctx.updates).toEqual([
      {
        criteria: { organizationId: 'provider-org', id: 'case-1' },
        patch: { chainLastError: 'RecordMissing' },
      },
    ]);
  });

  it('only a case closed as a decision is closed (OVERTURNED yes, PROPOSED no)', async () => {
    const overturned = withCaseStore();
    await expect(
      overturned.service.buildCancel(
        { ...overturned.proposal, status: 'OVERTURNED' } as SlashProposalEntity,
        '0xprovider',
      ),
    ).rejects.toMatchObject({ publicContext: { closed: true } });
    expect(overturned.chainStatus()).toBe('CANCELLED');

    const open = withCaseStore();
    await expect(
      open.service.buildCancel(
        { ...open.proposal, status: 'PROPOSED' } as SlashProposalEntity,
        '0xprovider',
      ),
    ).rejects.toMatchObject({ publicContext: { closed: false } });
    expect(open.chainStatus()).toBe('CANCEL_REQUESTED');
  });

  it.each(['PENDING', 'DISPUTED'] as const)(
    'no parts but the case record is %s on chain: builds its cancel, writes nothing',
    async (status) => {
      const ctx = withCaseStore();
      ctx.executor.records.set(ctx.proposal.chainRequestId, record(status));

      await ctx.service.buildCancel(ctx.proposal, '0xprovider');

      expect(ctx.built()).toEqual([ctx.proposal.chainRequestId]);
      expect(ctx.updates).toEqual([]);
      expect(ctx.events).toEqual([]);
    },
  );

  it('an executed record is never written as cancelled', async () => {
    const ctx = withCaseStore();
    ctx.executor.records.set(ctx.proposal.chainRequestId, record('EXECUTED'));

    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
    });
    expect(ctx.chainStatus()).toBe('CANCEL_REQUESTED');
    expect(ctx.events).toEqual([]);
  });

  // C1: a withdrawn judgement executed while the cancel waited is paged, and said as EXECUTED.
  it('C1: an executed record is alerted and refused as EXECUTED, never closed', async () => {
    const ctx = withCaseStore();
    ctx.executor.records.set(ctx.proposal.chainRequestId, record('EXECUTED'));
    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      publicContext: { chainStatus: 'EXECUTED', closed: false },
    });
    expect(ctx.alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'CRITICAL',
        name: 'slash_executed_while_cancel_waited',
        details: expect.objectContaining({ proposalId: 'case-1', where: 'record' }),
      }),
    );
    expect(ctx.updates).toEqual([]);
  });

  it('a part that executed keeps the case out of CANCELLED, and is alerted', async () => {
    const ctx = withCaseStore([[agent(1), '200']]);
    await ctx.planner.propose(ctx.proposal, '0xprovider');
    Object.assign(ctx.parts.rows[0], { chainStatus: 'EXECUTED', executedAt: X0 });

    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
      publicContext: { chainStatus: 'EXECUTED', closed: false },
    });
    expect(ctx.chainStatus()).toBe('CANCEL_REQUESTED');
    expect(ctx.alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ where: 'part' }) }),
    );
  });

  // I3: a case with parts is judged by its parts, never by a read of the case id.
  it('a case with parts, all cancelled: closed from the parts, without reading the case id', async () => {
    const ctx = withCaseStore([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await ctx.planner.propose(ctx.proposal, '0xprovider');
    ctx.parts.rows.forEach((row) => Object.assign(row, { chainStatus: 'CANCELLED' }));
    const reads = jest.spyOn(ctx.executor, 'readRecord');

    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      publicContext: { chainStatus: 'CANCELLED', closed: true },
    });
    expect(reads.mock.calls.map(([id]) => id)).not.toContain(ctx.proposal.chainRequestId);
    expect(ctx.chainStatus()).toBe('CANCELLED');
    expect(ctx.events[0]).toMatchObject({
      summary: expect.stringContaining('Every on-chain record of this penalty is cancelled'),
      detail: expect.objectContaining({ parts: 2 }),
    });
  });

  it('a case with a part still NONE (it may land) is refused, not closed', async () => {
    const ctx = withCaseStore([
      [agent(1), '200'],
      [agent(2), '100'],
    ]);
    await ctx.planner.propose(ctx.proposal, '0xprovider');
    Object.assign(ctx.parts.rows[0], { chainStatus: 'CANCELLED' });
    Object.assign(ctx.parts.rows[1], { chainStatus: 'NONE' });

    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      publicContext: { closed: false },
    });
    expect(ctx.chainStatus()).toBe('CANCEL_REQUESTED');
  });

  it('an unreadable chain is a 503, and nothing is written', async () => {
    const ctx = withCaseStore();
    ctx.executor.readRecord = async () => {
      throw new Error('rpc down');
    };
    await expect(ctx.service.buildCancel(ctx.proposal, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_CHAIN_UNAVAILABLE,
    });
    expect(ctx.updates).toEqual([]);
  });

  it('a recalculated case (still UPHELD) is refused but left for the sweep to re-propose', async () => {
    const ctx = withCaseStore();
    const upheld = { ...ctx.proposal, status: 'UPHELD' } as SlashProposalEntity;
    await expect(ctx.service.buildCancel(upheld, '0xprovider')).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_NOTHING_STANDING,
    });
    expect(ctx.updates).toEqual([]);
  });
});
