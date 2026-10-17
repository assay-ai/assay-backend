import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { SHARING_GRACE_MS } from '@modules/toolset/domain/sharing';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { ResolvedHandle } from '@modules/toolset/services/handles.service';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';

const OWNER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz';
const NOW = new Date('2026-10-17T12:00:00Z');

const entry = (toolId: string, extra: Record<string, unknown> = {}) => ({
  toolId,
  toolName: toolId,
  providerMode: 'BEST',
  providerIds: [],
  minTier: null,
  maxPrice: null,
  minQuality: null,
  requireOutputFields: [],
  onEmpty: 'FAIL',
  ...extra,
});

type Row = Record<string, unknown> & { id: string; slug: string };

/**
 * The shared URL forms of design spec §7.4: `/@handle/slug[@n]`, `/u/token[@n]`
 * and `/my/slug@n`. Every refusal is the same 404 as a missing slug.
 */
describe('McpEndpointResolver — shared toolsets', () => {
  function build(overrides: Partial<Row> = {}, handle: ResolvedHandle | null = ownerHandle()) {
    const toolset: Row = {
      id: 'ts-1',
      ownerOrgId: OWNER,
      slug: 'kit',
      name: 'Draft name',
      discovery: 'AUTO',
      searchThreshold: 25,
      pinnedTools: [],
      visibility: 'PUBLIC',
      listingStatus: 'LISTED',
      graceVisibility: null,
      graceUntil: null,
      unlistedToken: TOKEN,
      removedAt: null,
      deletedAt: null,
      delistedAt: null,
      firstSharedAt: NOW,
      latestVersion: 3,
      lastSharedVersion: 2,
      lastPublicVersion: 2,
      ...overrides,
    };
    const shared = (overrides.sharedAs as string[] | undefined) ?? ['PUBLIC', 'PUBLIC', 'PRIVATE'];
    const versions: Record<number, unknown> = {
      1: version(1, [entry('t1')], shared[0]),
      2: version(
        2,
        [entry('t1'), entry('t2', { providerMode: 'ONLY', providerIds: ['p1'] })],
        shared[1],
      ),
      3: version(3, [entry('t9')], shared[2]),
    };
    const reads = { slug: 0 };
    let sharedEpoch = 1;
    const resolver = new McpEndpointResolver(
      {
        findOwnedBySlug: async (org: string, slug: string) =>
          org === toolset.ownerOrgId && slug === toolset.slug && !toolset.deletedAt
            ? toolset
            : null,
        findHolderOfSlug: async (owner: string | null, slug: string) => {
          reads.slug += 1;
          return owner === toolset.ownerOrgId && slug === toolset.slug ? toolset : null;
        },
        findByUnlistedToken: async (token: string) =>
          token === toolset.unlistedToken ? toolset : null,
      } as never,
      { findByToolsets: async () => [] } as never,
      {
        current: async () => '1',
        currentShared: async () => String(sharedEpoch),
      } as unknown as AccessEpochService,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
      { findVersion: async (_id: string, n: number) => versions[n] ?? null } as never,
      {
        resolve: async (name: string) => (name === 'acme' || name === 'old-acme' ? handle : null),
        handlesOf: async () =>
          handle?.kind === 'ORG' ? new Map([[OWNER, 'acme']]) : new Map<string, string>(),
      } as never,
      () => NOW,
    );
    return { resolver, toolset, reads, bumpShared: () => (sharedEpoch += 1) };
  }

  function ownerHandle(): ResolvedHandle {
    return {
      kind: 'ORG',
      organizationId: OWNER,
      handle: 'acme',
      renamedTo: null,
      aliasUntil: null,
    };
  }

  function version(n: number, entries: unknown[], sharedAs = 'PUBLIC') {
    return {
      toolsetId: 'ts-1',
      version: n,
      sharedAs,
      entries,
      toolIds: (entries as { toolId: string }[]).map((e) => e.toolId),
      discovery: 'FULL',
      searchThreshold: 10,
      pinnedTools: ['t1'],
      name: `Kit v${n}`,
      description: null,
      icon: null,
    };
  }

  const resolve = (resolver: McpEndpointResolver, url: string, org = VIEWER) =>
    resolver.resolve(org, parseMcpUrl(url)!);
  const notFound = { errorCode: McpErrorCode.MCP_URL_NOT_FOUND };

  it('serves a PUBLIC, LISTED toolset at its last shared version, never the Draft', async () => {
    const { resolver } = build();
    const view = await resolve(resolver, '/@acme/kit');
    expect(view.toolset).toMatchObject({ id: 'ts-1', version: 2, latest: true, name: 'Kit v2' });
    expect(view.baseToolIds).toEqual(['t1', 't2']);
    expect(view.entryRules.get('t2')?.providerIds).toEqual(['p1']);
    expect(view.settings).toEqual({ discovery: 'FULL', searchThreshold: 10, pinnedTools: ['t1'] });
    expect(view.handle).toBe('acme');
    expect(view.notice).toBeNull();
    expect(view.canonicalUrl).toBe('https://mcp.example.com/@acme/kit');
  });

  it('serves a pinned version, and 404s for one past the last shared version', async () => {
    const { resolver } = build();
    expect((await resolve(resolver, '/@acme/kit@1')).toolset).toMatchObject({
      version: 1,
      latest: false,
    });
    // v3 was published privately: no shared URL ever serves it.
    await expect(resolve(resolver, '/@acme/kit@3')).rejects.toMatchObject(notFound);
    await expect(resolve(resolver, '/@acme/kit@9')).rejects.toMatchObject(notFound);
  });

  it.each([
    ['UNLISTED', { visibility: 'UNLISTED', listingStatus: null }],
    ['PRIVATE', { visibility: 'PRIVATE', listingStatus: null }],
    ['taken down', { removedAt: NOW }],
    [
      'grace over',
      { visibility: 'PRIVATE', listingStatus: null, graceVisibility: 'PUBLIC', graceUntil: NOW },
    ],
  ])(
    'answers /@handle/slug of a %s toolset with the same 404 as a missing slug',
    async (_, over) => {
      const { resolver } = build(over as Partial<Row>);
      await expect(resolve(resolver, '/@acme/kit')).rejects.toMatchObject(notFound);
      await expect(resolve(resolver, '/@acme/nope')).rejects.toMatchObject(notFound);
    },
  );

  it('keeps serving a delisted toolset until its grace ends, and says so', async () => {
    const until = new Date(NOW.getTime() + SHARING_GRACE_MS);
    const { resolver } = build({
      listingStatus: 'DELISTED',
      delistedAt: NOW,
      graceVisibility: 'PUBLIC',
      graceUntil: until,
    });
    const view = await resolve(resolver, '/@acme/kit');
    expect(view.notice).toEqual({ sharingEndsAt: until, renamedTo: null });
  });

  it('serves an old handle as a rename alias, with the current name', async () => {
    const until = new Date(NOW.getTime() + 1000);
    const { resolver } = build(
      {},
      {
        kind: 'ORG',
        organizationId: OWNER,
        handle: 'old-acme',
        renamedTo: 'acme',
        aliasUntil: until,
      },
    );
    const view = await resolve(resolver, '/@old-acme/kit');
    expect(view.notice).toEqual({ sharingEndsAt: until, renamedTo: 'acme' });
    expect(view.handle).toBe('old-acme');
  });

  it('404s when the handle does not resolve (unknown, frozen, alias expired)', async () => {
    const { resolver } = build({}, null);
    await expect(resolve(resolver, '/@acme/kit')).rejects.toMatchObject(notFound);
  });

  it('serves /u/{token} only with the current token, and not after a takedown', async () => {
    const { resolver } = build({ visibility: 'UNLISTED', listingStatus: null });
    expect((await resolve(resolver, `/u/${TOKEN}`)).toolset?.version).toBe(2);
    expect((await resolve(resolver, `/u/${TOKEN}@1`)).toolset?.version).toBe(1);
    await expect(resolve(resolver, '/u/zyxwvutsrqponmlkjihgfedcba')).rejects.toMatchObject(
      notFound,
    );
    const removed = build({ visibility: 'UNLISTED', listingStatus: null, removedAt: NOW });
    await expect(resolve(removed.resolver, `/u/${TOKEN}`)).rejects.toMatchObject(notFound);
  });

  it('stops /u/ links of an organization whose handle is frozen', async () => {
    const { resolver } = build({ visibility: 'UNLISTED', listingStatus: null }, null);
    await expect(resolve(resolver, `/u/${TOKEN}`)).rejects.toMatchObject(notFound);
  });

  it('serves /my/{slug}@n to the owner only, any published version, even after a takedown', async () => {
    const { resolver } = build({ removedAt: NOW, visibility: 'PRIVATE', listingStatus: null });
    expect((await resolve(resolver, '/my/kit@3', OWNER)).toolset?.version).toBe(3);
    await expect(resolve(resolver, '/my/kit@3', OTHER)).rejects.toMatchObject(notFound);
    await expect(resolve(resolver, '/my/kit@4', OWNER)).rejects.toMatchObject(notFound);
  });

  it('never serves a version published PRIVATE, even below the newest shared one', async () => {
    const { resolver } = build({
      sharedAs: ['PRIVATE', 'PRIVATE', 'PUBLIC'],
      lastSharedVersion: 3,
      lastPublicVersion: 3,
    } as Partial<Row>);
    expect((await resolve(resolver, '/@acme/kit')).toolset?.version).toBe(3);
    await expect(resolve(resolver, '/@acme/kit@1')).rejects.toMatchObject(notFound);
    await expect(resolve(resolver, '/@acme/kit@2')).rejects.toMatchObject(notFound);
    await expect(resolve(resolver, `/u/${TOKEN}@2`)).rejects.toMatchObject(notFound);
    // The owner's own /my/ serves every version.
    expect((await resolve(resolver, '/my/kit@1', OWNER)).toolset?.version).toBe(1);
  });

  it('a PUBLIC grace never serves content published UNLISTED on /@ URLs', async () => {
    const { resolver } = build({
      visibility: 'UNLISTED',
      listingStatus: null,
      graceVisibility: 'PUBLIC',
      graceUntil: new Date(NOW.getTime() + SHARING_GRACE_MS),
      sharedAs: ['PUBLIC', 'PUBLIC', 'UNLISTED'],
      lastSharedVersion: 3,
      lastPublicVersion: 2,
    } as Partial<Row>);
    expect((await resolve(resolver, '/@acme/kit')).toolset?.version).toBe(2);
    await expect(resolve(resolver, '/@acme/kit@3')).rejects.toMatchObject(notFound);
    expect((await resolve(resolver, `/u/${TOKEN}`)).toolset?.version).toBe(3);
  });

  it('caches a shared view once for every organization, until the sharing epoch moves', async () => {
    const { resolver, reads, bumpShared } = build();
    await resolve(resolver, '/@acme/kit', VIEWER);
    await resolve(resolver, '/@acme/kit?tools=t1', OTHER);
    expect(reads.slug).toBe(1);
    bumpShared();
    await resolve(resolver, '/@acme/kit', VIEWER);
    expect(reads.slug).toBe(2);
  });
});
