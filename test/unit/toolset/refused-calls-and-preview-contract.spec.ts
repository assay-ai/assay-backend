import { noFitReasonOf, warningsOf } from '@modules/mcp/services/mcp-url-preview.service';
import { ChainId } from '@modules/chains/ports/caip.types';
import { ToolQuote } from '@modules/tool/services/provider-router.service';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { RefusedCallsService } from '@modules/toolset/services/refused-calls.service';

const ORG = '92a3b4c5-3647-4e89-bafb-1c2d3e4f5061';
const P1 = 'a3b4c5d6-4758-4f9a-8b0c-2d3e4f506172';
const P2 = 'b4c5d6e7-5869-40ab-9c1d-3e4f50617283';

/** The two contract details the web app builds against. */
describe('refused calls — provider names', () => {
  const row = {
    callId: 'c1',
    agentId: 'a1',
    toolId: 't1',
    toolName: 'get_weather',
    refusalCode: 'NO_PROVIDER_MATCHES_RULES',
    refusalLayer: 'AGENT_LIMITS',
    refusalDetail: {
      providers: [
        { providerId: P1, reason: 'EXCLUDED_BY_AGENT', source: 'AGENT', detail: 'x' },
        { providerId: P2, reason: 'BELOW_MIN_TIER', source: 'TOOLSET', detail: 'y' },
      ],
    },
    endpointKind: 'ROOT',
    toolsetId: null,
    toolsetVersion: null,
    viewFilter: null,
    createdAt: new Date('2026-10-17T12:00:00.000Z'),
  };

  it('names each provider, and reads a provider with no row as null', async () => {
    const lookups: string[][] = [];
    const service = new RefusedCallsService(
      { findOneBy: async () => row } as never,
      {
        findDisplayNames: async (ids: string[]) => {
          lookups.push(ids);
          return new Map([[P1, 'Acme Weather, Paris']]);
        },
      } as never,
    );

    const dto = await service.get(ORG, 'c1');

    expect(dto.providers).toEqual([
      expect.objectContaining({ providerId: P1, providerName: 'Acme Weather, Paris' }),
      expect.objectContaining({ providerId: P2, providerName: null }),
    ]);
    expect(lookups).toEqual([[P1, P2]]);
    expect(dto.details).toEqual({});
  });

  const serviceFor = (record: Record<string, unknown>) =>
    new RefusedCallsService(
      { findOneBy: async () => record } as never,
      { findDisplayNames: async () => new Map() } as never,
    );

  it('CONTRACT_VERSION_RETIRED: details.replacement names the tool id, name and version', async () => {
    const dto = await serviceFor({
      ...row,
      refusalCode: 'CONTRACT_VERSION_RETIRED',
      refusalLayer: 'SERVER',
      refusalDetail: {
        toolId: 't1',
        name: 'get_weather',
        replacement: 'get_weather@2 (v2.0.0)',
        replacementTool: { toolId: 't1', name: 'get_weather', major: 2, semver: '2.0.0' },
      },
    }).get(ORG, 'c1');
    expect(dto.details).toEqual({
      replacement: {
        toolId: 't1',
        name: 'get_weather',
        major: 2,
        semver: '2.0.0',
        label: 'get_weather@2 (v2.0.0)',
      },
    });
  });

  it('CONTRACT_VERSION_RETIRED with nothing to replace it: details.replacement is null', async () => {
    const dto = await serviceFor({
      ...row,
      refusalCode: 'CONTRACT_VERSION_RETIRED',
      refusalDetail: {
        toolId: 't1',
        name: 'get_weather',
        replacement: null,
        replacementTool: null,
      },
    }).get(ORG, 'c1');
    expect(dto.details).toEqual({ replacement: null });
  });

  it('CONTRACT_VERSION_MISMATCH: each provider carries servedMajors and requestedRange', async () => {
    const mismatch = {
      providerId: P1,
      reason: 'CONTRACT_VERSION_MISMATCH',
      source: 'MIGRATION',
      detail: 'binding b1 serves ^1, not contract v2.0.0',
      servedMajors: [1],
      requestedMajor: 2,
      requestedRange: [2],
    };
    const dto = await serviceFor({ ...row, refusalDetail: { providers: [mismatch] } }).get(
      ORG,
      'c1',
    );
    expect(dto.providers).toEqual([{ ...mismatch, providerName: null }]);
  });
});

describe('Connect preview — warnings carry tool ids and names', () => {
  const tool = (over: Record<string, unknown>) => ({
    toolId: 'id-x',
    name: 'x',
    category: 'maps',
    listed: true,
    allowed: true,
    pricingMode: PricingMode.PAID,
    price: '$0.01',
    providerCount: 2,
    noProviderFits: false,
    noFitReason: null,
    ...over,
  });

  it('lists each tool as { toolId, name }, and an ignored name with a null id', () => {
    const warnings = warningsOf(
      [
        tool({ toolId: 'id-1', name: 'get_weather', providerCount: 1 }),
        tool({ toolId: 'id-2', name: 'geocode_place', allowed: false, listed: false }),
      ],
      ['nope_tool'],
    );
    expect(warnings).toEqual([
      { code: 'NO_BACKUP_PROVIDER', tools: [{ toolId: 'id-1', name: 'get_weather' }] },
      { code: 'BLOCKED_BY_ACCESS', tools: [{ toolId: 'id-2', name: 'geocode_place' }] },
      { code: 'IGNORED_TOOLS', tools: [{ toolId: null, name: 'nope_tool' }] },
    ]);
  });
});

describe('preview noFitReason: why this agent cannot run a tool, display only', () => {
  const AGENT_CHAIN = 'eip155:46630' as ChainId;
  const quote = (over: Partial<ToolQuote> = {}) =>
    ({
      price: { amount: '100000' },
      pricingMode: PricingMode.PAID,
      settlementChains: [AGENT_CHAIN],
      ...over,
    }) as unknown as ToolQuote;

  it('is null for a tool that runs, and for no quote at all', () => {
    expect(noFitReasonOf(null, AGENT_CHAIN)).toBeNull();
    expect(noFitReasonOf(quote(), AGENT_CHAIN)).toBeNull();
  });

  it('says RULES when the rules emptied the tool', () => {
    const emptied = quote({
      price: null,
      ruleRejections: [
        { providerId: 'p1', reason: 'EXCLUDED_BY_AGENT', source: 'AGENT', detail: '' },
      ] as never,
    });
    expect(noFitReasonOf(emptied, AGENT_CHAIN)).toBe('RULES');
    expect(noFitReasonOf(quote({ price: null }), AGENT_CHAIN)).toBeNull();
  });

  it('says OTHER_CHAIN for a paid or freemium tool not settled on the agent chain', () => {
    const elsewhere = { settlementChains: ['solana:devnet' as ChainId] };
    expect(noFitReasonOf(quote(elsewhere), AGENT_CHAIN)).toBe('OTHER_CHAIN');
    expect(
      noFitReasonOf(quote({ ...elsewhere, pricingMode: PricingMode.FREEMIUM }), AGENT_CHAIN),
    ).toBe('OTHER_CHAIN');
    expect(
      noFitReasonOf(quote({ ...elsewhere, pricingMode: PricingMode.FREE }), AGENT_CHAIN),
    ).toBeNull();
  });
});
