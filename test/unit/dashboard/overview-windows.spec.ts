import { OVERVIEW_CHART_DAYS, overviewWindows } from '@modules/dashboard/domain/overview-windows';

const DAY_MS = 86_400_000;

/*
 * The dashboard's own window arithmetic, verbatim (`features/buyer/period.ts`
 * `monthPeriod` / `dayPeriod` / `recentDays`, `libs/utc-time.ts`
 * `utcDayBounds`): what `useOverview` sends today, and what `GET /overview`,
 * given only the anchor, must ask its parts for.
 */
function monthPeriod(anchor: Date) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1));
  const to = new Date(Date.UTC(y, m + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function dayPeriod(anchor: Date) {
  const from = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()),
  );
  const to = new Date(from.getTime() + 86_400_000);
  const key = from.toISOString().slice(0, 10);
  return { key, from: from.toISOString(), to: to.toISOString() };
}

function recentDays(anchor: Date, count: number) {
  return Array.from({ length: count }, (_, i) =>
    dayPeriod(new Date(anchor.getTime() - (count - 1 - i) * 86_400_000)),
  );
}

function utcDayBounds(anchor: Date, options: { offsetDays?: number } = {}) {
  const at = anchor.getTime();
  const day = Math.floor(at / DAY_MS) * DAY_MS + (options.offsetDays ?? 0) * DAY_MS;
  return { from: new Date(day).toISOString(), to: new Date(day + DAY_MS).toISOString() };
}

describe('overviewWindows — the windows the dashboard computes, from its anchor', () => {
  const anchors = [
    '2026-10-20T10:30:00.000Z',
    '2026-10-20T00:00:00.000Z',
    '2026-10-20T23:59:59.999Z',
    '2026-11-01T00:00:00.000Z',
    '2026-12-31T23:59:59.999Z',
    '2027-01-01T00:00:00.000Z',
    '2028-02-29T12:00:00.000Z',
    '2028-03-01T00:00:00.001Z',
    '2026-03-29T01:30:00.000Z',
  ];

  it.each(anchors)('equals the browser’s windows at %s', (iso) => {
    const anchor = new Date(iso);
    expect(overviewWindows(anchor)).toEqual({
      month: monthPeriod(anchor),
      today: utcDayBounds(anchor),
      yesterday: utcDayBounds(anchor, { offsetDays: -1 }),
      days: recentDays(anchor, 7),
    });
  });

  it('agrees on a run of anchors across a whole year, every 7 h 13 min', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    for (let at = start; at < start + 366 * DAY_MS; at += 7 * 3_600_000 + 13 * 60_000) {
      const anchor = new Date(at);
      const windows = overviewWindows(anchor);
      expect(windows.month).toEqual(monthPeriod(anchor));
      expect(windows.today).toEqual(utcDayBounds(anchor));
      expect(windows.days).toEqual(recentDays(anchor, OVERVIEW_CHART_DAYS));
    }
  });

  it('ends the chart on today and starts it six days before', () => {
    const windows = overviewWindows(new Date('2026-10-20T10:30:00.000Z'));
    expect(windows.days[0].from).toBe('2026-10-14T00:00:00.000Z');
    expect(windows.days[6]).toEqual({ key: '2026-10-20', ...windows.today });
  });
});
