import { ProviderTier } from '@modules/provider/ports/provider.types';
import { OnEmpty, ProviderMode } from '@modules/tool/domain/routing';
import { PricingMode, Tool, ToolTier } from '@modules/tool/ports/tool.types';
import {
  ALLOW_ALL,
  AccessMode,
  ToolAccessStanding,
  accessAllows,
  buildGrant,
  grantAllows,
  readAllowedToolsets,
  toolStanding,
} from '@modules/toolset/domain/access';
import { EMPTY_FILTER, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { entryRulesOf, selectViewTools, servesPricingMode } from '@modules/toolset/domain/view';

const KIT = 'toolset-kit';
const OTHER = 'toolset-other';

/**
 * Access (design spec §7.7, FR-3): what an agent — or one key — may call,
 * whatever URL the call comes through. A key only narrows: its grant is
 * intersected with its agent's.
 */
describe('access — one grant', () => {
  const restricted = buildGrant(
    AccessMode.RESTRICTED,
    ['tool-direct'],
    [
      { toolsetId: KIT, version: null, viaUrlOnly: true },
      { toolsetId: OTHER, version: null, viaUrlOnly: false },
    ],
    (ref) => (ref.toolsetId === KIT ? ['tool-kit'] : ['tool-other']),
  );

  it('ALL allows everything, on every URL', () => {
    expect(grantAllows(ALLOW_ALL, 'anything', null)).toBe(true);
  });

  it('RESTRICTED allows a listed tool on every URL', () => {
    expect(grantAllows(restricted, 'tool-direct', null)).toBe(true);
    expect(grantAllows(restricted, 'tool-direct', KIT)).toBe(true);
  });

  it('allows a viaUrlOnly toolset tool only through that toolset URL', () => {
    expect(grantAllows(restricted, 'tool-kit', KIT)).toBe(true);
    expect(grantAllows(restricted, 'tool-kit', null)).toBe(false);
    expect(grantAllows(restricted, 'tool-kit', OTHER)).toBe(false);
  });

  it('allows a toolset tool everywhere when viaUrlOnly is off', () => {
    expect(grantAllows(restricted, 'tool-other', null)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(grantAllows(restricted, 'tool-unknown', KIT)).toBe(false);
  });

  it('reads a stored list defensively, failing closed', () => {
    expect(
      readAllowedToolsets([
        { toolsetId: KIT, version: null, viaUrlOnly: false },
        { toolsetId: OTHER },
        { version: 3 },
        'junk',
      ]),
    ).toEqual([
      { toolsetId: KIT, version: null, viaUrlOnly: false },
      // viaUrlOnly defaults to on: the safer reading.
      { toolsetId: OTHER, version: null, viaUrlOnly: true },
    ]);
    expect(readAllowedToolsets(null)).toEqual([]);
  });
});

describe('access — agent ∩ key narrowing', () => {
  const agent = buildGrant(AccessMode.RESTRICTED, ['a', 'b'], [], () => []);
  const keyOnlyA = buildGrant(AccessMode.RESTRICTED, ['a'], [], () => []);
  const keyWider = buildGrant(AccessMode.RESTRICTED, ['a', 'b', 'c'], [], () => []);

  it('no narrowing: the agent decides', () => {
    expect(accessAllows({ agent, key: null }, 'b', null)).toBe(true);
    expect(accessAllows({ agent, key: null }, 'c', null)).toBe(false);
  });

  it('a key narrows the agent', () => {
    expect(accessAllows({ agent, key: keyOnlyA }, 'a', null)).toBe(true);
    expect(accessAllows({ agent, key: keyOnlyA }, 'b', null)).toBe(false);
  });

  it('a key can never widen the agent', () => {
    expect(accessAllows({ agent, key: keyWider }, 'c', null)).toBe(false);
    expect(accessAllows({ agent: ALLOW_ALL, key: keyOnlyA }, 'b', null)).toBe(false);
  });

  it('reports the standing a settings screen shows', () => {
    const viaUrl = buildGrant(
      AccessMode.RESTRICTED,
      [],
      [{ toolsetId: KIT, version: null, viaUrlOnly: true }],
      () => ['tool-kit'],
    );
    expect(toolStanding({ agent: viaUrl, key: null }, 'tool-kit')).toBe(
      ToolAccessStanding.VIA_TOOLSET_URL,
    );
    expect(toolStanding({ agent: ALLOW_ALL, key: null }, 'x')).toBe(ToolAccessStanding.ALLOWED);
    expect(toolStanding({ agent: viaUrl, key: null }, 'x')).toBe(ToolAccessStanding.BLOCKED);
  });
});

const tool = (id: string, name: string, category: string): Tool => ({
  id,
  name,
  category,
  description: `${name}.`,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
});

describe('views — what a URL serves before access', () => {
  const catalogue = [
    tool('t1', 'get_weather', 'weather'),
    tool('t2', 'geocode_place', 'maps'),
    tool('t3', 'get_token_market', 'crypto'),
  ];

  it('the root serves the catalogue in its order', () => {
    const { tools } = selectViewTools({ baseToolIds: null, filter: EMPTY_FILTER }, catalogue);
    expect(tools.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('a toolset serves its entries in entry order, skipping unknown ids', () => {
    const { tools } = selectViewTools(
      { baseToolIds: ['t3', 'missing', 't1'], filter: EMPTY_FILTER },
      catalogue,
    );
    expect(tools.map((t) => t.id)).toEqual(['t3', 't1']);
  });

  it('?tools= narrows and reports what it ignored, including a name outside the toolset', () => {
    const filter = parseMcpUrl('/?tools=get_weather,nope_tool,get_token_market@2')!.filter;
    expect(selectViewTools({ baseToolIds: null, filter }, catalogue)).toEqual({
      tools: [catalogue[0]],
      ignoredTools: ['get_token_market@2', 'nope_tool'],
    });
    const inToolset = selectViewTools(
      { baseToolIds: ['t2'], filter: parseMcpUrl('/?tools=get_weather')!.filter },
      catalogue,
    );
    expect(inToolset).toEqual({ tools: [], ignoredTools: ['get_weather'] });
  });

  it('?category= keeps those categories', () => {
    const filter = parseMcpUrl('/?category=maps,crypto')!.filter;
    expect(
      selectViewTools({ baseToolIds: null, filter }, catalogue).tools.map((t) => t.id),
    ).toEqual(['t2', 't3']);
  });

  it('filters only ever narrow: an empty toolset stays empty whatever the filter names', () => {
    const filter = parseMcpUrl('/?tools=get_weather&category=weather')!.filter;
    expect(selectViewTools({ baseToolIds: [], filter }, catalogue).tools).toEqual([]);
  });

  it('?free=1 keeps FREE and FREEMIUM only', () => {
    const free = parseMcpUrl('/?free=1')!.filter;
    expect(servesPricingMode(free, PricingMode.FREE)).toBe(true);
    expect(servesPricingMode(free, PricingMode.FREEMIUM)).toBe(true);
    expect(servesPricingMode(free, PricingMode.PAID)).toBe(false);
    expect(servesPricingMode(EMPTY_FILTER, PricingMode.PAID)).toBe(true);
  });

  it('reads an entry rule, and an entry that sets nothing as no rule', () => {
    const base = {
      providerMode: ProviderMode.BEST,
      providerIds: [],
      minTier: null,
      maxPriceAmount: null,
      maxPriceAssetId: null,
      maxPriceDecimals: null,
      minQuality: null,
      onEmpty: OnEmpty.FAIL,
    };
    expect(entryRulesOf(base)).toBeNull();
    expect(
      entryRulesOf({
        ...base,
        providerMode: ProviderMode.ONLY,
        providerIds: ['p1'],
        minTier: ProviderTier.ESTABLISHED,
        maxPriceAmount: '10000',
        maxPriceAssetId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:x',
        maxPriceDecimals: 6,
        minQuality: '0.900',
        onEmpty: OnEmpty.FALLBACK_BEST,
      }),
    ).toEqual({
      mode: ProviderMode.ONLY,
      providerIds: ['p1'],
      minTier: ProviderTier.ESTABLISHED,
      maxPrice: {
        amount: '10000',
        asset: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:x',
        decimals: 6,
      },
      minQuality: 0.9,
      onEmpty: OnEmpty.FALLBACK_BEST,
    });
  });
});
