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

    await expect(service.propose(proposal, '0xprovider')).rejects.toThrow('rpc timeout');
    expect(parts.rows.map((row) => row.chainStatus)).toEqual(['PENDING', 'NONE']);

    executor.proposeFails.clear();
    await service.propose(proposal, '0xprovider');
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
