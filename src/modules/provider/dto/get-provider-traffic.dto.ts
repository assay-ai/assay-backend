import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * `GET /providers/me/traffic` — call volume, bucketed by UTC calendar day.
 *
 * Not a cursor list: a bounded window of daily buckets is small enough to
 * return whole, and a client charting it wants every bucket in one response
 * rather than paging through days. Same shape decision `receipts/summary`
 * made — see `ReceiptSummaryService`. Counts calls, not money, so unlike
 * `earnings` there is no asset to disambiguate.
 *
 * `agentId` is `payment_intents.agent_id` — the only per-call agent
 * identifier that exists; there is no `mcp_sessions` table to join against.
 * When present it narrows both the day/status buckets and the agent
 * breakdown to that one caller; when absent the agent breakdown still ships,
 * covering every agent that called this provider in the window.
 */
export class GetProviderTrafficQueryDto {
  @ApiProperty({ description: 'ISO 8601 — inclusive lower bound', example: '2026-08-01T00:00:00Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'ISO 8601 — exclusive upper bound', example: '2026-08-16T00:00:00Z' })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({ description: 'Only calls from this agent (`payment_intents.agent_id`)' })
  @IsOptional()
  @IsUUID()
  agentId?: string;
}

export class ProviderStatusCountDto {
  @ApiProperty({ description: 'One of `PaymentIntentStatus`' })
  status: string;

  @ApiProperty()
  calls: number;
}

export class ProviderTrafficBucketDto {
  @ApiProperty({ description: 'UTC calendar day, `YYYY-MM-DD`' })
  day: string;

  @ApiProperty()
  calls: number;

  @ApiProperty({
    type: [ProviderStatusCountDto],
    description:
      'Every `PaymentIntentStatus`, zero-filled — a status never disappears across buckets',
  })
  byStatus: ProviderStatusCountDto[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'No per-day latency source exists: `payment_intents` records no latency column, and ' +
      '`ProviderStats.p50LatencyMs` is a single rolling snapshot, not bucketed by day. Always `null` ' +
      'until a latency column lands (left undone — see the provider module memory note).',
  })
  p50LatencyMs: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'See `p50LatencyMs` — always `null` today.' })
  p95LatencyMs: number | null;
}

/**
 * One calling agent's volume over the whole window — not bucketed
 * by day, unlike {@link ProviderTrafficBucketDto}: the point of this list is
 * "which agents", so it is grouped by `agentId` and ordered by `calls` desc,
 * truncated to the top callers rather than zero-filled like the day buckets
 * (there is no fixed universe of agent ids to zero-fill against).
 */
export class ProviderAgentTrafficDto {
  @ApiProperty({ description: '`payment_intents.agent_id`' })
  agentId: string;

  @ApiProperty()
  calls: number;

  @ApiProperty({
    type: [ProviderStatusCountDto],
    description: 'Every `PaymentIntentStatus`, zero-filled, for this agent alone',
  })
  byStatus: ProviderStatusCountDto[];
}

export class GetProviderTrafficResponseDto {
  @ApiProperty({ example: '2026-08-01T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-08-16T00:00:00.000Z' })
  to: string;

  @ApiProperty({ type: [ProviderTrafficBucketDto] })
  buckets: ProviderTrafficBucketDto[];

  @ApiProperty({ description: 'Σ calls across every bucket' })
  totalCalls: number;

  @ApiProperty({
    type: [ProviderAgentTrafficDto],
    description:
      'Calls per agent over the whole period, status split, ordered by `calls` desc — top 10 ' +
      'callers. Narrowed to one agent when `agentId` is passed on the request.',
  })
  agentBreakdown: ProviderAgentTrafficDto[];
}
