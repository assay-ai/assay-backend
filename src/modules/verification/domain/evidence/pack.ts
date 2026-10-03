import { createHash } from 'node:crypto';

import { canonicalJson } from '@shared/crypto/canonical-json';

import {
  BuildEvidenceCoreInput,
  EvidenceCore,
  EvidenceDigestInput,
  EvidencePolicy,
  ReconstructedVerdict,
  SealedPackView,
} from './pack.types';

/** Self-describing, so a stored digest names the algorithm that produced it. */
export const BODY_DIGEST_PREFIX = 'sha256:';

/** The version of the document shape, carried inside the document. */
export const EVIDENCE_PACK_SCHEMA = 'x402/evidence-pack/v1' as const;

/**
 * The digest of one body, or `null` when the call had none.
 *
 * `null` and `{}` are different calls. Hashing the empty object for an absent
 * body would make "the agent sent nothing" and "the agent sent an empty
 * object" indistinguishable in the evidence, which is exactly the kind of
 * detail a dispute turns on.
 *
 * Over `canonicalJson`, not `JSON.stringify`: the digest has to survive a round
 * trip through `jsonb`, and Postgres does not preserve key order.
 */
export function digestBody(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return BODY_DIGEST_PREFIX + sha256(canonicalJson(value));
}

/**
 * Assembles the document that gets sealed.
 *
 * Everything here is copied from the record as it stands at judgement, and
 * converted to plain JSON: `Date` becomes an ISO string because `canonicalJson`
 * refuses a `Date` outright, which would make the core unhashable rather than
 * subtly wrong.
 *
 * ## What is deliberately not in it
 *
 * - **The raw bodies.** Only `bodyDigests`, so `evidence_bodies` can be deleted
 *   after the retention window without breaking `content_hash`.
 * - **Anything that changes after sealing.** No body-retention state, no
 *   `settled_at`, no `attempts`. A value that moves is a value that makes the
 *   hash unrecomputable the first time it moves.
 * - **`seq` and `prev_hash`.** They are hashed *alongside* the core rather than
 *   inside it, so the same document is the same document wherever it sits in a
 *   chain, and re-pointing a pack at a different predecessor still changes its
 *   digest. See `computeContentHash`.
 */
export function buildEvidenceCore(input: BuildEvidenceCoreInput): EvidenceCore {
  const { record } = input;

  return {
    schema: EVIDENCE_PACK_SCHEMA,
    verdictId: record.id,
    intentId: record.intentId,
    toolId: record.toolId,
    organizationId: record.organizationId,
    providerId: record.providerId,
    verdict: {
      status: record.verdictStatus,
      reasonCode: record.reasonCode,
      reason: record.reason,
      score: record.score,
      costUsd: record.costUsd,
    },
    settlementOutcome: record.settlementOutcome,
    stages: record.stages ?? null,
    verifiers: record.verifiers ?? null,
    tally: record.tally ?? null,
    decidedBy: record.decidedBy ?? null,
    policy: pinnedPolicy(input),
    // Nothing implements `SEMANTIC_JUDGE`, so no record carries a model id to
    // copy. The key is present and null — "no model judged this" — because an
    // absent key reads as "the question was never asked". When a judge ships,
    // this is the one line that has to learn where the id is persisted.
    semantic: null,
    sampling: {
      sampleRate: record.sampleRate,
      sampled: record.sampled,
      sampleSelector: record.sampleSelector,
      sampleDisplay: record.sampleDisplay,
    },
    timestamps: {
      requestedAt: record.createdAt.toISOString(),
      evaluatedAt: record.evaluatedAt ? record.evaluatedAt.toISOString() : null,
      sealedAt: input.sealedAt.toISOString(),
    },
    bodyDigests: {
      request: digestBody(input.request),
      response: digestBody(input.response),
    },
  };
}

/**
 * `sha256(canonicalJson({ core, seq, prevHash }))`, 64 lower-case hex.
 *
 * No `sha256:` prefix, unlike the body digests: this value goes into a
 * `char(64)` column with a `^[0-9a-f]{64}$` CHECK, and the two conventions are
 * kept apart on purpose — one is a column the database validates, the other is
 * a value inside a `jsonb` document where nothing else says what algorithm
 * produced it.
 *
 * `seq` is stringified because Postgres returns `bigint` as a string: a hash
 * that disagreed with itself across the driver boundary would fail to verify on
 * every read, and would do it only for rows that had made a round trip.
 */
export function computeContentHash(input: EvidenceDigestInput): string {
  return sha256(
    canonicalJson({
      core: input.core,
      seq: String(input.seq),
      prevHash: input.prevHash,
    }),
  );
}

/**
 * Does this pack still hash to the digest stored beside it?
 *
 * Boolean rather than throwing, because the two callers want different things
 * from the answer: the read path turns `false` into an error a human is meant
 * to see, and the chain walker wants to keep going and report every break.
 *
 * Deliberately independent of `evidence_bodies` — a pack whose bodies were
 * deleted at 72 hours verifies exactly as it did on the day it was sealed. That
 * is the property the two-table design exists for, and it is asserted directly
 * rather than inferred from the absence of a body parameter.
 */
export function verifyPackIntegrity(pack: SealedPackView): boolean {
  return computeContentHash(pack) === pack.contentHash;
}

/**
 * The verdict, rebuilt from the sealed document alone.
 *
 * Reads only from `core`, never from the surrounding row, so what it returns is
 * what the hash covers. A reconstruction that consulted the mutable record
 * would prove nothing: it would agree with the record by construction, which is
 * the one thing evidence must not do.
 */
export function reconstructVerdict(core: EvidenceCore): ReconstructedVerdict {
  return {
    status: core.verdict.status,
    reasonCode: core.verdict.reasonCode,
    reason: core.verdict.reason,
    score: core.verdict.score,
    settlementOutcome: core.settlementOutcome,
    decisionPolicyId: core.policy?.decisionPolicyId ?? null,
    decisionPolicyVersion: core.policy?.decisionPolicyVersion ?? null,
    evaluatedAt: core.timestamps.evaluatedAt,
  };
}

/**
 * The pinned policy, or `null` for a record no policy judged.
 *
 * Keyed on `decision_policy_id`/`decision_policy_version` because
 * `chk_verification_records_judged_is_whole` guarantees that pair on every
 * judged record, while the verification-policy pair is legitimately absent for
 * a tool with no local checks. Pinning the nullable pair would drop the policy
 * out of the evidence for exactly those calls.
 */
function pinnedPolicy(input: BuildEvidenceCoreInput): EvidencePolicy | null {
  const { record } = input;
  if (record.decisionPolicyId === null || record.decisionPolicyVersion === null) {
    return null;
  }

  return {
    decisionPolicyId: record.decisionPolicyId,
    decisionPolicyVersion: record.decisionPolicyVersion,
    decisionDocument: input.decisionDocument,
    verificationPolicyId: record.policyId,
    verificationPolicyVersion: record.policyVersion,
    verificationDocument: input.verificationDocument,
    lifecycle: record.lifecycle,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
