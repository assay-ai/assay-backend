import { warningsOf } from '@modules/mcp/services/mcp-url-preview.service';
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
