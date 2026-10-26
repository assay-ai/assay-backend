import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, chainIdOf } from '@modules/chains/ports/caip.types';
import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  ProviderChainStakeKey,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { ProviderRegistryPort } from '@modules/provider/ports/provider-registry.port';
import { ProviderStatus, ProviderTier } from '@modules/provider/ports/provider.types';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

/**
 * The second contact is optional at registration and required before a PAID
 * listing is published. Everything else here passes (green run, payout
 * proved, stake above the floor), so `SECOND_CONTACT` is the only variable.
 */
describe('BindingPublishService — a paid listing needs a second contact', () => {
  const ORG = 'org-1';
  const BINDING = 'binding-1';
  const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
  const CHAIN = chainIdOf(ASSET);
  const OWNER = { name: 'Sam Example', email: 'sam@example.test', phone: null };

  function draftRow(pricingMode: PricingMode): ToolBindingEntity {
    return {
      id: BINDING,
      organizationId: ORG,
      toolId: 'get_usd_eur_rate',
      endpoint: 'https://provider.example.com/api',
      requestMapping: { method: 'GET', path: '/r', query: {} },
      responseMapping: { rate: { $path: '$.rate' } },
      pricingMode,
      priceAmount: pricingMode === PricingMode.FREE ? '0' : '10000',
      assetId: ASSET,
      settlementChains: [CHAIN],
      slaFailureRate: '0.02',
      timeoutMs: 5_000,
      status: BindingStatus.DRAFT,
      pauseReason: null,
      pausedAt: null,
      mappingVersion: 1,
      publishedVersion: null,
      publishedAt: null,
    } as unknown as ToolBindingEntity;
  }

  function build(row: ToolBindingEntity, ownerContact: typeof OWNER | null) {
    const manager = {
      save: jest.fn().mockImplementation((_entity: unknown, value: unknown) => value),
      createQueryBuilder: jest.fn().mockImplementation(() => {
        const qb = {
          update: () => qb,
          set: () => qb,
          where: () => qb,
          andWhere: () => qb,
          execute: () => Promise.resolve({ affected: 1 }),
        };
        return qb;
      }),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation((work: (m: unknown) => unknown) => work(manager)),
    } as unknown as DataSource;
    const providers = {
      findOneBy: jest.fn().mockResolvedValue({ organizationId: ORG, ownerContact }),
    };

    const service = new BindingPublishService(
      { loadEditable: jest.fn().mockResolvedValue(row) } as unknown as BindingEditorService,
      {
        findLatestForRevision: jest.fn().mockResolvedValue({
          mappingVersion: row.mappingVersion,
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
                  staked: MoneyUtil.of('500000000', ASSET, 6),
                  observedAt: new Date(0),
                },
              ]),
            ),
          ),
        ),
      } as unknown as ProviderStakePort,
      {
        findRoutingStates: jest.fn().mockResolvedValue(
          new Map([
            [
              ORG,
              {
                providerId: ORG,
                status: ProviderStatus.ACTIVE,
                tier: ProviderTier.NEW,
                stats: {},
                payoutAccountByChain: new Map([
                  [CHAIN, `${CHAIN}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId],
                ]),
                payoutEnrolmentChains: new Set([CHAIN]),
              },
            ],
          ]),
        ),
      } as unknown as ProviderRegistryPort,
      new Map([[CHAIN, { floor: MoneyUtil.of('50000000', ASSET, 6), priceMultiple: 1000 }]]),
      dataSource,
      undefined,
      { list: async () => [], pruneExcept: async () => [] } as never,
      undefined,
      undefined,
      providers as unknown as ProviderRepository,
    );

    return { service, providers };
  }

  it('refuses to publish a paid listing without a second contact, naming the code', async () => {
    const { service } = build(draftRow(PricingMode.PAID), null);

    const check = await service.check(ORG, BINDING);
    const row = check.requirements.find(
      (entry) => entry.requirement === PublishRequirement.SECOND_CONTACT,
    );
    expect(check.publishable).toBe(false);
    expect(row).toMatchObject({
      met: false,
      code: 'PROVIDER_SECOND_CONTACT_REQUIRED',
      detail: 'Add a second contact before you list paid tools.',
    });
    // The only unmet requirement: everything else on this binding is ready.
    expect(check.requirements.filter((entry) => !entry.met)).toHaveLength(1);

    let thrown: { errorCode?: string; message?: string } | undefined;
    try {
      await service.publish(ORG, 'user-1', BINDING);
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown?.errorCode).toBe(ProviderErrorCode.PROVIDER_PUBLISH_CHECKS_FAILED);
    expect(thrown?.message).toContain('SECOND_CONTACT (PROVIDER_SECOND_CONTACT_REQUIRED)');
  });

  it('a FREEMIUM listing is paid too', async () => {
    const { service } = build(draftRow(PricingMode.FREEMIUM), null);

    const check = await service.check(ORG, BINDING);

    expect(
      check.requirements.find((entry) => entry.requirement === PublishRequirement.SECOND_CONTACT)
        ?.met,
    ).toBe(false);
  });

  it('publishes a free listing without a second contact, and does not read the provider row', async () => {
    const { service, providers } = build(draftRow(PricingMode.FREE), null);

    const check = await service.check(ORG, BINDING);
    expect(check.publishable).toBe(true);

    const published = await service.publish(ORG, 'user-1', BINDING);
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(providers.findOneBy).not.toHaveBeenCalled();
  });

  it('publishes the paid listing once the second contact is added', async () => {
    const { service } = build(draftRow(PricingMode.PAID), OWNER);

    const check = await service.check(ORG, BINDING);
    expect(check.publishable).toBe(true);

    const published = await service.publish(ORG, 'user-1', BINDING);
    expect(published.publishedAt).toBeInstanceOf(Date);
  });
});
