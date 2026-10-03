import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { StageResultDto } from './get-verdict.dto';

/**
 * The sample-selection proof.
 *
 * Reproducible because the draw is `HMAC-SHA256(secret, intentId)` — this is
 * what makes `sampleSelector` evidence rather than an assertion: replaying the
 * draw against the stored `intentId` reaches the same number.
 */
export class SamplingProofDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'The odds this call had of being semantically judged, `0..1`',
  })
  sampleRate: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Was the semantic stage actually drawn' })
  sampled: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The HMAC draw, `0..1` — replay it against `intentId` to verify the selection',
  })
  sampleSelector: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'The published sentence — "1 in 13 calls"' })
  sampleDisplay: string | null;
}

/**
 * The policy document pinned to this verdict, at the exact version it
 * was judged under.
 *
 * `null` only when the record has not been judged yet (`state = PENDING`) —
 * `chk_verification_records_judged_is_whole` guarantees `decisionPolicyId` /
 * `decisionPolicyVersion` are set on every other record, so a judged verdict
 * always resolves this unless the policy row itself was since removed, which
 * this schema never does (`VerificationPolicyEntity` rows are immutable and
 * never deleted).
 */
export class PinnedPolicyDto {
  @ApiProperty()
  policyId: string;

  @ApiProperty()
  policyVersion: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'One of `PolicyLifecycle` today, not at judgement time',
  })
  lifecycle: string | null;

  @ApiProperty({ description: 'The DecisionPolicy document — verifiers, clauses, otherwise' })
  decisionDocument: Record<string, unknown>;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The VerificationPolicy document — schema, rules, thresholds. Null if none ran locally',
  })
  verificationDocument: Record<string, unknown> | null;
}

/**
 * Whether this pack is sealed evidence, and where it sits in the chain.
 *
 * `null` on the whole object means the verdict predates evidence-pack sealing
 * and was never sealed: the payload is still composed from the record, but it is a *view*,
 * not evidence, and saying so is the point. Nothing was backfilled, because
 * stamping today's `sealedAt` on last week's judgement would be a lie in the
 * one field an auditor reads first.
 */
export class EvidenceIntegrityDto {
  @ApiProperty({ description: 'True when this payload came from a sealed pack' })
  sealed: boolean;

  @ApiProperty({ description: "Position in this organization's chain, from 1" })
  seq: number;

  @ApiProperty({ description: 'sha256 of the canonical core, recomputed on every read' })
  contentHash: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "The previous pack's content hash; null on the organization's first pack",
  })
  prevHash: string | null;

  @ApiProperty()
  sealedAt: Date;

  @ApiProperty({
    enum: ['RAW', 'DIGESTED'],
    description:
      'RAW while the bodies are kept; DIGESTED once the retention window has passed and only ' +
      'their digests remain',
  })
  bodyState: 'RAW' | 'DIGESTED';
}

/**
 * The same, for the provider who served the call — **without `seq` and
 * `prevHash`**.
 *
 * Not tidiness: `seq` is the buyer organization's chain position, which is a
 * count of how many verdicts that organization has had. Publishing it to a
 * provider would leak one tenant's volume to another party through a field that
 * looks like plumbing. What a provider needs in order to check their own copy —
 * the content hash, the seal time, whether the bodies are still kept — is all
 * here.
 */
export class ProviderEvidenceIntegrityDto {
  @ApiProperty()
  sealed: boolean;

  @ApiProperty()
  contentHash: string;

  @ApiProperty()
  sealedAt: Date;

  @ApiProperty({ enum: ['RAW', 'DIGESTED'] })
  bodyState: 'RAW' | 'DIGESTED';
}

/** The digests of the raw bodies, which outlive the bodies themselves. */
export class EvidenceBodyDigestsDto {
  @ApiPropertyOptional({
    nullable: true,
    description: '`sha256:…`, or null when there was no body',
  })
  request: string | null;

  @ApiPropertyOptional({ nullable: true })
  response: string | null;
}

/**
 * `GET /api/v1/verdicts/:id/evidence` — the evidence pack for one call.
 *
 * Retrievable for **any** verdict, not only failures — visibility must not be
 * conditional on being accused. This is the call-level building block; the
 * window-level pack (`manifest.json` / `verdicts.jsonl` / `samples/` /
 * `attestation.json`) is not built here.
 *
 * An evidence pack that names a `policyId` with no `policyVersion` is not
 * evidence: `chk_verification_records_judged_is_whole` is the CHECK constraint
 * that makes that unrepresentable for a judged record, and `pinnedPolicy` is
 * `null` rather than half-filled for the one case it can occur — a record
 * still `PENDING`.
 */
export class VerdictEvidenceDto {
  @ApiProperty({ description: 'The verification_records row id' })
  id: string;

  @ApiProperty()
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true })
  providerId: string | null;

  @ApiPropertyOptional({ enum: ['PENDING', 'JUDGED', 'SETTLED'] })
  state: string;

  @ApiPropertyOptional({ nullable: true, description: "The agent's arguments, as stored" })
  request: unknown;

  @ApiPropertyOptional({
    nullable: true,
    description: "The provider's response, after the binding's response mapping",
  })
  response: unknown;

  @ApiPropertyOptional({
    nullable: true,
    description: "The tool's outputSchema as it stood at call time",
  })
  outputSchema: unknown;

  @ApiProperty({
    type: [StageResultDto],
    description: 'All four pipeline stages, always, in pipeline order',
  })
  stageResults: StageResultDto[];

  @ApiProperty({ type: SamplingProofDto })
  sampling: SamplingProofDto;

  @ApiPropertyOptional({
    type: PinnedPolicyDto,
    nullable: true,
    description: 'Null only while the record is still PENDING — see the class comment',
  })
  pinnedPolicy: PinnedPolicyDto | null;

  @ApiPropertyOptional({ nullable: true })
  evaluatedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional({
    type: EvidenceIntegrityDto,
    nullable: true,
    description:
      'Null for a verdict judged before evidence sealing existed: a view of the record, ' +
      'not evidence',
  })
  integrity: EvidenceIntegrityDto | null;

  @ApiPropertyOptional({
    type: EvidenceBodyDigestsDto,
    nullable: true,
    description: 'Present on a sealed pack; the digests survive the bodies',
  })
  bodyDigests: EvidenceBodyDigestsDto | null;
}

/**
 * `GET /api/v1/providers/me/verdicts/:id/evidence` — the same call, read by the
 * provider who served it.
 *
 * Same evidence, one boundary: no `seq`, no `prevHash` (see
 * `ProviderEvidenceIntegrityDto`). Unlike the buyer's route this one has no
 * unsealed fallback — a provider asking about a verdict judged before evidence-pack
 * sealing gets a 404 rather than a composed view, because without a pack there is
 * nothing that proves the call was theirs to read.
 */
export class ProviderVerdictEvidenceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  intentId: string;

  @ApiProperty()
  toolId: string;

  @ApiPropertyOptional({ nullable: true, description: "The agent's arguments, as sent upstream" })
  request: unknown;

  @ApiPropertyOptional({ nullable: true, description: 'The response this provider returned' })
  response: unknown;

  @ApiProperty({ type: [StageResultDto] })
  stageResults: StageResultDto[];

  @ApiProperty({ type: SamplingProofDto })
  sampling: SamplingProofDto;

  @ApiPropertyOptional({ type: PinnedPolicyDto, nullable: true })
  pinnedPolicy: PinnedPolicyDto | null;

  @ApiPropertyOptional({ nullable: true })
  evaluatedAt: Date | null;

  @ApiProperty({ type: ProviderEvidenceIntegrityDto })
  integrity: ProviderEvidenceIntegrityDto;

  @ApiProperty({ type: EvidenceBodyDigestsDto })
  bodyDigests: EvidenceBodyDigestsDto;
}
