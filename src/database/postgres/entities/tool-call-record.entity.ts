import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * What a **free** call leaves behind.
 *
 * The relay path creates no payment intent, no hold, no voucher and no ledger
 * write: *"Running holds, ledger entries and settlement over `$0.00` costs the
 * same as running them over `$1.00` and buys nothing."* A free call therefore
 * has no row in `payment_intents`, and this is the row it has instead.
 *
 * Until this table existed, `McpToolCallService` ran the paid machinery over a
 * zero price and `LedgerHoldService.createHold` refused it — *"a hold must
 * reserve a non-zero amount"* — so the first genuinely `FREE` binding answered
 * `409`. No demo binding was `FREE`, which is the only reason that had not
 * surfaced.
 *
 * ## What it is not
 *
 * It is not a financial record and must never be treated as one. There is no
 * amount, no asset and no fee, because nothing moved. Anything that folds money
 * reads `payment_intents`; anything that counts *calls* has to read both, and
 * `GET /tool-calls` currently reads only the first.
 *
 * ## Retention
 *
 * 30 days, then aggregation. `expires_at` is stored rather than derived from
 * `created_at` so the sweep is an index range scan, and so shortening the
 * window later does not retroactively destroy rows written under the old one.
 * `WithoutSoftDelete` because that retention is real deletion — a `deleted_at`
 * on a row the sweep is meant to remove is the row still being there.
 */
@Entity('tool_call_records')
@Index('idx_tool_call_records_organization_id', ['organizationId'])
export class ToolCallRecordEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /**
   * The same id the provider received as `X-Assay-Call-Id`.
   *
   * Unique, so a retried write cannot double-count one free call against the
   * quota that is the only thing standing between the platform and unbounded
   * cost.
   */
  @Column({ name: 'call_id', type: 'uuid' })
  callId: string;

  @Column({ name: 'tool_id', type: 'varchar', length: 128, nullable: true })
  toolId: string | null;

  /** `NULL` when no binding was ever selected — every candidate refused. */
  @Column({ name: 'binding_id', type: 'uuid', nullable: true })
  bindingId: string | null;

  @Column({ name: 'provider_id', type: 'uuid', nullable: true })
  providerId: string | null;

  /**
   * `FREE` or `FREEMIUM` only — `chk_tool_call_records_pricing_mode`.
   *
   * A `PAID` call has a payment intent and belongs in that table. Two rows for
   * one call would make every count in the product ambiguous.
   */
  @Column({ name: 'pricing_mode', type: 'varchar', length: 16, nullable: true })
  pricingMode: string | null;

  /** A `ResponseClass` — classification runs identically on the free path. */
  @Column({ name: 'classification', type: 'varchar', length: 32, nullable: true })
  classification: string | null;

  @Column({ name: 'latency_ms', type: 'int' })
  latencyMs: number;

  /**
   * The routed-call hash, same construction as `payment_intents.request_hash`.
   *
   * Present so the duplicate-call detector sees free traffic too — a retry loop
   * against a free tool is still a retry loop, and it is the platform paying
   * for it rather than the agent.
   */
  @Column({ name: 'request_hash', type: 'varchar', length: 128, nullable: true })
  requestHash: string | null;

  /**
   * Only when the call was sampled for verification — 1% flat, platform-funded,
   * reputation only. `NULL` on every unsampled call, which is almost all of
   * them, and `NULL` here means *not checked*, never *passed*.
   */
  @Column({ name: 'verdict', type: 'varchar', length: 32, nullable: true })
  verdict: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  // ── Attribution: which MCP URL the call came through (design spec §7.8) ──

  /** `ROOT` | `HANDLE` | `CATEGORY` | `TOOLSET` — `EndpointKind`. */
  @Column({ name: 'endpoint_kind', type: 'varchar', length: 12, nullable: true })
  endpointKind: string | null;

  @Column({ name: 'toolset_id', type: 'uuid', nullable: true })
  toolsetId: string | null;

  /** `NULL` with a toolset: the Draft. */
  @Column({ name: 'toolset_version', type: 'int', nullable: true })
  toolsetVersion: number | null;

  @Column({ name: 'endpoint_handle', type: 'varchar', length: 24, nullable: true })
  endpointHandle: string | null;

  /** The view filters that differ from the URL's default, or `NULL`. */
  @Column({ name: 'view_filter', type: 'jsonb', nullable: true })
  viewFilter: Record<string, unknown> | null;

  // ── A refused call (FR-16): nothing reached a provider, nothing was charged ──

  /** The agent-facing code, e.g. `NO_PROVIDER_MATCHES_RULES`. `NULL` on a served call. */
  @Column({ name: 'refusal_code', type: 'varchar', length: 48, nullable: true })
  refusalCode: string | null;

  /** `SERVER` | `AGENT_LIMITS` | `TOOLSET_RULES` — which layer refused it. */
  @Column({ name: 'refusal_layer', type: 'varchar', length: 16, nullable: true })
  refusalLayer: string | null;

  /** On `NO_PROVIDER_MATCHES_RULES`: each provider's reason and source. */
  @Column({ name: 'refusal_detail', type: 'jsonb', nullable: true })
  refusalDetail: Record<string, unknown> | null;

  /** The name the agent asked for — the only identity of a tool that does not exist. */
  @Column({ name: 'tool_name', type: 'varchar', length: 128, nullable: true })
  toolName: string | null;
}
