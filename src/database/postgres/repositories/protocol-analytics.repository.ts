import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CREDITED_SQL } from '@database/postgres/repositories/payment-intent.repository';
import {
  AnalyticsFigures,
  AnalyticsDay,
  AnalyticsTool,
  AnalyticsPaymentGroup,
} from '@modules/protocol-analytics/dto/protocol-analytics.dto';
import { analyticsWindow } from '@modules/protocol-analytics/domain/analytics-window';

export interface AnalyticsSnapshot {
  from: string;
  totals: AnalyticsFigures;
  previous: AnalyticsFigures | null;
  daily: AnalyticsDay[];
  topTools: AnalyticsTool[];
  recent: AnalyticsPaymentGroup[];
  escrow: { available: string; held: string };
  withheldForPrivacy: boolean;
}

function figures(where = 'true'): string {
  const count = (condition: string) => `COUNT(*) FILTER (WHERE ${where} AND ${condition})::int`;
  const amount = (expression: string) =>
    `COALESCE(SUM(${expression}) FILTER (WHERE ${where}), 0)::text`;
  return `jsonb_build_object(
    'paidCalls', ${count('true')},
    'payingAgents', COUNT(DISTINCT agent_account) FILTER (WHERE ${where})::int,
    'toolsEarning', COUNT(DISTINCT tool_id) FILTER (WHERE ${where} AND collected)::int,
    'collectedCalls', ${count('collected')},
    'refundedCalls', ${count('refunded')},
    'pendingCalls', ${count('pending')},
    'volume', ${amount('price_amount')},
    'revenue', ${amount('fee')},
    'providerEarnings', ${amount('earned')},
    'refunded', ${amount('CASE WHEN refunded THEN price_amount ELSE 0 END')},
    'pending', ${amount('CASE WHEN pending THEN price_amount ELSE 0 END')},
    'notCharged', ${amount('price_amount - fee - earned - CASE WHEN refunded OR pending THEN price_amount ELSE 0 END')},
    'passRate', ${count('collected')}::numeric / NULLIF(${count('collected OR refunded')}, 0)
  )`;
}

/**
 * Explicit cross-tenant public read model. Aggregates only; no buyer, wallet,
 * intent, credential, endpoint or transaction identifiers leave this query.
 * A single statement makes money, counts and charts one PostgreSQL snapshot.
 */
export const PROTOCOL_ANALYTICS_SQL = `
WITH funded AS MATERIALIZED (
  SELECT intent.id, intent.organization_id, intent.agent_account, intent.tool_id,
    intent.created_at, intent.price_amount, intent.held_status, intent.decimals,
    h.status AS ledger_hold_status,
    (intent.status = 'SETTLED' AND ${CREDITED_SQL} AND h.status = 'COMMITTED'
      AND (intent.held_status IS NULL OR intent.held_status = 'COLLECTED')) AS collected,
    ((intent.status = 'REFUNDED' OR COALESCE(intent.held_status = 'REFUNDED', false))
      AND intent.hold_released_at IS NOT NULL AND h.status = 'RELEASED') AS refunded
  FROM payment_intents intent
  JOIN ledger_holds h ON h.id = intent.hold_id AND h.organization_id = intent.organization_id
  WHERE intent.asset_id = $1 AND intent.call_class = 'PAID' AND intent.price_amount > 0
    AND intent.hold_id IS NOT NULL
    AND intent.created_at < $2::timestamptz
), entries AS (
  SELECT l.intent_id,
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'PLATFORM_FEE'), 0) AS fee,
    COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'PROVIDER_CREDIT'), 0) AS earned
  FROM ledger_entries l JOIN funded f ON f.id = l.intent_id
  WHERE l.asset_id = $1
    AND l.entry_type IN ('PLATFORM_FEE', 'PROVIDER_CREDIT') AND f.collected
  GROUP BY l.intent_id
), base AS MATERIALIZED (
  SELECT f.*, COALESCE(e.fee, 0) AS fee, COALESCE(e.earned, 0) AS earned,
    (NOT f.collected AND NOT f.refunded AND
      (f.ledger_hold_status = 'OPEN' OR COALESCE(f.held_status = 'HELD', false))) AS pending,
    (f.created_at AT TIME ZONE 'UTC')::date AS day
  FROM funded f LEFT JOIN entries e ON e.intent_id = f.id
), current_calls AS MATERIALIZED (
  SELECT * FROM base WHERE $3::timestamptz IS NULL OR created_at >= $3::timestamptz
), first_agents AS MATERIALIZED (
  SELECT agent_account, MIN(day) AS first_day FROM base GROUP BY agent_account
), first_tools AS MATERIALIZED (
  SELECT tool_id, MIN(day) AS first_day FROM base WHERE collected GROUP BY tool_id
), days AS (
  SELECT day::date FROM generate_series($5::timestamptz AT TIME ZONE 'UTC',
    ($2::timestamptz AT TIME ZONE 'UTC')::date, interval '1 day') day
), daily_figures AS (
  SELECT day, ${figures()} AS figures FROM current_calls GROUP BY day
), named_tools AS MATERIALIZED (
  SELECT c.*, t.name, t.category FROM current_calls c JOIN tools t ON t.id = c.tool_id
  WHERE t.visibility = 'LISTED' AND t.status IN ('ACTIVE', 'DEPRECATED') AND (t.kind = 'STANDARD' OR t.review_status = 'APPROVED')
), public_tools AS (
  SELECT name, category, ${figures()} AS figures FROM named_tools GROUP BY name, category
  HAVING COUNT(DISTINCT organization_id) >= 5
), public_recent AS (
  SELECT day, name, ${figures()} AS figures
  FROM named_tools GROUP BY day, name
  HAVING COUNT(DISTINCT organization_id) >= 5
)
SELECT
  COALESCE((SELECT MIN(created_at) FROM current_calls), $2::timestamptz) AS "from",
  (SELECT ${figures()} FROM current_calls) AS totals,
  CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE
    (SELECT ${figures('created_at >= $4::timestamptz AND created_at < $3::timestamptz')} FROM base)
  END AS previous,
  (SELECT COALESCE(jsonb_agg(COALESCE(f.figures, '{"paidCalls":0,"payingAgents":0,"toolsEarning":0,"collectedCalls":0,"refundedCalls":0,"pendingCalls":0,"volume":"0","revenue":"0","providerEarnings":"0","refunded":"0","pending":"0","notCharged":"0","passRate":null}'::jsonb) || jsonb_build_object(
    'day', to_char(d.day, 'YYYY-MM-DD'),
    'agentsSinceLaunch', (SELECT COUNT(*)::int FROM first_agents a WHERE a.first_day <= d.day),
    'toolsSinceLaunch', (SELECT COUNT(*)::int FROM first_tools t WHERE t.first_day <= d.day)
  ) ORDER BY d.day), '[]') FROM days d LEFT JOIN daily_figures f ON f.day = d.day
    ) AS daily,
  (SELECT COALESCE(jsonb_agg(row), '[]') FROM (
    SELECT jsonb_build_object('name', name, 'category', category,
      'paidCalls', figures->'paidCalls', 'volume', figures->'volume',
      'collectedCalls', figures->'collectedCalls', 'refundedCalls', figures->'refundedCalls',
      'passRate', figures->'passRate') AS row
    FROM public_tools ORDER BY (figures->>'paidCalls')::int DESC, name LIMIT 12
  ) x) AS "topTools",
  (SELECT COALESCE(jsonb_agg(row), '[]') FROM (
    SELECT jsonb_build_object('day', to_char(day, 'YYYY-MM-DD'), 'tool', name,
      'paidCalls', figures->'paidCalls', 'volume', figures->'volume',
      'collectedCalls', figures->'collectedCalls', 'refundedCalls', figures->'refundedCalls') AS row
    FROM public_recent ORDER BY day DESC, name LIMIT 12
  ) x) AS recent,
  (SELECT jsonb_build_object('available', COALESCE(SUM(b.available),0)::text,
    'held', COALESCE(SUM(b.held),0)::text)
    FROM account_balances b WHERE b.asset_id = $1 AND EXISTS (
      SELECT 1 FROM buyer_escrows e WHERE e.organization_id=b.organization_id
        AND e.account_id=b.account_id AND e.asset_id=b.asset_id
    )) AS escrow,
  ((SELECT COUNT(DISTINCT tool_id) FROM current_calls) > (SELECT COUNT(*) FROM public_tools)
    OR (SELECT COUNT(*) FROM (SELECT day, tool_id FROM current_calls GROUP BY day, tool_id) groups)
       > (SELECT COUNT(*) FROM public_recent))
    AS "withheldForPrivacy",
  (EXISTS (SELECT 1 FROM funded WHERE decimals <> $6::int)
    OR EXISTS (SELECT 1 FROM ledger_entries l JOIN funded f ON f.id=l.intent_id
      WHERE l.asset_id=$1 AND l.entry_type IN ('PLATFORM_FEE','PROVIDER_CREDIT') AND l.decimals<>$6::int)
    OR EXISTS (SELECT 1 FROM account_balances WHERE asset_id=$1 AND decimals<>$6::int))
  AS "invalidScale"
`;

@Injectable()
export class ProtocolAnalyticsRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  async read(
    asset: string,
    window: ReturnType<typeof analyticsWindow>,
    decimals = 6,
  ): Promise<AnalyticsSnapshot> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query(`SET LOCAL statement_timeout = '5000ms'`);
      const rows = await manager.query<(AnalyticsSnapshot & { invalidScale: boolean })[]>(
        PROTOCOL_ANALYTICS_SQL,
        [
          asset,
          window.to.toISOString(),
          window.from?.toISOString() ?? null,
          window.previousFrom?.toISOString() ?? null,
          window.chartFrom.toISOString(),
          decimals,
        ],
      );
      const { invalidScale, ...result } = rows[0];
      if (invalidScale)
        throw new Error('Analytics asset scale is inconsistent with recorded amounts');
      return { ...result, from: new Date(result.from).toISOString() };
    });
  }
}
