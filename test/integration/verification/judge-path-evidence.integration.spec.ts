import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';
import { VerdictOutcome, VerdictStatus } from '@modules/verification/domain/verdict';
import { unrunStages } from '@modules/verification/domain/aggregation/run-verifiers';
import {
  reconstructVerdict,
  verifyPackIntegrity,
} from '@modules/verification/domain/evidence/pack';
import type { EvidenceCore } from '@modules/verification/domain/evidence/pack.types';
import type { VerificationOutcome } from '@modules/verification/services/verification-aggregator.service';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import {
  JudgePathTestContext,
  createJudgePathTestContext,
} from '../helpers/judge-path-test-context';

/**
 * The worker path, end to end, with real money and a real database.
 *
 * This is the harness the evidence pack was first written without: every other proof that a
 * judged verdict has evidence either issued the two statements `judge()` makes
 * by hand, or asserted the wiring against fakes. Neither shows that the code
 * which actually runs — hold, transition table, compare-and-swap, transaction,
 * sealer, chain, settlement — leaves a pack behind.
 *
 * Only the verdict itself and the BullMQ wakeup are stubbed; see the context.
 */
describe('a real judged call leaves sealed evidence', () => {
  let context: JudgePathTestContext;

  beforeAll(async () => {
    context = await createJudgePathTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  function outcome(
    status: VerdictStatus,
    settlement: VerdictOutcome,
    intentId: string,
    toolId: string,
  ): VerificationOutcome {
    const evaluatedAt = new Date();
    return {
      verdict: {
        intentId,
        toolId,
        policyId: 'policy.weather',
        policyVersion: 2,
        decisionPolicyId: 'decision.default',
        decisionPolicyVersion: 1,
        lifecycle: PolicyLifecycle.ACTIVE,
        status,
        reasonCode: status === VerdictStatus.PASS ? null : 'schema_mismatch',
        reason: status === VerdictStatus.PASS ? null : 'the response is missing tempF',
        score: status === VerdictStatus.PASS ? 0.98 : 0.2,
        costUsd: 0,
        tally: {
          declared: 1,
          votes: 1,
          passed: status === VerdictStatus.PASS ? 1 : 0,
          failed: status === VerdictStatus.PASS ? 0 : 1,
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
        intentId,
        status,
        outcome: settlement,
        settle: settlement === VerdictOutcome.SETTLE,
        strike: settlement === VerdictOutcome.REFUND,
        slashable: settlement === VerdictOutcome.REFUND,
        decisionPolicyId: 'decision.default',
        decisionPolicyVersion: 1,
        reasonCode: status === VerdictStatus.PASS ? null : 'schema_mismatch',
        reason: status === VerdictStatus.PASS ? null : 'the response is missing tempF',
        evaluatedAt,
      },
      stages: unrunStages('schema_mismatch', 'stand-in for the pipeline').map(
        (evaluation) => evaluation.result,
      ),
    };
  }

  async function packRow(verdictId: string) {
    const [row] = (await context.dataSource.query(
      `SELECT p."id", p."seq", p."prev_hash", p."content_hash", p."core", p."provider_id"
         FROM "evidence_packs" p WHERE p."verdict_id" = $1`,
      [verdictId],
    )) as Array<{
      id: string;
      seq: string;
      prev_hash: string | null;
      content_hash: string;
      core: EvidenceCore;
      provider_id: string | null;
    }>;
    return row;
  }

  it('settles a passing call and seals a pack that reconstructs the verdict', async () => {
    const intent = await context.callReadyToJudge();
    context.decide.mockResolvedValue(
      outcome(VerdictStatus.PASS, VerdictOutcome.SETTLE, intent.id, intent.toolId),
    );

    await context.settlement.judgeAndSettle(context.organizationId, intent.id);

    // The money moved — this is the real path, not a fixture.
    const settled = await context.intents.findById(context.organizationId, intent.id);
    expect(settled.status).toBe(PaymentIntentStatus.SETTLED);

    const record = await context.records.findByIntentId(context.organizationId, intent.id);
    expect(record?.state).toBe('SETTLED');

    const pack = await packRow(record!.id);
    expect(pack).toBeDefined();
    expect(
      verifyPackIntegrity({
        core: pack.core,
        seq: pack.seq,
        prevHash: pack.prev_hash,
        contentHash: pack.content_hash.trim(),
      }),
    ).toBe(true);
    expect(reconstructVerdict(pack.core)).toMatchObject({
      status: VerdictStatus.PASS,
      settlementOutcome: VerdictOutcome.SETTLE,
    });
  });

  it('refunds a failing call and still seals — evidence is not conditional on the outcome', async () => {
    const intent = await context.callReadyToJudge();
    context.decide.mockResolvedValue(
      outcome(VerdictStatus.FAIL, VerdictOutcome.REFUND, intent.id, intent.toolId),
    );

    await context.settlement.judgeAndSettle(context.organizationId, intent.id);

    const refunded = await context.intents.findById(context.organizationId, intent.id);
    expect(refunded.status).toBe(PaymentIntentStatus.REFUNDED);

    const record = await context.records.findByIntentId(context.organizationId, intent.id);
    const pack = await packRow(record!.id);
    expect(reconstructVerdict(pack.core)).toMatchObject({
      status: VerdictStatus.FAIL,
      reasonCode: 'schema_mismatch',
      settlementOutcome: VerdictOutcome.REFUND,
    });
  });

  it('carries the bodies the call actually used into the pack', async () => {
    const intent = await context.callReadyToJudge();
    context.decide.mockResolvedValue(
      outcome(VerdictStatus.PASS, VerdictOutcome.SETTLE, intent.id, intent.toolId),
    );

    await context.settlement.judgeAndSettle(context.organizationId, intent.id);

    const record = await context.records.findByIntentId(context.organizationId, intent.id);
    const view = await context.evidence.forBuyer(context.organizationId, record!.id);

    expect(view?.integrity.sealed).toBe(true);
    expect(view?.request).toEqual({ city: 'Paris', days: 3 });
    expect(view?.response).toEqual({ tempC: 31, summary: 'clear' });
    expect(view?.bodyDigests.response).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('leaves the provider able to read its own pack', async () => {
    const providerId = '99999999-9999-4999-8999-999999999999';
    const intent = await context.callReadyToJudge({ providerId });
    context.decide.mockResolvedValue(
      outcome(VerdictStatus.FAIL, VerdictOutcome.REFUND, intent.id, intent.toolId),
    );

    await context.settlement.judgeAndSettle(context.organizationId, intent.id);
    const record = await context.records.findByIntentId(context.organizationId, intent.id);

    const view = await context.evidence.forProvider(providerId, record!.id);
    expect(view.id).toBe(record!.id);
    expect(view.integrity).not.toHaveProperty('seq');
  });

  it('holds the invariant across a batch: no judged record without a pack', async () => {
    const intents = await Promise.all([
      context.callReadyToJudge(),
      context.callReadyToJudge(),
      context.callReadyToJudge(),
      context.callReadyToJudge(),
      context.callReadyToJudge(),
    ]);
    context.decide.mockImplementation(({ intentId }: { intentId: string }) =>
      Promise.resolve(outcome(VerdictStatus.PASS, VerdictOutcome.SETTLE, intentId, 'tool')),
    );

    await Promise.all(
      intents.map((intent) => context.settlement.judgeAndSettle(context.organizationId, intent.id)),
    );

    const [{ orphans }] = (await context.dataSource.query(
      `SELECT count(*)::int AS orphans
         FROM "verification_records" r
        WHERE r."organization_id" = $1
          AND r."state" IN ('JUDGED', 'SETTLED')
          AND NOT EXISTS (SELECT 1 FROM "evidence_packs" p WHERE p."verdict_id" = r."id")`,
      [context.organizationId],
    )) as Array<{ orphans: number }>;
    expect(orphans).toBe(0);

    const seqs = (await context.dataSource.query(
      `SELECT "seq" FROM "evidence_packs" WHERE "organization_id" = $1 ORDER BY "seq"`,
      [context.organizationId],
    )) as Array<{ seq: string }>;
    expect(seqs.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4, 5]);
  });

  it('is re-entrant: a second delivery of the same wakeup does not seal twice', async () => {
    const intent = await context.callReadyToJudge();
    context.decide.mockResolvedValue(
      outcome(VerdictStatus.PASS, VerdictOutcome.SETTLE, intent.id, intent.toolId),
    );

    await context.settlement.judgeAndSettle(context.organizationId, intent.id);
    await context.settlement.judgeAndSettle(context.organizationId, intent.id);

    const [{ packs }] = (await context.dataSource.query(
      `SELECT count(*)::int AS packs FROM "evidence_packs" WHERE "organization_id" = $1`,
      [context.organizationId],
    )) as Array<{ packs: number }>;
    expect(packs).toBe(1);
    expect(context.decide).toHaveBeenCalledTimes(1);
  });
});
