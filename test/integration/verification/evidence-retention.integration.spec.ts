import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { runInTransaction } from '@shared/database/transaction.util';
import { DEFAULT_EVIDENCE_RETENTION } from '@modules/verification/config/evidence-retention.config';
import {
  verifyPackIntegrity,
  reconstructVerdict,
} from '@modules/verification/domain/evidence/pack';
import type {
  EvidenceCore,
  EvidenceRecordSnapshot,
} from '@modules/verification/domain/evidence/pack.types';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';
import { EvidenceRetentionService } from '@modules/verification/services/evidence-retention.service';

import { EvidenceTestContext, createEvidenceTestContext } from '../helpers/evidence-test-context';

/**
 * Evidence retention: **after 72 hours the raw body is gone and the verdict
 * is still provable.**
 *
 * Both halves are asserted against real rows, because both are easy to get
 * wrong in a way that looks right. Deleting the body from `evidence_bodies`
 * while `verification_records` still holds the original is the vacuous version
 * of the first half; a pack that stops verifying once its body is gone is the
 * failure the two-table design exists to prevent, and it would only show up
 * three days after a deploy.
 */
describe('the body expires and the verdict survives', () => {
  let context: EvidenceTestContext;
  let dataSource: DataSource;
  let sealer: EvidencePackSealerService;
  let reader: EvidencePackService;
  let retention: EvidenceRetentionService;

  beforeAll(async () => {
    context = await createEvidenceTestContext();
    dataSource = context.dataSource;
    const packs = new EvidencePackRepository(dataSource);
    const bodies = new EvidenceBodyRepository(dataSource);
    const records = new VerificationRecordRepository(dataSource);
    sealer = new EvidencePackSealerService(
      packs,
      bodies,
      new VerificationPolicyRepository(dataSource),
      DEFAULT_EVIDENCE_RETENTION,
    );
    reader = new EvidencePackService(packs, bodies);
    retention = new EvidenceRetentionService(bodies, records, DEFAULT_EVIDENCE_RETENTION);
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
      verdictStatus: 'FAIL',
      reasonCode: 'SCHEMA_MISMATCH',
      reason: 'the response did not match the schema',
      score: 0.1,
      costUsd: 0.002,
      settlementOutcome: 'REFUND',
      policyId: null,
      policyVersion: null,
      decisionPolicyId: null,
      decisionPolicyVersion: null,
      lifecycle: null,
      sampleRate: 0.05,
      sampled: false,
      sampleSelector: 0.5,
      sampleDisplay: '1 in 20 calls',
      stages: [
        { stage: 'SCHEMA', status: 'FAILED', code: 'missing_field', detail: null, score: 0 },
      ],
      verifiers: null,
      tally: null,
      decidedBy: null,
      evaluatedAt: new Date(),
      createdAt: new Date(),
    };
  }

  /**
   * Seals a pack as though the call had happened `hoursAgo`.
   *
   * The age comes from `sealedAt`, not from an UPDATE afterwards: the sealer
   * stamps `expires_at = sealedAt + retention`, and `evidence_bodies` refuses
   * UPDATE by trigger — which this test tripped over on its first run, exactly
   * as a repair script would. Backdating the seal exercises the real write path
   * instead of working around it.
   *
   * `verification_records.created_at` still has to be moved by hand: it is set
   * by the database at enqueue and that table has no such trigger.
   */
  async function sealOne(hoursAgo = 0) {
    const verdictId = await context.insertVerdict();
    const sealedAt = new Date(Date.now() - hoursAgo * 3_600_000);

    const sealed = await runInTransaction(dataSource, (queryRunner) =>
      sealer.seal(queryRunner, {
        record: snapshot(verdictId),
        request: { city: 'Paris' },
        response: { tempC: 31 },
        sealedAt,
      }),
    );

    await dataSource.query(`UPDATE "verification_records" SET "created_at" = $1 WHERE "id" = $2`, [
      sealedAt,
      verdictId,
    ]);

    return { verdictId, sealed };
  }

  it('deletes the body from BOTH tables and keeps the verdict provable', async () => {
    const { verdictId, sealed } = await sealOne(73);

    const result = await retention.sweep();

    expect(result).toEqual({ bodiesDeleted: 1, recordsScrubbed: 1 });

    // 1. the sealed copy is gone
    const [{ bodies }] = (await dataSource.query(
      `SELECT count(*)::int AS bodies FROM "evidence_bodies" WHERE "pack_id" = $1`,
      [sealed.id],
    )) as Array<{ bodies: number }>;
    expect(bodies).toBe(0);

    // 2. the ORIGINAL is gone too — the half that makes this check non-vacuous
    const [record] = (await dataSource.query(
      `SELECT "request", "response" FROM "verification_records" WHERE "id" = $1`,
      [verdictId],
    )) as Array<{ request: unknown; response: unknown }>;
    expect(record.request).toBeNull();
    expect(record.response).toBeNull();

    // 3. the pack still hashes to what was stored, and still yields the verdict
    const [pack] = (await dataSource.query(
      `SELECT "core", "seq", "prev_hash", "content_hash" FROM "evidence_packs" WHERE "id" = $1`,
      [sealed.id],
    )) as Array<{
      core: EvidenceCore;
      seq: string;
      prev_hash: string | null;
      content_hash: string;
    }>;

    expect(
      verifyPackIntegrity({
        core: pack.core,
        seq: pack.seq,
        prevHash: pack.prev_hash,
        contentHash: pack.content_hash.trim(),
      }),
    ).toBe(true);
    expect(reconstructVerdict(pack.core)).toMatchObject({
      status: 'FAIL',
      reasonCode: 'SCHEMA_MISMATCH',
      settlementOutcome: 'REFUND',
    });

    // 4. and the endpoint says DIGESTED rather than 404 or an empty pack
    const view = await reader.forBuyer(context.organizationId, verdictId);
    expect(view?.integrity.bodyState).toBe('DIGESTED');
    expect(view?.bodyDigests.response).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('leaves a body inside the window completely alone', async () => {
    const { verdictId } = await sealOne(71);

    const result = await retention.sweep();

    expect(result).toEqual({ bodiesDeleted: 0, recordsScrubbed: 0 });
    const view = await reader.forBuyer(context.organizationId, verdictId);
    expect(view?.integrity.bodyState).toBe('RAW');
    expect(view?.response).toEqual({ tempC: 31 });
  });

  it('scrubs a record that was never judged, which has no pack at all', async () => {
    // The case that makes `created_at` the right key: a worker died, the record
    // is still PENDING with `evaluated_at` null, and it is holding a body.
    const orphan = await context.insertVerdict();
    await dataSource.query(`UPDATE "verification_records" SET "created_at" = $1 WHERE "id" = $2`, [
      new Date(Date.now() - 100 * 3_600_000),
      orphan,
    ]);

    const result = await retention.sweep();

    expect(result.recordsScrubbed).toBe(1);
    const [record] = (await dataSource.query(
      `SELECT "request", "response", "state", "evaluated_at" FROM "verification_records" WHERE "id" = $1`,
      [orphan],
    )) as Array<{ request: unknown; response: unknown; state: string; evaluated_at: Date | null }>;
    expect(record.state).toBe('PENDING');
    expect(record.evaluated_at).toBeNull();
    expect(record.request).toBeNull();
  });

  it('is idempotent — a second sweep finds nothing left to do', async () => {
    await sealOne(73);

    await retention.sweep();

    expect(await retention.sweep()).toEqual({ bodiesDeleted: 0, recordsScrubbed: 0 });
  });
});
