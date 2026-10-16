import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import {
  ProviderChainStakeKey,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { loadMinimumStakeByChain } from '@modules/provider/services/provider-stake.service';
import { IneligibilityReason } from '@modules/tool/domain/routing';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

/**
 * **Which stake FLOOR the publish gate compares a binding against.**
 *
 * The publish gate used to be handed one `MinimumStakeParameters` — the floor
 * of the FIRST chain in `ENABLED_CHAINS` — and to compare every binding's price
 * against it. On a deployment that lists `eip155:46630` first, every
 * Solana-priced binding then failed `STAKE_ASSET_MISMATCH` ("binding priced in
 * solana…, stake floor in eip155:46630…") however much it had staked on
 * Solana, while the router — which resolves the floor per settlement chain —
 * served the very same binding. The two gates are meant to give one answer.
 *
 * Both chain orders are run, because a gate that read "the first chain's
 * floor" passes exactly one of them for each binding.
 */
describe('BindingPublishService — the stake floor is the binding’s own chain’s', () => {
  const ORG = 'org-1';
  const BINDING = 'binding-1';

  const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
  const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
  const SOLANA_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
  const EVM_ASSET: AssetId = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

  const config = { get: () => undefined } as unknown as ConfigService;

  const account = (chainId: ChainId): AccountId =>
    (chainId.startsWith('eip155')
      ? `${chainId}:0x00000000000000000000000000000000000000aa`
      : `${chainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`) as AccountId;

  function build(input: {
    assetId: AssetId;
    chainId: ChainId;
    enabled: readonly ChainId[];
    stakedWhole: string;
    /** Row fields to override — a live binding carrying an unpublished draft. */
    row?: Partial<ToolBindingEntity>;
  }) {
    const row = {
      id: BINDING,
      organizationId: ORG,
      toolId: 'geocode_place',
      endpoint: 'https://provider.example.com/api',
      requestMapping: { method: 'GET', path: '/s', query: {} },
      responseMapping: { lat: { $path: '$.lat' } },
      pricingMode: PricingMode.PAID,
      // $0.01 — 1000× is $10, under the $50 floor, so the floor is what binds.
      priceAmount: '10000',
      assetId: input.assetId,
      settlementChains: [input.chainId],
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      maxRps: null,
      maxDailyCalls: null,
      slaFailureRate: '0.02',
      timeoutMs: 5_000,
      status: BindingStatus.DRAFT,
      mappingVersion: 1,
      publishedVersion: null,
      ...input.row,
    } as unknown as ToolBindingEntity;

    const stakes = {
      stakeOn: jest.fn().mockImplementation((keys: readonly ProviderChainStakeKey[]) =>
        Promise.resolve(
          new Map(
            keys.map((key) => [
              stakeKey(key.providerId, key.chainId),
              {
                providerId: key.providerId,
                chainId: key.chainId,
                // Staked in the chain's own settlement asset, as on-chain.
                staked: MoneyUtil.of(
                  `${input.stakedWhole}000000`,
                  key.chainId === SOLANA ? SOLANA_ASSET : EVM_ASSET,
                  6,
                ),
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
              payoutAccountByChain: new Map([[input.chainId, account(input.chainId)]]),
              payoutEnrolmentChains: new Set([input.chainId]),
            },
          ],
        ]),
      ),
    } as unknown as ProviderRegistryPort;

    return new BindingPublishService(
      { loadEditable: jest.fn().mockResolvedValue(row) } as unknown as BindingEditorService,
      {
        findLatestForRevision: jest.fn().mockResolvedValue({
          mappingVersion: row.mappingVersion,
          outcome: 'PASSED',
          failedLayer: null,
          createdAt: new Date(),
        }),
      } as unknown as BindingTestRunRepository,
      stakes,
      registry,
      // The real wiring: the same derivation `ROUTER_CONFIG` uses.
      loadMinimumStakeByChain(config, input.enabled),
      {} as unknown as DataSource,
    );
  }

  const ORDERS: Array<[string, readonly ChainId[]]> = [
    ['EVM listed first', [EVM, SOLANA]],
    ['Solana listed first', [SOLANA, EVM]],
  ];

  describe.each(ORDERS)('ENABLED_CHAINS with %s', (_label, enabled) => {
    it.each([
      ['a Solana binding staked on Solana', SOLANA_ASSET, SOLANA],
      ['an EVM binding staked on EVM', EVM_ASSET, EVM],
    ])('publishes %s', async (_name, assetId, chainId) => {
      const check = await build({ assetId, chainId, enabled, stakedWhole: '500' }).check(
        ORG,
        BINDING,
      );

      const stake = check.requirements.find(
        (r) => r.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
      );
      expect(stake?.met).toBe(true);
      expect(check.publishable).toBe(true);
    });

    it.each([
      ['a Solana binding', SOLANA_ASSET, SOLANA],
      ['an EVM binding', EVM_ASSET, EVM],
    ])('refuses %s staked under its own chain’s floor', async (_name, assetId, chainId) => {
      const check = await build({ assetId, chainId, enabled, stakedWhole: '10' }).check(
        ORG,
        BINDING,
      );

      const stake = check.requirements.find(
        (r) => r.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
      );
      expect(stake?.met).toBe(false);
      // Below the floor, not "wrong asset": the comparison happened, in the
      // binding's own chain's asset.
      expect(stake?.code).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);
      expect(check.publishable).toBe(false);
    });
  });

  /**
   * The publish gate reads the row's DRAFT terms on purpose: publishing is the
   * moment they become served, so the stake they need must be there first. The
   * stake monitor reads the published revision instead (see
   * `stake-monitor-published-terms.spec.ts`); this pins the other half.
   */
  it('checks a re-publish against the NEW draft price, not the published one', async () => {
    const check = await build({
      assetId: SOLANA_ASSET,
      chainId: SOLANA,
      enabled: [SOLANA],
      // $60 covers the published $0.01 (floor $50) but not the draft $0.10
      // (1000× = $100).
      stakedWhole: '60',
      row: {
        status: BindingStatus.ACTIVE,
        priceAmount: '100000',
        mappingVersion: 2,
        publishedVersion: 1,
      },
    }).check(ORG, BINDING);

    const stake = check.requirements.find(
      (r) => r.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    );
    expect(stake?.met).toBe(false);
    expect(stake?.code).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);
    expect(check.publishable).toBe(false);
  });
});
