import { MAX_MAPPING_HEADERS } from '@modules/provider/credentials/credential-rules';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import {
  SaveToolBindingBodyDto,
  UpdateToolBindingBodyDto,
} from '@modules/provider/dto/save-tool-binding.dto';
import { MappingDirection } from '@modules/tool/domain/mapping/mapping.types';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingAuthMode, BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';

import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import { ConfigProviderStakeSource } from '@modules/provider/services/config-provider-stake.source';

import {
  MINIMUM_STAKE,
  PAYOUT_CHAIN,
  STAKE_ASSET,
  buildTool,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The binding editor's save-time checks.
 *
 * A wrong-typed mapping is blocked right at save — refused at Save, not at 3am
 * on somebody's request. Two kinds of wrong are decidable there and both are covered below:
 *
 * - the spec is **malformed** (bad selector, unknown transform) —
 *   `mapping-validator.ts`, the router's own function; and
 * - the spec is well-formed and **cannot satisfy the tool contract** whatever
 *   the endpoint returns — `contract-check.ts`.
 *
 * Each of them asserts the same second thing: **nothing was written**. A
 * validation that rejects after the insert is a validation that leaves a row
 * behind.
 */
const PROVIDER = 'org-99999999-9999-4999-8999-999999999999';
const SUBJECT = 'cred-9';

/**
 * The chains the write-time gate is wired to accept here.
 *
 * Both, enrolled and over-staked, because this file is about **mapping** and
 * **storage**: a chain rejection landing on a case that is asserting where a
 * list is written would be a test going red for a reason it never mentions.
 * The gate's own refusals are `binding-chain-gate.spec.ts`.
 *
 * One asset's floor under both chains, for the reason
 * `helpers/binding-editor-harness.ts` gives at length: a second chain's real
 * floor is a second CAIP-19 asset, and `evaluateStakeGate` would then refuse
 * with `STAKE_ASSET_MISMATCH` before comparing anything.
 */
const GATE_CHAINS = [PAYOUT_CHAIN, CHAIN_IDS.SOLANA_MAINNET];

/** The tool contract every case below is mapped onto: `{ answer: string }`, required. */
const TOOL = buildTool();

function body(overrides: Partial<SaveToolBindingBodyDto> = {}): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: 'https://api.example.com/v2',
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: STAKE_ASSET,
    settlementChains: [PAYOUT_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 8000,
    ...overrides,
  } as SaveToolBindingBodyDto;
}

/**
 * The same body as {@link body}, but as the plain JSON a request actually
 * carries — the shape `class-validator` is handed before anything is typed.
 */
function saveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(body() as unknown as Record<string, unknown>), ...overrides };
}

/**
 * Which properties `class-validator` refused, for a DTO rule that has no
 * service-side half.
 *
 * "Zero is not a ceiling" is enforced by a decorator and nowhere else, so
 * asserting it through `create()` would only prove that the service does not
 * re-check what the pipe already checked. This runs the decorators themselves,
 * which is the thing under test.
 */
async function invalidProperties(
  dto: new () => object,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, payload));
  return errors.map((error) => error.property);
}

function row(overrides: Partial<ToolBindingEntity> = {}): ToolBindingEntity {
  return {
    id: 'b1000000-0000-4000-8000-000000000001',
    organizationId: PROVIDER,
    toolId: TOOL.id,
    endpoint: 'https://api.example.com/v2',
    requestMapping: { method: 'POST', path: '/search', body: { q: { $path: '$.query' } } },
    responseMapping: { answer: { $path: '$.data.answer' } },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: STAKE_ASSET,
    settlementChains: [PAYOUT_CHAIN],
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    slaFailureRate: '0.02000',
    timeoutMs: 8000,
    status: BindingStatus.ACTIVE,
    mappingVersion: 3,
    publishedVersion: 3,
    publishedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as ToolBindingEntity;
}

function build(
  stored: ToolBindingEntity | null = null,
  versions: readonly Partial<BindingVersionEntity>[] = [],
  options: { relayConfigured?: boolean } = {},
) {
  const written: Array<{ entity: string; row: unknown }> = [];

  const manager = {
    save: jest.fn(async (entity: unknown, value: unknown) => {
      written.push({ entity: (entity as { name: string }).name, row: value });
      return value;
    }),
    // The stored `binding_versions` rows: `findOne` by revision, `maximum` over them.
    findOne: jest.fn(
      async (_entity: unknown, { where }: { where: { mappingVersion: number } }) =>
        versions.find((version) => version.mappingVersion === where.mappingVersion) ?? null,
    ),
    maximum: jest.fn(async () =>
      versions.length === 0
        ? (stored?.mappingVersion ?? null)
        : Math.max(...versions.map((version) => version.mappingVersion as number)),
    ),
  };

  const dataSource = {
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;

  const bindings = {
    findOne: jest.fn(async () => stored),
  } as unknown as ToolBindingRepository;

  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(async (id: string) => (id === TOOL.id ? TOOL : null)),
    listTools: jest.fn(),
    findBindings: jest.fn(),
  };

  const enrolments: ChainEnrolmentPort = {
    enrolmentsOf: async (providerIds: readonly string[]) =>
      new Map(
        providerIds.flatMap((providerId) =>
          GATE_CHAINS.map((chainId) => [
            enrolmentKey(providerId, chainId),
            {
              providerId,
              chainId,
              payoutAccountId: `${chainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
              stakeAuthorityAccountId: null,
              status: ChainEnrolmentStatus.ACTIVE,
              enrolledAt: new Date(0),
            } as ChainEnrolment,
          ]),
        ) as [string, ChainEnrolment][],
      ),
  };

  const stakes = new ConfigProviderStakeSource(
    Object.fromEntries(GATE_CHAINS.map((chainId) => [stakeKey(PROVIDER, chainId), usdc('1000')])),
  );

  return {
    // The write-time chain gate's four dependencies, wired to
    // "everything this fixture asks for is fine": the provider is enrolled and
    // over-staked on {@link PAYOUT_CHAIN}, which every body here names. The
    // gate itself is `binding-chain-gate.spec.ts`'s subject; here it must
    // simply not be what refuses, or a mapping test would go green on a chain
    // rejection.
    service: new BindingEditorService(
      bindings,
      catalogue,
      dataSource,
      enrolments,
      stakes,
      GATE_CHAINS,
      new Map(GATE_CHAINS.map((chainId) => [chainId, MINIMUM_STAKE])),
      options.relayConfigured
        ? { url: new URL('https://egress.test'), token: 'a'.repeat(64) }
        : null,
    ),
    written,
    dataSource,
  };
}

describe('BindingEditorService.create — a bad mapping is refused at Save', () => {
  it('refuses a malformed selector, and writes nothing', async () => {
    const { service, dataSource } = build();

    await expectErrorCodeAsync(
      () =>
        service.create(PROVIDER, SUBJECT, body({ responseMapping: { answer: { $path: '$.[' } } })),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses an unknown transform', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.create(
          PROVIDER,
          SUBJECT,
          body({ responseMapping: { answer: { $path: '$.a', $transform: ['uppercas'] } } }),
        ),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('refuses a wildcard at a scalar site — it reads many values where one belongs', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.create(PROVIDER, SUBJECT, body({ responseMapping: { answer: '$.items[*].name' } })),
      ToolErrorCode.TOOL_MAPPING_INVALID,
    );
  });

  it('refuses a constant of the wrong type for the contract', async () => {
    const { service, dataSource } = build();

    // `answer` is `string` on the tool's outputSchema. This mapping would fail
    // on every single call, and there is no response that could save it.
    await expectErrorCodeAsync(
      () =>
        service.create(PROVIDER, SUBJECT, body({ responseMapping: { answer: { $const: 42 } } })),
      ToolErrorCode.TOOL_MAPPING_TYPE_MISMATCH,
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses a mapping that never writes a required field', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.create(PROVIDER, SUBJECT, body({ responseMapping: { somethingElse: '$.data.x' } })),
      ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    );
  });

  it('refuses $optional at a required field unless it carries a $default', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.create(
          PROVIDER,
          SUBJECT,
          body({ responseMapping: { answer: { $path: '$.a', $optional: true } } }),
        ),
      ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    );

    // The same field with a default is fine: it is always written.
    const ok = build();
    await expect(
      ok.service.create(
        PROVIDER,
        SUBJECT,
        body({ responseMapping: { answer: { $path: '$.a', $optional: true, $default: '' } } }),
      ),
    ).resolves.toBeDefined();
  });

  it('404s for a tool that is not in the catalogue', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () => service.create(PROVIDER, SUBJECT, body({ toolId: 'no_such_tool' })),
      ProviderErrorCode.PROVIDER_BINDING_TOOL_UNKNOWN,
    );
  });
});

describe('BindingEditorService.create — what gets stored', () => {
  it('stores the canonical form, not the shorthand the provider typed', async () => {
    const { service, written } = build();

    const saved = await service.create(PROVIDER, SUBJECT, body());

    const binding = written.find((entry) => entry.entity === 'ToolBindingEntity')
      ?.row as ToolBindingEntity;

    // `"$.data.answer"` was a bare string on the way in. It is a `$path` node
    // at rest, so nothing downstream ever has to re-derive whether it was a
    // selector or a constant.
    expect(binding.responseMapping).toEqual({ answer: { $path: '$.data.answer' } });
    expect(binding.requestMapping).toEqual({
      method: 'POST',
      path: '/search',
      body: { q: { $path: '$.query' } },
    });

    // Born DRAFT, at revision 1, published nowhere.
    expect(binding.status).toBe(BindingStatus.DRAFT);
    expect(binding.mappingVersion).toBe(1);
    expect(binding.publishedVersion).toBeNull();
    expect(saved.hasUnpublishedChanges).toBe(true);
  });

  it('writes the binding and its first revision snapshot in one transaction', async () => {
    const { service, written } = build();

    await service.create(PROVIDER, SUBJECT, body());

    expect(written.map((entry) => entry.entity)).toEqual([
      'ToolBindingEntity',
      'BindingVersionEntity',
    ]);

    const snapshot = written[1].row as BindingVersionEntity;
    expect(snapshot.mappingVersion).toBe(1);
    expect(snapshot.authoredBy).toBe(SUBJECT);
    // The snapshot carries the price itself rather than joining for it — a
    // dispute argues over the price that was in force, not today's.
    expect(snapshot.priceAmount).toBe('50000');
    expect(snapshot.publishedAt).toBeNull();
  });

  it('refuses a credential-like key in the endpoint query, and writes nothing', async () => {
    const { service, written } = build();

    await expectErrorCodeAsync(
      () => service.create(PROVIDER, SUBJECT, body({ endpoint: 'https://x.test?apikey=1' })),
      ProviderErrorCode.PROVIDER_CREDENTIAL_IN_QUERY,
    );
    expect(written).toEqual([]);
  });

  it('refuses a port the relay cannot reach, and writes nothing', async () => {
    const { service, written } = build(null, [], { relayConfigured: true });

    await expectErrorCodeAsync(
      () => service.create(PROVIDER, SUBJECT, body({ endpoint: 'https://p.test:3000/x' })),
      ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
    );
    expect(written).toEqual([]);
  });

  it('refuses a port the relay cannot reach on update, and writes nothing', async () => {
    const { service, written } = build(row(), [], { relayConfigured: true });

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, row().id, { endpoint: 'https://p.test:3000/x' }),
      ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
    );
    expect(written).toEqual([]);
  });

  it.each([
    ['http', 'http://p.test/x'],
    ['an IPv4 literal', 'https://203.0.113.7/x'],
    ['an IPv6 literal', 'https://[2001:db8::1]/x'],
  ])('refuses %s while the relay is on, and writes nothing', async (_label, endpoint) => {
    const { service, written } = build(null, [], { relayConfigured: true });

    await expectErrorCodeAsync(
      () => service.create(PROVIDER, SUBJECT, body({ endpoint })),
      ProviderErrorCode.PROVIDER_ENDPOINT_NOT_RELAYABLE,
    );
    expect(written).toEqual([]);
  });

  it('refuses an IP literal on update while the relay is on', async () => {
    const { service, written } = build(row(), [], { relayConfigured: true });

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, row().id, { endpoint: 'https://198.51.100.4/x' }),
      ProviderErrorCode.PROVIDER_ENDPOINT_NOT_RELAYABLE,
    );
    expect(written).toEqual([]);
  });

  it(`refuses more than ${MAX_MAPPING_HEADERS} mapping headers, and writes nothing`, async () => {
    const { service, written } = build();
    const headers = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`x-h-${i}`, { $const: 'v' }]));

    await expectErrorCodeAsync(
      () =>
        service.create(
          PROVIDER,
          SUBJECT,
          body({
            requestMapping: {
              method: 'POST',
              path: '/search',
              headers: headers(MAX_MAPPING_HEADERS + 1),
              body: { q: '$.query' },
            },
          } as never),
        ),
      ProviderErrorCode.PROVIDER_TOO_MANY_MAPPING_HEADERS,
    );
    expect(written).toEqual([]);
    // The reserve leaves room for Assay's six and ten credential headers under the relay's 64.
    expect(MAX_MAPPING_HEADERS + 6 + 10).toBeLessThanOrEqual(64);

    await service.create(
      PROVIDER,
      SUBJECT,
      body({
        requestMapping: {
          method: 'POST',
          path: '/search',
          headers: headers(MAX_MAPPING_HEADERS),
          body: { q: '$.query' },
        },
      } as never),
    );
    expect(written.length).toBeGreaterThan(0);
  });

  it('refuses an x-assay- mapping header on create, constant or derived, and writes nothing', async () => {
    const { service, written } = build();

    for (const node of [{ $const: 'forged' }, { $path: '$.query' }]) {
      await expectErrorCodeAsync(
        () =>
          service.create(
            PROVIDER,
            SUBJECT,
            body({
              requestMapping: {
                method: 'POST',
                path: '/search',
                headers: { 'X-Assay-Agent': node },
                body: { q: '$.query' },
              },
            } as never),
          ),
        ProviderErrorCode.PROVIDER_RESERVED_MAPPING_HEADER,
      );
    }
    expect(written).toEqual([]);
  });

  it('refuses an x-assay- mapping header on update', async () => {
    const { service, written } = build(row());

    await expectErrorCodeAsync(
      () =>
        service.update(PROVIDER, SUBJECT, row().id, {
          requestMapping: {
            method: 'POST',
            path: '/search',
            headers: { 'x-assay-call-id': { $const: 'forged' } },
            body: { q: '$.query' },
          },
        }),
      ProviderErrorCode.PROVIDER_RESERVED_MAPPING_HEADER,
    );
    expect(written).toEqual([]);
  });

  it('refuses a secret-looking constant header on update', async () => {
    const { service, written } = build(row());

    await expectErrorCodeAsync(
      () =>
        service.update(PROVIDER, SUBJECT, row().id, {
          requestMapping: {
            method: 'POST',
            path: '/search',
            headers: { Authorization: { $const: 'Bearer x' } },
            body: { q: '$.query' },
          },
        }),
      ProviderErrorCode.PROVIDER_SECRET_IN_MAPPING,
    );
    expect(written).toEqual([]);
  });

  it('changes authMode without bumping the revision', async () => {
    const { service } = build(row());
    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      authMode: BindingAuthMode.API_KEY,
    });

    expect(saved.authMode).toBe('API_KEY');
    expect(saved.version).toBe(3);
  });

  it('prices a FREE binding at zero whatever the caller sent', async () => {
    const { service, written } = build();

    await service.create(
      PROVIDER,
      SUBJECT,
      body({ pricingMode: PricingMode.FREE, priceAmount: '50000' }),
    );

    expect((written[0].row as ToolBindingEntity).priceAmount).toBe('0');
  });
});

describe('BindingEditorService — a charging mode needs a price above zero', () => {
  it.each([PricingMode.PAID, PricingMode.FREEMIUM])(
    'refuses a %s create at price 0, and writes nothing',
    async (pricingMode) => {
      const { service, written } = build();

      await expectErrorCodeAsync(
        () => service.create(PROVIDER, SUBJECT, body({ pricingMode, priceAmount: '0' })),
        ProviderErrorCode.PROVIDER_BINDING_PRICE_NOT_POSITIVE,
      );
      expect(written).toEqual([]);
    },
  );

  it('refuses a zero-padded zero as well', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () => service.create(PROVIDER, SUBJECT, body({ priceAmount: '000' })),
      ProviderErrorCode.PROVIDER_BINDING_PRICE_NOT_POSITIVE,
    );
  });

  it('refuses a PATCH that sets the price to 0 on a PAID binding', async () => {
    const { service, written } = build(row());

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, row().id, { priceAmount: '0' }),
      ProviderErrorCode.PROVIDER_BINDING_PRICE_NOT_POSITIVE,
    );
    expect(written).toEqual([]);
  });

  it('refuses a PATCH that only switches the mode to PAID while the stored price is 0', async () => {
    const { service } = build(row({ pricingMode: PricingMode.FREE, priceAmount: '0' }));

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, row().id, { pricingMode: PricingMode.PAID }),
      ProviderErrorCode.PROVIDER_BINDING_PRICE_NOT_POSITIVE,
    );
  });

  it('accepts mode PAID together with a positive price, and price 0 on FREE', async () => {
    const { service } = build(row({ pricingMode: PricingMode.FREE, priceAmount: '0' }));
    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      pricingMode: PricingMode.PAID,
      priceAmount: '1',
    });
    expect(saved.pricingMode).toBe(PricingMode.PAID);

    const free = build(row());
    await expect(
      free.service.update(PROVIDER, SUBJECT, row().id, {
        pricingMode: PricingMode.FREE,
        priceAmount: '0',
      }),
    ).resolves.toBeDefined();
  });
});

describe('BindingEditorService — free-tier limits are call counts', () => {
  it('stores freeDailyBudget as a call count and reads it back as the same number', async () => {
    const { service } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, { freeDailyBudget: 80 });
    expect(saved.freeDailyBudget).toBe(80);

    const cleared = await service.update(PROVIDER, SUBJECT, row().id, { freeDailyBudget: null });
    expect(cleared.freeDailyBudget).toBeNull();
  });

  it('refuses a freeDailyBudget that is not a positive whole number of calls', async () => {
    for (const value of ['5000000', 1.5, 0, -1, 2_147_483_648]) {
      expect(await invalidProperties(UpdateToolBindingBodyDto, { freeDailyBudget: value })).toEqual(
        ['freeDailyBudget'],
      );
      expect(await invalidProperties(SaveToolBindingBodyDto, { freeDailyBudget: value })).toContain(
        'freeDailyBudget',
      );
    }
    expect(
      await invalidProperties(UpdateToolBindingBodyDto, { freeDailyBudget: 2_147_483_647 }),
    ).toEqual([]);
    expect(await invalidProperties(UpdateToolBindingBodyDto, { freeDailyBudget: null })).toEqual(
      [],
    );
  });

  it('refuses a freeQuotaPerAgent beyond the int column', async () => {
    expect(
      await invalidProperties(UpdateToolBindingBodyDto, { freeQuotaPerAgent: 2_147_483_648 }),
    ).toEqual(['freeQuotaPerAgent']);
    expect(
      await invalidProperties(UpdateToolBindingBodyDto, { freeQuotaPerAgent: 2_147_483_647 }),
    ).toEqual([]);
  });
});

describe('BindingEditorService.update — which edits raise the revision', () => {
  it('raises the revision and snapshots when the response mapping changes', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      responseMapping: { answer: '$.result.text' },
    });

    expect(saved.version).toBe(4);
    expect(written.map((entry) => entry.entity)).toEqual([
      'ToolBindingEntity',
      'BindingVersionEntity',
    ]);
    // Published revision stays behind — that gap *is* "you have unpublished
    // changes", and it is what invalidates any green tester run at revision 3.
    expect(saved.publishedVersion).toBe(3);
    expect(saved.hasUnpublishedChanges).toBe(true);
  });

  it('raises the revision when the price changes — the snapshot has to record it', async () => {
    const { service } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, { priceAmount: '90000' });

    expect(saved.version).toBe(4);
  });

  it('does not raise the revision for the SLA rate, which changes nothing about a call', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, { slaFailureRate: 0.09 });

    expect(saved.version).toBe(3);
    // No snapshot: nothing about what a call does or costs has changed, so
    // re-running the mapping tester would be friction with no question behind it.
    expect(written.map((entry) => entry.entity)).toEqual(['ToolBindingEntity']);
  });

  it('does not raise the revision when a PATCH re-sends an unchanged field', async () => {
    const { service } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      endpoint: 'https://api.example.com/v2',
      responseMapping: { answer: '$.data.answer' },
    });

    expect(saved.version).toBe(3);
  });

  describe('an edit that lands back on the published terms', () => {
    /** Published at revision 1 (price 50000); the row is a draft at revision 2 (price 60000). */
    const published: Partial<BindingVersionEntity> = {
      mappingVersion: 1,
      endpoint: row().endpoint,
      // `jsonb` key order, deliberately not the row's own.
      requestMapping: { path: '/search', body: { q: { $path: '$.query' } }, method: 'POST' },
      responseMapping: row().responseMapping,
      pricingMode: PricingMode.PAID,
      priceAmount: '50000',
      assetId: STAKE_ASSET,
      timeoutMs: 8000,
    } as Partial<BindingVersionEntity>;
    const draft = () => row({ mappingVersion: 2, publishedVersion: 1, priceAmount: '60000' });
    const versions = [published, { ...published, mappingVersion: 2, priceAmount: '60000' }];

    it('returns to the published revision instead of minting a new one', async () => {
      const { service, written } = build(draft(), versions);

      const saved = await service.update(PROVIDER, SUBJECT, row().id, { priceAmount: '50000' });

      expect(saved.version).toBe(1);
      expect(saved.publishedVersion).toBe(1);
      expect(saved.hasUnpublishedChanges).toBe(false);
      // No snapshot: revision 1 already records these terms.
      expect(written.map((entry) => entry.entity)).toEqual(['ToolBindingEntity']);
    });

    it('still drafts a new revision when the terms differ from the published ones', async () => {
      const { service, written } = build(draft(), versions);

      const saved = await service.update(PROVIDER, SUBJECT, row().id, { priceAmount: '70000' });

      expect(saved.version).toBe(3);
      expect(saved.hasUnpublishedChanges).toBe(true);
      expect(written.map((entry) => entry.entity)).toEqual([
        'ToolBindingEntity',
        'BindingVersionEntity',
      ]);
    });

    it('numbers the next edit past the abandoned draft, whose revision is still stored', async () => {
      // Back at revision 1 after a return, with revision 2 already in `binding_versions`.
      const { service } = build(row({ mappingVersion: 1, publishedVersion: 1 }), versions);

      const saved = await service.update(PROVIDER, SUBJECT, row().id, { priceAmount: '70000' });

      expect(saved.version).toBe(3);
    });

    it('does not return when the same edit also moves the settlement chains', async () => {
      const { service } = build(draft(), versions);

      const saved = await service.update(PROVIDER, SUBJECT, row().id, {
        priceAmount: '50000',
        settlementChains: [PAYOUT_CHAIN, CHAIN_IDS.SOLANA_MAINNET],
      });

      expect(saved.version).toBe(3);
      expect(saved.hasUnpublishedChanges).toBe(true);
    });
  });

  it('refuses to edit a SUSPENDED binding — that state is the platform’s, not the provider’s', async () => {
    const { service } = build(row({ status: BindingStatus.SUSPENDED }));

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, row().id, { timeoutMs: 9000 }),
      ProviderErrorCode.PROVIDER_BINDING_NOT_EDITABLE,
    );
  });

  it('404s for a binding that belongs to somebody else', async () => {
    const { service } = build(null);

    await expectErrorCodeAsync(
      () => service.update(PROVIDER, SUBJECT, 'b1000000-0000-4000-8000-0000000000ff', {}),
      ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    );
  });
});

describe('BindingEditorService.validateMapping — what the editor calls while you type', () => {
  it('returns the canonical form, the selectors and the transforms', async () => {
    const { service } = build();

    const result = await service.validateMapping({
      direction: MappingDirection.RESPONSE,
      mapping: { answer: { $path: '$.data.answer', $transform: ['trim'] } },
      toolId: TOOL.id,
    });

    expect(result.canonical).toEqual({
      // A parameterless transform canonicalises to `{ name, args: {} }`.
      answer: { $path: '$.data.answer', $transform: [{ name: 'trim', args: {} }] },
    });
    expect(result.selectors).toEqual(['$.data.answer']);
    expect(result.transforms).toEqual(['trim']);
  });

  it('applies the contract check too, so the editor is red before Save is pressed', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.validateMapping({
          direction: MappingDirection.RESPONSE,
          mapping: { notAnswer: '$.x' },
          toolId: TOOL.id,
        }),
      ToolErrorCode.TOOL_MAPPING_REQUIRED_FIELD_MISSING,
    );
  });

  it('checks a request mapping without a contract — there is no schema for a provider’s own API', async () => {
    const { service } = build();

    const result = await service.validateMapping({
      direction: MappingDirection.REQUEST,
      mapping: { method: 'GET', path: '/v1/cities/{$.cityId}/now', query: { hl: 'en' } },
      toolId: TOOL.id,
    });

    // `"en"` is a constant, `{$.cityId}` is a selector — the shorthand rule,
    // resolved once and stored.
    expect(result.canonical).toEqual({
      method: 'GET',
      path: '/v1/cities/{$.cityId}/now',
      query: { hl: { $const: 'en' } },
    });
    expect(result.selectors).toEqual(['$.cityId']);
  });
});

/**
 * The provider *declares* the ceiling.
 *
 * The ceiling is a provider ceiling, **self-declared**. `BindingCeilingService`
 * enforces one, but originally no DTO carried the field and no controller accepted it, so the
 * only way to set a ceiling was a raw `UPDATE`: the platform enforced a limit
 * no provider could express.
 *
 * The two facts this block pins:
 *
 * - the editor accepts both figures, on create and on update, and `null`
 *   clears them; and
 * - **neither raises `mapping_version`.** That number describes *what served a
 *   call*; a ceiling describes *how many calls get served*. Forcing a provider
 *   to re-run the mapping tester because they lowered `maxRps` punishes the
 *   act we want them to take freely — the same call the binding editor already made for
 *   `slaFailureRate`.
 *
 * The third ceiling, **timeout**, is not added here: it already exists
 * as `tool_bindings.timeout_ms`, is editable through this same endpoint, and
 * *is* versioned, because a different deadline genuinely changes what served a
 * call. The last case below pins that asymmetry so it reads as a decision.
 */
describe('BindingEditorService — a provider declares their own ceiling', () => {
  it('accepts maxRps and maxDailyCalls on create and on update', async () => {
    const created = build();

    const saved = await created.service.create(
      PROVIDER,
      SUBJECT,
      body({ maxRps: 25, maxDailyCalls: 100_000 }),
    );

    const written = created.written.find((entry) => entry.entity === 'ToolBindingEntity')
      ?.row as ToolBindingEntity;
    expect(written.maxRps).toBe(25);
    expect(written.maxDailyCalls).toBe(100_000);
    // Readable back, or a provider can set a ceiling and never see it again.
    expect(saved.maxRps).toBe(25);
    expect(saved.maxDailyCalls).toBe(100_000);

    const edited = build(row({ maxRps: 25, maxDailyCalls: 100_000 }));
    const updated = await edited.service.update(PROVIDER, SUBJECT, row().id, {
      maxRps: 10,
      maxDailyCalls: 5_000,
    });

    expect(updated.maxRps).toBe(10);
    expect(updated.maxDailyCalls).toBe(5_000);
  });

  it('leaves both null when a provider declares no ceiling at all', async () => {
    const { service, written } = build();

    const saved = await service.create(PROVIDER, SUBJECT, body());

    const stored = written[0].row as ToolBindingEntity;
    // `null`, never `0`: `0` would mean "declared unroutable", which is what
    // the pause button is for.
    expect(stored.maxRps).toBeNull();
    expect(stored.maxDailyCalls).toBeNull();
    expect(saved.maxRps).toBeNull();
  });

  it('does NOT bump mapping_version when only a ceiling changes', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      maxRps: 40,
      maxDailyCalls: 250_000,
    });

    expect(saved.version).toBe(3);
    // No `binding_versions` row either. The snapshot is the revision's
    // evidence; writing one without moving the number would leave two
    // snapshots claiming to be revision 3.
    expect(written.map((entry) => entry.entity)).toEqual(['ToolBindingEntity']);
    expect(saved.hasUnpublishedChanges).toBe(false);
  });

  it('accepts null to clear a ceiling', async () => {
    const { service, written } = build(row({ maxRps: 25, maxDailyCalls: 100_000 }));

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      maxRps: null,
      maxDailyCalls: null,
    });

    const stored = written[0].row as ToolBindingEntity;
    expect(stored.maxRps).toBeNull();
    expect(stored.maxDailyCalls).toBeNull();
    expect(saved.maxRps).toBeNull();
    expect(saved.maxDailyCalls).toBeNull();
    // Clearing is still not a revision.
    expect(saved.version).toBe(3);
  });

  it('leaves a ceiling alone when the PATCH does not mention it', async () => {
    const { service, written } = build(row({ maxRps: 25, maxDailyCalls: 100_000 }));

    await service.update(PROVIDER, SUBJECT, row().id, { slaFailureRate: 0.04 });

    const stored = written[0].row as ToolBindingEntity;
    // `undefined` is "not sent" and `null` is "clear it" — the same
    // distinction `freeQuotaPerAgent` already draws one field up.
    expect(stored.maxRps).toBe(25);
    expect(stored.maxDailyCalls).toBe(100_000);
  });

  it('still raises the revision for timeoutMs — the third ceiling, which does change a call', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, { timeoutMs: 9_000 });

    expect(saved.version).toBe(4);
    expect(written.map((entry) => entry.entity)).toEqual([
      'ToolBindingEntity',
      'BindingVersionEntity',
    ]);
  });

  it('refuses zero or negative', async () => {
    // Zero is not a small ceiling, it is "declared unroutable" — and a
    // provider who wants that has the pause button, which says so on the row
    // and in the console. Refused at the DTO so the only two things that can
    // reach the column are a positive integer and `null`.
    for (const value of [0, -1, -1_000]) {
      expect(
        await invalidProperties(SaveToolBindingBodyDto, saveBody({ maxRps: value })),
      ).toContain('maxRps');
      expect(
        await invalidProperties(SaveToolBindingBodyDto, saveBody({ maxDailyCalls: value })),
      ).toContain('maxDailyCalls');
      expect(await invalidProperties(UpdateToolBindingBodyDto, { maxRps: value })).toContain(
        'maxRps',
      );
      expect(await invalidProperties(UpdateToolBindingBodyDto, { maxDailyCalls: value })).toContain(
        'maxDailyCalls',
      );
    }

    // 1 is the smallest ceiling anyone can mean, and it is accepted.
    expect(await invalidProperties(SaveToolBindingBodyDto, saveBody({ maxRps: 1 }))).toEqual([]);
    expect(await invalidProperties(UpdateToolBindingBodyDto, { maxDailyCalls: 1 })).toEqual([]);
    // So is clearing it, and so is not mentioning it.
    expect(await invalidProperties(UpdateToolBindingBodyDto, { maxRps: null })).toEqual([]);
    expect(await invalidProperties(UpdateToolBindingBodyDto, {})).toEqual([]);
  });

  it('refuses a fractional ceiling — half a call per second is not a thing to shed on', async () => {
    expect(await invalidProperties(SaveToolBindingBodyDto, saveBody({ maxRps: 2.5 }))).toContain(
      'maxRps',
    );
  });
});

/**
 * `settlement_chains` — where a binding is offered.
 *
 * One tool binding may serve both chains: the endpoint is one HTTPS service;
 * only the settlement is chain-bound. The list is the provider's own
 * declaration, carried by the column, the type and the validator. It is
 * **not** a claim that the provider is enrolled or staked on what it names —
 * the write-time gate asks that, and the router re-checks it on every routing
 * decision, and both exist because this
 * list cannot know.
 */
describe('BindingEditorService — the chains a binding is offered on', () => {
  /** Not the chain `STAKE_ASSET` names, which is what makes it a real subject. */
  const OTHER_CHAIN = CHAIN_IDS.SOLANA_MAINNET;

  it('stores the declared list, and does not derive it from assetId', async () => {
    const { service, written } = build(null);

    // The binding is priced on `PAYOUT_CHAIN` and declared on a DIFFERENT
    // chain. Any implementation that reached for `chainIdOf(body.assetId)` —
    // as a default, a fallback or a "correction" — writes `[PAYOUT_CHAIN]`
    // here and fails. That divergence is legal by construction: the model
    // separates *where a provider can be paid* from *where a tool is offered*,
    // and nothing at Save reconciles them.
    await service.create(PROVIDER, SUBJECT, body({ settlementChains: [OTHER_CHAIN] }));

    const stored = written.find((entry) => entry.entity === 'ToolBindingEntity')
      ?.row as ToolBindingEntity;
    expect(stored.settlementChains).toEqual([OTHER_CHAIN]);
    expect(stored.assetId).toBe(STAKE_ASSET);
  });

  it('stores a two-chain list whole', async () => {
    const { service, written } = build(null);

    await service.create(
      PROVIDER,
      SUBJECT,
      body({ settlementChains: [PAYOUT_CHAIN, OTHER_CHAIN] }),
    );

    const stored = written.find((entry) => entry.entity === 'ToolBindingEntity')
      ?.row as ToolBindingEntity;
    expect(stored.settlementChains).toEqual([PAYOUT_CHAIN, OTHER_CHAIN]);
  });

  it('reads the list back on the save response', async () => {
    const { service } = build(null);

    const saved = await service.create(
      PROVIDER,
      SUBJECT,
      body({ settlementChains: [OTHER_CHAIN] }),
    );

    // A dial with no gauge is the failure `maxRps` had before it was put on
    // the read: a provider who can set a value and never see it again cannot
    // answer "why is my tool not routing where I offered it".
    expect(saved.settlementChains).toEqual([OTHER_CHAIN]);
  });

  it('raises the revision when the chains change — a term of the offer moved', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      settlementChains: [PAYOUT_CHAIN, OTHER_CHAIN],
    });

    // In `VERSIONED_FIELDS` for the reason `assetId` is: a reviewer approving a
    // published revision must see where it settles change, rather than find it
    // moved underneath one they already approved. A snapshot is written with it.
    expect(saved.version).toBe(4);
    expect(written.map((entry) => entry.entity)).toEqual([
      'ToolBindingEntity',
      'BindingVersionEntity',
    ]);
    expect(saved.publishedVersion).toBe(3);
    expect(saved.hasUnpublishedChanges).toBe(true);
  });

  it('does not raise the revision when a PATCH re-sends the same chains', async () => {
    const { service, written } = build(row());

    const saved = await service.update(PROVIDER, SUBJECT, row().id, {
      settlementChains: [PAYOUT_CHAIN],
    });

    expect(saved.version).toBe(3);
    expect(written.map((entry) => entry.entity)).toEqual(['ToolBindingEntity']);
  });

  it('leaves the list alone when the PATCH does not mention it', async () => {
    const { service, written } = build(row());

    await service.update(PROVIDER, SUBJECT, row().id, { slaFailureRate: 0.09 });

    const stored = written.find((entry) => entry.entity === 'ToolBindingEntity')
      ?.row as ToolBindingEntity;
    expect(stored.settlementChains).toEqual([PAYOUT_CHAIN]);
  });

  it('refuses an empty list — a binding offered nowhere routes nowhere', async () => {
    // The refusal that matters most, because the failure it prevents is
    // silent: an empty list is a binding that looks healthy in a console and
    // is unroutable, with no screen that says why.
    expect(
      await invalidProperties(SaveToolBindingBodyDto, saveBody({ settlementChains: [] })),
    ).toContain('settlementChains');
    expect(await invalidProperties(UpdateToolBindingBodyDto, { settlementChains: [] })).toContain(
      'settlementChains',
    );
  });

  it('refuses a missing list on create, and accepts its absence on update', async () => {
    const withoutChains = saveBody();
    delete withoutChains.settlementChains;
    expect(await invalidProperties(SaveToolBindingBodyDto, withoutChains)).toContain(
      'settlementChains',
    );

    // `undefined` on a PATCH means "leave it alone", which is every other
    // optional field's meaning here and is not the same as clearing it.
    expect(await invalidProperties(UpdateToolBindingBodyDto, {})).toEqual([]);
  });

  it('refuses an entry that is not a CAIP-2 chain id', async () => {
    for (const value of ['mainnet', 'solana', ':EtWT', 'solana:EtWT/token:abc', '']) {
      expect(
        await invalidProperties(SaveToolBindingBodyDto, saveBody({ settlementChains: [value] })),
      ).toContain('settlementChains');
    }
  });

  it('refuses a bad entry ANYWHERE in the list, not only the first', async () => {
    // `@Matches({ each: true })` is the difference between validating a list
    // and validating its head. A per-element rule that only ever sees index 0
    // is the shape a two-chain list makes reachable for the first time.
    expect(
      await invalidProperties(
        SaveToolBindingBodyDto,
        saveBody({ settlementChains: [PAYOUT_CHAIN, 'mainnet'] }),
      ),
    ).toContain('settlementChains');
  });

  it('accepts a well-formed list of one and of two', async () => {
    expect(
      await invalidProperties(
        SaveToolBindingBodyDto,
        saveBody({ settlementChains: [PAYOUT_CHAIN] }),
      ),
    ).toEqual([]);
    expect(
      await invalidProperties(
        SaveToolBindingBodyDto,
        saveBody({ settlementChains: [PAYOUT_CHAIN, 'eip155:46630'] }),
      ),
    ).toEqual([]);
  });

  it('refuses a bare string where a list belongs', async () => {
    expect(
      await invalidProperties(
        SaveToolBindingBodyDto,
        saveBody({ settlementChains: PAYOUT_CHAIN as unknown }),
      ),
    ).toContain('settlementChains');
  });
});
