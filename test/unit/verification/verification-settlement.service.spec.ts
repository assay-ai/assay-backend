import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { PaymentIntentRepository, VerificationRecordRepository } from '@database/postgres';
import { VerificationRecordState } from '@database/postgres/repositories/verification-record.repository';
import {
  HoldEffect,
  requirePaymentIntentTransition,
} from '@modules/payment/domain/payment-intent-transitions';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentIntentTransitionContext,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import {
  DEFAULT_VERIFICATION_BUDGET,
  PolicyLifecycle,
  VerdictOutcome,
  VerdictStatus,
  unrunStages,
} from '@modules/verification/domain';
import { VerificationSamplingConfig } from '@modules/verification/config/verification-sampling.config';
import { DataSource } from 'typeorm';

import { SlaWindowPoster } from '@modules/verification/ports/sla-window-poster.port';
import { VerificationJudgePublisher } from '@modules/verification/publishers/verification-judge.publisher';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';
import {
  VerificationAggregatorService,
  VerificationOutcome,
} from '@modules/verification/services/verification-aggregator.service';
import { VerificationSettlementService } from '@modules/verification/services/verification-settlement.service';

import { usdc } from '../tool/helpers/routing-fixtures';

/**
 * `VerificationSettlementService` — the worker half of taking
 * verification off the latency path.
 *
 * Every fake here exists to make the crash-resume claims checkable rather
 * than assumed: `FakeLedger` counts an *applied* commit or release
 * separately from a call to `commitHold`/`releaseHold`, because the whole
 * point of the idempotency guarantee is that the method can be called
 * repeatedly and only the first call is allowed to move money.
 * `FakePaymentIntents.resolve` runs the **real** transition table
 * (`requirePaymentIntentTransition`) and throws the **real**
 * `PaymentErrors.invalidStateTransition`, so the service's own
 * `isInvalidStateTransition` catch is exercised against the genuine error
 * shape rather than a stand-in for it.
 */

const ORG = 'org-1';
const INTENT_ID = 'intent-1';
const TOOL_ID = 'tool-1';
const PROVIDER_ID = 'provider-1';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type HoldState = 'OPEN' | 'COMMITTED' | 'RELEASED';

class FakeLedger {
  private readonly holds = new Map<string, HoldState>();
  commitCalls = 0;
  releaseCalls = 0;
  appliedCommits = 0;
  appliedReleases = 0;

  open(holdId: string): void {
    this.holds.set(holdId, 'OPEN');
  }

  async commitHold(_organizationId: string, holdId: string) {
    this.commitCalls += 1;
    const state = this.holds.get(holdId) ?? 'OPEN';
    if (state === 'COMMITTED') return { hold: {} as never, applied: false };
    if (state === 'RELEASED')
      throw new Error(`hold ${holdId}: cannot commit an already-released hold`);
    this.holds.set(holdId, 'COMMITTED');
    this.appliedCommits += 1;
    return { hold: {} as never, applied: true };
  }

  /**
   * `repairHoldEffect`'s `COMMIT` branch calls this, not `commitHold`
   * — same state machine, same counters, so the existing `appliedCommits` /
   * `commitCalls` assertions still mean "a commit happened" regardless of
   * which of the two methods produced it.
   */
  async commitHoldAndCredit(_organizationId: string, holdId: string, _credit: unknown) {
    return this.commitHold(_organizationId, holdId);
  }

  async releaseHold(_organizationId: string, holdId: string) {
    this.releaseCalls += 1;
    const state = this.holds.get(holdId) ?? 'OPEN';
    if (state === 'RELEASED') return { hold: {} as never, applied: false };
    if (state === 'COMMITTED')
      throw new Error(`hold ${holdId}: cannot release an already-committed hold`);
    this.holds.set(holdId, 'RELEASED');
    this.appliedReleases += 1;
    return { hold: {} as never, applied: true };
  }
}

/**
 * `PaymentIntentService` over a `Map`, applying the real transition table —
 * mirrors `test/unit/mcp/helpers/mcp-harness.ts`'s `FakeIntents`, with the
 * one difference that matters here: a lost compare-and-swap throws the real
 * `PaymentErrors.invalidStateTransition`, which is what
 * `VerificationSettlementService`'s crash-resume path actually catches.
 */
class FakePaymentIntents {
  readonly rows = new Map<string, PaymentIntent>();

  constructor(private readonly ledger: FakeLedger) {}

  seed(intent: PaymentIntent): void {
    this.rows.set(intent.id, intent);
    if (intent.holdId) this.ledger.open(intent.holdId);
  }

  async findById(_organizationId: string, id: string): Promise<PaymentIntent> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no such intent: ${id}`);
    return row;
  }

  async resolve(
    organizationId: string,
    id: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    context: PaymentIntentTransitionContext = {},
  ): Promise<PaymentIntent> {
    const rule = requirePaymentIntentTransition(from, to, { intentId: id });
    const current = this.rows.get(id) as PaymentIntent;

    if (current.status !== from) {
      throw PaymentErrors.invalidStateTransition({
        intentId: id,
        from,
        to,
        actual: current.status,
      });
    }

    let updated: PaymentIntent = {
      ...current,
      status: to,
      statusReason: context.reason ?? current.statusReason,
      verificationVerdict: context.verificationVerdict ?? current.verificationVerdict,
      settledAmount: context.settledAmount ?? current.settledAmount,
    };
    this.rows.set(id, updated);

    if (rule.holdEffect === HoldEffect.NONE || !updated.holdId) return updated;

    if (rule.holdEffect === HoldEffect.RELEASE) {
      await this.ledger.releaseHold(organizationId, updated.holdId);
    } else if (rule.holdEffect === HoldEffect.COMMIT) {
      await this.ledger.commitHold(organizationId, updated.holdId);
    }

    updated = { ...updated, holdReleasedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  /** Intents that are buyer debt (lapsed, not being replaced) — what `voidDebt` acts on. */
  readonly debts = new Set<string>();
  readonly voided: Array<{ id: string; outcome: string }> = [];

  /** `PaymentIntentService.voidDebt`: a debt's hold released, nobody credited. */
  async voidDebt(organizationId: string, id: string, outcome: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || !this.debts.has(id) || !row.holdId) return false;
    await this.ledger.releaseHold(organizationId, row.holdId);
    this.rows.set(id, { ...row, holdReleasedAt: new Date() });
    this.voided.push({ id, outcome });
    return true;
  }
}

/** Only `update()` — the one method the repair path calls directly. */
class FakePaymentIntentRepository {
  constructor(private readonly intents: FakePaymentIntents) {}

  async update(
    criteria: { readonly organizationId: string; readonly id: string },
    patch: Partial<PaymentIntent>,
  ) {
    const row = this.intents.rows.get(criteria.id);
    if (!row) return { affected: 0 };
    this.intents.rows.set(criteria.id, { ...row, ...patch });
    return { affected: 1 };
  }
}

class FakeVerificationRecords {
  readonly rows = new Map<string, VerificationRecordEntity>();

  seedPending(
    intentId: string,
    overrides: Partial<VerificationRecordEntity> = {},
  ): VerificationRecordEntity {
    const row = {
      id: randomUUID(),
      organizationId: ORG,
      intentId,
      toolId: TOOL_ID,
      providerId: PROVIDER_ID,
      state: VerificationRecordState.PENDING,
      request: { query: 'usdc price' },
      response: { answer: 'forty-two' },
      outputSchema: { type: 'object' },
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
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      ...overrides,
    } as unknown as VerificationRecordEntity;

    this.rows.set(row.id, row);
    return row;
  }

  async insert(row: Record<string, unknown>): Promise<void> {
    const existing = [...this.rows.values()].find(
      (candidate) => candidate.intentId === row.intentId,
    );
    if (existing) {
      const error = new Error('duplicate key value violates unique constraint') as Error & {
        code: string;
        constraint: string;
      };
      error.code = '23505';
      error.constraint = 'uq_verification_records_intent';
      throw error;
    }

    this.rows.set(
      row.id as string,
      {
        ...row,
        attempts: 0,
        lastError: null,
      } as unknown as VerificationRecordEntity,
    );
  }

  async findByIntentId(
    _organizationId: string,
    intentId: string,
  ): Promise<VerificationRecordEntity | null> {
    return [...this.rows.values()].find((row) => row.intentId === intentId) ?? null;
  }

  async markJudgedIfPending(
    _organizationId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.state !== VerificationRecordState.PENDING) return 0;
    Object.assign(row, patch, { state: VerificationRecordState.JUDGED });
    return 1;
  }

  async markSettledIfJudged(
    _organizationId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.state !== VerificationRecordState.JUDGED) return 0;
    Object.assign(row, patch, { state: VerificationRecordState.SETTLED });
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: INTENT_ID,
    organizationId: ORG,
    status: PaymentIntentStatus.VERIFYING,
    statusReason: null,
    agentId: 'agent-1',
    agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1' as never,
    providerId: PROVIDER_ID,
    providerAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/provider-1' as never,
    toolId: TOOL_ID,
    // The binding that served, written by the same transition that named the
    // provider. The worker reads neither — it judges an answer, not a
    // route — so it is here only to make the fixture a whole `PaymentIntent`.
    bindingId: 'binding-1',
    rail: PaymentRail.RAIL_A_PER_CALL,
    callId: 'test-call-id',
    callClass: PaymentIntentCallClass.PAID,
    price: usdc('0.05'),
    providerAmount: usdc('0.04'),
    platformFee: usdc('0.01'),
    settledAmount: null,
    requestHash: 'hash',
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
    expiresAt: new Date(Date.now() + 300_000),
    idempotencyKey: null,
    voucherNonce: null,
    voucherSeq: null,
    voucherSignature: null,
    voucherResourceHash: null,
    voucherIssuedAt: null,
    holdId: 'hold-1',
    holdReleasedAt: null,
    classification: 'DATA_RESULT',
    verificationVerdict: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A `VerificationOutcome` shaped enough for the settlement service to act on. */
function verificationOutcome(status: VerdictStatus, outcome: VerdictOutcome): VerificationOutcome {
  const evaluatedAt = new Date();
  const stages = unrunStages('test_stage', 'stand-in for the pipeline in this test').map(
    (evaluation) => evaluation.result,
  );

  return {
    verdict: {
      intentId: INTENT_ID,
      toolId: TOOL_ID,
      policyId: 'policy-1',
      policyVersion: 1,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      lifecycle: PolicyLifecycle.ACTIVE,
      status,
      reasonCode: status === VerdictStatus.PASS ? null : 'test_reason',
      reason: status === VerdictStatus.PASS ? null : 'the test verdict says so',
      score: 0.9,
      costUsd: 0,
      tally: {
        declared: 2,
        votes: 2,
        passed: status === VerdictStatus.PASS ? 2 : 0,
        failed: status === VerdictStatus.PASS ? 0 : 2,
        misapplied: 0,
        unavailable: 0,
        abstained: 0,
        failedFraction: status === VerdictStatus.PASS ? 0 : 1,
        unregistered: 0,
      },
      decidedBy: { clauseIndex: null, trigger: null, label: null },
      verifiers: [],
      shadow: false,
      evaluatedAt,
    },
    settlement: {
      intentId: INTENT_ID,
      status,
      outcome,
      settle: outcome === VerdictOutcome.SETTLE,
      strike: outcome === VerdictOutcome.REFUND,
      slashable: outcome === VerdictOutcome.REFUND,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      reasonCode: status === VerdictStatus.PASS ? null : 'test_reason',
      reason: status === VerdictStatus.PASS ? null : 'the test verdict says so',
      evaluatedAt,
    },
    stages,
  };
}

interface Harness {
  readonly service: VerificationSettlementService;
  readonly ledger: FakeLedger;
  readonly intents: FakePaymentIntents;
  readonly records: FakeVerificationRecords;
  readonly decide: jest.Mock;
  readonly publishJudge: jest.Mock;
  /** The evidence-pack sealer, stubbed — what it was called with is the assertion. */
  readonly seal: jest.Mock;
  /** Records how the judging transaction ended: committed, or rolled back. */
  readonly transaction: { commits: number; rollbacks: number };
  /** The SLA window's `SLA_WINDOW_POSTER` — what `settle()` posted, if anything. */
  readonly postCall: jest.Mock;
}

/**
 * A `DataSource` that is only a transaction ceremony.
 *
 * `runInTransaction` needs `createQueryRunner().connect()/startTransaction()/
 * commitTransaction()/rollbackTransaction()/release()`, and nothing in this
 * suite issues SQL — the repositories are fakes. Counting the commits and
 * rollbacks is the point: it is how a unit test can tell that the verdict write
 * and the seal are inside ONE transaction, without a database to roll back.
 *
 * That the rollback actually un-writes the row is a database property and is
 * asserted where it can be: `evidence-pack-sealer.integration.spec.ts`.
 */
function fakeDataSource(transaction: { commits: number; rollbacks: number }) {
  return {
    createQueryRunner: () => ({
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => {
        transaction.commits += 1;
      },
      rollbackTransaction: async () => {
        transaction.rollbacks += 1;
      },
      release: async () => undefined,
      manager: {},
    }),
  };
}

function harness(options: { samplingSecret?: string | null } = {}): Harness {
  const ledger = new FakeLedger();
  const intents = new FakePaymentIntents(ledger);
  const paymentIntents = new FakePaymentIntentRepository(intents);
  const records = new FakeVerificationRecords();
  const decide = jest.fn();
  const publishJudge = jest.fn().mockResolvedValue(undefined);

  const sampling: VerificationSamplingConfig = {
    // `??` would treat an explicit `null` (sampling deliberately disabled) the
    // same as "not passed" and silently default it back to a secret — the
    // exact distinction this option exists to let a test control.
    secret: options.samplingSecret === undefined ? 'test-sampling-secret' : options.samplingSecret,
    budget: DEFAULT_VERIFICATION_BUDGET,
  };

  const seal = jest.fn().mockResolvedValue({
    id: 'pack-1',
    seq: 1,
    contentHash: 'a'.repeat(64),
    prevHash: null,
    sealedAt: new Date(),
    bodyExpiresAt: new Date(),
  });
  const transaction = { commits: 0, rollbacks: 0 };
  const postCall = jest.fn().mockResolvedValue(undefined);

  const service = new VerificationSettlementService(
    records as unknown as VerificationRecordRepository,
    paymentIntents as unknown as PaymentIntentRepository,
    intents as unknown as PaymentIntentService,
    ledger as unknown as LedgerService,
    { decide } as unknown as VerificationAggregatorService,
    { publishJudge } as unknown as VerificationJudgePublisher,
    { seal } as unknown as EvidencePackSealerService,
    fakeDataSource(transaction) as unknown as DataSource,
    sampling,
    { postCall } as unknown as SlaWindowPoster,
  );

  return { service, ledger, intents, records, decide, publishJudge, seal, transaction, postCall };
}

function theRecord(records: FakeVerificationRecords): VerificationRecordEntity {
  return [...records.rows.values()][0];
}

// ---------------------------------------------------------------------------
// enqueue()
// ---------------------------------------------------------------------------

describe('VerificationSettlementService.enqueue', () => {
  it('writes a PENDING record and publishes the wakeup', async () => {
    const { service, records, publishJudge } = harness();

    await service.enqueue({
      organizationId: ORG,
      intentId: INTENT_ID,
      toolId: TOOL_ID,
      providerId: PROVIDER_ID,
      request: { query: 'usdc price' },
      response: { answer: 'forty-two' },
      outputSchema: { type: 'object' } as never,
    });

    const record = theRecord(records);
    expect(record.state).toBe(VerificationRecordState.PENDING);
    expect(record.intentId).toBe(INTENT_ID);
    expect(publishJudge).toHaveBeenCalledTimes(1);
    expect(publishJudge).toHaveBeenCalledWith({
      organizationId: ORG,
      intentId: INTENT_ID,
      recordId: record.id,
    });
  });

  it('does not duplicate the record on a retried enqueue for the same intent', async () => {
    const { service, records, publishJudge } = harness();
    const input = {
      organizationId: ORG,
      intentId: INTENT_ID,
      toolId: TOOL_ID,
      providerId: PROVIDER_ID,
      request: { query: 'usdc price' },
      response: { answer: 'forty-two' },
      outputSchema: { type: 'object' } as never,
    };

    await service.enqueue(input);
    await service.enqueue(input);

    expect(records.rows.size).toBe(1);
    // Still wakes the worker both times — the second call must not throw out
    // of the caller (`McpToolCallService`), which is the property that matters.
    expect(publishJudge).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// judgeAndSettle() — the six required behaviours
// ---------------------------------------------------------------------------

describe('VerificationSettlementService.judgeAndSettle', () => {
  it('1. a PASS verdict settles the intent and commits the hold, never releases', async () => {
    const { service, ledger, intents, records, decide, postCall } = harness();
    intents.seed(baseIntent());
    records.seedPending(INTENT_ID);
    decide.mockResolvedValue(verificationOutcome(VerdictStatus.PASS, VerdictOutcome.SETTLE));

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.SETTLED);
    expect(ledger.appliedCommits).toBe(1);
    expect(ledger.appliedReleases).toBe(0);
    expect(theRecord(records).state).toBe(VerificationRecordState.SETTLED);

    // Posted before the record is marked SETTLED — see the
    // `SLA_WINDOW_POSTER` call site's own comment for why the order matters.
    expect(postCall).toHaveBeenCalledTimes(1);
    expect(postCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: PROVIDER_ID,
        providerId: PROVIDER_ID,
        bindingId: 'binding-1',
        intentId: INTENT_ID,
        agentId: 'agent-1',
        verdictStatus: VerdictStatus.PASS,
      }),
    );
  });

  it('2. a FAIL verdict refunds the intent and releases the hold, never commits', async () => {
    const { service, ledger, intents, records, decide } = harness();
    intents.seed(baseIntent());
    records.seedPending(INTENT_ID);
    decide.mockResolvedValue(verificationOutcome(VerdictStatus.FAIL, VerdictOutcome.REFUND));

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.REFUNDED);
    expect(ledger.appliedReleases).toBe(1);
    expect(ledger.appliedCommits).toBe(0);
    expect(theRecord(records).state).toBe(VerificationRecordState.SETTLED);
  });

  it('2b. a MISAPPLIED (VOID) verdict voids the intent — the hold is released, nobody is blamed', async () => {
    const { service, ledger, intents, records, decide } = harness();
    intents.seed(baseIntent());
    records.seedPending(INTENT_ID);
    decide.mockResolvedValue(verificationOutcome(VerdictStatus.MISAPPLIED, VerdictOutcome.VOID));

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.VOIDED);
    expect(ledger.appliedReleases).toBe(1);
    expect(ledger.appliedCommits).toBe(0);
  });

  it('3. crash between judge and settle: re-run does not call decide() again, and the hold resolves exactly once', async () => {
    const { service, ledger, intents, records, decide } = harness();
    intents.seed(baseIntent());
    // Phase 1 already ran and completed — a JUDGED record with a verdict on
    // it — and the process died before phase 2 started.
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.PASS,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.SETTLE,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(decide).not.toHaveBeenCalled();
    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.SETTLED);
    expect(ledger.appliedCommits).toBe(1);
    expect(theRecord(records).state).toBe(VerificationRecordState.SETTLED);
  });

  it('4. crash after the intent transition but before the ledger call: the repair path applies the hold effect once, without a second transition attempt', async () => {
    const { service, ledger, intents, records, decide } = harness();
    // The intent's status already moved — `resolve()`'s own CAS succeeded —
    // but the process died before the ledger call that should have followed
    // it, so `holdReleasedAt` never got stamped and the hold at the ledger
    // is still OPEN.
    intents.seed(baseIntent({ status: PaymentIntentStatus.SETTLED, holdReleasedAt: null }));
    const resolveSpy = jest.spyOn(intents, 'resolve');
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.PASS,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.SETTLE,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(decide).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(ledger.appliedCommits).toBe(1);
    expect(ledger.appliedReleases).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).not.toBeNull();
    expect(theRecord(records).state).toBe(VerificationRecordState.SETTLED);
  });

  it('5. double delivery settles exactly once, across the PASS/FAIL matrix', async () => {
    const matrix: readonly [VerdictStatus, VerdictOutcome, PaymentIntentStatus][] = [
      [VerdictStatus.PASS, VerdictOutcome.SETTLE, PaymentIntentStatus.SETTLED],
      [VerdictStatus.FAIL, VerdictOutcome.REFUND, PaymentIntentStatus.REFUNDED],
      [VerdictStatus.MISAPPLIED, VerdictOutcome.VOID, PaymentIntentStatus.VOIDED],
    ];

    for (const [status, outcome, expectedIntentStatus] of matrix) {
      const { service, ledger, intents, records, decide } = harness();
      intents.seed(baseIntent());
      records.seedPending(INTENT_ID);
      decide.mockResolvedValue(verificationOutcome(status, outcome));

      // BullMQ is at-least-once: the same wakeup can be delivered twice.
      await service.judgeAndSettle(ORG, INTENT_ID);
      await service.judgeAndSettle(ORG, INTENT_ID);

      expect(decide).toHaveBeenCalledTimes(1);
      expect(intents.rows.get(INTENT_ID)?.status).toBe(expectedIntentStatus);
      expect(ledger.appliedCommits + ledger.appliedReleases).toBe(1);
    }
  });

  it('6. no decision policy: decide() returning null settles the call, and the stored stages say nothing ran', async () => {
    const { service, ledger, intents, records, decide } = harness();
    intents.seed(baseIntent());
    records.seedPending(INTENT_ID);
    decide.mockResolvedValue(null);

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.SETTLED);
    expect(ledger.appliedCommits).toBe(1);

    const record = theRecord(records);
    expect(record.state).toBe(VerificationRecordState.SETTLED);
    // Never a fabricated PASS — this is the honest "nobody judged this" record.
    expect(record.verdictStatus).not.toBe(VerdictStatus.PASS);
    expect(record.verdictStatus).toBe('UNVERIFIED');
    expect(record.decisionPolicyId).toBe('none');

    const stages = record.stages as ReadonlyArray<{ readonly status: string }>;
    expect(stages).toHaveLength(4);
    expect(stages.every((stage) => stage.status !== 'PASSED')).toBe(true);
  });

  /**
   * The repair path reads the hold effect off the **intent's status**, through
   * `PAYMENT_INTENT_TRANSITIONS`, and not off the record's `settlementOutcome`.
   *
   * The two agree on every path that exists today, which is exactly why this
   * needs a test: "they agree" is a claim about the current call graph, and
   * the repair path runs precisely when the current call graph did not finish.
   * `payment_intents.status` is what the transition table binds a `holdEffect`
   * to, so if the money ever moved on the record's say-so instead, it could
   * move in a direction the payment record does not describe — and the payment
   * record is what a reconciliation, a statement and a dispute all read.
   */
  /**
   * The verdict and its evidence are one transaction.
   *
   * What a unit test can prove here is the *shape*: that the seal happens on
   * the winning branch of the compare-and-swap, with the judged values rather
   * than the pre-judgement ones, and that a sealer failure ends the transaction
   * in a rollback and re-raises. That the rollback actually un-writes the row
   * is a database property, asserted in
   * `test/integration/verification/evidence-pack-sealer.integration.spec.ts`.
   */
  describe('evidence sealing', () => {
    it('seals the judged verdict, not the record as it was before judging', async () => {
      const { service, intents, records, decide, seal, transaction } = harness();
      intents.seed(baseIntent());
      records.seedPending(INTENT_ID);
      decide.mockResolvedValue(verificationOutcome(VerdictStatus.FAIL, VerdictOutcome.REFUND));

      await service.judgeAndSettle(ORG, INTENT_ID);

      expect(seal).toHaveBeenCalledTimes(1);
      const [, input] = seal.mock.calls[0] as [
        unknown,
        { record: Record<string, unknown>; sealedAt: Date },
      ];
      expect(input.record).toMatchObject({
        id: theRecord(records).id,
        organizationId: ORG,
        intentId: INTENT_ID,
        verdictStatus: VerdictStatus.FAIL,
        settlementOutcome: VerdictOutcome.REFUND,
      });
      expect(input.sealedAt).toBeInstanceOf(Date);
      expect(transaction.rollbacks).toBe(0);
    });

    it('does not seal when another worker won the compare-and-swap', async () => {
      // Second delivery of the same wakeup: the record is already JUDGED, the
      // CAS affects no rows, and a second pack for one verdict would be refused
      // by uq_evidence_packs_verdict anyway. Not attempting it is the point —
      // the loser must not turn a duplicate wakeup into an error.
      const { service, intents, records, decide, seal } = harness();
      intents.seed(baseIntent());
      records.seedPending(INTENT_ID);
      decide.mockResolvedValue(verificationOutcome(VerdictStatus.PASS, VerdictOutcome.SETTLE));

      await service.judgeAndSettle(ORG, INTENT_ID);
      seal.mockClear();
      await service.judgeAndSettle(ORG, INTENT_ID);

      expect(seal).not.toHaveBeenCalled();
    });

    it('rolls the judgement back and re-raises when sealing throws', async () => {
      // The trade this design makes, stated as a test: no evidence, no verdict.
      // A sealer bug stops judging instead of letting verdicts accumulate that
      // nobody can ever explain.
      const { service, intents, records, decide, seal, transaction } = harness();
      intents.seed(baseIntent());
      records.seedPending(INTENT_ID);
      decide.mockResolvedValue(verificationOutcome(VerdictStatus.PASS, VerdictOutcome.SETTLE));
      seal.mockRejectedValue(new Error('the chain is unreadable'));

      await expect(service.judgeAndSettle(ORG, INTENT_ID)).rejects.toThrow(
        'the chain is unreadable',
      );

      expect(transaction.rollbacks).toBe(1);
      expect(transaction.commits).toBe(0);
    });
  });

  it('repairs in the direction the intent status implies, even when the record disagrees', async () => {
    const { service, ledger, intents, records } = harness();
    // Terminal as REFUNDED — whose edge out of VERIFYING carries RELEASE —
    // while the record claims the verdict settled. The status wins.
    intents.seed(baseIntent({ status: PaymentIntentStatus.REFUNDED, holdReleasedAt: null }));
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.PASS,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.SETTLE,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(ledger.appliedReleases).toBe(1);
    expect(ledger.appliedCommits).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).not.toBeNull();
  });

  it('repairs a hold left open on VOIDED, which a VOID verdict now reaches from VERIFYING', async () => {
    const { service, ledger, intents, records } = harness();
    // `VERIFYING → VOIDED` is the MISAPPLIED edge; its declared effect is
    // RELEASE, so a worker that died after the status change is repaired in
    // the agent's favour, from the table rather than from the verdict.
    intents.seed(baseIntent({ status: PaymentIntentStatus.VOIDED, holdReleasedAt: null }));
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.MISAPPLIED,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.VOID,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(ledger.appliedCommits).toBe(0);
    expect(ledger.appliedReleases).toBe(1);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).not.toBeNull();
  });

  /**
   * REGRESSION (review 2026-10-15 P-8): the repair skipped EVERY rail-B intent
   * as "awaiting redemption", which is true only of SETTLED. A rail-B intent
   * that reached REFUNDED or VOIDED and then lost its release kept the buyer's
   * money held for good.
   */
  it.each([
    [PaymentIntentStatus.REFUNDED, VerdictStatus.FAIL, VerdictOutcome.REFUND],
    [PaymentIntentStatus.VOIDED, VerdictStatus.MISAPPLIED, VerdictOutcome.VOID],
  ])('releases a rail-B hold left open on %s', async (status, verdictStatus, settlementOutcome) => {
    const { service, ledger, intents, records } = harness();
    intents.seed(baseIntent({ status, rail: PaymentRail.RAIL_B_VOUCHER, holdReleasedAt: null }));
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(ledger.appliedReleases).toBe(1);
    expect(ledger.appliedCommits).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).not.toBeNull();
  });

  it('still leaves a SETTLED rail-B hold to the redemption job', async () => {
    const { service, ledger, intents, records } = harness();
    intents.seed(
      baseIntent({
        status: PaymentIntentStatus.SETTLED,
        rail: PaymentRail.RAIL_B_VOUCHER,
        holdReleasedAt: null,
      }),
    );
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.PASS,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.SETTLE,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(ledger.appliedReleases).toBe(0);
    expect(ledger.appliedCommits).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).toBeNull();
  });

  /**
   * The deadline on verdicts (no-platform-debt step 4): the expiry sweep
   * settled this rail-B intent as served at `expiresAt + 900 s`. A verdict
   * that lands afterwards — even a REFUND — must neither settle it again nor
   * release the hold the redemption job is about to collect.
   */
  it('a late verdict on a rail-B intent the deadline already settled moves no money', async () => {
    const { service, ledger, intents, records } = harness();
    intents.seed(
      baseIntent({
        status: PaymentIntentStatus.SETTLED,
        rail: PaymentRail.RAIL_B_VOUCHER,
        holdReleasedAt: null,
      }),
    );
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.FAIL,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.REFUND,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(ledger.appliedReleases).toBe(0);
    expect(ledger.appliedCommits).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.SETTLED);
    expect(intents.rows.get(INTENT_ID)?.holdReleasedAt).toBeNull();
    // Asked, but it is not debt (awaiting redemption): nothing voided.
    expect(intents.voided).toEqual([]);
  });

  it('M2: a late REFUND for a call that became buyer debt voids the debt — buyer not charged', async () => {
    const { service, ledger, intents, records } = harness();
    intents.seed(
      baseIntent({
        status: PaymentIntentStatus.SETTLED,
        rail: PaymentRail.RAIL_B_VOUCHER,
        holdReleasedAt: null,
      }),
    );
    intents.debts.add(INTENT_ID);
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.FAIL,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.REFUND,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.voided).toEqual([{ id: INTENT_ID, outcome: VerdictOutcome.REFUND }]);
    expect(ledger.appliedReleases).toBe(1);
    expect(ledger.appliedCommits).toBe(0);
    expect(intents.rows.get(INTENT_ID)?.status).toBe(PaymentIntentStatus.SETTLED);
  });

  it('M2: a late PASS for a debt is not a void — the buyer still owes the served call', async () => {
    const { service, intents, records } = harness();
    intents.seed(
      baseIntent({
        status: PaymentIntentStatus.SETTLED,
        rail: PaymentRail.RAIL_B_VOUCHER,
        holdReleasedAt: null,
      }),
    );
    intents.debts.add(INTENT_ID);
    records.seedPending(INTENT_ID, {
      state: VerificationRecordState.JUDGED,
      verdictStatus: VerdictStatus.PASS,
      decisionPolicyId: 'decision-1',
      decisionPolicyVersion: 1,
      evaluatedAt: new Date(),
      stages: [],
      settlementOutcome: VerdictOutcome.SETTLE,
    });

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(intents.voided).toEqual([]);
  });

  it('drops the wakeup when no record exists, without throwing', async () => {
    const { service, decide } = harness();

    await expect(service.judgeAndSettle(ORG, 'no-such-intent')).resolves.toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });

  it('with no sampling secret configured, every call records NOT_SAMPLED rather than drawing against a predictable key', async () => {
    const { service, intents, records, decide } = harness({ samplingSecret: null });
    intents.seed(baseIntent());
    records.seedPending(INTENT_ID);
    decide.mockResolvedValue(verificationOutcome(VerdictStatus.PASS, VerdictOutcome.SETTLE));

    await service.judgeAndSettle(ORG, INTENT_ID);

    expect(decide).toHaveBeenCalledTimes(1);
    const [[call]] = decide.mock.calls;
    expect(call.semantic?.outcome).toBe('NOT_SAMPLED');
    expect(theRecord(records).sampled).toBe(false);
  });
});
