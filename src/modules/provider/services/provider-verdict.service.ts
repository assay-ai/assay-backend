import { Injectable } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { SlaWindowCallEntity } from '@database/postgres/entities/sla-window-call.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  DecidedBy,
  VerifierOutcome,
  VerifierResult,
  VoteTally,
} from '@modules/verification/domain/aggregation';
import {
  STAGE_STATUS_LABEL,
  STAGE_STATUS_NOTE,
  StageResult,
  VERIFICATION_PIPELINE,
  VerificationStage,
  isStagePass,
  notReached,
} from '@modules/verification/domain/stage';
import { VerdictOutcome, VerdictStatus } from '@modules/verification/domain/verdict';
import {
  DecidedByDto,
  GetVerdictParamsDto,
  StageResultDto,
  VerifierVoteDto,
  VoteTallyDto,
} from '@modules/verification/dto/get-verdict.dto';
import { VerificationErrors } from '@modules/verification/errors/verification.errors';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  ListProviderVerdictsQueryDto,
  ProviderVerdictConsequenceDto,
  ProviderVerdictDetailDto,
  ProviderVerdictListItemDto,
} from '../dto/provider-verdict.dto';

/**
 * Declared next to the query it drives, per `backend/docs/api-list-contract.md`.
 * Mirrors `VerdictService`'s `VERDICT_LIST` — `score` is deliberately absent
 * for the same reason: `api-list-contract.md` rule 1 forbids sorting on a
 * nullable column, and `score` is null on every record nothing has scored.
 */
const PROVIDER_VERDICT_LIST: ListSpec = {
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
 * `GET /providers/me/verdicts` and `GET /providers/me/verdicts/:id`.
 *
 * The gap this closes: a provider is charged for a verdict and today cannot
 * see it at all. `VerdictsController` (the buyer's route) scopes on
 * `session.organizationId`, and on `verification_records` that column is the
 * **payer's** org — a provider token gets `items: []`. This service scopes on
 * `provider_id` instead, the same idiom as `EvidencePackService.forProvider`
 * beside it on this controller: `record.organizationId IS NOT NULL` satisfies
 * `OrganizationScopedRepository`'s query-builder guard while reading across
 * every buying tenant on purpose (`ProviderTrafficService` L57-58 explains the
 * same shape).
 *
 * ## The feed is one query plus three batched lookups, never N+1
 *
 * `idx_verification_records_provider_created (provider_id, created_at)`
 * carries the page itself. Four of the feed's columns live on other tables —
 * `payment_intents` (call id, class, agent), `sla_window_calls` (window
 * membership), `evidence_packs` / `evidence_bodies` (retention state) — and
 * each is fetched **once per page**, batched by `IN (...)`, the same shape
 * `ToolCallsService.verdictsByIntentId` already uses for the same reason:
 * `paginate()` takes one query builder over one entity, so a second entity's
 * columns cannot ride the same `getMany()`. `agentId` / `windowId` filtering
 * still happens in the main query, via a `leftJoin` with no `addSelect` —
 * registers the alias for `WHERE` without changing what `getMany()` returns,
 * exactly as `ToolCallsService.list` does it.
 *
 * ## The two boundaries this route holds
 *
 * - **404, never 403** for a verdict this provider did not serve — see
 *   `getById`.
 * - **The agent dimension, never the buyer.** `agentId` comes from
 *   `payment_intents.agent_id`; nothing here ever reads or returns
 *   `organization_id` off a joined row, which is the buying organization's
 *   identity.
 */
@Injectable()
export class ProviderVerdictService {
  constructor(
    private readonly records: VerificationRecordRepository,
    private readonly intents: PaymentIntentRepository,
    private readonly slaCalls: SlaWindowCallRepository,
    private readonly evidencePacks: EvidencePackRepository,
    private readonly evidenceBodies: EvidenceBodyRepository,
  ) {}

  async list(
    providerId: string,
    query: ListProviderVerdictsQueryDto,
  ): Promise<CursorPageDto<ProviderVerdictListItemDto>> {
    const qb = this.records
      .createQueryBuilder('record')
      .where('record.organizationId IS NOT NULL')
      .andWhere('record.providerId = :providerId', { providerId });

    if (query.agentId) {
      qb.leftJoin(PaymentIntentEntity, 'intent', 'intent.id = record.intentId').andWhere(
        'intent.agentId = :agentId',
        { agentId: query.agentId },
      );
    }
    if (query.windowId) {
      qb.leftJoin(SlaWindowCallEntity, 'swc', 'swc.intentId = record.intentId').andWhere(
        'swc.windowId = :windowId',
        { windowId: query.windowId },
      );
    }
    if (query.verdictStatus?.length) {
      qb.andWhere('record.verdictStatus IN (:...verdictStatus)', {
        verdictStatus: query.verdictStatus,
      });
    }
    if (query.reasonCode) {
      qb.andWhere('record.reasonCode = :reasonCode', { reasonCode: query.reasonCode });
    }

    applyTimeWindow(qb, query, PROVIDER_VERDICT_LIST);

    const page = await paginate(qb, query, PROVIDER_VERDICT_LIST);

    const intentIds = page.items.map((record) => record.intentId);
    const verdictIds = page.items.map((record) => record.id);

    const [intentsById, slaCallsByIntentId, retentionByVerdictId] = await Promise.all([
      this.fetchIntentsByIds(intentIds),
      this.fetchSlaCallsByIntentIds(intentIds),
      this.fetchRetentionByVerdictIds(providerId, verdictIds),
    ]);

    return page.map((record) =>
      toListItemDto(
        record,
        intentsById.get(record.intentId) ?? null,
        slaCallsByIntentId.get(record.intentId) ?? null,
        retentionByVerdictId.get(record.id) ?? null,
      ),
    );
  }

  async getById(
    providerId: string,
    params: GetVerdictParamsDto,
  ): Promise<ProviderVerdictDetailDto> {
    const record = await this.records
      .createQueryBuilder('record')
      .where('record.organizationId IS NOT NULL')
      .andWhere('record.providerId = :providerId', { providerId })
      .andWhere('record.id = :id', { id: params.id })
      .getOne();

    if (!record) {
      // 404, never 403 — see the class comment.
      throw VerificationErrors.verdictNotFound({ id: params.id });
    }

    const intent = await this.intents
      .createQueryBuilder('intent')
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.id = :id', { id: record.intentId })
      .getOne();

    return toDetailDto(record, intent);
  }

  /** Batched by `id IN (...)`, cross-organization — see the class comment. */
  private async fetchIntentsByIds(
    intentIds: readonly string[],
  ): Promise<Map<string, PaymentIntentEntity>> {
    if (intentIds.length === 0) return new Map();

    const rows = await this.intents
      .createQueryBuilder('intent')
      .select([
        'intent.id',
        'intent.agentId',
        'intent.callId',
        'intent.callClass',
        'intent.bindingId',
      ])
      .where('intent.organizationId IS NOT NULL')
      .andWhere('intent.id IN (:...intentIds)', { intentIds: [...intentIds] })
      .getMany();

    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Batched by `intent_id IN (...)`, cross-organization. */
  private async fetchSlaCallsByIntentIds(
    intentIds: readonly string[],
  ): Promise<Map<string, SlaWindowCallEntity>> {
    if (intentIds.length === 0) return new Map();

    const rows = await this.slaCalls
      .createQueryBuilder('call')
      .select(['call.intentId', 'call.windowId', 'call.countedAsQuality'])
      .where('call.organizationId IS NOT NULL')
      .andWhere('call.intentId IN (:...intentIds)', { intentIds: [...intentIds] })
      .getMany();

    return new Map(rows.map((row) => [row.intentId, row]));
  }

  /**
   * Retention state, without going through `EvidencePackService`.
   *
   * That service recomputes the sealed hash on every read and throws on a
   * mismatch — correct for one verdict a human is looking at, wrong for a
   * page of twenty-five: one tampered pack would 500 the entire feed instead
   * of the one row it actually concerns. This reads only what a list row
   * needs — whether a pack exists, and whether its body row still does — the
   * same two facts `EvidencePackService.render` derives `bodyState` from.
   */
  private async fetchRetentionByVerdictIds(
    providerId: string,
    verdictIds: readonly string[],
  ): Promise<Map<string, VerdictRetention>> {
    if (verdictIds.length === 0) return new Map();

    const packs = await this.evidencePacks
      .createQueryBuilder('pack')
      .select(['pack.id', 'pack.verdictId'])
      .where('pack.organizationId IS NOT NULL')
      .andWhere('pack.providerId = :providerId', { providerId })
      .andWhere('pack.verdictId IN (:...verdictIds)', { verdictIds: [...verdictIds] })
      .getMany();

    if (packs.length === 0) return new Map();

    const packIds = packs.map((pack) => pack.id);
    const bodies = await this.evidenceBodies
      .createQueryBuilder('body')
      .select(['body.packId', 'body.expiresAt'])
      .where('body.organizationId IS NOT NULL')
      .andWhere('body.packId IN (:...packIds)', { packIds })
      .getMany();

    const expiryByPackId = new Map(bodies.map((body) => [body.packId, body.expiresAt]));
    const result = new Map<string, VerdictRetention>();
    for (const pack of packs) {
      const bodiesExpireAt = expiryByPackId.get(pack.id) ?? null;
      result.set(pack.verdictId, {
        state: expiryByPackId.has(pack.id) ? 'RAW' : 'DIGESTED',
        bodiesExpireAt,
      });
    }
    return result;
  }
}

/** A sealed pack's body state, and when a still-kept body stops being kept. */
interface VerdictRetention {
  readonly state: 'RAW' | 'DIGESTED';
  readonly bodiesExpireAt: Date | null;
}

function toListItemDto(
  record: VerificationRecordEntity,
  intent: PaymentIntentEntity | null,
  slaCall: SlaWindowCallEntity | null,
  retention: VerdictRetention | null,
): ProviderVerdictListItemDto {
  return {
    id: record.id,
    intentId: record.intentId,
    toolId: record.toolId,
    callId: intent?.callId ?? null,
    callClass: intent?.callClass ?? null,
    state: record.state,
    verdictStatus: (record.verdictStatus as VerdictStatus | null) ?? null,
    reasonCode: record.reasonCode,
    score: record.score,
    failingRules: buildFailingRules(record),
    agentId: intent?.agentId ?? null,
    decisionPolicyVersion: record.decisionPolicyVersion,
    // No source exists for this — see `ProviderVerdictListItemDto`'s class comment.
    bindingVersion: null,
    windowId: slaCall?.windowId ?? null,
    countedTowardWindow: slaCall?.countedAsQuality ?? null,
    retentionState: retention?.state ?? null,
    bodiesExpireAt: retention?.bodiesExpireAt ?? null,
    createdAt: record.createdAt,
  };
}

function toDetailDto(
  record: VerificationRecordEntity,
  intent: PaymentIntentEntity | null,
): ProviderVerdictDetailDto {
  return {
    id: record.id,
    intentId: record.intentId,
    toolId: record.toolId,
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
    evaluatedAt: record.evaluatedAt,
    createdAt: record.createdAt,
    consequence: buildConsequence(record, intent),
    evidenceUrl: `/providers/me/verdicts/${record.id}/evidence`,
  };
}

/**
 * Every failed verifier's code, deduplicated, in the order it first appears.
 * See `ProviderVerdictListItemDto.failingRules`.
 */
function buildFailingRules(record: VerificationRecordEntity): string[] {
  const votes = parseVerifiers(record.verifiers);
  const codes: string[] = [];
  for (const vote of votes) {
    if (vote.outcome === VerifierOutcome.FAIL && vote.code && !codes.includes(vote.code)) {
      codes.push(vote.code);
    }
  }
  return codes;
}

function buildConsequence(
  record: VerificationRecordEntity,
  intent: PaymentIntentEntity | null,
): ProviderVerdictConsequenceDto {
  if (!intent) {
    // No `payment_intents` row found for this record's `intentId`. Every
    // judged verdict has exactly one — this branch is data-integrity paranoia,
    // not an expected path — so nothing here is fabricated from the record
    // alone; the money fields have no source without the intent, and are
    // reported as absent rather than as a zero that never happened.
    return {
      settlementOutcome: record.settlementOutcome,
      settledAt: record.settledAt,
      intentStatus: null,
      strike: deriveStrike(record.settlementOutcome),
      price: null,
      providerAmount: null,
      platformFee: null,
      settledAmount: null,
    };
  }

  const asset = intent.assetId as AssetId;
  return {
    settlementOutcome: record.settlementOutcome,
    settledAt: record.settledAt,
    intentStatus: intent.status,
    strike: deriveStrike(record.settlementOutcome),
    price: toMoneyDto(MoneyUtil.of(intent.priceAmount, asset, intent.decimals)),
    providerAmount: toMoneyDto(MoneyUtil.of(intent.providerAmount, asset, intent.decimals)),
    platformFee: toMoneyDto(MoneyUtil.of(intent.platformFee, asset, intent.decimals)),
    settledAmount: intent.settledAmount
      ? toMoneyDto(MoneyUtil.of(intent.settledAmount, asset, intent.decimals))
      : null,
  };
}

/**
 * `null` while `JUDGED` and unsettled — `settlementOutcome` itself is null
 * then, and "did this strike" has no answer yet, not a `false` one. Once set,
 * `REFUND` is the only outcome that strikes — see `VERDICT_CONSEQUENCE`.
 */
function deriveStrike(settlementOutcome: string | null): boolean | null {
  return settlementOutcome === null ? null : settlementOutcome === VerdictOutcome.REFUND;
}

function toMoneyDto(money: Money): NonNullable<ProviderVerdictConsequenceDto['price']> {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

/**
 * All four pipeline stages, always, in pipeline order — duplicated from
 * `VerdictService.buildStageResults` rather than imported. Same reasoning as
 * that function's own comment against `ReceiptService`: this reads the same
 * `StageResult[]` off `record.stages`, but the provider module owns no import
 * path into a private function of a sibling module's service file.
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

function parseVerifiers(value: unknown): VerifierResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isVerifierResultShape);
}

function buildVerifierVotes(record: VerificationRecordEntity): VerifierVoteDto[] {
  return parseVerifiers(record.verifiers).map((result) => ({
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
