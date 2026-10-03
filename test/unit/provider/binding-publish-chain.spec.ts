import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  AssetId,
  CHAIN_IDS,
  ChainId,
  chainIdOf,
} from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  ProviderChainStakeKey,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import {
  ProviderRoutingState,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { IneligibilityReason, MinimumStakeParameters } from '@modules/tool/domain/routing';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

/**
 * **Which chains the PUBLISH gate asks `evaluatePayoutGate` about**.
 *
 * ## Why this file exists
 *
 * `evaluatePayoutGate` has two callers — `filterEligible` on every routing
 * decision, and `BindingPublishService.evaluate` before a binding may go live.
 * `payout-gate.spec.ts`'s mirrored pair pins the chain derivation for the
 * first. Nothing pinned it for the second: `publish-gate.spec.ts` feeds
 * `evaluatePublishGate` a ready-made `PayoutGateVerdict` and never touches a
 * chain, and `BindingPublishService` had no unit spec at all. **Hardcoding
 * `SOLANA_DEVNET` at `binding-publish.service.ts` passed the entire unit tree**
 * — measured, and the only test anywhere that saw it lives in the integration
 * suite.
 *
 * ## What a wrong chain here costs
 *
 * A provider proved only on chain A publishes a `PAID` binding priced on chain
 * B. The publish checklist goes green; the binding goes live; `filterEligible`
 * then refuses it on every single call, because the routing gate asks about B.
 * The provider has a live binding that never takes traffic and a console that
 * says every requirement is met — which is precisely the failure
 * `publish-gate.ts`'s own header describes and the reason the two gates share
 * one function.
 *
 * ## Two mirrored cases, because one alone proves nothing
 *
 * A gate that hardcodes *any* chain passes one of the pair and fails the other,
 * whichever chain it hardcodes. Neither case alone has that property.
 *
 * ## The source of the chain moved, and the last case is what proves it
 *
 * Originally the chain was derived from the binding's price
 * (`chainIdOf(assetId)`). It is now `tool_bindings.settlement_chains`, the
 * provider's own declaration, and the two are the same value on every row the
 * migration backfilled — so every case above stays green against a service that
 * never stopped reading `assetId`. The case at the end hands the gate a binding
 * whose two disagree, which is the only input that tells them apart.
 */
describe('BindingPublishService — the chain the payout gate is asked about', () => {
  const ORG = 'org-1';
  const BINDING = 'binding-1';

  const DEVNET_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
  const MAINNET_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_MAINNET;

  const DEVNET = chainIdOf(DEVNET_ASSET);
  const MAINNET = chainIdOf(MAINNET_ASSET);

  const account = (chainId: ChainId): AccountId =>
    `${chainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;

  const usdc = (whole: string, asset: AssetId): Money => MoneyUtil.of(`${whole}000000`, asset, 6);

  /**
   * Priced far above the floor and denominated in the binding's own asset, so
   * the stake gate is satisfied in both cases and the only requirement that can
   * move is the payout one. A fixture that failed two gates would prove
   * neither.
   */
  const stakeParameters = (asset: AssetId): MinimumStakeParameters =>
    Object.freeze({ floor: usdc('50', asset), priceMultiple: 1000 });

  function bindingRow(assetId: AssetId, settlementChains?: readonly ChainId[]): ToolBindingEntity {
    return {
      settlementChains: settlementChains ?? [chainIdOf(assetId)],
      id: BINDING,
      organizationId: ORG,
      toolId: 'search_web',
      endpoint: 'https://provider.example.com/api',
      requestMapping: { method: 'POST', path: '/s', body: {} },
      responseMapping: { answer: { $path: '$.a' } },
      pricingMode: PricingMode.PAID,
      priceAmount: '50000',
      assetId,
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      maxRps: null,
      maxDailyCalls: null,
      slaFailureRate: '0.02',
      timeoutMs: 5_000,
      status: BindingStatus.DRAFT,
      mappingVersion: 1,
      publishedVersion: null,
    } as unknown as ToolBindingEntity;
  }

  function providerState(enrolledOn: ChainId): ProviderRoutingState {
    return {
      providerId: ORG,
      status: ProviderStatus.ACTIVE,
      tier: ProviderTier.ESTABLISHED,
      stats: {},
      payoutAccountByChain: new Map([[enrolledOn, account(enrolledOn)]]),
      payoutEnrolmentChains: new Set([enrolledOn]),
    };
  }

  function build(input: {
    assetId: AssetId;
    enrolledOn: ChainId;
    settlementChains?: readonly ChainId[];
  }) {
    const row = bindingRow(input.assetId, input.settlementChains);

    const editor = {
      loadEditable: jest.fn().mockResolvedValue(row),
    } as unknown as BindingEditorService;

    const runs = {
      // A green run for this revision, so `TESTER_RUN`/`TESTER_PASSED` are met
      // and cannot be what fails.
      findLatestForRevision: jest.fn().mockResolvedValue({
        mappingVersion: 1,
        outcome: 'PASSED',
        failedLayer: null,
        createdAt: new Date(),
      }),
    } as unknown as BindingTestRunRepository;

    // Answers whatever chain it is asked about, so the stake gate is never
    // what refuses here — the subject is which chain the PAYOUT gate is asked
    // about. Echoing the key back is deliberate: a `stakeOn` that ignored its
    // keys would look identical from here, and killing that degenerate is
    // `onchain-provider-stake.source.spec.ts`'s job, not this file's.
    const stakes = {
      stakeOn: jest.fn().mockImplementation((keys: readonly ProviderChainStakeKey[]) =>
        Promise.resolve(
          new Map(
            keys.map((key) => [
              stakeKey(key.providerId, key.chainId),
              {
                providerId: key.providerId,
                chainId: key.chainId,
                staked: usdc('1000', input.assetId),
                observedAt: new Date(0),
              },
            ]),
          ),
        ),
      ),
    } as unknown as ProviderStakePort;

    const registry = {
      findRoutingStates: jest
        .fn()
        .mockResolvedValue(new Map([[ORG, providerState(input.enrolledOn)]])),
    } as unknown as ProviderRegistryPort;

    const service = new BindingPublishService(
      editor,
      runs,
      stakes,
      registry,
      stakeParameters(input.assetId),
      {} as unknown as DataSource,
    );

    return { service };
  }

  async function payoutRequirement(input: {
    assetId: AssetId;
    enrolledOn: ChainId;
    settlementChains?: readonly ChainId[];
  }) {
    const { service } = build(input);
    const check = await service.check(ORG, BINDING);
    return {
      check,
      payout: check.requirements.find((r) => r.requirement === PublishRequirement.PAYOUT_ACCOUNT),
    };
  }

  it('asks about MAINNET for a mainnet-priced binding — a devnet-only provider cannot publish', async () => {
    const { check, payout } = await payoutRequirement({
      assetId: MAINNET_ASSET,
      enrolledOn: DEVNET,
    });

    expect(payout?.met).toBe(false);
    expect(payout?.code).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    // Names the chain that was actually asked about, so a hardcode is visible
    // in the message and not only in the verdict.
    expect(payout?.detail).toContain(MAINNET);
    expect(check.publishable).toBe(false);
    // And it is the ONLY unmet requirement — the stake is fine and the tester
    // is green, so this fixture violates exactly one thing.
    expect(check.requirements.filter((r) => !r.met).map((r) => r.requirement)).toEqual([
      PublishRequirement.PAYOUT_ACCOUNT,
    ]);
  });

  it('asks about DEVNET for a devnet-priced binding — a mainnet-only provider cannot publish', async () => {
    const { check, payout } = await payoutRequirement({
      assetId: DEVNET_ASSET,
      enrolledOn: MAINNET,
    });

    expect(payout?.met).toBe(false);
    expect(payout?.detail).toContain(DEVNET);
    expect(check.publishable).toBe(false);
  });

  it.each([
    ['mainnet', MAINNET_ASSET, MAINNET],
    ['devnet', DEVNET_ASSET, DEVNET],
  ])(
    'publishes a %s-priced binding when the provider is enrolled on that same chain',
    async (_label, assetId, chainId) => {
      const { check, payout } = await payoutRequirement({ assetId, enrolledOn: chainId });

      expect(payout?.met).toBe(true);
      expect(check.publishable).toBe(true);
    },
  );

  it('reports PAYOUT_ENROLMENT_NOT_ACTIVE when the enrolment on that chain is closed', async () => {
    // Same shape as a `SUSPENDED` row seen from routing: the chain is enrolled,
    // the address is not in the routable map. The console must not tell this
    // provider to prove an address they have already proved.
    const row = bindingRow(MAINNET_ASSET);
    const editor = {
      loadEditable: jest.fn().mockResolvedValue(row),
    } as unknown as BindingEditorService;
    const runs = {
      findLatestForRevision: jest.fn().mockResolvedValue({
        mappingVersion: 1,
        outcome: 'PASSED',
        failedLayer: null,
        createdAt: new Date(),
      }),
    } as unknown as BindingTestRunRepository;
    const stakes = {
      stakeOn: jest.fn().mockImplementation((keys: readonly ProviderChainStakeKey[]) =>
        Promise.resolve(
          new Map(
            keys.map((key) => [
              stakeKey(key.providerId, key.chainId),
              {
                providerId: key.providerId,
                chainId: key.chainId,
                staked: usdc('1000', MAINNET_ASSET),
                observedAt: new Date(0),
              },
            ]),
          ),
        ),
      ),
    } as unknown as ProviderStakePort;
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
              payoutAccountByChain: new Map(),
              payoutEnrolmentChains: new Set([MAINNET]),
            } as ProviderRoutingState,
          ],
        ]),
      ),
    } as unknown as ProviderRegistryPort;

    const service = new BindingPublishService(
      editor,
      runs,
      stakes,
      registry,
      stakeParameters(MAINNET_ASSET),
      {} as unknown as DataSource,
    );

    const check = await service.check(ORG, BINDING);
    const payout = check.requirements.find(
      (r) => r.requirement === PublishRequirement.PAYOUT_ACCOUNT,
    );

    expect(payout?.met).toBe(false);
    expect(payout?.code).toBe(IneligibilityReason.PAYOUT_ENROLMENT_NOT_ACTIVE);
  });

  it('a provider the registry has never heard of fails closed, on the binding’s chain', async () => {
    // The synthesised state inside `candidate()` is permissive for status and
    // tier and must stay fail-closed for the payee — and its refusal must still
    // name the chain the binding settles on, not a default.
    const row = bindingRow(MAINNET_ASSET);
    const service = new BindingPublishService(
      { loadEditable: jest.fn().mockResolvedValue(row) } as unknown as BindingEditorService,
      {
        findLatestForRevision: jest.fn().mockResolvedValue({
          mappingVersion: 1,
          outcome: 'PASSED',
          failedLayer: null,
          createdAt: new Date(),
        }),
      } as unknown as BindingTestRunRepository,
      {
        stakeOn: jest.fn().mockImplementation((keys: readonly ProviderChainStakeKey[]) =>
          Promise.resolve(
            new Map(
              keys.map((key) => [
                stakeKey(key.providerId, key.chainId),
                {
                  providerId: key.providerId,
                  chainId: key.chainId,
                  staked: usdc('1000', MAINNET_ASSET),
                  observedAt: new Date(0),
                },
              ]),
            ),
          ),
        ),
      } as unknown as ProviderStakePort,
      {
        findRoutingStates: jest.fn().mockResolvedValue(new Map()),
      } as unknown as ProviderRegistryPort,
      stakeParameters(MAINNET_ASSET),
      {} as unknown as DataSource,
    );

    const check = await service.check(ORG, BINDING);
    const payout = check.requirements.find(
      (r) => r.requirement === PublishRequirement.PAYOUT_ACCOUNT,
    );

    expect(payout?.met).toBe(false);
    expect(payout?.code).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    expect(payout?.detail).toContain(MAINNET);
    expect(payout?.detail).not.toContain(CHAIN_IDS.SOLANA_DEVNET);
  });

  it('follows settlement_chains, not the asset the price is quoted in', async () => {
    // The binding is PRICED in devnet USDC and OFFERED on mainnet. The provider
    // is enrolled on devnet only.
    //
    // A gate still deriving `chainIdOf(assetId)` asks about devnet, finds the
    // enrolment, and publishes — a live binding offered on a chain its provider
    // has never proved an address on. The gate that reads the column asks about
    // mainnet and refuses. Every other case in this file passes either way,
    // because the migration backfilled the column FROM the asset.
    const { check, payout } = await payoutRequirement({
      assetId: DEVNET_ASSET,
      enrolledOn: DEVNET,
      settlementChains: [MAINNET],
    });

    expect(payout?.met).toBe(false);
    expect(payout?.detail).toContain(MAINNET);
    expect(check.publishable).toBe(false);
  });

  it('reports one entry per FAILING chain, naming each', async () => {
    // A two-chain binding whose provider is enrolled on neither. One entry that
    // said "PAYOUT_ACCOUNT: not met" would leave the provider with two chains
    // and no way to know which — or that it was both.
    const { check } = await payoutRequirement({
      assetId: DEVNET_ASSET,
      enrolledOn: DEVNET,
      settlementChains: [MAINNET, 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' as ChainId],
    });

    const payouts = check.requirements.filter(
      (r) => r.requirement === PublishRequirement.PAYOUT_ACCOUNT,
    );

    expect(payouts).toHaveLength(2);
    expect(payouts.every((r) => !r.met)).toBe(true);
    expect(payouts[0].detail).toContain(MAINNET);
    expect(payouts[1].detail).toContain('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z');
  });
});
