import { Column, Entity } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * A request for a tool we do not have, with a named owner and a clock — see
 * `1757800000000-create-tool-requests.ts` for why this table is one small
 * ticket rather than a proposal-and-review workflow, and for the two CHECK
 * constraints (`chk_tool_requests_answered_is_timed`,
 * `chk_tool_requests_closed_is_whole`) that `ToolRequestQueueService` must not
 * fight.
 *
 * `OrganizationScopedEntityWithoutSoftDelete`, like `SlashProposalEntity` —
 * there is no financial record here that a soft delete would need to protect,
 * and the base class's automatic `deleted_at IS NULL` filter is one query
 * predicate this table has no use for.
 *
 * ## `organizationId` is the requester's own tenant
 *
 * Unlike `payment_intents` / `verification_records`, where `organization_id`
 * is the *payer's* org and a provider reads by a separate `provider_id`
 * column instead — see `ProviderVerdictsController`'s docstring — a tool
 * request has exactly one party. `organizationId` here is that party, full
 * stop, and `ToolRequestRepository`'s provider-facing methods scope on it in
 * the ordinary way `OrganizationScopedRepository` expects. The operator queue
 * is the one deliberate cross-tenant reader, exactly as `SlashProposalRepository`
 * documents for its own queue.
 */
@Entity('tool_requests')
export class ToolRequestEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /**
   * The agent that filed the ticket, when the caller was an agent session
   * rather than a bare organization actor. Nullable: `McpSession.agentId` is
   * always present on today's callers, but the column does not assume every
   * future caller of this table is one.
   */
  @Column({ name: 'requested_by_agent_id', type: 'uuid', nullable: true })
  requestedByAgentId: string | null;

  @Column({ name: 'title', type: 'varchar', length: 160 })
  title: string;

  @Column({ name: 'description', type: 'text' })
  description: string;

  @Column({ name: 'upstream_url', type: 'varchar', length: 2048, nullable: true })
  upstreamUrl: string | null;

  @Column({ name: 'expected_monthly_calls', type: 'int', nullable: true })
  expectedMonthlyCalls: number | null;

  /** `ToolRequestStatus`. `chk_tool_requests_status`. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'OPEN' })
  status: string;

  /**
   * References `operators`, never a free-text name — "named owner" means an
   * actual row, per the migration's docstring.
   * Nullable until the first response assigns one; `ON DELETE SET NULL` at
   * the database, so an operator who has left is a foreign key that still
   * resolves to who they were rather than a row this table cannot delete.
   */
  @Column({ name: 'owner_operator_id', type: 'uuid', nullable: true })
  ownerOperatorId: string | null;

  /**
   * Two working days from filing, computed once at insert by
   * `computeFirstResponseDueAt` and never re-derived. See that function's
   * docstring and the migration's "the one column that carries the promise".
   */
  @Column({ name: 'first_response_due_at', type: 'timestamptz' })
  firstResponseDueAt: Date;

  /**
   * Set on the first transition out of `OPEN`, whichever of the three
   * outcomes it lands on, and never cleared afterward —
   * `chk_tool_requests_answered_is_timed`.
   */
  @Column({ name: 'first_responded_at', type: 'timestamptz', nullable: true })
  firstRespondedAt: Date | null;

  /** Required exactly when `status` is `ACCEPTED` or `DECLINED`. */
  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote: string | null;

  /** Required exactly when `status` is `ACCEPTED` or `DECLINED`. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
