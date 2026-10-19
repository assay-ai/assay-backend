import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalEventEntity } from '@database/postgres/entities/slash-proposal-event.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { chainIdOf } from '@modules/chains/ports/caip.types';
import { GetProviderStakeResponseDto } from '@modules/provider/dto/get-provider-stake.dto';
import { StrikeComputationStep } from '@modules/provider/domain/sla/sla-window';
import { Tool } from '@modules/tool/ports/tool.types';

/** A real CAIP-19 id — `MoneyUtil.of` rejects anything else, unlike the entity column. */
export const TEST_ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

/**
 * A second real chain's asset, so a per-chain fixture has TWO entries with
 * DIFFERENT amounts. One entry cannot tell "the entry for this asset" apart
 * from "the first entry" or "the only entry".
 */
export const OTHER_CHAIN_ASSET = ASSET_IDS.USDC_SOLANA_MAINNET;

/** A proper hex uuid — `renderBindingLabel` uppercases the id verbatim, so a
 * fixture with embedded non-hex letters would render a misleading label. */
export const TEST_BINDING_ID = 'c3a1f2b4-5678-4abc-9def-000000000001';

/**
 * Hand-written fakes for `SlashCaseService`, matching
 * `test/unit/slash/helpers/fake-slash-repositories.ts` and
 * `test/unit/provider/helpers/`: no `jest.mock` of a repository, entities
 * built with real row shapes, and `createQueryBuilder` faked with
 * `../../provider/helpers/fake-query-builder`'s recording builder rather than
 * a database.
 *
 * A distinct filename from `fake-slash-repositories.ts` per the task's own
 * instruction — other agents' suites read that file, and this one is only for
 * `slash-case.service.spec.ts`.
 */

export function buildProposal(
  overrides: Partial<SlashProposalEntity> & { id: string; organizationId: string },
): SlashProposalEntity {
  return Object.assign(
    new SlashProposalEntity(),
    {
      providerId: 'org_1',
      bindingId: TEST_BINDING_ID,
      toolId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'SLA_STRIKE',
      strikeId: 'strike_1',
      windowId: 'window_1',
      status: 'PROPOSED',
      chainRequestId: 'a'.repeat(64),
      penaltyAmount: '5136000',
      appliedAmount: null,
      assetId: TEST_ASSET,
      decimals: 6,
      beneficiaryAccount: null,
      proposedAt: new Date('2026-08-10T09:14:00Z'),
      notifiedAt: new Date('2026-08-10T09:14:00Z'),
      acknowledgedAt: null,
      earliestExecutionAt: new Date('2026-08-13T09:14:00Z'),
      disputedAt: null,
      disputeId: null,
      resolutionKind: null,
      outcome: null,
      resolvedAt: null,
      decidedByOperatorId: null,
      executedAt: null,
      executionSignature: null,
      reversedAt: null,
      reversalSignature: null,
      rootCauseKey: null,
      countsAsFalsePositive: false,
      createdAt: new Date('2026-08-10T09:14:00Z'),
      updatedAt: new Date('2026-08-10T09:14:00Z'),
      version: 1,
    },
    overrides,
  );
}

export function buildStrike(
  overrides: Partial<SlaStrikeEntity> & { id: string; organizationId: string },
): SlaStrikeEntity {
  return Object.assign(
    new SlaStrikeEntity(),
    {
      providerId: 'org_1',
      bindingId: TEST_BINDING_ID,
      toolId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      windowId: 'window_1',
      status: 'RECORDED',
      recordedAt: new Date('2026-08-10T09:00:00Z'),
      windowOpenedAt: new Date('2026-08-03T09:00:00Z'),
      windowClosedAt: new Date('2026-08-10T09:00:00Z'),
      totalCalls: 720,
      verifiedCalls: 612,
      failedCalls: 92,
      observedRate: 92 / 612,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      tolerance: 0.0227,
      effectiveThreshold: 0.0727,
      excessRate: 0.1003,
      estimatedBadCalls: 72.2,
      averagePriceAmount: '1000',
      penaltyMultiplier: 2,
      penaltyAmount: '5136000',
      assetId: TEST_ASSET,
      computation: FULL_COMPUTATION,
      createdAt: new Date('2026-08-10T09:00:00Z'),
      updatedAt: new Date('2026-08-10T09:00:00Z'),
      version: 1,
    },
    overrides,
  );
}

/** Every step `strikeArithmeticFor` writes, exactly as it labels them. */
export const FULL_COMPUTATION: readonly StrikeComputationStep[] = Object.freeze([
  { label: 'observed_rate', expression: '92 failed / 612 verified', value: '15.03%' },
  { label: 'tolerance', expression: '2.58 × sqrt(0.05 × 0.95 / 612)', value: '2.27%' },
  { label: 'effective_threshold', expression: '5.00% declared + 2.27% tolerance', value: '7.27%' },
  { label: 'sample_gate', expression: '612 verified >= 400 required', value: 'true' },
  { label: 'excess_rate', expression: '15.03% observed − 5.00% declared', value: '10.03%' },
  { label: 'estimated_bad_calls', expression: '10.03% × 720 window calls', value: '72.2000' },
  { label: 'average_price', expression: '720000 minor units / 720 calls', value: '1000' },
  {
    label: 'penalty',
    expression: '720000 × 10.03% × 2 (= estimated_bad × average_price × multiplier)',
    value: '5136000',
  },
]);

export function buildWindow(
  overrides: Partial<SlaWindowEntity> & { id: string; organizationId: string },
): SlaWindowEntity {
  return Object.assign(
    new SlaWindowEntity(),
    {
      providerId: 'org_1',
      bindingId: TEST_BINDING_ID,
      toolId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: 4471,
      status: 'CLOSED',
      outcome: 'BREACH_PROPOSED',
      openedAt: new Date('2026-08-03T09:00:00Z'),
      deadlineAt: new Date('2026-08-10T09:00:00Z'),
      closedAt: new Date('2026-08-10T09:00:00Z'),
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 720,
      verifiedCalls: 612,
      failedCalls: 92,
      totalCallAmount: '720000',
      assetId: TEST_ASSET,
      warningLevel: null,
      warnedAt: null,
      criticalWarnedAt: null,
      samplingEscalationRequested: false,
      createdAt: new Date('2026-08-03T09:00:00Z'),
      updatedAt: new Date('2026-08-10T09:00:00Z'),
      version: 1,
    },
    overrides,
  );
}

export function buildCall(
  overrides: Partial<SlaWindowCallEntity> & { id: string; organizationId: string },
): SlaWindowCallEntity {
  return Object.assign(
    new SlaWindowCallEntity(),
    {
      windowId: 'window_1',
      intentId: `intent-${overrides.id}`,
      agentId: 'agent_1',
      verdict: 'PASS',
      reasonCode: null,
      countedAsQuality: true,
      countedAsFailure: false,
      priceAmount: '1000',
      assetId: TEST_ASSET,
      postedAt: new Date('2026-08-05T00:00:00Z'),
      createdAt: new Date('2026-08-05T00:00:00Z'),
      updatedAt: new Date('2026-08-05T00:00:00Z'),
      version: 1,
    },
    overrides,
  );
}

export function buildBindingVersion(
  overrides: Partial<BindingVersionEntity> & { id: string; organizationId: string },
): BindingVersionEntity {
  return Object.assign(
    new BindingVersionEntity(),
    {
      bindingId: TEST_BINDING_ID,
      mappingVersion: 3,
      toolId: 'search_web',
      endpoint: 'https://provider.example/search',
      requestMapping: {},
      responseMapping: {},
      pricingMode: 'PAID',
      priceAmount: '1000',
      assetId: TEST_ASSET,
      timeoutMs: 5000,
      authoredBy: 'user_1',
      publishedAt: new Date('2026-08-06T00:00:00Z'),
      publishedBy: 'user_1',
      createdAt: new Date('2026-08-06T00:00:00Z'),
      updatedAt: new Date('2026-08-06T00:00:00Z'),
      version: 1,
    },
    overrides,
  );
}

export function buildBinding(
  overrides: Partial<ToolBindingEntity> & { id: string; organizationId: string },
): ToolBindingEntity {
  return Object.assign(
    new ToolBindingEntity(),
    {
      toolId: 'search_web',
      endpoint: 'https://provider.example/search',
      requestMapping: {},
      responseMapping: {},
      pricingMode: 'PAID',
      priceAmount: '1000',
      assetId: TEST_ASSET,
      maxRps: null,
      maxDailyCalls: null,
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      slaFailureRate: '0.05000',
      timeoutMs: 5000,
      status: 'ACTIVE',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      version: 1,
    },
    overrides,
  );
}

export function buildTool(overrides: Partial<Tool> & { id: string }): Tool {
  return {
    name: overrides.id,
    description: '',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    verificationPolicyId: 'policy_1',
    tier: 'VERIFIED' as Tool['tier'],
    ...overrides,
  };
}

/** `SlashProposalEventEntity` rows, for `FakeSlashProposalEvents`. */
export function buildEvent(
  overrides: Partial<SlashProposalEventEntity> & { id: string; organizationId: string },
): SlashProposalEventEntity {
  return Object.assign(
    new SlashProposalEventEntity(),
    {
      proposalId: 'proposal_1',
      occurredAt: new Date('2026-08-10T09:14:00Z'),
      kind: 'PROPOSED',
      actorType: 'system',
      actorId: null,
      summary: 'Slash proposed',
      detail: {},
      createdAt: new Date('2026-08-10T09:14:00Z'),
      updatedAt: new Date('2026-08-10T09:14:00Z'),
      version: 1,
    },
    overrides,
  );
}

/** `SlashProposalEventRepository`, faked — `append` for `SlashProposalService`, `findForProposal` for `SlashCaseService.timeline`. */
export class FakeSlashProposalEvents {
  readonly rows: SlashProposalEventEntity[] = [];

  async append(entry: Partial<SlashProposalEventEntity>): Promise<void> {
    this.rows.push(entry as SlashProposalEventEntity);
  }

  async findForProposal(
    organizationId: string,
    proposalId: string,
  ): Promise<SlashProposalEventEntity[]> {
    return this.rows.filter(
      (row) => row.organizationId === organizationId && row.proposalId === proposalId,
    );
  }
}

/**
 * A minimal, fully-typed `GetProviderStakeResponseDto`, so `buildInaction`
 * never sees `undefined`.
 *
 * **Two chains, with different amounts, and only one of them in `TEST_ASSET`.**
 * `buildInaction` picks the entry denominated in the proposal's own asset,
 * because that is the collateral the settlement contract of that chain can
 * actually confiscate. One entry could not tell that apart from "the first
 * entry" or "the only entry", and the second chain's $250 is deliberately the
 * larger of the two so that a forecast reading the wrong row would over-state
 * the stake rather than fail quietly at zero.
 */
export function buildStakeResponse(
  overrides: Partial<GetProviderStakeResponseDto> = {},
): GetProviderStakeResponseDto {
  return {
    stake: [
      // The OTHER chain FIRST, deliberately: a forecast reading `stake[0]`
      // rather than the proposal's own asset would take $250 here, and the
      // slash it forecasts could not happen — that collateral is unreachable to
      // the settlement contract of the chain the call was paid on.
      {
        chainId: chainIdOf(OTHER_CHAIN_ASSET),
        hasKnownStake: true,
        staked: { amount: '250000000', asset: OTHER_CHAIN_ASSET, decimals: 6 },
        observedAt: '2026-08-10T00:00:00Z',
        unbonding: null,
        unbondingStartedAt: null,
        unbondingCompletesAt: null,
        chainReadable: true,
        stakeAuthority: null,
      },
      {
        chainId: chainIdOf(TEST_ASSET),
        hasKnownStake: true,
        staked: { amount: '100000000', asset: TEST_ASSET, decimals: 6 },
        observedAt: '2026-08-10T00:00:00Z',
        unbonding: null,
        unbondingStartedAt: null,
        unbondingCompletesAt: null,
        chainReadable: true,
        stakeAuthority: null,
      },
    ],
    requirement: [],
    requirementRule: 'max',
    requirementTotal: null,
    negotiatedMinimum: null,
    graceSummary: null,
    headroom: null,
    shortfall: null,
    recommendedBuffer: null,
    ...overrides,
  };
}
