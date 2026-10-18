import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import {
  STAGE_STATUS_LABEL,
  STAGE_STATUS_NOTE,
  StageResult,
  StageStatus,
  VERIFICATION_PIPELINE,
  VerificationStage,
} from '@modules/verification/domain/stage';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { ReceiptService } from '@modules/verification/services/receipt.service';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const INTENT_ID = 'intent-aaaaaaaa-1111-4111-8111-111111111111';
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

function buildIntent(overrides: Partial<PaymentIntentEntity> = {}): PaymentIntentEntity {
  return {
    id: INTENT_ID,
    organizationId: ORG,
    status: PaymentIntentStatus.VERIFYING,
    statusReason: null,
    agentId: 'agent-1',
    agentAccount: 'solana:mainnet:agent',
    providerId: 'provider-1',
    providerAccount: 'solana:mainnet:provider',
    toolId: 'tool-1',
    rail: 'RAIL_A_PER_CALL',
    assetId: USDC,
    decimals: 6,
    priceAmount: '1000',
    providerAmount: '900',
    platformFee: '100',
    settledAmount: null,
    requestHash: 'hash',
    chainId: 'solana:mainnet',
    expiresAt: new Date('2026-08-10T10:05:00.000Z'),
    idempotencyKey: null,
    voucherNonce: null,
    holdId: 'hold-1',
    holdReleasedAt: null,
    classification: null,
    verificationVerdict: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:01.000Z'),
    ...overrides,
  } as PaymentIntentEntity;
}

function buildRecord(overrides: Partial<VerificationRecordEntity> = {}): VerificationRecordEntity {
  return {
    id: 'record-1',
    organizationId: ORG,
    intentId: INTENT_ID,
    toolId: 'tool-1',
    providerId: 'provider-1',
    state: 'JUDGED',
    request: null,
    response: null,
    outputSchema: null,
    verdictStatus: null,
    reasonCode: null,
    reason: null,
    score: null,
    costUsd: null,
    policyId: null,
    policyVersion: null,
    decisionPolicyId: null,
    decisionPolicyVersion: null,
    lifecycle: null,
    sampleRate: null,
    sampled: null,
    sampleSelector: null,
    sampleDisplay: null,
    stages: null,
    verifiers: null,
    tally: null,
    decidedBy: null,
    evaluatedAt: null,
    settlementOutcome: null,
    settledAt: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:01.000Z'),
    ...overrides,
  } as VerificationRecordEntity;
}

function stageResult(
  stage: VerificationStage,
  status: StageStatus,
  patch: Partial<StageResult> = {},
): StageResult {
  return { stage, status, code: null, detail: null, score: null, ...patch };
}

function build(intent: PaymentIntentEntity | null, record: VerificationRecordEntity | null) {
  const intents = {
    findOneBy: jest.fn().mockResolvedValue(intent),
  } as unknown as PaymentIntentRepository;
  const records = {
    findByIntentId: jest.fn().mockResolvedValue(record),
  } as unknown as VerificationRecordRepository;

  return { service: new ReceiptService(intents, records), intents, records };
}

describe('ReceiptService — the four stage rows are always present, in pipeline order', () => {
  it('renders all four as NOT_REACHED when there is no verification_records row yet', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.PROVIDER_EXECUTING }),
      null,
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.stages).toHaveLength(4);
    expect(receipt.stages.map((row) => row.stage)).toEqual(VERIFICATION_PIPELINE);
    expect(receipt.stages.every((row) => row.status === StageStatus.NOT_REACHED)).toBe(true);
    expect(receipt.stages.every((row) => row.passed === false)).toBe(true);
  });

  it('renders all four as NOT_REACHED when the record exists but is still PENDING', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.VERIFYING }),
      buildRecord({ state: 'PENDING', stages: null }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.stages).toHaveLength(4);
    expect(receipt.stages.every((row) => row.status === StageStatus.NOT_REACHED)).toBe(true);
  });

  it('fills in NOT_REACHED for every stage after the one that failed — never omitted, never a pass', async () => {
    const stored: StageResult[] = [
      stageResult(VerificationStage.SCHEMA, StageStatus.PASSED, { score: 1 }),
      stageResult(VerificationStage.DETERMINISTIC_RULES, StageStatus.FAILED, {
        code: 'insufficient_results',
        detail: '0 results returned, the minimum is 1',
        score: 0.31,
      }),
      // CROSS_CHECK and SEMANTIC deliberately absent from the stored array —
      // exactly what the pipeline writes once it stops at the first failure.
    ];

    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.REFUNDED }),
      buildRecord({ state: 'SETTLED', stages: stored, verdictStatus: 'FAIL' }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.stages).toHaveLength(4);
    expect(receipt.stages.map((row) => row.stage)).toEqual(VERIFICATION_PIPELINE);

    const byStage = new Map(receipt.stages.map((row) => [row.stage, row]));
    expect(byStage.get(VerificationStage.SCHEMA)).toMatchObject({
      status: StageStatus.PASSED,
      passed: true,
    });
    expect(byStage.get(VerificationStage.DETERMINISTIC_RULES)).toMatchObject({
      status: StageStatus.FAILED,
      passed: false,
      code: 'insufficient_results',
    });
    // The hardest requirement on the receipt: not omitted, and not a pass.
    expect(byStage.get(VerificationStage.CROSS_CHECK)).toMatchObject({
      status: StageStatus.NOT_REACHED,
      passed: false,
    });
    expect(byStage.get(VerificationStage.SEMANTIC)).toMatchObject({
      status: StageStatus.NOT_REACHED,
      passed: false,
    });
  });

  it('carries the label and note straight from STAGE_STATUS_LABEL / STAGE_STATUS_NOTE — never retyped', async () => {
    const stored: StageResult[] = [
      stageResult(VerificationStage.SCHEMA, StageStatus.PASSED),
      stageResult(VerificationStage.DETERMINISTIC_RULES, StageStatus.PASSED),
      stageResult(VerificationStage.CROSS_CHECK, StageStatus.NOT_IMPLEMENTED),
      stageResult(VerificationStage.SEMANTIC, StageStatus.SKIPPED, {
        detail: '1 in 125 calls at this price',
      }),
    ];
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.SETTLED }),
      buildRecord({ stages: stored }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    for (const row of receipt.stages) {
      expect(row.label).toBe(STAGE_STATUS_LABEL[row.status]);
      expect(row.note).toBe(STAGE_STATUS_NOTE[row.status]);
    }
  });
});

describe('ReceiptService — no did-not-run status ever renders as a pass', () => {
  // Driven off `Object.values(StageStatus)` on purpose: a ninth member added
  // to the enum without a corresponding fix here fails this test rather than
  // silently reading as a tick on a receipt.
  const statuses = Object.values(StageStatus);

  it.each(statuses)('status %s renders passed=true only for PASSED', async (status) => {
    const stored: StageResult[] = [stageResult(VerificationStage.SCHEMA, status)];
    const { service } = build(buildIntent(), buildRecord({ stages: stored }));

    const receipt = await service.getReceipt(ORG, INTENT_ID);
    const row = receipt.stages.find((candidate) => candidate.stage === VerificationStage.SCHEMA);

    expect(row?.status).toBe(status);
    expect(row?.passed).toBe(status === StageStatus.PASSED);
  });

  it('covers every declared status — the enum did not grow without this test noticing', () => {
    expect(statuses).toEqual(
      expect.arrayContaining([
        StageStatus.PASSED,
        StageStatus.FAILED,
        StageStatus.NOT_REACHED,
        StageStatus.NOT_APPLICABLE,
        StageStatus.NOT_IMPLEMENTED,
        StageStatus.MISAPPLIED,
        StageStatus.SKIPPED,
        StageStatus.UNAVAILABLE,
      ]),
    );
    expect(statuses).toHaveLength(8);
  });
});

describe('ReceiptService — listed and charged, always both, even when equal', () => {
  it('are equal for a SETTLED call, and both still present', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.SETTLED, priceAmount: '1000' }),
      buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.listedPrice).toEqual({ amount: '1000', asset: USDC, decimals: 6 });
    expect(receipt.chargedPrice).toEqual({ amount: '1000', asset: USDC, decimals: 6 });
    expect(receipt.withheld).toEqual({ amount: '0', asset: USDC, decimals: 6 });
  });

  it('charges nothing on a SETTLED call whose voucher the provider forfeited (review M2)', async () => {
    const { service } = build(
      buildIntent({
        status: PaymentIntentStatus.SETTLED,
        priceAmount: '1000',
        redemptionLastError: 'provider_forfeit:ProviderBelowMinimumStake',
      }),
      buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.listedPrice.amount).toBe('1000');
    expect(receipt.chargedPrice.amount).toBe('0');
    // Withheld (NOT_COLLECTED): the hold was released, and the aggregate
    // `GET /withheld` counts it, so the row must too (UX review B1 I3).
    expect(receipt.withheld.amount).toBe('1000');
    expect(receipt.forfeited).toBe(true);
    expect(receipt.debt).toBeNull();
    expect(receipt.chargeNote).toBe('provider_forfeit:ProviderBelowMinimumStake');
  });

  it('an OUTSTANDING buyer debt is charged (held) and says so', async () => {
    const { service } = build(
      buildIntent({
        status: PaymentIntentStatus.SETTLED,
        priceAmount: '1000',
        holdReleasedAt: null,
        redemptionLapsedAt: new Date('2026-10-16T00:00:00Z'),
        redemptionLastError: 'DelegateIsRevoked',
      }),
      buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.chargedPrice.amount).toBe('1000');
    expect(receipt.forfeited).toBe(false);
    expect(receipt.debt).toBe('OUTSTANDING');
    expect(receipt.chargeNote).toBe('DelegateIsRevoked');
  });

  it('a WRITTEN_OFF debt is not charged, and is not a forfeit', async () => {
    const { service } = build(
      buildIntent({
        status: PaymentIntentStatus.SETTLED,
        priceAmount: '1000',
        holdReleasedAt: new Date('2026-11-16T00:00:00Z'),
        redemptionLapsedAt: new Date('2026-10-16T00:00:00Z'),
        redemptionLastError: 'uncollected:DelegateIsRevoked',
      }),
      buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.chargedPrice.amount).toBe('0');
    expect(receipt.forfeited).toBe(false);
    expect(receipt.debt).toBe('WRITTEN_OFF');
    // Still owed, so not withheld.
    expect(receipt.withheld.amount).toBe('0');
  });

  it.each([
    ['a late verdict', 'voided:REFUND'],
    ['an upheld report', 'voided:DISPUTE_UPHELD'],
  ])(
    'a debt voided by %s is not charged and withholds the listed price (B1 I3)',
    async (_, mark) => {
      const { service } = build(
        buildIntent({
          status: PaymentIntentStatus.SETTLED,
          priceAmount: '1000',
          holdReleasedAt: new Date('2026-10-16T01:00:00Z'),
          redemptionLapsedAt: new Date('2026-10-16T00:00:00Z'),
          redemptionLastError: mark,
        }),
        buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
      );

      const receipt = await service.getReceipt(ORG, INTENT_ID);

      expect(receipt.chargedPrice.amount).toBe('0');
      expect(receipt.withheld.amount).toBe('1000');
      expect(receipt.debt).toBe('VOIDED');
    },
  );

  it('a plain SETTLED call carries no flag', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.SETTLED, priceAmount: '1000' }),
      buildRecord({ verdictStatus: 'PASS', stages: passingStages() }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.forfeited).toBe(false);
    expect(receipt.debt).toBeNull();
    expect(receipt.chargeNote).toBeNull();
  });

  it('charges nothing on a REFUNDED call — withheld equals the full listed price', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.REFUNDED, priceAmount: '1000' }),
      buildRecord({ verdictStatus: 'FAIL' }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.listedPrice.amount).toBe('1000');
    expect(receipt.chargedPrice.amount).toBe('0');
    expect(receipt.withheld.amount).toBe('1000');
  });

  it('charges nothing while still in flight, before any verdict exists', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.PROVIDER_EXECUTING, priceAmount: '2500' }),
      null,
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.listedPrice.amount).toBe('2500');
    expect(receipt.chargedPrice.amount).toBe('0');
  });

  /**
   * The per-row figure has to be the *same predicate* as the aggregate, not a
   * subtraction that happens to agree on terminal calls.
   *
   * `withheld = listed - charged` is right for a settled or refunded call and
   * wrong for every other one, and the two cases below are where it comes
   * apart. If a row claimed withheld value that
   * `sumWithheldByAssetAndStatus` does not count, the "not charged" total on
   * the overview would not equal the sum of the rows a user can click through
   * to — which is the one property that makes the figure a record
   * rather than an advertisement.
   */
  it('withholds nothing on an in-flight call — money not yet charged is not money withheld', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.VERIFYING, priceAmount: '2500' }),
      buildRecord({ state: 'PENDING' }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.chargedPrice.amount).toBe('0');
    // Not '2500'. The call may still settle.
    expect(receipt.withheld.amount).toBe('0');
  });

  it('withholds nothing on an intent that expired before its funds were ever secured', async () => {
    // `CREATED → EXPIRED` carries `HoldEffect.NONE`, so there is no
    // `HOLD_RELEASE` for this price and the aggregate excludes it. See
    // `modules/ledger/domain/withheld.ts` — value can only be withheld if it
    // was first held.
    const { service } = build(
      buildIntent({
        status: PaymentIntentStatus.EXPIRED,
        priceAmount: '4000',
        holdId: null,
      }),
      null,
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.listedPrice.amount).toBe('4000');
    expect(receipt.chargedPrice.amount).toBe('0');
    expect(receipt.withheld.amount).toBe('0');
  });

  it('withholds the full price on an expiry that DID reserve funds', async () => {
    const { service } = build(
      buildIntent({
        status: PaymentIntentStatus.EXPIRED,
        priceAmount: '4000',
        holdId: 'hold-1',
      }),
      null,
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.withheld.amount).toBe('4000');
  });
});

describe('ReceiptService — policy, sampling and verdict render honestly when nothing has judged yet', () => {
  it('is all null, not fabricated, with no verification_records row', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.PROVIDER_EXECUTING }),
      null,
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.verdict).toEqual({
      status: null,
      reasonCode: null,
      reason: null,
      score: null,
      tally: null,
      decidedBy: null,
    });
    expect(receipt.policy).toEqual({
      policyId: null,
      policyVersion: null,
      decisionPolicyId: null,
      decisionPolicyVersion: null,
      lifecycle: null,
    });
    expect(receipt.sampling).toEqual({ rate: null, sampled: null, display: null });
    expect(receipt.evaluatedAt).toBeNull();
    expect(receipt.settledAt).toBeNull();
  });

  it('carries both policy pairs and the sampling sentence once judged', async () => {
    const { service } = build(
      buildIntent({ status: PaymentIntentStatus.SETTLED }),
      buildRecord({
        policyId: 'search_web.default',
        policyVersion: 3,
        decisionPolicyId: 'search_web.decision',
        decisionPolicyVersion: 1,
        lifecycle: 'ACTIVE',
        sampleRate: 0.08,
        sampled: false,
        sampleDisplay: '1 in 13 calls at this price',
        stages: passingStages(),
      }),
    );

    const receipt = await service.getReceipt(ORG, INTENT_ID);

    expect(receipt.policy).toEqual({
      policyId: 'search_web.default',
      policyVersion: 3,
      decisionPolicyId: 'search_web.decision',
      decisionPolicyVersion: 1,
      lifecycle: 'ACTIVE',
    });
    expect(receipt.sampling).toEqual({
      rate: 0.08,
      sampled: false,
      display: '1 in 13 calls at this price',
    });
  });
});

describe('ReceiptService — not found', () => {
  it('404s when the intent does not belong to this organization', async () => {
    const { service } = build(null, null);

    await expect(service.getReceipt(ORG, INTENT_ID)).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_RECEIPT_NOT_FOUND,
      statusCode: 404,
    });
  });
});

function passingStages(): StageResult[] {
  return [
    stageResult(VerificationStage.SCHEMA, StageStatus.PASSED),
    stageResult(VerificationStage.DETERMINISTIC_RULES, StageStatus.PASSED),
    stageResult(VerificationStage.CROSS_CHECK, StageStatus.NOT_IMPLEMENTED),
    stageResult(VerificationStage.SEMANTIC, StageStatus.SKIPPED),
  ];
}
