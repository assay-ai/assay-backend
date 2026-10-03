import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * Who did what, to which resource, when.
 *
 * ## Append-only, and structurally so
 *
 * `WithoutSoftDelete`, and nothing in the codebase updates a row here. An audit
 * log that can be edited answers no question it is asked, because the answer is
 * only as good as the guarantee that nobody rewrote it — and a `deleted_at`
 * column is precisely the affordance for rewriting it while leaving the row
 * count intact.
 *
 * ## Why the actor is a pair, not a user id
 *
 * Most writes on this platform are not made by a person. An agent spending
 * under a policy, the expiry sweep releasing a hold, and an operator raising a
 * cap are three different kinds of actor, and collapsing them into one `user_id`
 * column means the common case (`agent`) either fabricates a user or leaves the
 * column null — at which point "who did this" has no answer for the majority of
 * rows. `actor_type` + `actor_id` keeps the question answerable for all of them.
 *
 * ## `before` / `after` rather than a diff
 *
 * Diffs are computed from states; states cannot be recovered from a diff whose
 * schema has since changed. Storing both endpoints costs jsonb and makes the row
 * self-contained six months and three migrations later, which is when an audit
 * log is actually read.
 */
@Entity('audit_log_entries')
@Index('idx_audit_log_entries_resource', ['organizationId', 'resourceType', 'resourceId'])
@Index('idx_audit_log_entries_actor', ['organizationId', 'actorId'])
export class AuditLogEntryEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** `user` | `agent` | `system` | `provider`. */
  @Column({ name: 'actor_type', type: 'varchar', length: 16 })
  actorType: string;

  /** The user id, agent id, or the name of the job for `system`. */
  @Column({ name: 'actor_id', type: 'varchar', length: 128 })
  actorId: string;

  /** Dotted and past-tense: `spend_policy.updated`, `credential.revoked`. */
  @Column({ name: 'action', type: 'varchar', length: 64 })
  action: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 32 })
  resourceType: string;

  @Column({ name: 'resource_id', type: 'varchar', length: 128, nullable: true })
  resourceId: string | null;

  @Column({ name: 'before', type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ name: 'after', type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  /**
   * Where the request came from.
   *
   * Nullable because a `system` actor has no request behind it, and inventing
   * `127.0.0.1` for the expiry sweep would make the column lie in exactly the
   * rows an investigator is trying to rule out.
   */
  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  /** Correlates this entry with the request log and any other row it wrote. */
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true })
  requestId: string | null;
}
