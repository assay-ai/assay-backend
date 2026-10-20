/**
 * The windows the buyer Overview reads, from one anchor instant.
 *
 * The dashboard computes these in the browser today (`features/buyer/period.ts`
 * `monthPeriod` / `recentDays`, `libs/utc-time.ts` `utcDayBounds`) and sends
 * them as `from` / `to`; `GET /overview` takes the anchor instead and computes
 * the same windows with the same arithmetic, so each nested part is asked for
 * the window the browser would have asked for. All UTC, all half-open
 * `[from, to)`, rendered with `toISOString()` like the browser renders them.
 */

const DAY_MS = 86_400_000;

export interface OverviewWindow {
  readonly from: string;
  readonly to: string;
}

export interface OverviewDayWindow extends OverviewWindow {
  /** `2026-08-19`. */
  readonly key: string;
}

export interface OverviewWindows {
  readonly month: OverviewWindow;
  readonly today: OverviewWindow;
  readonly yesterday: OverviewWindow;
  /** The last `OVERVIEW_CHART_DAYS` UTC days ending today, oldest first. */
  readonly days: readonly OverviewDayWindow[];
}

/** The chart's length: `recentDays(anchor, 7)`. */
export const OVERVIEW_CHART_DAYS = 7;

/** `monthPeriod`: the anchor's UTC month. */
export function monthWindow(anchor: Date): OverviewWindow {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  return {
    from: new Date(Date.UTC(y, m, 1)).toISOString(),
    to: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

/** `utcDayBounds`: the anchor's UTC day, moved by `offsetDays`. */
export function utcDayWindow(anchor: Date, offsetDays = 0): OverviewWindow {
  const day = Math.floor(anchor.getTime() / DAY_MS) * DAY_MS + offsetDays * DAY_MS;
  return { from: new Date(day).toISOString(), to: new Date(day + DAY_MS).toISOString() };
}

/** `dayPeriod`: the UTC calendar day the anchor falls on, with its key. */
function dayPeriod(anchor: Date): OverviewDayWindow {
  const from = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()),
  );
  const to = new Date(from.getTime() + DAY_MS);
  return { key: from.toISOString().slice(0, 10), from: from.toISOString(), to: to.toISOString() };
}

/** `recentDays`: the last `count` days ending on the anchor's, oldest first. */
export function recentDayWindows(anchor: Date, count: number): OverviewDayWindow[] {
  return Array.from({ length: count }, (_, i) =>
    dayPeriod(new Date(anchor.getTime() - (count - 1 - i) * DAY_MS)),
  );
}

export function overviewWindows(anchor: Date): OverviewWindows {
  return {
    month: monthWindow(anchor),
    today: utcDayWindow(anchor),
    yesterday: utcDayWindow(anchor, -1),
    days: recentDayWindows(anchor, OVERVIEW_CHART_DAYS),
  };
}
