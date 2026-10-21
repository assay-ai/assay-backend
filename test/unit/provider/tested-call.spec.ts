import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { evaluatePublishGate, PublishRequirement } from '@modules/provider/domain/publish-gate';
import { revisionsWithSameCall, testedCallKey } from '@modules/provider/domain/tested-call';
import { BindingTestOutcome } from '@modules/provider/ports/binding-test.types';
import { ProviderChainStakeKey, stakeKey } from '@modules/provider/ports/provider-stake.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { loadMinimumStakeByChain } from '@modules/provider/services/provider-stake.service';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

/**
 * BUG-PRV-CATALOG-02: a price-only change at Go live keeps the passing test;
 * anything that changes the call still asks for a new one.
 */
const CALL = {
  endpoint: 'https://provider.example.com/api',
  requestMapping: { method: 'GET', path: '/s', query: { q: { $path: '$.query' } } },
  responseMapping: { lat: { $path: '$.lat' } },
  timeoutMs: 5_000,
  toolVersionRange: '^1',
  providesOutputFields: ['b', 'a'],
  supportsInputFields: [],
};
const OFFER = {
  pricingMode: PricingMode.FREE,
  priceAmount: '0',
  assetId: ASSET_IDS.USDC_SOLANA_DEVNET as string,
  settlementChains: [CHAIN_IDS.SOLANA_DEVNET],
};

describe('testedCallKey / revisionsWithSameCall', () => {
  const snapshot = (mappingVersion: number, change: Record<string, unknown> = {}) => ({
    mappingVersion,
    ...CALL,
    ...OFFER,
    ...change,
  });

  it('ignores the price, pricing mode, asset and chains', () => {
    const paid = snapshot(2, {
      pricingMode: PricingMode.PAID,
      priceAmount: '260000',
      assetId: 'other',
      settlementChains: ['eip155:1'],
    });
    expect(testedCallKey(paid)).toBe(testedCallKey(snapshot(1)));
    expect(revisionsWithSameCall(paid, [paid, snapshot(1)])).toEqual([2, 1]);
  });

  it('does not depend on mapping key order or field-list order', () => {
    const reordered = snapshot(2, {
      requestMapping: { query: { q: { $path: '$.query' } }, path: '/s', method: 'GET' },
      providesOutputFields: ['a', 'b'],
    });
    expect(revisionsWithSameCall(reordered, [snapshot(1)])).toEqual([2, 1]);
  });

  it.each([
    ['the endpoint', { endpoint: 'https://provider.example.com/v2' }],
    ['the request mapping', { requestMapping: { method: 'POST', path: '/s' } }],
    ['the response mapping', { responseMapping: { lat: { $path: '$.latitude' } } }],
    ['the timeout', { timeoutMs: 9_000 }],
    ['the contract range', { toolVersionRange: '^2' }],
    ['the promised output fields', { providesOutputFields: ['a'] }],
    ['the supported input fields', { supportsInputFields: ['units'] }],
  ])('treats a change of %s as a different call', (_name, change) => {
    const current = snapshot(2, change);
    expect(revisionsWithSameCall(current, [snapshot(1)])).toEqual([2]);
  });

  it('counts an earlier revision with the same call after a change and its undo (A→B→A)', () => {
    const b = snapshot(2, { endpoint: 'https://provider.example.com/v2' });
    const current = snapshot(3, { priceAmount: '5' });
    expect(revisionsWithSameCall(current, [current, b, snapshot(1)])).toEqual([3, 1]);
  });

  it('never counts a later revision', () => {
    expect(revisionsWithSameCall(snapshot(1), [snapshot(2)])).toEqual([1]);
  });
});

describe('evaluatePublishGate with same-call revisions', () => {
  const run = (mappingVersion: number, outcome = BindingTestOutcome.PASSED) => ({
    mappingVersion,
    outcome,
    failedLayer: null,
    ranAt: new Date(0),
  });
  const tester = (check: ReturnType<typeof evaluatePublishGate>) =>
    check.requirements
      .filter(
        (r) =>
          r.requirement === PublishRequirement.TESTER_RUN ||
          r.requirement === PublishRequirement.TESTER_PASSED,
      )
      .map((r) => [r.met, r.code]);
  const base = { payoutByChain: new Map(), stakeByChain: new Map() };

  it('accepts a passing run at a same-call revision', () => {
    const check = evaluatePublishGate({
      ...base,
      mappingVersion: 6,
      sameCallRevisions: [5],
      latestRun: run(5),
    });
    expect(tester(check)).toEqual([
      [true, null],
      [true, null],
    ]);
  });

  it('still refuses a run at a revision with another call (stale)', () => {
    const check = evaluatePublishGate({ ...base, mappingVersion: 6, latestRun: run(5) });
    expect(tester(check)).toEqual([
      [false, 'tester_run_is_stale'],
      [false, 'tester_never_run'],
    ]);
  });

  it('still refuses a failed run at a same-call revision', () => {
    const check = evaluatePublishGate({
      ...base,
      mappingVersion: 6,
      sameCallRevisions: [5],
      latestRun: run(5, BindingTestOutcome.FAILED),
    });
    expect(tester(check)[1]).toEqual([false, 'tester_failed']);
  });
});

describe('BindingPublishService.check — the price edit at Go live (BUG-PRV-CATALOG-02)', () => {
  const ORG = 'org-1';
  const BINDING = 'binding-1';
  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
  const config = { get: () => undefined } as unknown as ConfigService;

  /** Revision 5 was tested and passed; revision 6 is what the edit made. */
  function build(change: Partial<ToolBindingEntity>) {
    const tested = { mappingVersion: 5, ...CALL, ...OFFER };
    const row = {
      id: BINDING,
      organizationId: ORG,
      toolId: 'geocode_place',
      ...CALL,
      ...OFFER,
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      maxRps: null,
      maxDailyCalls: null,
      slaFailureRate: '0.02',
      status: BindingStatus.DRAFT,
      mappingVersion: 6,
      publishedVersion: null,
      ...change,
    } as unknown as ToolBindingEntity;

    const passed = {
      mappingVersion: 5,
      outcome: 'PASSED',
      failedLayer: null,
      createdAt: new Date(),
    };
    const runs = {
      // Answers only when revision 5 is among the revisions asked about.
      findLatestForRevision: jest.fn(
        async (_o: string, _b: string, revisions: number | readonly number[]) =>
          (typeof revisions === 'number' ? [revisions] : revisions).includes(5) ? passed : null,
      ),
    } as unknown as BindingTestRunRepository;
    const versions = {
      find: jest.fn(async () => [{ ...row }, tested]),
    };
    const stakes = {
      stakeOn: jest.fn((keys: readonly ProviderChainStakeKey[]) =>
        Promise.resolve(
          new Map(
            keys.map((key) => [
              stakeKey(key.providerId, key.chainId),
              {
                providerId: key.providerId,
                chainId: key.chainId,
                staked: MoneyUtil.of('500000000', ASSET, 6),
                observedAt: new Date(0),
              },
            ]),
          ),
        ),
      ),
    };
    const registry = {
      findRoutingStates: jest.fn().mockResolvedValue(
        new Map([
          [
            ORG,
            {
              providerId: ORG,
              status: ProviderStatus.ACTIVE,
              tier: ProviderTier.ESTABLISHED,
              stats: {},
              payoutAccountByChain: new Map([
                [SOLANA, `${SOLANA}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId],
              ]),
              payoutEnrolmentChains: new Set([SOLANA]),
            },
          ],
        ]),
      ),
    };
    const service = new BindingPublishService(
      { loadEditable: jest.fn().mockResolvedValue(row) } as unknown as BindingEditorService,
      runs,
      stakes as never,
      registry as never,
      loadMinimumStakeByChain(config, [SOLANA]),
      {} as unknown as DataSource,
      undefined,
      { list: async () => [], pruneExcept: async () => [] } as never,
      undefined,
      versions as never,
    );
    return { service, versions };
  }

  const testerMet = async (change: Partial<ToolBindingEntity>) => {
    const { service } = build(change);
    const check = await service.check(ORG, BINDING);
    return check.requirements
      .filter((r) => r.requirement === PublishRequirement.TESTER_PASSED)
      .every((r) => r.met);
  };

  it('keeps the passing test when only the price and pricing mode changed', async () => {
    expect(await testerMet({ pricingMode: PricingMode.PAID, priceAmount: '260000' })).toBe(true);
  });

  it.each([
    ['the endpoint', { endpoint: 'https://provider.example.com/v2' }],
    ['the response mapping', { responseMapping: { lat: { $path: '$.latitude' } } }],
    ['the timeout', { timeoutMs: 9_000 }],
  ])('asks for a new test when %s changed', async (_name, change) => {
    expect(await testerMet({ priceAmount: '260000', ...change } as never)).toBe(false);
  });
});
