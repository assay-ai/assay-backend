import {
  SnapshotEntry,
  ToolsetSnapshot,
  changelogOf,
  diffSnapshots,
  isEmptyDiff,
  readSnapshotEntries,
} from '@modules/toolset/domain/snapshot';
import {
  FEWER_THAN_K,
  FEWER_THAN_K_ORGS,
  RawWindow,
  Trend,
  compactCount,
  dashboardFigures,
  independentParties,
  popularScore,
  publicFigures,
  roundOrgs,
  trendingScore,
} from '@modules/toolset/domain/stats';

const entry = (toolId: string, toolName: string, extra: Partial<SnapshotEntry> = {}) => ({
  toolId,
  toolName,
  providerMode: 'BEST',
  providerIds: [],
  minTier: null,
  maxPrice: null,
  minQuality: null,
  requireOutputFields: [],
  onEmpty: 'FAIL',
  ...extra,
});
const snapshot = (
  entries: SnapshotEntry[],
  extra: Partial<ToolsetSnapshot> = {},
): ToolsetSnapshot => ({
  entries,
  discovery: 'AUTO',
  searchThreshold: 25,
  pinnedTools: [],
  name: 'Kit',
  description: null,
  icon: null,
  ...extra,
});

describe('toolset snapshots', () => {
  it('diffs added, removed, rule and setting changes, and writes the changelog', () => {
    const v1 = snapshot([entry('a', 'get_weather'), entry('b', 'geocode_place')]);
    const v2 = snapshot(
      [
        entry('a', 'get_weather', { providerMode: 'ONLY', providerIds: ['p1'] }),
        entry('c', 'get_token_market'),
      ],
      { discovery: 'SEARCH' },
    );
    const diff = diffSnapshots(v1, v2);
    expect(diff).toEqual({
      added: ['get_token_market'],
      removed: ['geocode_place'],
      rulesChanged: ['get_weather'],
      settingsChanged: ['discovery'],
    });
    expect(changelogOf(diff, false)).toBe(
      'Added get_token_market. Removed geocode_place. Changed rules for get_weather. Changed discovery.',
    );
    expect(changelogOf(diffSnapshots(null, v1), true)).toBe('First version: 2 tools.');
    expect(isEmptyDiff(diffSnapshots(v1, v1))).toBe(true);
    expect(changelogOf(diffSnapshots(v1, v1), false)).toBe('No changes.');
  });

  it('caps a generated changelog at 500 characters', () => {
    const many = Array.from({ length: 80 }, (_, n) => entry(`t${n}`, `tool_number_${n}`));
    expect(changelogOf(diffSnapshots(snapshot([]), snapshot(many)), false).length).toBe(500);
  });

  it('reads stored entries defensively', () => {
    expect(readSnapshotEntries('nope')).toEqual([]);
    expect(readSnapshotEntries([null, { toolName: 'x' }, { toolId: 'a' }])).toEqual([
      entry('a', ''),
    ]);
  });
});

describe('toolset statistics (k = 5, rounding)', () => {
  const window = (over: Partial<RawWindow>): RawWindow => ({
    activeOrgs: 0,
    activeAgents: 0,
    calls: 0,
    copyOrgs: 0,
    latestVersionOrgs: 0,
    retainedOrgs: 0,
    ...over,
  });

  it.each([
    [0, null, FEWER_THAN_K],
    [4, null, FEWER_THAN_K],
    [5, 5, '5'],
    [99, 95, '95'],
    [100, 100, '100'],
    [137, 130, '130'],
  ])('active users %i → %s', (n, value, display) => {
    expect(roundOrgs(n)).toEqual({ value, display });
  });

  it.each([
    [7, '0'],
    [129, '120'],
    [1234, '1.2k'],
    [2000, '2k'],
    [35_400, '35k'],
    [1_260_000, '1.2M'],
  ])('calls %i → %s', (n, display) => {
    expect(compactCount(n).display).toBe(display);
  });

  it('withholds agents and calls below k, and the latest-version share below 20 orgs', () => {
    const small = publicFigures(
      window({ activeOrgs: 4, activeAgents: 9, calls: 900, copyOrgs: 3 }),
      null,
    );
    expect(small.activeUsers.display).toBe(FEWER_THAN_K);
    expect(small.agents).toBeNull();
    expect(small.calls30d).toBeNull();
    expect(small.copies.display).toBe(FEWER_THAN_K);
    expect(small.onLatestVersionPercent).toBeNull();

    const mid = publicFigures(
      window({ activeOrgs: 12, activeAgents: 17, calls: 1234, latestVersionOrgs: 12 }),
      null,
    );
    expect(mid.agents?.display).toBe('15');
    expect(mid.calls30d?.display).toBe('1.2k');
    expect(mid.onLatestVersionPercent).toBeNull();

    const big = publicFigures(window({ activeOrgs: 23, latestVersionOrgs: 15 }), null);
    expect(big.onLatestVersionPercent).toBe(70);
  });

  it('shows a trend only when both windows clear k', () => {
    expect(publicFigures(window({ activeOrgs: 20 }), window({ activeOrgs: 4 })).trend).toBeNull();
    expect(publicFigures(window({ activeOrgs: 20 }), window({ activeOrgs: 10 })).trend).toBe(
      Trend.UP,
    );
    expect(publicFigures(window({ activeOrgs: 5 }), window({ activeOrgs: 10 })).trend).toBe(
      Trend.DOWN,
    );
    expect(publicFigures(window({ activeOrgs: 10 }), window({ activeOrgs: 10 })).trend).toBe(
      Trend.FLAT,
    );
  });

  it('ranks by retained orgs, then active orgs', () => {
    const retained = popularScore(window({ activeOrgs: 10, retainedOrgs: 8 }));
    const churny = popularScore(window({ activeOrgs: 100, retainedOrgs: 7 }));
    expect(retained).toBeGreaterThan(churny);
    expect(trendingScore(window({ activeOrgs: 4 }), null)).toBe(0);
    expect(trendingScore(window({ activeOrgs: 10 }), window({ activeOrgs: 5 }))).toBe(1);
  });

  it('withholds every dashboard cell 1 to 4 orgs contribute to', () => {
    const figures = dashboardFigures(
      [
        { toolId: 'a', toolName: 'a', orgs: 3, calls: 500, errors: 5, notCharged: 1 },
        { toolId: 'b', toolName: 'b', orgs: 6, calls: 200, errors: 10, notCharged: 4 },
        { toolId: 'c', toolName: 'c', orgs: 0, calls: 0, errors: 0, notCharged: 0 },
      ],
      [
        { version: 1, orgs: 2, stoppedOrgs: 0 },
        { version: 2, orgs: 12, stoppedOrgs: 7 },
      ],
    );
    expect(figures.tools[0]).toMatchObject({ withheld: true, errorRatePercent: null });
    expect(figures.tools[0].calls?.display).toBe(FEWER_THAN_K_ORGS);
    expect(figures.tools[1]).toMatchObject({
      withheld: false,
      errorRatePercent: 5,
      notChargedRatePercent: 2,
    });
    expect(figures.tools[2]).toMatchObject({ withheld: false, errorRatePercent: null });
    expect(figures.versions[0].orgs.display).toBe(FEWER_THAN_K_ORGS);
    expect(figures.versions[0].stoppedAfterUpdate.display).toBe('0');
    expect(figures.versions[1].orgs.display).toBe('10');
    expect(figures.versions[1].stoppedAfterUpdate.display).toBe('5');
  });

  it('counts orgs that share a wallet, funding account or Privy user once', () => {
    const orgs = ['o1', 'o2', 'o3', 'o4'];
    expect(independentParties(orgs, [])).toBe(4);
    expect(
      independentParties(orgs, [
        ['o1', 'wallet:x'],
        ['o2', 'wallet:x'],
        ['o2', 'fund:y'],
        ['o3', 'fund:y'],
        ['o9', 'fund:y'],
      ]),
    ).toBe(2);
  });
});
