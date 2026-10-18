import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * An operator drafted a standard contract from a provider tool and invited
 * that tool's provider to bind to it (design spec §7.5 "Promotion").
 *
 * Not organization-scoped: the operator writes it for another organization,
 * and the provider reads its own rows by `organization_id`. Whether the
 * provider bound is not stored: it is whether a binding of theirs exists for
 * the standard tool, read when the invite is shown.
 */
@Entity('tool_promotion_invites')
export class ToolPromotionInviteEntity {
  @PrimaryColumn({ name: 'standard_tool_id', type: 'uuid' })
  standardToolId: string;

  /** The provider tool the contract was drafted from, or one found similar to it. */
  @PrimaryColumn({ name: 'source_tool_id', type: 'uuid' })
  sourceToolId: string;

  /** The provider invited: the source tool's owner. */
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** The operator who sent it. */
  @Column({ name: 'invited_by', type: 'uuid' })
  invitedBy: string;

  @Column({ name: 'invited_at', type: 'timestamptz' })
  invitedAt: Date;

  /** The provider dismissed it. */
  @Column({ name: 'dismissed_at', type: 'timestamptz', nullable: true })
  dismissedAt: Date | null;
}
