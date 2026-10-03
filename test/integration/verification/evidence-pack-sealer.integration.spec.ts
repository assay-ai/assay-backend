import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { runInTransaction } from '@shared/database/transaction.util';
import { DEFAULT_EVIDENCE_RETENTION } from '@modules/verification/config/evidence-retention.config';
import { verifyPackIntegrity } from '@modules/verification/domain/evidence/pack';
import type { EvidenceRecordSnapshot } from '@modules/verification/domain/evidence/pack.types';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';

import { EvidenceTestContext, createEvidenceTestContext } from '../helpers/evidence-test-context';

/**
 * `EvidencePackSealerService` against a real Postgres.
 *
 * Integration rather than unit, because everything worth asserting here lives
 * in the database: the advisory lock, the tail read inside the transaction, and
 * whether a pack still verifies after a round trip through `jsonb` and a
 * `bigint` column. A mocked `QueryRunner` would assert that the service calls
 * the methods this test could read off the source anyway.
 */
describe('sealing an evidence pack', () => {
  let context: EvidenceTestContext;
  let dataSource: DataSource;
  let sealer: EvidencePackSealerService;
  let packs: EvidencePackRepository;

  beforeAll(async () => {
    context = await createEvidenceTestContext();
    dataSource = context.dataSource;
    packs = new EvidencePackRepository(dataSource);
    sealer = new EvidencePackSealerService(
      packs,
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

  const SEALED_AT = new Date('2026-08-21T09:00:00.000Z');

  function snapshot(overrides: Partial<EvidenceRecordSnapshot> = {}): EvidenceRecordSnapshot {
    return {
      id: randomUUID(),
      organizationId: context.organizationId,
      intentId: randomUUID(),
      toolId: randomUUID(),
      providerId: randomUUID(),
      verdictStatus: 'PASS',
      reasonCode: null,
      reason: null,
      score: 0.98,
      costUsd: 0.002,
      settlementOutcome: 'SETTLE',
      policyId: null,
      policyVersion: null,
      decisionPolicyId: null,
      decisionPolicyVersion: null,
      lifecycle: null,
      sampleRate: 0.05,
      sampled: false,
      sampleSelector: 0.6,
      sampleDisplay: '1 in 20 calls',
      stages: [{ stage: 'SCHEMA', status: 'PASSED', code: null, detail: null, score: 1 }],
      verifiers: null,
      tally: null,
      decidedBy: null,
      evaluatedAt: new Date('2026-08-21T08:59:59.000Z'),
      createdAt: new Date('2026-08-21T08:59:58.000Z'),
      ...overrides,
    };
  }

  /** Seals one pack against a real verification record, in its own transaction. */
  async function seal(organizationId = context.organizationId) {
    const verdictId = await context.insertVerdict(organizationId);
    return runInTransaction(dataSource, (queryRunner) =>
      sealer.seal(queryRunner, {
        record: snapshot({ id: verdictId, organizationId }),
        request: { city: 'Paris' },
        response: { tempC: 31 },
        sealedAt: SEALED_AT,
      }),
    );
  }

  it('seals the first pack of an organization as genesis', async () => {
    const sealed = await seal();

    expect(sealed.seq).toBe(1);
    expect(sealed.prevHash).toBeNull();
    expect(sealed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each pack to the tail of its own organization', async () => {
    const first = await seal();
    const otherTenant = await seal(context.otherOrganizationId);
    const second = await seal();

    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.contentHash);
    // The other tenant's chain is untouched by ours: its own genesis, not seq 2.
    expect(otherTenant.seq).toBe(1);
    expect(otherTenant.prevHash).toBeNull();
  });

  it('serialises concurrent seals in one organization, with no gap and no fork', async () => {
    // Four at once, in four transactions. Without the advisory lock these read
    // the same tail and the second insert dies on uq_evidence_packs_prev.
    const sealed = await Promise.all([seal(), seal(), seal(), seal()]);

    expect(sealed.map((pack) => pack.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(sealed.map((pack) => pack.contentHash)).size).toBe(4);

    const rows = (await dataSource.query(
      `SELECT "seq", "content_hash", "prev_hash" FROM "evidence_packs"
        WHERE "organization_id" = $1 ORDER BY "seq"`,
      [context.organizationId],
    )) as Array<{ seq: string; content_hash: string; prev_hash: string | null }>;

    expect(rows[0].prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].content_hash);
    }
  });

  it('still verifies after a round trip through jsonb and bigint', async () => {
    // The reason this is here and not in the unit suite: `seq` comes back from
    // the driver as a string and `core` comes back with its keys in whatever
    // order Postgres stored them. A hash that did not survive both would verify
    // in memory and fail on every read.
    const sealed = await seal();

    const [row] = (await dataSource.query(
      `SELECT "core", "seq", "prev_hash", "content_hash" FROM "evidence_packs" WHERE "id" = $1`,
      [sealed.id],
    )) as Array<{ core: never; seq: string; prev_hash: string | null; content_hash: string }>;

    expect(typeof row.seq).toBe('string');
    expect(
      verifyPackIntegrity({
        core: row.core,
        seq: row.seq,
        prevHash: row.prev_hash,
        contentHash: row.content_hash.trim(),
      }),
    ).toBe(true);
  });

  it('writes the bodies with a deadline of sealed_at plus the retention window', async () => {
    const sealed = await seal();

    const [body] = (await dataSource.query(
      `SELECT "request", "response", "expires_at" FROM "evidence_bodies" WHERE "pack_id" = $1`,
      [sealed.id],
    )) as Array<{ request: unknown; response: unknown; expires_at: Date }>;

    expect(body.request).toEqual({ city: 'Paris' });
    expect(body.response).toEqual({ tempC: 31 });
    expect(body.expires_at.toISOString()).toBe(
      new Date(
        SEALED_AT.getTime() + DEFAULT_EVIDENCE_RETENTION.bodyRetentionHours * 3_600_000,
      ).toISOString(),
    );
  });

  it('keeps the body out of the pack itself', async () => {
    const sealed = await seal();

    const [row] = (await dataSource.query(
      `SELECT "core"::text AS core, "response_sha256" FROM "evidence_packs" WHERE "id" = $1`,
      [sealed.id],
    )) as Array<{ core: string; response_sha256: string }>;

    expect(row.core).not.toContain('tempC');
    expect(row.response_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rolls the pack back with the transaction that fails after it', async () => {
    const verdictId = await context.insertVerdict();

    await expect(
      runInTransaction(dataSource, async (queryRunner) => {
        await sealer.seal(queryRunner, {
          record: snapshot({ id: verdictId }),
          request: null,
          response: { tempC: 31 },
          sealedAt: SEALED_AT,
        });
        throw new Error('the judgement failed after sealing');
      }),
    ).rejects.toThrow('the judgement failed after sealing');

    const rows = (await dataSource.query(
      `SELECT count(*)::int AS packs FROM "evidence_packs"`,
    )) as Array<{
      packs: number;
    }>;
    expect(rows[0].packs).toBe(0);
  });
});
