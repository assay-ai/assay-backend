import { Column, Entity, Index } from 'typeorm';

import { jsonbSafeTransformer } from './jsonb-safe.transformer';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * The raw request and response an evidence pack was sealed over, kept for the
 * published retention window and then deleted whole.
 *
 * Separate from `evidence_packs` because the two have opposite lifetimes: the
 * pack must never change, and this must disappear on schedule. Merging them
 * would mean the append-only trigger needs a carve-out for the retention job,
 * and that carve-out is the way evidence gets rewritten by whoever can reach
 * the job. Deleting a row here is the policy working; there is no code path,
 * and no trigger exception, that edits one.
 *
 * `organization_id` is denormalised from the pack rather than joined, because
 * the column is on every table and the scope guard reads it here.
 *
 * Nothing is lost when a row goes: `evidence_packs.request_sha256` and
 * `response_sha256` outlive it, so a provider holding their own access log can
 * still prove their copy is the one that was judged.
 */
@Entity('evidence_bodies')
@Index('idx_evidence_bodies_expiry', ['expiresAt'])
export class EvidenceBodyEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'pack_id', type: 'uuid' })
  packId: string;

  /** The request as sent upstream, parsed. Null when the call had no body. */
  @Column({
    name: 'request',
    type: 'jsonb',
    nullable: true,
    // U+0000 and lone surrogates are escaped reversibly — see the transformer.
    transformer: jsonbSafeTransformer,
  })
  request: Record<string, unknown> | null;

  @Column({
    name: 'response',
    type: 'jsonb',
    nullable: true,
    // U+0000 and lone surrogates are escaped reversibly — see the transformer.
    transformer: jsonbSafeTransformer,
  })
  response: Record<string, unknown> | null;

  /** `sealed_at + EVIDENCE_BODY_RETENTION_HOURS`; the sweep's only predicate. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
