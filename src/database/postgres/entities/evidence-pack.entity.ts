import { Column, Entity, Index } from 'typeorm';

import { jsonbSafeTransformer } from './jsonb-safe.transformer';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One verdict's evidence, sealed at the moment it was judged.
 *
 * Written exactly once, inside the same transaction as the compare-and-swap
 * that decides the verdict, and never touched again — `trg_evidence_packs_
 * append_only` refuses `UPDATE` and `DELETE` at the database, so this class
 * deliberately exposes no way to modify a row and the repository has no update
 * method. Both are hedges against the same mistake; neither is sufficient
 * alone, because a trigger cannot stop a developer writing a second write path
 * and a missing method cannot stop `psql`.
 *
 * ## What is inside `core`, and what is deliberately outside it
 *
 * `core` is the sealed document: stage results, the pinned policy, the sampling
 * proof, the semantic model id and prompt version, the verdict, the timestamps.
 * `content_hash` is `sha256(canonicalJson({ core, seq, prevHash }))`.
 *
 * The raw request and response are **not** in it — only their digests, in
 * `core.bodyDigests` and mirrored into `request_sha256` / `response_sha256`.
 * That is what lets `evidence_bodies` be deleted after 72 hours while
 * `content_hash` still recomputes forever. Anything whose value changes over
 * the row's life — body retention state above all — must stay out of the
 * pre-image, or the hash stops being checkable the first time it changes.
 *
 * ## `sealed_at` next to `created_at` is not duplication
 *
 * `created_at` is the database's `now()`. `sealed_at` is the value the sealer
 * computed and **put inside `core.timestamps.sealedAt` before hashing**. They
 * agree in practice and the second is the one under the hash, which is the one
 * an auditor can check. Reading the timestamp off `created_at` would compare a
 * number nobody signed against a document that names a different one.
 */
@Entity('evidence_packs')
@Index('idx_evidence_packs_provider_feed', ['providerId', 'sealedAt'])
export class EvidencePackEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** The `verification_records` row this seals. Unique — one pack per verdict. */
  @Column({ name: 'verdict_id', type: 'uuid' })
  verdictId: string;

  @Column({ name: 'intent_id', type: 'uuid' })
  intentId: string;

  /**
   * The provider who served the call, and therefore who may read this pack.
   *
   * Null only where `verification_records.provider_id` is — a call the router
   * never assigned, which a judged call is not. It is carried here rather than
   * joined because the provider-side read is scoped by it.
   */
  @Column({ name: 'provider_id', type: 'uuid', nullable: true })
  providerId: string | null;

  /**
   * Position in this organization's chain, from 1, with no gaps.
   *
   * Never leaves the buyer's boundary: `seq` counts how many verdicts an
   * organization has had, so returning it on the provider-facing read would
   * publish one tenant's volume to another party.
   */
  @Column({ name: 'seq', type: 'bigint' })
  seq: string;

  /** The sealed document. See the class comment for what belongs in it. */
  // Escaped reversibly, so a judged body that holds U+0000 can still be sealed.
  @Column({ name: 'core', type: 'jsonb', transformer: jsonbSafeTransformer })
  core: Record<string, unknown>;

  /** `sha256:`-prefixed digest of the request body, or null when there was none. */
  @Column({ name: 'request_sha256', type: 'varchar', length: 71, nullable: true })
  requestSha256: string | null;

  @Column({ name: 'response_sha256', type: 'varchar', length: 71, nullable: true })
  responseSha256: string | null;

  /** 64 lower-case hex, no prefix — the column has a CHECK saying so. */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  /** The previous pack's `content_hash`; null on an organization's first pack. */
  @Column({ name: 'prev_hash', type: 'char', length: 64, nullable: true })
  prevHash: string | null;

  @Column({ name: 'sealed_at', type: 'timestamptz' })
  sealedAt: Date;

  /** When the raw bodies stop being kept — `sealed_at + EVIDENCE_BODY_RETENTION_HOURS`. */
  @Column({ name: 'body_expires_at', type: 'timestamptz' })
  bodyExpiresAt: Date;
}
