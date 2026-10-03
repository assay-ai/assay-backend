import { Injectable } from '@nestjs/common';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import { DecidedBy, VerifierResult, VoteTally } from '../domain/aggregation';
import {
  PinnedPolicyDto,
  SamplingProofDto,
  VerdictEvidenceDto,
} from '../dto/get-verdict-evidence.dto';
import {
  DecidedByDto,
  GetVerdictParamsDto,
  StageResultDto,
  VerdictDetailDto,
  VerifierVoteDto,
  VoteTallyDto,
} from '../dto/get-verdict.dto';
import { ListVerdictsQueryDto, VerdictListItemDto } from '../dto/list-verdicts.dto';
import {
  STAGE_STATUS_LABEL,
  STAGE_STATUS_NOTE,
  StageResult,
  VERIFICATION_PIPELINE,
  VerificationStage,
  isStagePass,
  notReached,
} from '../domain/stage';
import { VerdictStatus } from '../domain/verdict';
import { VerificationErrors } from '../errors/verification.errors';
import { EvidencePackService } from './evidence-pack.service';

/**
 * Declared next to the query it drives, per `backend/docs/api-list-contract.md`.
 *
 * `score` is deliberately **not** in this map. The contract's rule 1 forbids
 * sorting on a nullable column — `verification_records.score` is null on every
 * record nothing has scored, and a row-value comparison against `NULL` drops
 * the row from pagination silently rather than mis-ordering it. `createdAt`
 * is `NOT NULL` and the only sortable field.
 */
const VERDICT_LIST: ListSpec = {
  alias: 'record',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'record.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: VerificationRecordEntity) => row.createdAt),
    },
  },
};

/**
 * `GET /api/v1/verdicts`, `GET /api/v1/verdicts/:id` and
 * `GET /api/v1/verdicts/:id/evidence` — the verdict feed, one
 * verdict in full, and its evidence pack. All three read `verification_records`
 * only; the evidence pack additionally pins the `VerificationPolicyEntity` row
 * the record was judged under.
 */
@Injectable()
export class VerdictService {
  constructor(
    private readonly records: VerificationRecordRepository,
    private readonly policies: VerificationPolicyRepository,
    private readonly packs: EvidencePackService,
  ) {}

  async list(
    organizationId: string,
    query: ListVerdictsQueryDto,
  ): Promise<CursorPageDto<VerdictListItemDto>> {
    const qb = this.records
      .createQueryBuilder('record')
      .where('record.organizationId = :organizationId', { organizationId });

    applyTimeWindow(qb, query, VERDICT_LIST);

    if (query.verdictStatus?.length) {
      qb.andWhere('record.verdictStatus IN (:...verdictStatus)', {
        verdictStatus: query.verdictStatus,
      });
    }
    if (query.toolId) {
      qb.andWhere('record.toolId = :toolId', { toolId: query.toolId });
    }
    if (query.providerId) {
      qb.andWhere('record.providerId = :providerId', { providerId: query.providerId });
    }
    if (query.sampled !== undefined) {
      qb.andWhere('record.sampled = :sampled', { sampled: query.sampled });
    }
    if (query.policyId) {
      // Filters on `decisionPolicyId`, not `policyId` — see `ListVerdictsQueryDto`.
      qb.andWhere('record.decisionPolicyId = :policyId', { policyId: query.policyId });
    }

    const page = await paginate(qb, query, VERDICT_LIST);
    return page.map(toListItemDto);
  }

  async getById(organizationId: string, params: GetVerdictParamsDto): Promise<VerdictDetailDto> {
    const record = await this.records.findOneBy({ organizationId, id: params.id });
    if (!record) {
      throw VerificationErrors.verdictNotFound({ id: params.id });
    }

    return toDetailDto(record);
  }

  async getEvidence(
    organizationId: string,
    params: GetVerdictParamsDto,
  ): Promise<VerdictEvidenceDto> {
    const record = await this.records.findOneBy({ organizationId, id: params.id });
    if (!record) {
      throw VerificationErrors.verdictNotFound({ id: params.id });
    }

    // A sealed pack is the evidence; the record is only what it was built from.
    // Reading the pack also re-checks its hash, so a verdict whose evidence was
    // tampered with fails here rather than being rendered as if it were fine.
    const sealed = await this.packs.forBuyer(organizationId, params.id);
    if (sealed) {
      return {
        id: record.id,
        intentId: record.intentId,
        toolId: record.toolId,
        providerId: record.providerId,
        state: record.state,
        request: sealed.request,
        response: sealed.response,
        // Not part of the sealed core: `outputSchema` belongs to the tool
        // contract, which is versioned elsewhere and is not what this verdict
        // was judged against — the pinned policy is.
        outputSchema: record.outputSchema ?? null,
        stageResults: sealed.stageResults,
        sampling: sealed.sampling,
        pinnedPolicy: sealed.pinnedPolicy,
        evaluatedAt: sealed.evaluatedAt,
        createdAt: record.createdAt,
        integrity: sealed.integrity,
        bodyDigests: sealed.bodyDigests,
      };
    }

    // No pack: a verdict judged before evidence packs existed. Rendered from the record, as it
    // always was, and labelled `integrity: null` so nobody mistakes a view for
    // evidence. Deliberately not backfilled — sealing it now would stamp
    // today's `sealedAt` on last week's judgement.
    const pinnedPolicy = await this.resolvePinnedPolicy(record);

    return {
      id: record.id,
      intentId: record.intentId,
      toolId: record.toolId,
      providerId: record.providerId,
      state: record.state,
      request: record.request ?? null,
      response: record.response ?? null,
      outputSchema: record.outputSchema ?? null,
      stageResults: buildStageResults(record),
      sampling: buildSamplingProof(record),
      pinnedPolicy,
      evaluatedAt: record.evaluatedAt,
      createdAt: record.createdAt,
      integrity: null,
      bodyDigests: null,
    };
  }

  /**
   * The exact policy document this record was judged under, keyed on
   * `decisionPolicyId` / `decisionPolicyVersion` — the pair
   * `chk_verification_records_judged_is_whole` guarantees on every judged
   * record. `null` for a `PENDING` record, which has not been judged yet.
   */
  private async resolvePinnedPolicy(
    record: VerificationRecordEntity,
  ): Promise<PinnedPolicyDto | null> {
    if (!record.decisionPolicyId || record.decisionPolicyVersion == null) return null;

    const policy = await this.policies.findVersion(
      record.decisionPolicyId,
      record.decisionPolicyVersion,
    );
    if (!policy) return null;

    return toPinnedPolicyDto(policy);
  }
}

function toListItemDto(record: VerificationRecordEntity): VerdictListItemDto {
  return {
    id: record.id,
    intentId: record.intentId,
    toolId: record.toolId,
    providerId: record.providerId,
    verdictStatus: (record.verdictStatus as VerdictStatus | null) ?? null,
    reasonCode: record.reasonCode,
    score: record.score,
    sampled: record.sampled,
    decisionPolicyId: record.decisionPolicyId,
    decisionPolicyVersion: record.decisionPolicyVersion,
    state: record.state,
    createdAt: record.createdAt,
  };
}

function toDetailDto(record: VerificationRecordEntity): VerdictDetailDto {
  return {
    id: record.id,
    intentId: record.intentId,
    toolId: record.toolId,
    providerId: record.providerId,
    state: record.state,
    verdictStatus: (record.verdictStatus as VerdictStatus | null) ?? null,
    reasonCode: record.reasonCode,
    reason: record.reason,
    score: record.score,
    stageResults: buildStageResults(record),
    verifiers: buildVerifierVotes(record),
    tally: buildTally(record),
    decidedBy: buildDecidedBy(record),
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    decisionPolicyId: record.decisionPolicyId,
    decisionPolicyVersion: record.decisionPolicyVersion,
    lifecycle: record.lifecycle,
    sampled: record.sampled,
    sampleRate: record.sampleRate,
    sampleDisplay: record.sampleDisplay,
    settlementOutcome: record.settlementOutcome,
    evaluatedAt: record.evaluatedAt,
    settledAt: record.settledAt,
    createdAt: record.createdAt,
  };
}

function toPinnedPolicyDto(policy: VerificationPolicyEntity): PinnedPolicyDto {
  return {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    lifecycle: policy.lifecycle,
    decisionDocument: policy.decisionDocument,
    verificationDocument: policy.verificationDocument,
  };
}

function buildSamplingProof(record: VerificationRecordEntity): SamplingProofDto {
  return {
    sampleRate: record.sampleRate,
    sampled: record.sampled,
    sampleSelector: record.sampleSelector,
    sampleDisplay: record.sampleDisplay,
  };
}

/**
 * All four pipeline stages, always, in pipeline order — mirrors
 * `ReceiptService.buildStages`. Duplicated rather than imported because the
 * receipt renders a slightly different DTO shape (`ReceiptStageDto`, no
 * `label`/`note` split needed there in the same way); both read the same
 * `StageResult[]` off `record.stages` and apply the same `notReached()`
 * fallback for whichever entries the pipeline never reached.
 */
function buildStageResults(record: VerificationRecordEntity): StageResultDto[] {
  const stored = parseStages(record.stages);
  const byStage = new Map(stored.map((result) => [result.stage, result]));

  return VERIFICATION_PIPELINE.map((stage) => {
    const result = byStage.get(stage) ?? notReached(stage);
    return {
      stage,
      status: result.status,
      label: STAGE_STATUS_LABEL[result.status],
      note: STAGE_STATUS_NOTE[result.status],
      passed: isStagePass(result.status),
      code: result.code,
      detail: result.detail,
      score: result.score,
    };
  });
}

const PIPELINE_STAGES: ReadonlySet<string> = new Set(Object.values(VerificationStage));

function parseStages(value: unknown): StageResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isStageResultShape);
}

function isStageResultShape(value: unknown): value is StageResult {
  if (!isPlainObject(value)) return false;
  const stage = value.stage;
  const status = value.status;
  return typeof stage === 'string' && PIPELINE_STAGES.has(stage) && typeof status === 'string';
}

function buildVerifierVotes(record: VerificationRecordEntity): VerifierVoteDto[] {
  const value = record.verifiers;
  if (!Array.isArray(value)) return [];
  return value.filter(isVerifierResultShape).map((result) => ({
    verifierId: result.verifierId,
    outcome: result.outcome,
    code: result.code,
    detail: result.detail,
    score: result.score,
    costUsd: result.costUsd,
    stage: result.stage,
  }));
}

function isVerifierResultShape(value: unknown): value is VerifierResult {
  return (
    isPlainObject(value) &&
    typeof value.verifierId === 'string' &&
    typeof value.outcome === 'string'
  );
}

function buildTally(record: VerificationRecordEntity): VoteTallyDto | null {
  const value = record.tally;
  if (!isPlainObject(value) || !isTallyShape(value)) return null;
  const tally = value as unknown as VoteTally;

  return {
    declared: tally.declared,
    votes: tally.votes,
    passed: tally.passed,
    failed: tally.failed,
    misapplied: tally.misapplied,
    unavailable: tally.unavailable,
    abstained: tally.abstained,
    failedFraction: tally.failedFraction,
    unregistered: tally.unregistered,
  };
}

function isTallyShape(value: Record<string, unknown>): boolean {
  return typeof value.declared === 'number' && typeof value.votes === 'number';
}

function buildDecidedBy(record: VerificationRecordEntity): DecidedByDto | null {
  const value = record.decidedBy;
  if (!isPlainObject(value)) return null;
  const decidedBy = value as unknown as DecidedBy;

  return {
    clauseIndex: decidedBy.clauseIndex ?? null,
    trigger: decidedBy.trigger ?? null,
    label: decidedBy.label ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
