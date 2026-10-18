import { ToolVersionEntity } from '@database/postgres/entities/tool-version.entity';
import { ToolEntity } from '@database/postgres/entities/tool.entity';
import { McpCatalogueService, providerMetaOf } from '@modules/mcp/services/mcp-catalogue.service';
import { canBind } from '@modules/provider/services/provider-tool-bindings.service';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import {
  Tool,
  ToolKind,
  ToolTier,
  ToolVisibility,
  isNotReviewed,
  isVisibleToOrg,
} from '@modules/tool/ports/tool.types';
import { buildTools } from '@modules/tool/services/database-tool-contracts';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { EndpointKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { ToolsetVisibility } from '@modules/toolset/domain/sharing';
import { McpEndpointView, reachableThrough, selectViewTools } from '@modules/toolset/domain/view';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';
import { holdsUnlisted } from '@modules/toolset/services/toolset-publishing.service';
import { publisherKindOf } from '@modules/toolset/services/toolsets.service';

import { buildTool } from '../tool/helpers/routing-fixtures';

const OWNER = 'org-owner';
const OTHER = 'org-other';
const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };

const standard = buildTool({ id: 's1', name: 'get_weather', category: 'weather' });
const provider = (id: string, visibility: ToolVisibility, owner = OWNER): Tool =>
  buildTool({
    id,
    name: `acme__${id}`,
    category: 'social',
    kind: ToolKind.PROVIDER,
    ownerOrgId: owner,
    visibility,
    reviewed: visibility === ToolVisibility.LISTED,
  });
const privateTool = provider('p_private', ToolVisibility.PRIVATE);
const unlistedTool = provider('p_unlisted', ToolVisibility.UNLISTED);
const listedTool = provider('p_listed', ToolVisibility.LISTED);
const foreignUnlisted = provider('p_foreign', ToolVisibility.UNLISTED, OTHER);
const CATALOGUE = [standard, privateTool, unlistedTool, listedTool, foreignUnlisted];
const ALL_IDS = CATALOGUE.map((tool) => tool.id);

function view(
  path: string,
  toolsetOwner: string | null,
  baseToolIds: string[] | null,
): McpEndpointView {
  const parsed = parseMcpUrl(path)!;
  return {
    canonicalUrl: `https://mcp.example.com${path}`,
    path: parsed.path,
    kind: baseToolIds ? EndpointKind.TOOLSET : EndpointKind.ROOT,
    filter: parsed.filter,
    toolset: baseToolIds
      ? { id: 'ts', slug: 'kit', name: 'Kit', version: 1, latest: false, ownerOrgId: toolsetOwner }
      : null,
    handle: null,
    baseToolIds,
    entryRules: new Map(),
  };
}
const ids = (v: McpEndpointView) => selectViewTools(v, CATALOGUE).tools.map((tool) => tool.id);

/**
 * Where a provider tool is reachable (§7.6 "Reach of an UNLISTED provider
 * tool"), checked on every serve: enumeration of unlisted tools is the
 * attack this guards.
 */
describe('reach of provider tools', () => {
  it('the catalogue-wide views serve LISTED tools only', () => {
    expect(ids(view('/', null, null))).toEqual(['s1', 'p_listed']);
    expect(ids(view('/?tools=acme__p_unlisted,acme__p_private', null, null))).toEqual([]);
  });

  it("/my/ of the owner serves its PRIVATE and UNLISTED tools, never another org's", () => {
    expect(ids(view('/my/kit', OWNER, ALL_IDS))).toEqual([
      's1',
      'p_private',
      'p_unlisted',
      'p_listed',
    ]);
    // The same entries in another org's toolset reach only LISTED tools.
    expect(ids(view('/my/kit', OTHER, ALL_IDS))).toEqual(['s1', 'p_listed', 'p_foreign']);
  });

  it('/u/ of the owner serves its UNLISTED tools, not its PRIVATE ones', () => {
    expect(ids(view('/u/abcdefghijklmnopqrstuvwxyz', OWNER, ALL_IDS))).toEqual([
      's1',
      'p_unlisted',
      'p_listed',
    ]);
  });

  it('/@handle/slug serves LISTED tools only, whatever the snapshot holds', () => {
    expect(ids(view('/@acme/kit', OWNER, ALL_IDS))).toEqual(['s1', 'p_listed']);
    expect(reachableThrough(unlistedTool, view('/@acme/kit', OWNER, ALL_IDS))).toBe(false);
  });

  it('/@{handle} serves only the LISTED provider tools of its owner', () => {
    const handleView = { ...view('/@acme', null, null), baseOwnerOrgId: OWNER };
    expect(ids(handleView)).toEqual(['p_listed']);
  });

  it('a toolset may hold, and publish, only the owner’s own unlisted tools', () => {
    const row = (visibility: string, owner = OWNER) =>
      ({ kind: 'PROVIDER', visibility, ownerOrgId: owner }) as Pick<
        ToolEntity,
        'kind' | 'visibility' | 'ownerOrgId'
      >;
    expect(holdsUnlisted(row('PRIVATE'), OWNER, ToolsetVisibility.PRIVATE)).toBe(true);
    expect(holdsUnlisted(row('PRIVATE'), OWNER, ToolsetVisibility.UNLISTED)).toBe(false);
    expect(holdsUnlisted(row('UNLISTED'), OWNER, ToolsetVisibility.UNLISTED)).toBe(true);
    expect(holdsUnlisted(row('UNLISTED'), OWNER, ToolsetVisibility.PUBLIC)).toBe(false);
    expect(holdsUnlisted(row('UNLISTED', OTHER), OWNER, ToolsetVisibility.UNLISTED)).toBe(false);
    expect(publisherKindOf(OWNER, [{ tool: { kind: 'PROVIDER', ownerOrgId: OWNER } }])).toBe(
      'PROVIDER',
    );
    expect(
      publisherKindOf(OWNER, [
        { tool: { kind: 'PROVIDER', ownerOrgId: OWNER } },
        { tool: { kind: 'STANDARD', ownerOrgId: null } },
      ]),
    ).toBe('USER');
    expect(publisherKindOf(OWNER, [])).toBe('USER');
  });

  it('only a provider binds its own provider tool; nobody sees another org’s unlisted one', () => {
    expect(canBind(standard, OTHER)).toBe(true);
    expect(canBind(listedTool, OWNER)).toBe(true);
    expect(canBind(listedTool, OTHER)).toBe(false);
    expect(canBind(unlistedTool, OTHER)).toBe(false);
    expect(isVisibleToOrg(unlistedTool, OTHER)).toBe(false);
    expect(isVisibleToOrg(unlistedTool, OWNER)).toBe(true);
    expect(isVisibleToOrg(listedTool, OTHER)).toBe(true);
  });
});

describe('/@{handle}', () => {
  const resolverWith = (tools: readonly Tool[], resolved: unknown) =>
    new McpEndpointResolver(
      {} as never,
      {} as never,
      { currentShared: async () => '1', current: async () => '1' } as never,
      HOST,
      {} as never,
      { resolve: async () => resolved } as never,
      { listTools: async () => tools } as never,
    );
  const org = {
    kind: 'ORG',
    organizationId: OWNER,
    handle: 'acme',
    renamedTo: null,
    aliasUntil: null,
  };

  it('serves a maker with a LISTED provider tool', async () => {
    const resolved = await resolverWith(CATALOGUE, org).resolve('viewer', parseMcpUrl('/@acme')!);
    expect(resolved).toMatchObject({ kind: EndpointKind.HANDLE, baseOwnerOrgId: OWNER });
  });

  it('is the same 404 for no LISTED tool, an unknown or frozen handle and Official', async () => {
    for (const [tools, resolved] of [
      [[privateTool, unlistedTool], org],
      [CATALOGUE, null],
      [CATALOGUE, { kind: 'OFFICIAL' }],
    ] as const) {
      await expect(
        resolverWith(tools, resolved).resolve('viewer', parseMcpUrl('/@acme')!),
      ).rejects.toMatchObject({ errorCode: 'MCP_URL_NOT_FOUND' });
    }
  });
});

describe('contracts of provider tools', () => {
  const toolRow = (overrides: Partial<ToolEntity>) =>
    ({
      id: 't1',
      name: 'acme__search',
      kind: 'PROVIDER',
      ownerOrgId: OWNER,
      category: 'social',
      tags: [],
      visibility: 'LISTED',
      reviewStatus: 'PENDING',
      status: 'ACTIVE',
      currentVersion: 1,
      approvedVersion: 1,
      replacementToolId: null,
      ...overrides,
    }) as ToolEntity;
  const versionRow = (overrides: Partial<ToolVersionEntity>) =>
    ({
      toolId: 't1',
      version: 1,
      semver: '1.0.0',
      major: 1,
      summary: 'Approved.',
      description: 'Approved.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      optionalInputFields: [],
      optionalOutputFields: [],
      examples: [],
      tier: 'GUARANTEED',
      status: 'ACTIVE',
      publishedAt: new Date(0),
      ...overrides,
    }) as ToolVersionEntity;

  it('a LISTED provider tool serves approved versions only, never GUARANTEED', () => {
    const tool = buildTools(
      [toolRow({})],
      [versionRow({}), versionRow({ version: 2, semver: '1.0.1', summary: 'Not approved.' })],
    ).get('t1') as Tool;
    expect(tool.versions?.map((version) => version.semver)).toEqual(['1.0.0']);
    expect(tool.tier).toBe(ToolTier.VERIFIED);
    expect(tool.kind).toBe(ToolKind.PROVIDER);
    expect(tool.reviewed).toBe(true);
    expect(isNotReviewed(tool)).toBe(false);
  });

  it('an UNLISTED one is "Not reviewed"', () => {
    const tool = buildTools(
      [toolRow({ visibility: 'UNLISTED', approvedVersion: null, reviewStatus: 'NONE' })],
      [versionRow({ tier: 'UNVERIFIED' })],
    ).get('t1') as Tool;
    expect(isNotReviewed(tool)).toBe(true);
    expect(providerMetaOf(tool)).toEqual({ 'assay/kind': 'PROVIDER', 'assay/notReviewed': true });
    expect(providerMetaOf(standard)).toEqual({});
  });
});

describe('TOOL_REMOVED', () => {
  const removed = {
    id: 'gone',
    name: 'acme__gone',
    visibility: 'LISTED',
    ownerOrgId: OWNER,
    replacementToolName: 'search_posts',
  };
  const removedPrivate = { ...removed, id: 'hidden', name: 'acme__hidden', visibility: 'PRIVATE' };
  const catalogue = new McpCatalogueService(
    {
      listTools: async () => [standard],
      findRemovedByName: async (name: string) =>
        name === removed.name ? removed : name === removedPrivate.name ? removedPrivate : null,
    } as never,
    {} as never,
    {} as never,
    [],
    {} as never,
  );
  const scope = (v: McpEndpointView) => ({
    view: v,
    access: {
      agentId: 'a',
      agent: ALLOW_ALL,
      key: null,
      rules: null,
      pinnedTools: [],
      policyVersion: 1,
    },
    attribution: attributionOf(v),
  });

  it('names a removed tool the URL served, with its replacement', async () => {
    await expect(
      catalogue.admit('acme__gone', scope(view('/', null, null)) as never),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.TOOL_REMOVED,
    });
    await expect(
      catalogue.admit('acme__gone', scope(view('/my/kit', OTHER, ['gone'])) as never),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_REMOVED });
  });

  it('is no oracle: a removed private tool, or one the URL never held, is not in the toolset', async () => {
    await expect(
      catalogue.admit('acme__hidden', scope(view('/', null, null)) as never),
    ).rejects.toMatchObject({
      errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET,
    });
    await expect(
      catalogue.admit('acme__hidden', scope(view('/my/kit', OTHER, ['hidden'])) as never),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
    await expect(
      catalogue.admit('acme__gone', scope(view('/my/kit', OTHER, ['s1'])) as never),
    ).rejects.toMatchObject({ errorCode: ToolAccessErrorCode.TOOL_NOT_IN_TOOLSET });
  });

  it('off the MCP host, only LISTED tools are found by name', async () => {
    const offHost = new McpCatalogueService(
      { listTools: async () => [standard, unlistedTool] } as never,
      {} as never,
      {} as never,
      [],
      {} as never,
    );
    await expect(offHost.findByName('get_weather')).resolves.toMatchObject({ id: 's1' });
    await expect(offHost.findByName('acme__p_unlisted')).rejects.toMatchObject({
      errorCode: 'MCP_TOOL_NOT_FOUND',
    });
  });
});
