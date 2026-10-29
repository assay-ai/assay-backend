import { AnalyticsRange } from '../dto/protocol-analytics.dto';

export const ANALYTICS_CACHE_MS = 2_000;
export const DAY_MS = 86_400_000;

/** Includes the partial current UTC day. Previous is the same elapsed length. */
export function analyticsWindow(range: AnalyticsRange, now: Date) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = range === 'all' ? 90 : Number.parseInt(range, 10);
  const chartFrom = new Date(today.getTime() - (days - 1) * DAY_MS);
  const from = range === 'all' ? null : chartFrom;
  const previousFrom = from ? new Date(from.getTime() - (now.getTime() - from.getTime())) : null;
  return { from, to: now, chartFrom, previousFrom };
}
