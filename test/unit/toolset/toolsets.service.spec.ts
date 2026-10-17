import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import {
  TOOLSET_LIMITS,
  ToolsetsService,
  inferCategory,
  slugify,
} from '@modules/toolset/services/toolsets.service';
import { ProviderMode } from '@modules/tool/domain/routing';

const ORG = '2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091';
const ACTOR = { type: 'user' as const, id: 'login-1' };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function build(options: { owned?: number; tools?: number } = {}) {
  const tools = Array.from({ length: options.tools ?? 10 }, (_, i) => ({
    id: uuid(i),
    name: `tool_${i}`,
    category: i % 2 === 0 ? 'weather' : 'maps',
    visibility: 'LISTED',
    status: 'ACTIVE',
  }));
  const service = new ToolsetsService(
    {
      countOwned: async () => options.owned ?? 0,
      findOwned: async () => null,
      findOwnedBySlug: async () => null,
      slugsLike: async () => [],
    } as never,
    { findByToolsets: async () => [] } as never,
    { findByIds: async (ids: string[]) => tools.filter((tool) => ids.includes(tool.id)) } as never,
    { bump: async () => undefined } as never,
    { record: async () => undefined } as never,
    { transaction: async () => ({ id: 'never' }) } as never,
    { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
  );
  return { service, tools };
}

const codeOf = async (work: () => Promise<unknown>) =>
  work().then(
    () => null,
    (error: { errorCode?: string; statusCode?: number }) => ({
      code: error.errorCode,
      status: error.statusCode,
    }),
  );

/** The limits of design spec §7.13; beyond one the REST API answers 429. */
describe('ToolsetsService — limits and validation', () => {
  it(`refuses a ${TOOLSET_LIMITS.toolsetsPerOrg + 1}st tool set per organization with 429`, async () => {
    const { service } = build({ owned: TOOLSET_LIMITS.toolsetsPerOrg });
    expect(await codeOf(() => service.create(ORG, { name: 'One more' }, ACTOR))).toEqual({
      code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED,
      status: 429,
    });
  });

  it(`refuses more than ${TOOLSET_LIMITS.entriesPerToolset} entries with 429`, async () => {
    const { service } = build();
    const entries = Array.from({ length: TOOLSET_LIMITS.entriesPerToolset + 1 }, (_, i) => ({
      toolId: uuid(i),
    }));
    expect(await codeOf(() => service.create(ORG, { name: 'Big', entries }, ACTOR))).toEqual({
      code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED,
      status: 429,
    });
  });

  it(`refuses more than ${TOOLSET_LIMITS.pinnedTools} pinned tools with 429`, async () => {
    const { service, tools } = build();
    const entries = tools.slice(0, 6).map((tool) => ({ toolId: tool.id }));
    expect(
      await codeOf(() =>
        service.create(
          ORG,
          { name: 'Pins', entries, pinnedTools: tools.slice(0, 6).map((tool) => tool.name) },
          ACTOR,
        ),
      ),
    ).toEqual({ code: ToolsetErrorCode.TOOLSET_LIMIT_EXCEEDED, status: 429 });
  });

  it('refuses a pinned tool the tool set does not hold, a duplicate and an unknown tool', async () => {
    const { service, tools } = build();
    expect(
      (
        await codeOf(() =>
          service.create(
            ORG,
            { name: 'Pins', entries: [{ toolId: tools[0].id }], pinnedTools: ['tool_5'] },
            ACTOR,
          ),
        )
      )?.code,
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(
      (
        await codeOf(() =>
          service.create(
            ORG,
            { name: 'Twice', entries: [{ toolId: tools[0].id }, { toolId: tools[0].id }] },
            ACTOR,
          ),
        )
      )?.code,
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    expect(
      (
        await codeOf(() =>
          service.create(ORG, { name: 'Ghost', entries: [{ toolId: uuid(99) }] }, ACTOR),
        )
      )?.code,
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
  });

  it('a provider list must match its mode', async () => {
    const { service, tools } = build();
    for (const entry of [
      { toolId: tools[0].id, providerMode: ProviderMode.BEST, providerIds: [uuid(50)] },
      { toolId: tools[0].id, providerMode: ProviderMode.ONLY, providerIds: [] },
      { toolId: tools[0].id, providerMode: ProviderMode.EXCLUDE },
    ]) {
      expect(
        (await codeOf(() => service.create(ORG, { name: 'Mode', entries: [entry] }, ACTOR)))?.code,
      ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
    }
  });

  it('a maximum price must be in an asset the deployment holds', async () => {
    const { service, tools } = build();
    expect(
      (
        await codeOf(() =>
          service.create(
            ORG,
            {
              name: 'Price',
              entries: [
                { toolId: tools[0].id, maxPrice: { amount: '1', asset: 'eip155:1/erc20:0x0' } },
              ],
            },
            ACTOR,
          ),
        )
      )?.code,
    ).toBe(ToolsetErrorCode.TOOLSET_INVALID);
  });

  it('a tool set of another organization is a 404, never a 403', async () => {
    const { service } = build();
    expect(await codeOf(() => service.get(ORG, uuid(1)))).toEqual({
      code: ToolsetErrorCode.TOOLSET_NOT_FOUND,
      status: 404,
    });
    expect((await codeOf(() => service.delete(ORG, uuid(1), ACTOR)))?.status).toBe(404);
    expect((await codeOf(() => service.replaceEntries(ORG, uuid(1), [], ACTOR)))?.status).toBe(404);
  });
});

describe('ToolsetsService — slugs and categories', () => {
  it.each([
    ['Research', 'research'],
    ['  Crypto Research  Kit! ', 'crypto-research-kit'],
    ['Météo à Paris', 'meteo-a-paris'],
    ['x', 'set-x'],
    ['!!!', 'set-new'],
    ['a'.repeat(80), 'a'.repeat(64)],
  ])('slugify(%j) = %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('infers the most common category, the first one winning a tie', () => {
    const entry = (category: string) => ({ tool: { category } });
    expect(inferCategory([entry('maps'), entry('weather'), entry('weather')])).toBe('weather');
    expect(inferCategory([entry('maps'), entry('weather')])).toBe('maps');
    expect(inferCategory([])).toBeNull();
  });
});
