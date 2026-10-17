/**
 * Privacy-safe toolset statistics (design spec §7.8, FR-9, FR-10, NFR-4).
 *
 * Pure. The weekly job feeds raw window counts in; only what comes out of
 * {@link publicFigures} and {@link dashboardFigures} is stored in
 * `toolset_stats_published`, and pages and dashboards read nothing else.
 *
 * ```text
 * k = 5 orgs on every figure, public and private
 * Active users   "Fewer than 5" below 5; floor to 5 below 100; floor to 10 from 100
 * Agents, Calls  only when Active users ≥ 5 (agents rounded like users; calls compact)
 * Copies         by distinct copying orgs, same rule as Active users
 * Trend          arrow only, only when both windows have ≥ 5 orgs
 * On latest      only from 20 active orgs, rounded to 10 %
 * ```
 */

export const K_ANONYMITY = 5;
export const ON_LATEST_MIN_ORGS = 20;
export const FEWER_THAN_K = 'Fewer than 5';

/** Raw counts for one 30-day window. Never leaves the server. */
export interface RawWindow {
  /** Distinct calling orgs after excluding the publisher, linked orgs and sybil clusters. */
  readonly activeOrgs: number;
  readonly activeAgents: number;
  readonly calls: number;
  readonly copyOrgs: number;
  /** Active orgs whose last call used the latest version. */
  readonly latestVersionOrgs: number;
  /** Orgs active in this window and the one before. */
  readonly retainedOrgs: number;
}

/** A figure that may be withheld: `value` is the rounded number, `display` what a page shows. */
export interface Figure {
  readonly value: number | null;
  readonly display: string;
}

export enum Trend {
  UP = 'UP',
  DOWN = 'DOWN',
  FLAT = 'FLAT',
}

export interface PublicFigures {
  readonly activeUsers: Figure;
  readonly agents: Figure | null;
  readonly calls30d: Figure | null;
  readonly copies: Figure;
  readonly trend: Trend | null;
  /** Whole percent, a multiple of 10. */
  readonly onLatestVersionPercent: number | null;
}

/** Orgs (or agents): withheld below k, floored to 5 below 100, to 10 from 100. */
export function roundOrgs(n: number): Figure {
  if (n < K_ANONYMITY) return { value: null, display: FEWER_THAN_K };
  const value = n < 100 ? Math.floor(n / 5) * 5 : Math.floor(n / 10) * 10;
  return { value, display: String(value) };
}

/**
 * Calls, compact and floored: `120`, `1.2k`, `35k`, `1.2M`. Below 1,000 the
 * count is floored to 10 as well, so a single call never moves a figure.
 */
export function compactCount(n: number): Figure {
  if (n < 1_000) {
    const value = Math.floor(n / 10) * 10;
    return { value, display: String(value) };
  }
  if (n < 10_000) {
    const value = Math.floor(n / 100) * 100;
    return { value, display: `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` };
  }
  if (n < 1_000_000) {
    const value = Math.floor(n / 1000) * 1000;
    return { value, display: `${value / 1000}k` };
  }
  const value = Math.floor(n / 100_000) * 100_000;
  return { value, display: `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` };
}

export function trendOf(current: RawWindow, previous: RawWindow | null): Trend | null {
  if (!previous) return null;
  if (current.activeOrgs < K_ANONYMITY || previous.activeOrgs < K_ANONYMITY) return null;
  const ratio = current.activeOrgs / previous.activeOrgs;
  if (ratio > 1.1) return Trend.UP;
  if (ratio < 0.9) return Trend.DOWN;
  return Trend.FLAT;
}

export function publicFigures(current: RawWindow, previous: RawWindow | null): PublicFigures {
  const enough = current.activeOrgs >= K_ANONYMITY;
  return {
    activeUsers: roundOrgs(current.activeOrgs),
    agents: enough ? roundOrgs(current.activeAgents) : null,
    calls30d: enough ? compactCount(current.calls) : null,
    copies: roundOrgs(current.copyOrgs),
    trend: trendOf(current, previous),
    onLatestVersionPercent:
      current.activeOrgs >= ON_LATEST_MIN_ORGS
        ? Math.round((current.latestVersionOrgs / current.activeOrgs) * 10) * 10
        : null,
  };
}

/**
 * The catalogue's "Popular" order: retained orgs, never raw installs (§7.8).
 * Active orgs break ties, at a weight no retained org can be outvoted by.
 * Zero below k orgs.
 */
export function popularScore(window: RawWindow): number {
  // Below k the order would rank what the figures withhold: every such
  // toolset scores the same.
  if (window.activeOrgs < K_ANONYMITY) return 0;
  return window.retainedOrgs + window.activeOrgs / 1_000_000;
}

/** "Trending": growth in active orgs, only once a toolset clears k. */
export function trendingScore(current: RawWindow, previous: RawWindow | null): number {
  if (current.activeOrgs < K_ANONYMITY) return 0;
  const before = Math.max(previous?.activeOrgs ?? 0, K_ANONYMITY);
  return (current.activeOrgs - before) / before;
}

// ---------------------------------------------------------------------------
// The publisher dashboard (FR-10)
// ---------------------------------------------------------------------------

export interface RawToolCell {
  readonly toolId: string;
  readonly toolName: string;
  readonly orgs: number;
  readonly calls: number;
  readonly errors: number;
  readonly notCharged: number;
}

export interface RawVersionCell {
  readonly version: number;
  /** Orgs whose last call in the window used this version. */
  readonly orgs: number;
  /** Orgs that called the version before it and made no call after this one was published. */
  readonly stoppedOrgs: number;
}

export interface DashboardToolCell {
  readonly toolId: string;
  readonly toolName: string;
  readonly calls: Figure | null;
  readonly errorRatePercent: number | null;
  readonly notChargedRatePercent: number | null;
  /** Set when 1 to 4 orgs contribute: every number in the row is withheld. */
  readonly withheld: boolean;
}

export interface DashboardVersionCell {
  readonly version: number;
  readonly orgs: Figure;
  readonly stoppedAfterUpdate: Figure;
}

export interface DashboardFigures {
  readonly tools: readonly DashboardToolCell[];
  readonly versions: readonly DashboardVersionCell[];
}

export const FEWER_THAN_K_ORGS = 'Fewer than 5 orgs';

export function dashboardFigures(
  tools: readonly RawToolCell[],
  versions: readonly RawVersionCell[],
): DashboardFigures {
  return {
    tools: tools.map((cell) => {
      const withheld = cell.orgs > 0 && cell.orgs < K_ANONYMITY;
      if (withheld) {
        return {
          toolId: cell.toolId,
          toolName: cell.toolName,
          calls: { value: null, display: FEWER_THAN_K_ORGS },
          errorRatePercent: null,
          notChargedRatePercent: null,
          withheld,
        };
      }
      return {
        toolId: cell.toolId,
        toolName: cell.toolName,
        calls: compactCount(cell.calls),
        errorRatePercent: cell.calls > 0 ? Math.round((cell.errors / cell.calls) * 100) : null,
        notChargedRatePercent:
          cell.calls > 0 ? Math.round((cell.notCharged / cell.calls) * 100) : null,
        withheld,
      };
    }),
    versions: versions.map((cell) => ({
      version: cell.version,
      orgs: orgCell(cell.orgs),
      stoppedAfterUpdate: orgCell(cell.stoppedOrgs),
    })),
  };
}

/** A dashboard org count: 0 shows as 0, 1–4 is withheld, otherwise floored to 5. */
function orgCell(n: number): Figure {
  if (n === 0) return { value: 0, display: '0' };
  if (n < K_ANONYMITY) return { value: null, display: FEWER_THAN_K_ORGS };
  const value = Math.floor(n / 5) * 5;
  return { value, display: String(value) };
}

// ---------------------------------------------------------------------------
// Sybil discount
// ---------------------------------------------------------------------------

/**
 * How many independent parties `orgIds` are, when orgs that share an
 * identity (a wallet, a funding account, a Privy user) count once. Union-find
 * over `links` (`[orgId, identity]`). Until backlog G1.4 scores sybils, this
 * is the discount the data allows.
 */
export function independentParties(
  orgIds: readonly string[],
  links: readonly (readonly [string, string])[],
): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = x;
    while (node !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const members = new Set(orgIds);
  for (const org of members) parent.set(`o:${org}`, `o:${org}`);
  for (const [org, identity] of links) {
    if (!members.has(org)) continue;
    const key = `i:${identity}`;
    if (!parent.has(key)) parent.set(key, key);
    union(`o:${org}`, key);
  }
  const roots = new Set<string>();
  for (const org of members) roots.add(find(`o:${org}`));
  return roots.size;
}
