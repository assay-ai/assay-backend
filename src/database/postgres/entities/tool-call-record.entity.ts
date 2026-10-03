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
   * The same id the provider received as `X-X402-Call-Id`.
   *
   * Unique, so a retried write cannot double-count one free call against the
   * quota that is the only thing standing between the platform and unbounded
   * cost.
   */
  @Column({ name: 'call_id', type: 'uuid' })
  callId: string;

  @Column({ name: 'tool_id', type: 'varchar', length: 128 })
  toolId: string;

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
  @Column({ name: 'pricing_mode', type: 'varchar', length: 16 })
  pricingMode: string;

  /** A `ResponseClass` — classification runs identically on the free path. */
  @Column({ name: 'classification', type: 'varchar', length: 32 })
  classification: string;

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
}
