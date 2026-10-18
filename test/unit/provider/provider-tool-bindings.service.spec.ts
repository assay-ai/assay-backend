import { ConfigService } from '@nestjs/config';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderToolBindingsService } from '@modules/provider/services/provider-tool-bindings.service';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * `ProviderToolBindingsService` after bindings moved to `tool_bindings`.
 *
 * An earlier version served this by walking the whole catalogue in memory, and the tests
 * that covered the walk went with it: the list is now a keyset query against
 * `tool_bindings`, and a query builder faked convincingly enough to test
 * pagination is a re-implementation of Postgres. That half moved to
 * `test/integration/provider/binding-publish.integration.spec.ts`, against a
 * real database.
 *
 * What stays here is the part that is genuinely this class's logic and not the
 * database's: a binding belonging to another organization is a **404**, never
 * a 403. Distinguishing the two would confirm the id exists.
 */
const PROVIDER = 'org-66666666-6666-4666-8666-666666666666';
const OTHER_PROVIDER = 'org-77777777-7777-4777-8777-777777777777';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function row(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
  return {
    id: 'bnd-1',
    organizationId: PROVIDER,
    toolId: 'search_web',
    endpoint: 'https://api.example.com/search',
    requestMapping: { method: 'POST', body: {} },
    responseMapping: { results: {} },
    pricingMode: PricingMode.PAID,
    priceAmount: '10000',
    assetId: USDC,
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    slaFailureRate: '0.05000',
    timeoutMs: 8000,
    status: BindingStatus.ACTIVE,
    mappingVersion: 1,
    publishedVersion: 1,
    publishedAt: new Date(),
    ...overrides,
  } as ToolBindingEntity;
}

function build(rows: ToolBindingEntity[], revisions: Partial<BindingVersionEntity>[] = []) {
  const versions = {
    findOne: jest.fn(
      async ({ where }: { where: { bindingId: string; mappingVersion: number } }) =>
        (revisions.find(
          (v) => v.bindingId === where.bindingId && v.mappingVersion === where.mappingVersion,
        ) ?? null) as BindingVersionEntity | null,
    ),
  } as unknown as BindingVersionRepository;

  const repository = {
    findOne: jest.fn(async ({ where }: { where: { organizationId: string; id: string } }) => {
      return (
        rows.find(
          (candidate) =>
            candidate.organizationId === where.organizationId && candidate.id === where.id,
        ) ?? null
      );
    }),
  } as unknown as ToolBindingRepository;

  // The catalogue and the config belong to `getCatalogue`, which is covered in
  // `tool-catalogue.spec.ts`. Neither is reached by the two reads below.
  const catalogue = {
    findTool: jest.fn(),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  } as ToolCataloguePort;
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

  return {
    // `discardDraft`'s transaction, vault and audit are not reached by the reads.
    service: new ProviderToolBindingsService(
      repository,
      catalogue,
      config,
      versions,
      {} as never,
      {} as never,
      {} as never,
    ),
    repository,
  };
}

describe('ProviderToolBindingsService.getBinding — 404, never 403, across providers', () => {
  it('returns the binding’s full detail, including the mappings', async () => {
    const { service } = build([row({ id: 'bnd-1' })]);

    const detail = await service.getBinding(PROVIDER, 'bnd-1');

    expect(detail.id).toBe('bnd-1');
    expect(detail.requestMapping).toEqual({ method: 'POST', body: {} });
    expect(detail.responseMapping).toEqual({ results: {} });
    expect(detail.price).toEqual({ amount: '10000', asset: USDC, decimals: 6 });
    // `numeric` comes back from the driver as a string; the DTO is a number.
    expect(detail.slaFailureRate).toBe(0.05);
  });

  it('404s for a binding that exists but belongs to another provider', async () => {
    const { service, repository } = build([row({ id: 'bnd-2', organizationId: OTHER_PROVIDER })]);

    await expectErrorCodeAsync(
      () => service.getBinding(PROVIDER, 'bnd-2'),
      ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    );

    // The organization is in the predicate, not applied after the read — the
    // difference between a scoped query and a filtered one.
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { organizationId: PROVIDER, id: 'bnd-2' },
    });
  });

  it('404s for a binding id that does not exist anywhere', async () => {
    const { service } = build([]);

    await expectErrorCodeAsync(
      () => service.getBinding(PROVIDER, 'nope'),
      ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    );
  });
});

describe('ProviderToolBindingsService.getBinding — the published revision', () => {
  it('reports unpublished changes when the stored revision is ahead of the live one', async () => {
    const { service } = build([row({ mappingVersion: 4, publishedVersion: 3 })]);

    const detail = await service.getBinding(PROVIDER, 'bnd-1');

    expect(detail.version).toBe(4);
    expect(detail.publishedVersion).toBe(3);
    expect(detail.hasUnpublishedChanges).toBe(true);
  });

  it('reports none when the live revision is the stored one', async () => {
    const { service } = build([row({ mappingVersion: 4, publishedVersion: 4 })]);

    const detail = await service.getBinding(PROVIDER, 'bnd-1');

    expect(detail.publishedVersion).toBe(4);
    expect(detail.hasUnpublishedChanges).toBe(false);
  });

  /**
   * A `DRAFT` that has never been published *does* have unpublished changes —
   * everything about it is unpublished. Answering `false` here because there is
   * no published revision to differ from would tell a provider their draft was
   * already live, and would let the editor hide the publish call to action on
   * the one binding that most needs it.
   */
  it('counts a never-published draft as wholly unpublished', async () => {
    const { service } = build([
      row({
        status: BindingStatus.DRAFT,
        mappingVersion: 1,
        publishedVersion: null,
        publishedAt: null,
      }),
    ]);

    const detail = await service.getBinding(PROVIDER, 'bnd-1');

    expect(detail.publishedVersion).toBeNull();
    expect(detail.hasUnpublishedChanges).toBe(true);
  });
});

describe('ProviderToolBindingsService.getBinding — publishedEndpoint', () => {
  it('reads the endpoint of the revision that is published, not the draft', async () => {
    const { service } = build(
      [row({ endpoint: 'https://new.example.com/v2', mappingVersion: 4, publishedVersion: 3 })],
      [
        { bindingId: 'bnd-1', mappingVersion: 3, endpoint: 'https://old.example.com/v1' },
        { bindingId: 'bnd-1', mappingVersion: 4, endpoint: 'https://new.example.com/v2' },
      ],
    );

    const detail = await service.getBinding(PROVIDER, 'bnd-1');

    expect(detail.endpoint).toBe('https://new.example.com/v2');
    expect(detail.publishedEndpoint).toBe('https://old.example.com/v1');
  });

  it('is null for a binding that was never published', async () => {
    const { service } = build([
      row({ status: BindingStatus.DRAFT, publishedVersion: null, publishedAt: null }),
    ]);

    expect((await service.getBinding(PROVIDER, 'bnd-1')).publishedEndpoint).toBeNull();
  });
});

/**
 * `discardDraft`: a never-published draft only, scoped to the caller's
 * organization, with its credential sets pruned through the vault and one
 * audit entry, all in one transaction. The SQL of the evidence check is
 * proven against a real schema in `binding-discard.integration.spec.ts`.
 */
describe('ProviderToolBindingsService.discardDraft', () => {
  const ACTOR = { type: 'user' as const, id: 'cred-1' };

  function buildDiscard(stored: ToolBindingEntity | null, evidence: Record<string, boolean> = {}) {
    const manager = {
      findOne: jest.fn(async () => stored),
      query: jest.fn(async () => [evidence]),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    const dataSource = {
      transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
    };
    const vault = {
      pruneExcept: jest.fn(async () => [
        { origin: 'https://api.example.com', headerNames: ['X-Key'] },
      ]),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new ProviderToolBindingsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource as never,
      vault as never,
      audit as never,
    );
    return { service, manager, vault, audit };
  }

  const draft = () =>
    row({ id: 'bnd-d', status: BindingStatus.DRAFT, publishedVersion: null, publishedAt: null });

  it('reads the binding inside the caller’s organization, locked, and 404s otherwise', async () => {
    const { service, manager, audit } = buildDiscard(null);

    await expectErrorCodeAsync(
      () => service.discardDraft(PROVIDER, ACTOR, 'bnd-d'),
      ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    );
    expect(manager.findOne).toHaveBeenCalledWith(ToolBindingEntity, {
      where: { organizationId: PROVIDER, id: 'bnd-d' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['ACTIVE', { status: BindingStatus.ACTIVE }],
    ['PAUSED', { status: BindingStatus.PAUSED }],
    ['a draft that was published once', { status: BindingStatus.DRAFT, publishedVersion: 1 }],
  ])('refuses %s', async (_label, overrides) => {
    const { service, manager, vault } = buildDiscard(row({ id: 'bnd-d', ...overrides }));

    await expectErrorCodeAsync(
      () => service.discardDraft(PROVIDER, ACTOR, 'bnd-d'),
      ProviderErrorCode.PROVIDER_BINDING_NOT_DISCARDABLE,
    );
    expect(vault.pruneExcept).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('refuses a draft that a call already names', async () => {
    const { service, manager } = buildDiscard(draft(), { e0: true });

    await expectErrorCodeAsync(
      () => service.discardDraft(PROVIDER, ACTOR, 'bnd-d'),
      ProviderErrorCode.PROVIDER_BINDING_NOT_DISCARDABLE,
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('prunes every credential set through the vault, deletes the draft and audits it', async () => {
    const { service, manager, vault, audit } = buildDiscard(draft());

    await service.discardDraft(PROVIDER, ACTOR, 'bnd-d');

    expect(vault.pruneExcept).toHaveBeenCalledWith(manager, PROVIDER, 'bnd-d', []);
    expect(manager.delete).toHaveBeenCalledWith(ToolBindingEntity, {
      organizationId: PROVIDER,
      id: 'bnd-d',
    });
    expect(audit.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        organizationId: PROVIDER,
        actor: ACTOR,
        action: 'tool_binding.discarded',
        resourceType: 'tool_binding',
        resourceId: 'bnd-d',
        before: expect.objectContaining({
          credential_sets: [{ origin: 'https://api.example.com', header_names: ['X-Key'] }],
        }),
      }),
    );
  });
});
