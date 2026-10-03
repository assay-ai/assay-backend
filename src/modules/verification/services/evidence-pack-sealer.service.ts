import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';

import {
  EVIDENCE_RETENTION_CONFIG,
  EvidenceRetentionConfig,
} from '../config/evidence-retention.config';
import { buildEvidenceCore, computeContentHash } from '../domain/evidence/pack';
import { EvidenceRecordSnapshot } from '../domain/evidence/pack.types';

export interface SealEvidenceInput {
  /** The record as it stands *after* the judging patch, not before it. */
  readonly record: EvidenceRecordSnapshot;
  readonly request: unknown;
  readonly response: unknown;
  /** Injected, and the same instant that goes inside the hashed core. */
  readonly sealedAt: Date;
}

export interface SealedEvidence {
  readonly id: string;
  readonly seq: number;
  readonly contentHash: string;
  readonly prevHash: string | null;
  readonly sealedAt: Date;
  readonly bodyExpiresAt: Date;
}

/**
 * Seals one verdict's evidence, inside the transaction that decided it.
 *
 * ## Why this takes a `QueryRunner` and never opens its own
 *
 * The invariant the evidence pack rests on is `state = JUDGED ⟹ a pack exists`,
 * and it is only true if the pack commits with the verdict. A sealer that
 * opened its own transaction would produce, on any crash between the two, a
 * verdict with no evidence — which three days later is indistinguishable from a
 * verdict whose body simply expired, and which no sweeper can honestly repair
 * because `sealed_at` would then be a lie about when the judgement happened.
 *
 * The cost is stated plainly so nobody has to rediscover it: **if sealing
 * throws, the judgement rolls back and the record stays `PENDING`** for the
 * worker to retry. Verification stops rather than running blind. That is the
 * intended direction — a verdict without evidence is worse than a late verdict
 * — but it does mean a bug in this class is an outage in judging, not a
 * degradation of it.
 *
 * ## The three steps, in this order
 *
 * 1. `lockChain` — serialise this organization's chain for the rest of the
 *    transaction.
 * 2. `findTail` — the last link, read under that lock.
 * 3. Build the core, hash it, insert the pack and then the bodies.
 *
 * Reading the tail before taking the lock is the bug this ordering exists to
 * prevent: two judgements would read the same tail, and the second insert would
 * be refused by `uq_evidence_packs_prev`. The constraint is the backstop; the
 * lock is what keeps it from being a routine error path.
 */
@Injectable()
export class EvidencePackSealerService {
  private readonly logger = new Logger(EvidencePackSealerService.name);

  constructor(
    private readonly packs: EvidencePackRepository,
    private readonly bodies: EvidenceBodyRepository,
    private readonly policies: VerificationPolicyRepository,
    @Inject(EVIDENCE_RETENTION_CONFIG) private readonly retention: EvidenceRetentionConfig,
  ) {}

  async seal(queryRunner: QueryRunner, input: SealEvidenceInput): Promise<SealedEvidence> {
    const { record } = input;

    await this.packs.lockChain(queryRunner, record.organizationId);
    const tail = await this.packs.findTail(queryRunner, record.organizationId);

    const seq = tail ? Number(tail.seq) + 1 : 1;
    const prevHash = tail ? tail.contentHash : null;

    const core = buildEvidenceCore({
      record,
      ...(await this.pinnedDocuments(record)),
      request: input.request,
      response: input.response,
      sealedAt: input.sealedAt,
    });
    const contentHash = computeContentHash({ core, seq, prevHash });

    const bodyExpiresAt = new Date(
      input.sealedAt.getTime() + this.retention.bodyRetentionHours * 3_600_000,
    );

    const packId = await this.packs.insertSealed(queryRunner, {
      organizationId: record.organizationId,
      providerId: record.providerId,
      verdictId: record.id,
      intentId: record.intentId,
      seq: String(seq),
      core: core as unknown as Record<string, unknown>,
      requestSha256: core.bodyDigests.request,
      responseSha256: core.bodyDigests.response,
      contentHash,
      prevHash,
      sealedAt: input.sealedAt,
      bodyExpiresAt,
    });

    await this.bodies.insertBody(queryRunner, {
      organizationId: record.organizationId,
      packId,
      // Stored as they were judged. `null` stays `null` — an absent body and an
      // empty one are different calls, and `bodyDigests` already says which.
      request: (input.request ?? null) as Record<string, unknown> | null,
      response: (input.response ?? null) as Record<string, unknown> | null,
      expiresAt: bodyExpiresAt,
    });

    this.logger.debug(
      `Sealed evidence pack ${packId} for verdict ${record.id} at seq ${seq} ` +
        `(organization ${record.organizationId})`,
    );

    return { id: packId, seq, contentHash, prevHash, sealedAt: input.sealedAt, bodyExpiresAt };
  }

  /**
   * The policy documents at the version that judged this call.
   *
   * Read outside the caller's transaction on purpose: `verification_policies`
   * rows are immutable and never deleted, so there is nothing for the
   * transaction to protect, and enrolling a second table in the sealing
   * transaction would widen the lock footprint of the judging path for no gain.
   *
   * A record with no `decisionPolicyId` — `UNVERIFIED`, no policy exists for
   * the tool — resolves to two nulls and `buildEvidenceCore` puts `policy:
   * null` in the core. A missing row for a pair that *is* set resolves the same
   * way rather than throwing: the pack still records which policy id and
   * version judged the call, and refusing to seal because the document could
   * not be loaded would stop judging over a display detail.
   */
  private async pinnedDocuments(record: EvidenceRecordSnapshot): Promise<{
    decisionDocument: Record<string, unknown> | null;
    verificationDocument: Record<string, unknown> | null;
  }> {
    if (record.decisionPolicyId === null || record.decisionPolicyVersion === null) {
      return { decisionDocument: null, verificationDocument: null };
    }

    const policy = await this.policies.findVersion(
      record.decisionPolicyId,
      record.decisionPolicyVersion,
    );

    if (!policy) {
      this.logger.warn(
        `Sealing verdict ${record.id} without policy documents: ` +
          `${record.decisionPolicyId} v${record.decisionPolicyVersion} has no row`,
      );
      return { decisionDocument: null, verificationDocument: null };
    }

    return {
      decisionDocument: policy.decisionDocument as Record<string, unknown> | null,
      verificationDocument: policy.verificationDocument as Record<string, unknown> | null,
    };
  }
}
