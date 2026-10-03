/**
 * The shapes the evidence pack's pure core is built from and produces.
 *
 * `EvidenceRecordSnapshot` is deliberately a structural subset of
 * `VerificationRecordEntity` rather than the entity itself: `domain/` in this
 * module takes plain values and returns plain values, and importing an entity
 * here would put TypeORM behind a function whose whole claim is that it has no
 * I/O. It also names exactly which columns are evidence, which is the list a
 * reviewer needs when a column is added.
 */
export interface EvidenceRecordSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly intentId: string;
  readonly toolId: string;
  readonly providerId: string | null;

  readonly verdictStatus: string | null;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly score: number | null;
  readonly costUsd: number | null;
  readonly settlementOutcome: string | null;

  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly decisionPolicyId: string | null;
  readonly decisionPolicyVersion: number | null;
  readonly lifecycle: string | null;

  readonly sampleRate: number | null;
  readonly sampled: boolean | null;
  readonly sampleSelector: number | null;
  readonly sampleDisplay: string | null;

  readonly stages: unknown;
  readonly verifiers: unknown;
  readonly tally: unknown;
  readonly decidedBy: unknown;

  readonly evaluatedAt: Date | null;
  /** When the call reached verification — the pack's `requestedAt`. */
  readonly createdAt: Date;
}

export interface BuildEvidenceCoreInput {
  readonly record: EvidenceRecordSnapshot;
  /** The `DecisionPolicy` document at the version this verdict was judged under. */
  readonly decisionDocument: Record<string, unknown> | null;
  /** The `VerificationPolicy` document, or null when no local checks ran. */
  readonly verificationDocument: Record<string, unknown> | null;
  readonly request: unknown;
  readonly response: unknown;
  /** Injected, never `new Date()` — the same rule the verdict engine follows. */
  readonly sealedAt: Date;
}

/** The policy pinned to a verdict, at the exact version that judged it. */
export interface EvidencePolicy {
  readonly decisionPolicyId: string;
  readonly decisionPolicyVersion: number;
  readonly decisionDocument: Record<string, unknown> | null;
  readonly verificationPolicyId: string | null;
  readonly verificationPolicyVersion: number | null;
  readonly verificationDocument: Record<string, unknown> | null;
  readonly lifecycle: string | null;
}

/**
 * The model that produced a semantic judgement.
 *
 * **Null on every record today**, and that is a fact about the platform rather
 * than about this call: nothing implements `SEMANTIC_JUDGE`, so no
 * `modelId`/`promptVersion` is persisted anywhere for the core to copy. The pack
 * names both fields, so the key exists and says `null` — "no model judged
 * this" — rather than being omitted, which would read as "we did not ask".
 */
export interface EvidenceSemantic {
  readonly modelId: string;
  readonly promptVersion: number;
}

export interface EvidenceSampling {
  readonly sampleRate: number | null;
  readonly sampled: boolean | null;
  readonly sampleSelector: number | null;
  readonly sampleDisplay: string | null;
}

export interface EvidenceTimestamps {
  readonly requestedAt: string;
  readonly evaluatedAt: string | null;
  readonly sealedAt: string;
}

export interface EvidenceBodyDigests {
  readonly request: string | null;
  readonly response: string | null;
}

export interface EvidenceVerdict {
  readonly status: string | null;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly score: number | null;
  readonly costUsd: number | null;
}

/**
 * The sealed document. Pure JSON — no `Date`, no `bigint`, no class instance —
 * because `canonicalJson` refuses all three rather than coercing them, and a
 * core that cannot be canonicalised cannot be hashed.
 */
export interface EvidenceCore {
  readonly schema: 'x402/evidence-pack/v1';
  readonly verdictId: string;
  readonly intentId: string;
  readonly toolId: string;
  readonly organizationId: string;
  readonly providerId: string | null;
  readonly verdict: EvidenceVerdict;
  readonly settlementOutcome: string | null;
  readonly stages: unknown;
  readonly verifiers: unknown;
  readonly tally: unknown;
  readonly decidedBy: unknown;
  readonly policy: EvidencePolicy | null;
  readonly semantic: EvidenceSemantic | null;
  readonly sampling: EvidenceSampling;
  readonly timestamps: EvidenceTimestamps;
  readonly bodyDigests: EvidenceBodyDigests;
}

/** Everything under the hash: the document, and where it sits in the chain. */
export interface EvidenceDigestInput {
  readonly core: EvidenceCore;
  /** Postgres hands `bigint` back as a string; both spellings hash alike. */
  readonly seq: number | string;
  readonly prevHash: string | null;
}

/** A stored pack, as much of it as verifying needs. */
export interface SealedPackView extends EvidenceDigestInput {
  readonly contentHash: string;
}

/** What `reconstructVerdict` gives back — the verdict, from the core alone. */
export interface ReconstructedVerdict {
  readonly status: string | null;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly score: number | null;
  readonly settlementOutcome: string | null;
  readonly decisionPolicyId: string | null;
  readonly decisionPolicyVersion: number | null;
  readonly evaluatedAt: string | null;
}
