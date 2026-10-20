import {
  ServingBinding,
  providersLeft,
  routesToPublisher,
} from '@modules/toolset/domain/self-routing';
import { SnapshotEntry } from '@modules/toolset/domain/snapshot';

const PUBLISHER = 'org-publisher';
const RIVAL = 'org-rival';
const TOOL = 'tool-weather';

const entry = (over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  toolId: TOOL,
  toolName: 'get_weather',
  providerMode: 'BEST',
  providerIds: [],
  minTier: null,
  maxPrice: null,
  minQuality: null,
  requireOutputFields: [],
  onEmpty: 'FAIL',
  ...over,
});

const binding = (providerId: string, priceAmount = '100', toolId = TOOL): ServingBinding => ({
  toolId,
  providerId,
  priceAmount,
  assetId: 'usdc',
});

/** "Routes to the publisher's own provider" follows the effect of the rules (spec §7.7). */
describe('self-routing disclosure', () => {
  const both = [binding(PUBLISHER), binding(RIVAL)];

  it('shows for ONLY the publisher, and for EXCLUDE everyone else', () => {
    expect(
      routesToPublisher(
        [entry({ providerMode: 'ONLY', providerIds: [PUBLISHER] })],
        PUBLISHER,
        both,
      ),
    ).toBe(true);
    expect(
      routesToPublisher(
        [entry({ providerMode: 'EXCLUDE', providerIds: [RIVAL] })],
        PUBLISHER,
        both,
      ),
    ).toBe(true);
  });

  it('shows for a standard tool only the publisher serves, even on BEST', () => {
    expect(routesToPublisher([entry()], PUBLISHER, [binding(PUBLISHER)])).toBe(true);
    expect(routesToPublisher([entry()], PUBLISHER, both)).toBe(false);
  });

  it('shows when a price cap leaves only the publisher', () => {
    const capped = entry({ maxPrice: { amount: '50', asset: 'usdc', decimals: 6 } });
    expect(
      routesToPublisher([capped], PUBLISHER, [binding(PUBLISHER, '40'), binding(RIVAL, '60')]),
    ).toBe(true);
    expect(
      routesToPublisher([capped], PUBLISHER, [binding(PUBLISHER, '40'), binding(RIVAL, '50')]),
    ).toBe(false);
  });

  it('does not show when the mode names the publisher but a rival still serves', () => {
    expect(
      routesToPublisher(
        [entry({ providerMode: 'ONLY', providerIds: [PUBLISHER, RIVAL] })],
        PUBLISHER,
        both,
      ),
    ).toBe(false);
    expect(
      routesToPublisher(
        [entry({ providerMode: 'EXCLUDE', providerIds: [PUBLISHER] })],
        PUBLISHER,
        both,
      ),
    ).toBe(false);
  });

  it('follows FALLBACK_BEST when the rules leave nobody', () => {
    const onlyAbsent = { providerMode: 'ONLY', providerIds: [PUBLISHER] };
    expect(providersLeft(entry(onlyAbsent), [binding(RIVAL)])).toEqual(new Set());
    expect(
      providersLeft(entry({ ...onlyAbsent, onEmpty: 'FALLBACK_BEST' }), [binding(RIVAL)]),
    ).toEqual(new Set([RIVAL]));
    expect(
      routesToPublisher([entry({ ...onlyAbsent, onEmpty: 'FALLBACK_BEST' })], PUBLISHER, [
        binding(RIVAL),
      ]),
    ).toBe(false);
  });

  it('needs one tool only, never shows with no provider, and never for an Official set', () => {
    const other = entry({ toolId: 'tool-other', toolName: 'other' });
    expect(
      routesToPublisher([other, entry()], PUBLISHER, [
        binding(RIVAL, '1', 'tool-other'),
        binding(PUBLISHER),
      ]),
    ).toBe(true);
    expect(routesToPublisher([entry()], PUBLISHER, [])).toBe(false);
    expect(routesToPublisher([entry()], null, [binding(PUBLISHER)])).toBe(false);
  });
});
