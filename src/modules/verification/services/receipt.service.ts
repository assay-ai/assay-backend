import { Injectable } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { isWithheldIntent } from '@modules/ledger/domain/withheld';
import { PROVIDER_FORFEIT_PREFIX } from '@modules/payment/constants/voucher-redemption.constants';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  GetReceiptResponseDto,
  MoneyDto,
  ReceiptPolicyDto,
  ReceiptSamplingDto,
  ReceiptStageDto,
  ReceiptVerdictDto,
} from '../dto/get-receipt.dto';
import {
  STAGE_STATUS_LABEL,
  STAGE_STATUS_NOTE,
  StageResult,
  VERIFICATION_PIPELINE,
  VerificationStage,
  isStagePass,
  notReached,
} from '../domain/stage';
import { VerificationErrors } from '../errors/verification.errors';

/**
 * `GET /receipts/:intentId` — the join of `payment_intents` (the
 * money) and `verification_records` (the evidence), rendered so that a call
 * verification never reached still tells the truth about itself.
 *
 * The hardest requirement here is not a computation, it is an omission rule:
 * {@link buildStages} always returns all four `VERIFICATION_PIPELINE` entries,
 * whether or not a `verification_records` row exists yet, and whether or not
 * the pipeline stopped after the first stage. The reason: an omitted stage row
 * reads as a tick to anyone scanning a list, which is a statement about money
 * this endpoint must never make by accident.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly records: VerificationRecordRepository,
  ) {}

  async getReceipt(organizationId: string, intentId: string): Promise<GetReceiptResponseDto> {
    const intent = await this.intents.findOneBy({ organizationId, id: intentId });
    if (!intent) {
      throw VerificationErrors.receiptNotFound({ intentId });
    }

    // A call still routing, or voided before verification, has no
    // `verification_records` row at all — not an error, and not 404: the
    // receipt renders honestly with every stage `NOT_REACHED`. See the class
    // comment.
    const record = await this.records.findByIntentId(organizationId, intentId);

    const asset = intent.assetId as AssetId;
    const listedPrice = MoneyUtil.of(intent.priceAmount, asset, intent.decimals);
    // Charged is zero for every non-SETTLED terminal status, and for every
    // non-terminal one too — nothing has been charged until settlement says
    // so. `listedPrice` and `chargedPrice` are both always present, even when
    // equal: never show one number where the product's value lives in the
    // gap between two.
    // A voucher the provider forfeited was never collected: the buyer was not
    // charged, although the call is SETTLED (review 2026-10-15, M2).
    const forfeited = intent.redemptionLastError?.startsWith(PROVIDER_FORFEIT_PREFIX) ?? false;
    const chargedPrice =
      intent.status === PaymentIntentStatus.SETTLED && !forfeited
        ? listedPrice
        : MoneyUtil.zero(asset, intent.decimals);

    // **Not `listed - charged`.** That subtraction is right for a terminal
    // call and wrong for every other one: a call still in `VERIFYING` has been
    // charged nothing *yet*, and reporting its full price as withheld would
    // claim a guarantee that has not fired. The aggregate
    // (`sumWithheldByAssetAndStatus`, and `domain/withheld.ts` behind it)
    // counts only terminal intents that actually reserved money, so a per-row
    // figure computed any other way would not sum to the total shown beside
    // it — the exact "three surfaces, three definitions" failure this
    // exists to prevent. One predicate, `isWithheldIntent`, used by both.
    const withheld = isWithheldIntent({ status: intent.status, holdId: intent.holdId })
      ? listedPrice
      : MoneyUtil.zero(asset, intent.decimals);

    return {
      intentId: intent.id,
      toolId: intent.toolId,
      providerId: intent.providerId,
      classification: intent.classification,
      status: intent.status,
      listedPrice: toMoneyDto(listedPrice),
      chargedPrice: toMoneyDto(chargedPrice),
      withheld: toMoneyDto(withheld),
      verdict: buildVerdict(record),
      stages: buildStages(record),
      policy: buildPolicy(record),
      sampling: buildSampling(record),
      createdAt: intent.createdAt,
      expiresAt: intent.expiresAt,
      updatedAt: intent.updatedAt,
      holdReleasedAt: intent.holdReleasedAt,
      evaluatedAt: record?.evaluatedAt ?? null,
      settledAt: record?.settledAt ?? null,
    };
  }
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

/**
 * All four pipeline stages, always, in pipeline order.
 *
 * Driven off `VERIFICATION_PIPELINE` rather than off whatever the stored
 * `stages` array happens to contain: a record with no row yet, a `PENDING`
 * record whose `stages` column is still null, and a malformed or partial
 * array from a worker bug all fall back to the same `notReached(stage)` for
 * whichever entries are missing — which is the one fallback `StageStatus`
 * allows that can never be mistaken for a pass.
 */
function buildStages(record: VerificationRecordEntity | null): ReceiptStageDto[] {
  const stored = parseStages(record?.stages);
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

function buildVerdict(record: VerificationRecordEntity | null): ReceiptVerdictDto {
  const tally = record?.tally;
  const decidedBy = record?.decidedBy;

  return {
    status: record?.verdictStatus ?? null,
    reasonCode: record?.reasonCode ?? null,
    reason: record?.reason ?? null,
    score: record?.score ?? null,
    tally: isPlainObject(tally) ? tally : null,
    decidedBy: isPlainObject(decidedBy) ? decidedBy : null,
  };
}

function buildPolicy(record: VerificationRecordEntity | null): ReceiptPolicyDto {
  return {
    policyId: record?.policyId ?? null,
    policyVersion: record?.policyVersion ?? null,
    decisionPolicyId: record?.decisionPolicyId ?? null,
    decisionPolicyVersion: record?.decisionPolicyVersion ?? null,
    lifecycle: record?.lifecycle ?? null,
  };
}

function buildSampling(record: VerificationRecordEntity | null): ReceiptSamplingDto {
  return {
    rate: record?.sampleRate ?? null,
    sampled: record?.sampled ?? null,
    display: record?.sampleDisplay ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
