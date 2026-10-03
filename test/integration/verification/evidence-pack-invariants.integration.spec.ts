import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { runInTransaction } from '@shared/database/transaction.util';
import { DEFAULT_EVIDENCE_RETENTION } from '@modules/verification/config/evidence-retention.config';
import type { EvidenceRecordSnapshot } from '@modules/verification/domain/evidence/pack.types';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';

import { EvidenceTestContext, createEvidenceTestContext } from '../helpers/evidence-test-context';

/**
 * The invariant the evidence pack is worth having for: **a judged verdict
 * always has evidence.**
 *
 * This drives the two statements `judge()` makes — the compare-and-swap that
 * marks the record `JUDGED`, and the seal — through the real
 * `runInTransaction`, against a real Postgres, concurrently. It is the narrow,
 * fast half of the proof; `judge-path-evidence.integration.spec.ts` drives the
 * whole worker path including the ledger and the intent transitions.
 *
 * Four places hold the invariant between them, and each says which part:
 *
 * - that `judge()` puts these two calls in one transaction — unit
 *   (`verification-settlement.service.spec.ts`, "evidence sealing");
 * - that the pair holds under concurrency and rolls back together — here;
 * - that the real worker path leaves a pack behind, with real money moving —
 *   `judge-path-evidence.integration.spec.ts`;
 * - that no second code path marks a record `JUDGED` without sealing —
 *   `test/unit/verification/evidence-write-path.spec.ts`.
 */
describe('a judged verdict always has evidence', () => {
  let context: EvidenceTestContext;
  let dataSource: DataSource;
  let sealer: EvidencePackSealerService;
  let records: VerificationRecordRepository;

  beforeAll(async () => {
    context = await createEvidenceTestContext();
    dataSource = context.dataSource;
    records = new VerificationRecordRepository(dataSource);
    sealer = new EvidencePackSealerService(
      new EvidencePackRepository(dataSource),
      new EvidenceBodyRepository(dataSource),
      new VerificationPolicyRepository(dataSource),
      DEFAULT_EVIDENCE_RETENTION,
    );
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  function snapshot(id: string): EvidenceRecordSnapshot {
    return {
      id,
      organizationId: context.organizationId,
      intentId: randomUUID(),
      toolId: randomUUID(),
      providerId: randomUUID(),
      verdictStatus: 'PASS',
      reasonCode: null,
      reason: null,
      score: 1,
      costUsd: 0,
      settlementOutcome: 'SETTLE',
      policyId: null,
      policyVersion: null,
      decisionPolicyId: null,
      decisionPolicyVersion: null,
      lifecycle: null,
      sampleRate: 0.05,
      sampled: false,
      sampleSelector: 0.9,
      sampleDisplay: '1 in 20 calls',
      stages: [],
      verifiers: null,
      tally: null,
      decidedBy: null,
      evaluatedAt: new Date(),
      createdAt: new Date(),
    };
  }

  /** Exactly the two statements `judge()` issues, in one transaction. */
  async function judgeOne(verdictId: string): Promise<boolean> {
    return runInTransaction(dataSource, async (queryRunner) => {
      const affected = await records.markJudgedIfPending(
        context.organizationId,
        verdictId,
        {
          verdictStatus: 'PASS',
          settlementOutcome: 'SETTLE',
          evaluatedAt: new Date(),
          // `chk_verification_records_judged_is_whole` refuses a half-judged
          // row: a verdict with no policy behind it, or no stages, is not a
          // judgement. The fixture has to be a real one.
          decisionPolicyId: 'decision.default',
          decisionPolicyVersion: 1,
          stages: [],
        },
        queryRunner,
      );
      if (affected === 0) return false;

      await sealer.seal(queryRunner, {
        record: snapshot(verdictId),
        request: { city: 'Paris' },
        response: { tempC: 31 },
        sealedAt: new Date(),
      });
      return true;
    });
  }

  async function orphanCount(): Promise<number> {
    const [row] = (await dataSource.query(`
      SELECT count(*)::int AS orphans
        FROM "verification_records" r
       WHERE r."state" IN ('JUDGED', 'SETTLED')
         AND NOT EXISTS (SELECT 1 FROM "evidence_packs" p WHERE p."verdict_id" = r."id")
    `)) as Array<{ orphans: number }>;
    return row.orphans;
  }

  it('leaves no judged record without a pack, over twenty-five judgements', async () => {
    const verdicts = await Promise.all(Array.from({ length: 25 }, () => context.insertVerdict()));

    await Promise.all(verdicts.map((id) => judgeOne(id)));

    expect(await orphanCount()).toBe(0);
    const [{ packs }] = (await dataSource.query(
      `SELECT count(*)::int AS packs FROM "evidence_packs"`,
    )) as Array<{ packs: number }>;
    expect(packs).toBe(25);
  });

  it('produces one pack, not two, when two workers judge the same record', async () => {
    const verdictId = await context.insertVerdict();

    const outcomes = await Promise.all([judgeOne(verdictId), judgeOne(verdictId)]);

    // Exactly one worker won the compare-and-swap; the other did no work and
    // did not fail. A second pack would have been refused by
    // uq_evidence_packs_verdict, but never attempting it is the behaviour.
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const [{ packs }] = (await dataSource.query(
      `SELECT count(*)::int AS packs FROM "evidence_packs" WHERE "verdict_id" = $1`,
      [verdictId],
    )) as Array<{ packs: number }>;
    expect(packs).toBe(1);
    expect(await orphanCount()).toBe(0);
  });

  it('holds the invariant when sealing fails: the record stays PENDING', async () => {
    // The rollback, end to end and against a real database. The record was
    // marked JUDGED inside the transaction and is PENDING again after it.
    const verdictId = await context.insertVerdict();

    await expect(
      runInTransaction(dataSource, async (queryRunner) => {
        await records.markJudgedIfPending(
          context.organizationId,
          verdictId,
          {
            verdictStatus: 'PASS',
            settlementOutcome: 'SETTLE',
            evaluatedAt: new Date(),
            // `chk_verification_records_judged_is_whole` refuses a half-judged
            // row: a verdict with no policy behind it, or no stages, is not a
            // judgement. The fixture has to be a real one.
            decisionPolicyId: 'decision.default',
            decisionPolicyVersion: 1,
            stages: [],
          },
          queryRunner,
        );
        // A pack whose content hash is not 64 hex — the CHECK refuses it, which
        // is a realistic way for sealing to fail: a bug in the hashing.
        await queryRunner.manager.query(
          `INSERT INTO "evidence_packs"
             ("organization_id", "verdict_id", "intent_id", "seq", "core",
              "content_hash", "prev_hash", "sealed_at", "body_expires_at")
           VALUES ($1, $2, $3, 1, '{}'::jsonb, $4, NULL, now(), now())`,
          [context.organizationId, verdictId, randomUUID(), 'not-a-hash'.padEnd(64, 'z')],
        );
      }),
    ).rejects.toThrow();

    const [row] = (await dataSource.query(
      `SELECT "state" FROM "verification_records" WHERE "id" = $1`,
      [verdictId],
    )) as Array<{ state: string }>;

    expect(row.state).toBe('PENDING');
    expect(await orphanCount()).toBe(0);
  });
});
