import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, chainIdOf } from '@modules/chains/ports/caip.types';
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
import { BindingPauseReason, BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * **Publishing a new revision of a PAUSED binding.**
 *
 * `publish()` used to set `status = ACTIVE` while leaving `pause_reason` and
 * `paused_at` on the row, and `chk_tool_bindings_pause_attributed` — which
 * requires `(status = PAUSED) = (pause_reason IS NOT NULL)` — turned a normal
 * provider action into a 500.
 *
 * The rule pinned here: **publishing is not resuming**. The new revision is
 * published (so a later resume serves it), the binding stays `PAUSED` with its
 * pause attribution untouched, and the row written is one the CHECK accepts.
 */
describe('BindingPublishService — publishing a paused binding', () => {
  const ORG = 'org-1';
  const BINDING = 'binding-1';
  const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
  const CHAIN = chainIdOf(ASSET);
  const PAUSED_AT = new Date('2026-10-10T00:00:00Z');

  function pausedRow(mappingVersion: number, publishedVersion: number): ToolBindingEntity {
    return {
      id: BINDING,
      organizationId: ORG,
      toolId: 'get_usd_eur_rate',
      endpoint: 'https://provider.example.com/api',
      requestMapping: { method: 'GET', path: '/r', query: {} },
      responseMapping: { rate: { $path: '$.rate' } },
      pricingMode: PricingMode.PAID,
      priceAmount: '10000',
      assetId: ASSET,
      settlementChains: [CHAIN],
      slaFailureRate: '0.02',
      timeoutMs: 5_000,
      status: BindingStatus.PAUSED,
      pauseReason: BindingPauseReason.PROVIDER_REQUESTED,
      pausedAt: PAUSED_AT,
      mappingVersion,
      publishedVersion,
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    } as unknown as ToolBindingEntity;
  }

  function build(row: ToolBindingEntity) {
    const saved: ToolBindingEntity[] = [];
    const manager = {
      save: jest.fn().mockImplementation((_entity: unknown, value: ToolBindingEntity) => {
        saved.push({ ...value } as ToolBindingEntity);
        return Promise.resolve(value);
      }),
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
                tier: ProviderTier.ESTABLISHED,
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
    );

    return { service, saved };
  }

  it('publishes the new revision and leaves the binding PAUSED, attribution intact', async () => {
    const { service, saved } = build(pausedRow(2, 1));

    const result = await service.publish(ORG, 'subject-1', BINDING);

    expect(saved).toHaveLength(1);
    const written = saved[0];
    expect(written.publishedVersion).toBe(2);
    expect(written.status).toBe(BindingStatus.PAUSED);
    expect(written.pauseReason).toBe(BindingPauseReason.PROVIDER_REQUESTED);
    expect(written.pausedAt).toEqual(PAUSED_AT);
    // `chk_tool_bindings_pause_attributed`, as a predicate over what was written.
    expect(written.status === BindingStatus.PAUSED).toBe(written.pauseReason !== null);
    expect(result.publishedVersion).toBe(2);
    expect(result.status).toBe(BindingStatus.PAUSED);
  });

  it('refuses to republish the revision a paused binding already holds', async () => {
    const { service, saved } = build(pausedRow(3, 3));

    await expectErrorCodeAsync(
      () => service.publish(ORG, 'subject-1', BINDING),
      ProviderErrorCode.PROVIDER_BINDING_ALREADY_PUBLISHED,
    );
    expect(saved).toHaveLength(0);
  });
});
