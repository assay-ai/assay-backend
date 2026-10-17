import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { chainIdOf } from '@modules/chains/ports/caip.types';
import { DatabaseToolCatalogue } from '@modules/tool/services/database-tool-catalogue';
import { staticToolContracts } from '@modules/tool/ports/tool-contracts.port';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

import { buildTool } from './helpers/routing-fixtures';

/**
 * **Traffic is served by the PUBLISHED revision, never by the draft on the row.**
 *
 * A draft and a live binding are the same `tool_bindings` row: an edit raises
 * `mapping_version` and leaves `published_version` behind. The catalogue used
 * to hand the router the row's CURRENT endpoint, mappings, price and timeout,
 * so an edit to a live binding — or a pause, an edit and a resume — went on the
 * wire at once, untested and unpublished, with the publish gate only ever
 * guarding the first publish.
 *
 * The rule pinned here: when the row has moved past its published revision,
 * the versioned fields come from that revision's `binding_versions` snapshot,
 * and so does the `version` a verdict cites. A published revision with no
 * snapshot fails closed: the binding is not offered as `ACTIVE`.
 */
describe('DatabaseToolCatalogue — serves the published revision', () => {
  const TOOL = buildTool();
  const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
  const CHAIN = chainIdOf(ASSET);

  function row(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
    return {
      id: 'binding-1',
      organizationId: 'provider-1',
      toolId: TOOL.id,
      // The DRAFT values — what an edit wrote after publication.
      endpoint: 'https://draft.example.com/api',
      requestMapping: { method: 'GET', path: '/draft', query: {} },
      responseMapping: { answer: { $path: '$.draft' } },
      pricingMode: PricingMode.FREE,
      priceAmount: '0',
      assetId: ASSET,
      settlementChains: [CHAIN],
      freeQuotaPerAgent: null,
      freeDailyBudget: null,
      maxRps: null,
      maxDailyCalls: null,
      slaFailureRate: '0.02',
      timeoutMs: 1,
      status: BindingStatus.ACTIVE,
      mappingVersion: 14,
      publishedVersion: 1,
      ...overrides,
    } as unknown as ToolBindingEntity;
  }

  function snapshot(overrides: Partial<BindingVersionEntity> = {}): BindingVersionEntity {
    return {
      organizationId: 'provider-1',
      bindingId: 'binding-1',
      mappingVersion: 1,
      toolId: TOOL.id,
      // The PUBLISHED values — what the tester passed and the provider published.
      endpoint: 'https://published.example.com/api',
      requestMapping: { method: 'GET', path: '/published', query: {} },
      responseMapping: { answer: { $path: '$.published' } },
      pricingMode: PricingMode.PAID,
      priceAmount: '50000',
      assetId: ASSET,
      timeoutMs: 5_000,
      publishedAt: new Date('2026-10-09T00:00:00Z'),
      ...overrides,
    } as unknown as BindingVersionEntity;
  }

  function build(rows: ToolBindingEntity[], snapshots: BindingVersionEntity[]) {
    const versions = {
      find: jest
        .fn()
        .mockImplementation(
          (options: {
            where: Array<{ organizationId: string; bindingId: string; mappingVersion: number }>;
          }) =>
            Promise.resolve(
              snapshots.filter((s) =>
                options.where.some(
                  (w) =>
                    w.organizationId === s.organizationId &&
                    w.bindingId === s.bindingId &&
                    w.mappingVersion === s.mappingVersion,
                ),
              ),
            ),
        ),
    };
    const catalogue = new DatabaseToolCatalogue(
      staticToolContracts([TOOL]),
      { findByTool: jest.fn().mockResolvedValue(rows) } as unknown as ToolBindingRepository,
      versions as unknown as BindingVersionRepository,
    );
    return { catalogue, versions };
  }

  it('serves the published endpoint, mappings, price and timeout of a live binding with a draft', async () => {
    const { catalogue } = build([row()], [snapshot()]);

    const [binding] = await catalogue.findBindings(TOOL.id);

    expect(binding.status).toBe(BindingStatus.ACTIVE);
    expect(binding.endpoint).toBe('https://published.example.com/api');
    expect(binding.requestMapping).toEqual({ method: 'GET', path: '/published', query: {} });
    expect(binding.responseMapping).toEqual({ answer: { $path: '$.published' } });
    expect(binding.pricingMode).toBe(PricingMode.PAID);
    expect(binding.priceAmount).toBe('50000');
    expect(binding.timeoutMs).toBe(5_000);
    // The revision a verdict cites is the one that served the call.
    expect(binding.version).toBe(1);
  });

  it('a resumed binding with a draft serves its last published revision', async () => {
    // pause → edit → resume: the row is ACTIVE again at mapping v3, published v2.
    const { catalogue } = build(
      [row({ mappingVersion: 3, publishedVersion: 2 })],
      [
        snapshot({ mappingVersion: 1, endpoint: 'https://v1.example.com' }),
        snapshot({ mappingVersion: 2 }),
      ],
    );

    const [binding] = await catalogue.findBindings(TOOL.id);

    expect(binding.status).toBe(BindingStatus.ACTIVE);
    expect(binding.endpoint).toBe('https://published.example.com/api');
    expect(binding.version).toBe(2);
  });

  it('serves the row as-is when it is at its published revision, without a lookup', async () => {
    const { catalogue, versions } = build([row({ mappingVersion: 4, publishedVersion: 4 })], []);

    const [binding] = await catalogue.findBindings(TOOL.id);

    expect(binding.endpoint).toBe('https://draft.example.com/api');
    expect(binding.version).toBe(4);
    expect(versions.find).not.toHaveBeenCalled();
  });

  it('leaves a never-published draft as a DRAFT (the router refuses it)', async () => {
    const { catalogue } = build(
      [row({ status: BindingStatus.DRAFT, mappingVersion: 2, publishedVersion: null })],
      [],
    );

    const [binding] = await catalogue.findBindings(TOOL.id);

    expect(binding.status).toBe(BindingStatus.DRAFT);
  });

  it('fails closed when the published revision has no snapshot', async () => {
    const { catalogue } = build([row()], []);

    const [binding] = await catalogue.findBindings(TOOL.id);

    // Never the draft's terms under an ACTIVE status.
    expect(binding.status).not.toBe(BindingStatus.ACTIVE);
  });

  it('keys each snapshot to its own binding', async () => {
    const other = row({
      id: 'binding-2',
      organizationId: 'provider-2',
      mappingVersion: 6,
      publishedVersion: 5,
    });
    const { catalogue } = build(
      [row(), other],
      [
        snapshot(),
        snapshot({
          organizationId: 'provider-2',
          bindingId: 'binding-2',
          mappingVersion: 5,
          endpoint: 'https://two.example.com',
        }),
      ],
    );

    const bindings = await catalogue.findBindings(TOOL.id);

    expect(bindings.map((b) => [b.id, b.endpoint, b.version])).toEqual([
      ['binding-1', 'https://published.example.com/api', 1],
      ['binding-2', 'https://two.example.com', 5],
    ]);
  });
});
