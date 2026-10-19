import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { SlaWindowFailureGroup } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashCaseService } from '@modules/slash/services/slash-case.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import { fakeQueryBuilder } from '../provider/helpers/fake-query-builder';
import {
  FakeNotifications,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';
import {
  buildBinding,
  buildBindingVersion,
  buildCall,
  buildProposal,
  buildStakeResponse,
  buildStrike,
  buildTool,
  buildWindow,
  FakeSlashProposalEvents,
  FULL_COMPUTATION,
  OTHER_CHAIN_ASSET,
  TEST_ASSET,
  TEST_BINDING_ID,
} from './helpers/fake-slash-case-collaborators';

const ORG = 'org_1';

/**
 * `SlaWindowRepository`, faked: `findOneBy` for the point reads
 * (`buildCase`) and `createQueryBuilder` for `loadPriorWindows`, which this suite
 * does not exercise beyond returning an empty list — none of the five
 * required cases touch `priorWindows`.
 */
class FakeWindows {
  private readonly rows = new Map<string, SlaWindowEntity>();
  priorWindowRows: SlaWindowEntity[] = [];

  seed(window: SlaWindowEntity): SlaWindowEntity {
    this.rows.set(window.id, window);
    return window;
  }

  async findOneBy(where: { organizationId: string; id: string }): Promise<SlaWindowEntity | null> {
    const row = this.rows.get(where.id);
    return row && row.organizationId === where.organizationId ? row : null;
  }

  createQueryBuilder() {
    return fakeQueryBuilder(this.priorWindowRows).qb;
  }
}

class FakeStrikes {
  private readonly rows = new Map<string, SlaStrikeEntity>();

  seed(strike: SlaStrikeEntity): SlaStrikeEntity {
    this.rows.set(strike.id, strike);
    return strike;
  }

  async findOneBy(where: { organizationId: string; id: string }): Promise<SlaStrikeEntity | null> {
    const row = this.rows.get(where.id);
    return row && row.organizationId === where.organizationId ? row : null;
  }
}

class FakeBindings {
  private readonly rows = new Map<string, ToolBindingEntity>();

  seed(binding: ToolBindingEntity): ToolBindingEntity {
    this.rows.set(binding.id, binding);
    return binding;
  }

  async findOneBy(where: {
    organizationId: string;
    id: string;
  }): Promise<ToolBindingEntity | null> {
    const row = this.rows.get(where.id);
    return row && row.organizationId === where.organizationId ? row : null;
  }
}

class FakeCalls {
  callsToReturn: ReturnType<typeof buildCall>[] = [];
  reasonGroups: SlaWindowFailureGroup[] = [];
  agentGroups: SlaWindowFailureGroup[] = [];

  async findByWindow() {
    return this.callsToReturn;
  }
  async countFailuresByReasonCode() {
    return this.reasonGroups;
  }
  async countFailuresByAgentId() {
    return this.agentGroups;
  }
}

class FakeBindingVersions {
  editionsToReturn: BindingVersionEntity[] = [];

  createQueryBuilder() {
    return fakeQueryBuilder(this.editionsToReturn).qb;
  }
}

class FakeCaseRead {
  evidenceCount = 0;

  async countEvidencePacksForWindow() {
    return this.evidenceCount;
  }
}

function build(parts: Record<string, unknown>[] | null = null) {
  const proposals = new FakeSlashProposals();
  const events = new FakeSlashProposalEvents();
  const notifications = new FakeNotifications();
  const lifecycle = new SlashProposalService(
    proposals as never,
    events as never,
    notifications as never,
    TEST_SLASH_CONFIG,
  );

  const strikes = new FakeStrikes();
  const windows = new FakeWindows();
  const calls = new FakeCalls();
  const bindingVersions = new FakeBindingVersions();
  const bindings = new FakeBindings();
  const caseRead = new FakeCaseRead();
  const stakeService = { getStake: jest.fn().mockResolvedValue(buildStakeResponse()) };
  const catalogue = {
    findTool: jest.fn().mockResolvedValue(buildTool({ id: 'search_web' })),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  };

  const service = new SlashCaseService(
    lifecycle,
    events as never,
    strikes as never,
    windows as never,
    calls as never,
    bindingVersions as never,
    bindings as never,
    caseRead as never,
    stakeService as never,
    catalogue as never,
    (parts ? { findForEpoch: async () => parts } : null) as never,
  );

  return {
    service,
    proposals,
    events,
    strikes,
    windows,
    calls,
    bindingVersions,
    bindings,
    caseRead,
    stakeService,
    catalogue,
  };
}

describe('SlashCaseService.buildCase — arithmetic', () => {
  it('renders each row from the strike’s real `computation` array', async () => {
    const { service, proposals, strikes, windows, bindings } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const result = await service.buildCase(ORG, 'p1');
    const byKey = new Map(result.arithmetic.map((row) => [row.key, row]));

    const observedRow = byKey.get('observed_rate')!;
    expect(observedRow.expression).toBe('92 failed / 612 verified');
    expect(observedRow.value).toBe('15.03%');
    // The strike breaches (observed 15.03% > threshold 7.27%) — always BAD for
    // a row that exists at all, since a strike is only ever written for a
    // breaching window.
    expect(observedRow.tone).toBe('BAD');

    const toleranceRow = byKey.get('tolerance')!;
    expect(toleranceRow.expression).toBe('2.58 × sqrt(0.05 × 0.95 / 612)');
    expect(toleranceRow.value).toBe('2.27%');

    const verifiedRow = byKey.get('verified_calls')!;
    expect(verifiedRow.expression).toBe('612 verified >= 400 required');
    expect(verifiedRow.value).toBe('612');
    expect(verifiedRow.note).toBe('≥ 400 minimum sample — window is slashable');
    expect(verifiedRow.tone).toBe('GOOD');

    const penaltyRow = byKey.get('penalty')!;
    expect(penaltyRow.expression).toBe(
      '720000 × 10.03% × 2 (= estimated_bad × average_price × multiplier)',
    );
    // proposal.decimals = 6, penaltyAmount = '5136000' minor units.
    expect(penaltyRow.value).toBe('5.136000');

    const windowCallsRow = byKey.get('window_calls')!;
    expect(windowCallsRow.value).toBe('720');
    expect(windowCallsRow.expression).toBeNull();
  });

  it('returns a null expression, not a fabricated one, when `computation` lacks a step', async () => {
    const { service, proposals, strikes, windows, bindings } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(
      buildStrike({
        id: 'strike_1',
        organizationId: ORG,
        // The `tolerance` step is missing — as if a future refactor of
        // `strikeArithmeticFor` dropped it, or an old row predates it.
        computation: FULL_COMPUTATION.filter((step) => step.label !== 'tolerance'),
      }),
    );
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const result = await service.buildCase(ORG, 'p1');
    const toleranceRow = result.arithmetic.find((row) => row.key === 'tolerance')!;

    expect(toleranceRow.expression).toBeNull();
    // The VALUE still comes from the strike's own column — that is real data,
    // not the working. Only the expression is withheld.
    expect(toleranceRow.value).toBe('2.27%');
  });

  it('never invents the per-window cap — it names where the number actually lives', async () => {
    const { service, proposals, strikes, windows, bindings } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const result = await service.buildCase(ORG, 'p1');
    const capRow = result.arithmetic.find((row) => row.key === 'per_window_cap')!;

    expect(capRow.expression).toBeNull();
    expect(capRow.value).toBe('enforced on chain — not computed here');
  });

  it('returns no arithmetic rows at all when the strike cannot be read', async () => {
    const { service, proposals, bindings } = build();

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        strikeId: '00000000-0000-4000-8000-00000000dead',
        windowId: null,
      }),
    );
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const result = await service.buildCase(ORG, 'p1');
    expect(result.arithmetic).toEqual([]);
  });
});

describe('SlashCaseService.buildCase — toolName', () => {
  it('names the tool from the catalogue', async () => {
    const { service, proposals, bindings, catalogue } = build();
    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));
    catalogue.findTool.mockResolvedValue(buildTool({ id: 'search_web', name: 'search_web' }));

    const result = await service.buildCase(ORG, 'p1');

    expect(result.proposal.toolName).toBe('search_web');
  });

  it('is null, never an id, when the catalogue cannot name the tool', async () => {
    const { service, proposals, bindings, catalogue } = build();
    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));
    catalogue.findTool.mockResolvedValue(null);

    const result = await service.buildCase(ORG, 'p1');

    expect(result.proposal.toolName).toBeNull();
  });
});

describe('SlashCaseService.buildCase — changeOverlay', () => {
  it('is null when no binding or mapping edit published inside the window', async () => {
    const { service, proposals, strikes, windows, bindings, bindingVersions } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));
    bindingVersions.editionsToReturn = []; // no publish falls inside the window

    const result = await service.buildCase(ORG, 'p1');
    expect(result.changeOverlay).toBeNull();
  });

  it('splits the window’s calls before/after the most recent in-window publish', async () => {
    const { service, proposals, strikes, windows, bindings, bindingVersions, calls } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const changedAt = new Date('2026-08-06T00:00:00Z');
    bindingVersions.editionsToReturn = [
      buildBindingVersion({
        id: 'v1',
        organizationId: ORG,
        mappingVersion: 3,
        publishedAt: changedAt,
        publishedBy: 'user_9',
      }),
    ];
    calls.callsToReturn = [
      buildCall({
        id: 'c1',
        organizationId: ORG,
        postedAt: new Date('2026-08-05T00:00:00Z'),
        countedAsQuality: true,
        countedAsFailure: false,
      }),
      buildCall({
        id: 'c2',
        organizationId: ORG,
        postedAt: new Date('2026-08-07T00:00:00Z'),
        countedAsQuality: true,
        countedAsFailure: true,
      }),
      buildCall({
        id: 'c3',
        organizationId: ORG,
        postedAt: new Date('2026-08-08T00:00:00Z'),
        countedAsQuality: true,
        countedAsFailure: true,
      }),
    ];

    const result = await service.buildCase(ORG, 'p1');

    expect(result.changeOverlay).not.toBeNull();
    expect(result.changeOverlay!.changedAt).toEqual(changedAt);
    expect(result.changeOverlay!.changedBy).toBe('user_9');
    expect(result.changeOverlay!.fromVersion).toBe('v2');
    expect(result.changeOverlay!.toVersion).toBe('v3');
    expect(result.changeOverlay!.verifiedBefore).toBe(1);
    expect(result.changeOverlay!.failuresBefore).toBe(0);
    expect(result.changeOverlay!.verifiedAfter).toBe(2);
    expect(result.changeOverlay!.failuresAfter).toBe(2);
  });
});

describe('SlashCaseService.buildCase — clocks', () => {
  it('runs the provider’s clock only while the record’s door is still in the future', async () => {
    const { service, proposals } = build();

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        strikeId: null,
        windowId: null,
        status: 'PROPOSED',
        chainStatus: 'PENDING',
        chainExecutableAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    const result = await service.buildCase(ORG, 'p1');

    expect(result.proposal.clocks.runningClock).toBe('PROVIDER');
    expect(result.proposal.clocks.secondsRemaining).toBeGreaterThan(0);
  });

  it('carries the mirrored on-chain record: status, executableAt, disputedAt and the disputed count', async () => {
    const { service, proposals } = build();
    const chainExecutableAt = new Date('2026-10-15T09:37:00.000Z');
    const chainDisputedAt = new Date('2026-10-15T08:58:08.000Z');

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        strikeId: null,
        windowId: null,
        status: 'DISPUTED',
        chainStatus: 'PENDING',
        chainExecutableAt,
        chainDisputedAt,
        chainDisputedParts: 0,
      }),
    );

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    expect(clocks.chainStatus).toBe('PENDING');
    expect(clocks.chainExecutableAt).toEqual(chainExecutableAt);
    expect(clocks.chainDisputedAt).toEqual(chainDisputedAt);
    expect(clocks.chainDisputedParts).toBe(0);
  });

  it('reports a case never put on chain as NONE with no chain clocks', async () => {
    const { service, proposals } = build();

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        strikeId: null,
        windowId: null,
        status: 'PROPOSED',
      }),
    );

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    expect(clocks.chainStatus).toBe('NONE');
    expect(clocks.chainExecutableAt).toBeNull();
    expect(clocks.chainDisputedAt).toBeNull();
    expect(clocks.chainDisputedParts).toBe(0);
  });
});

describe('SlashCaseService.restoration', () => {
  it('marks the penalty NOT_APPLICABLE once the case is upheld — it stands', async () => {
    const { service, proposals } = build();

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        status: 'UPHELD',
        resolutionKind: 'CHAIN_ARBITER',
        resolvedAt: new Date('2026-08-11T00:00:00Z'),
      }),
    );

    const rows = await service.restoration(ORG, 'p1');
    expect(rows.map((row) => row.label)).toEqual([
      'Tier progress restored',
      'Penalty cancelled',
      'Counted against our false-positive metric',
      'Policy recalibration ticket',
    ]);
    const penaltyRow = rows.find((row) => row.label === 'Penalty cancelled')!;
    expect(penaltyRow.status).toBe('NOT_APPLICABLE');
  });

  it('reads ON_DECISION for the penalty and the metric while the case is still open', async () => {
    const { service, proposals } = build();

    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        strikeId: null,
        windowId: null,
        status: 'PROPOSED',
        resolvedAt: null,
      }),
    );

    const rows = await service.restoration(ORG, 'p1');
    const penaltyRow = rows.find((row) => row.label === 'Penalty cancelled')!;
    const metricRow = rows.find(
      (row) => row.label === 'Counted against our false-positive metric',
    )!;

    expect(penaltyRow.status).toBe('ON_DECISION');
    expect(metricRow.status).toBe('ON_DECISION');
  });

  it('is honest that tier progress and the policy ticket are not tracked', async () => {
    const { service, proposals } = build();

    proposals.seed(
      buildProposal({ id: 'p1', organizationId: ORG, strikeId: null, windowId: null }),
    );

    const rows = await service.restoration(ORG, 'p1');
    const tierRow = rows.find((row) => row.label === 'Tier progress restored')!;
    const ticketRow = rows.find((row) => row.label === 'Policy recalibration ticket')!;

    expect(tierRow.status).toBe('NOT_APPLICABLE');
    expect(tierRow.value).toContain('not tracked');
    expect(ticketRow.status).toBe('NOT_APPLICABLE');
    expect(ticketRow.value).toContain('not tracked');
  });
});

/**
 * The slash case's "what happens if you do nothing" panel, against a
 * **per-chain** stake.
 *
 * The stake now arrives as a list, one entry per chain, and the forecast is
 * about exactly one of them: the chain the disputed call was PAID on, whose
 * settlement contract is the only one that can confiscate anything. Collateral
 * on any other chain is unreachable to it, so a forecast built from the wrong
 * row describes a slash that cannot happen — and it describes it on the screen
 * a provider decides whether to dispute from.
 *
 * `buildStakeResponse` puts the other chain FIRST, with the LARGER balance, so
 * "the first entry" and "the largest entry" both produce a visibly wrong number
 * rather than accidentally the right one.
 */
describe('SlashCaseService.buildCase — the inaction forecast is about ONE chain', () => {
  it('takes the stake from the chain the proposal is denominated in', async () => {
    const { service, proposals, strikes, windows, bindings } = build();

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { inaction } = await service.buildCase(ORG, 'p1');

    // $100 on the proposal's own chain — not $250 from the other one, and not
    // $350 from both.
    expect(inaction.stakeBefore).toEqual({ amount: '100000000', asset: TEST_ASSET, decimals: 6 });
    // 100.000000 − 5.136000
    expect(inaction.stakeAfter).toEqual({ amount: '94864000', asset: TEST_ASSET, decimals: 6 });
  });

  it('reports zero, in the proposal’s own asset, when only ANOTHER chain has a reading', async () => {
    // The compromise the DTO forces — `stakeBefore` is required and has no way
    // to say "unknown" — but it must be reached by the chain having no reading,
    // never by silently spending the other chain's collateral. The other chain
    // is flush with $250 here and contributes nothing.
    const { service, proposals, strikes, windows, bindings, stakeService } = build();
    stakeService.getStake.mockResolvedValue(
      buildStakeResponse({
        stake: [
          {
            chainId: 'eip155:46630',
            hasKnownStake: true,
            staked: { amount: '250000000', asset: OTHER_CHAIN_ASSET, decimals: 6 },
            observedAt: '2026-08-10T00:00:00Z',
            unbonding: null,
            unbondingStartedAt: null,
            unbondingCompletesAt: null,
            chainReadable: true,
            stakeAuthority: null,
          },
        ],
      }),
    );

    proposals.seed(buildProposal({ id: 'p1', organizationId: ORG }));
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { inaction } = await service.buildCase(ORG, 'p1');

    expect(inaction.stakeBefore).toEqual({ amount: '0', asset: TEST_ASSET, decimals: 6 });
  });
});

describe('SlashCaseService.buildCase — the clocks of an EVM case', () => {
  const EVM_ASSET = 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3';
  const DOOR = new Date('2099-01-01T00:00:00Z');

  it('has one deadline, the record’s executableAt', async () => {
    const { service, proposals, strikes, windows, bindings } = build();
    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        assetId: EVM_ASSET,
        chainStatus: 'PENDING',
        chainExecutableAt: DOOR,
      }),
    );
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    expect(clocks).toMatchObject({
      chainState: 'PENDING',
      disputeBy: DOOR,
      runningClock: 'PROVIDER',
    });
  });

  it('shows a disputed record as DISPUTED, with nothing left to dispute', async () => {
    const { service, proposals, strikes, windows, bindings } = build();
    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        status: 'DISPUTED',
        assetId: EVM_ASSET,
        chainStatus: 'DISPUTED',
        chainExecutableAt: DOOR,
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
      }),
    );
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    expect(clocks).toMatchObject({ chainState: 'DISPUTED', disputeBy: null, runningClock: 'NONE' });
  });

  it('N-4: reads a partly disputed case per record, with its undisputed part still disputable', async () => {
    const { service, proposals, strikes, windows, bindings } = build([
      // The arbiter cancelled the disputed part; the other part stands.
      {
        chainStatus: 'CANCELLED',
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
        chainExecutableAt: DOOR,
        cancelReason: 'WITHDRAWN',
      },
      {
        chainStatus: 'PENDING',
        chainDisputedAt: null,
        chainExecutableAt: DOOR,
        cancelReason: null,
      },
    ]);
    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        status: 'DISPUTED',
        assetId: EVM_ASSET,
        chainStatus: 'PENDING',
        chainExecutableAt: DOOR,
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
      }),
    );
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    // Not "UPHELD" (the case mirror's dispute date), and not past disputing.
    expect(clocks).toMatchObject({
      chainState: 'PENDING',
      disputeBy: DOOR,
      runningClock: 'PROVIDER',
    });
  });

  it('R2-3: shows a mixed case as executed in part, with the records cancelled for the provider', async () => {
    const { service, proposals, strikes, windows, bindings } = build([
      {
        chainStatus: 'EXECUTED',
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
        chainExecutableAt: DOOR,
        cancelReason: null,
      },
      {
        chainStatus: 'CANCELLED',
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
        chainExecutableAt: DOOR,
        cancelReason: 'WITHDRAWN',
      },
    ]);
    proposals.seed(
      buildProposal({
        id: 'p1',
        organizationId: ORG,
        status: 'EXECUTED',
        assetId: EVM_ASSET,
        chainStatus: 'EXECUTED',
        chainExecutableAt: DOOR,
        chainDisputedAt: new Date('2026-08-11T00:00:00Z'),
      }),
    );
    strikes.seed(buildStrike({ id: 'strike_1', organizationId: ORG }));
    windows.seed(buildWindow({ id: 'window_1', organizationId: ORG }));
    bindings.seed(buildBinding({ id: TEST_BINDING_ID, organizationId: ORG }));

    const { clocks } = (await service.buildCase(ORG, 'p1')).proposal;

    expect(clocks).toMatchObject({
      chainState: 'PARTIALLY_EXECUTED',
      chainRecords: 2,
      cancelledRecords: 1,
    });
  });
});
