import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { runInTransaction } from '@shared/database/transaction.util';
import { DEFAULT_EVIDENCE_RETENTION } from '@modules/verification/config/evidence-retention.config';
import type { EvidenceRecordSnapshot } from '@modules/verification/domain/evidence/pack.types';
import { EvidencePackSealerService } from '@modules/verification/services/evidence-pack-sealer.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';

import { EvidenceTestContext, createEvidenceTestContext } from '../helpers/evidence-test-context';

/**
 * Tamper evidence, second half: **one mutated byte is detected.**
 *
 * The first half lives in `evidence-pack-constraints.integration.spec.ts` — the
 * trigger refuses `UPDATE` outright. This file answers the question that one
 * leaves open: *and if somebody gets past the trigger?* A restore from backup,
 * a superuser session, a migration that disables it — none of those are
 * hypothetical, and none of them are stopped by a trigger.
 *
 * So the tamper here is performed the way a real one would have to be: disable
 * the trigger, write, enable it again. `ALTER TABLE … DISABLE TRIGGER` needs
 * table ownership, which the test role has and a production application role
 * should not — that separation belongs to the deployment configuration and is
 * not asserted here.
 */
describe('a tampered evidence pack is refused on read', () => {
  let context: EvidenceTestContext;
  let dataSource: DataSource;
  let sealer: EvidencePackSealerService;
  let reader: EvidencePackService;

  beforeAll(async () => {
    context = await createEvidenceTestContext();
    dataSource = context.dataSource;
    const packs = new EvidencePackRepository(dataSource);
    const bodies = new EvidenceBodyRepository(dataSource);
    sealer = new EvidencePackSealerService(
      packs,
      bodies,
      new VerificationPolicyRepository(dataSource),
      DEFAULT_EVIDENCE_RETENTION,
    );
    reader = new EvidencePackService(packs, bodies);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  async function sealOne() {
    const verdictId = await context.insertVerdict();
    const snapshot: EvidenceRecordSnapshot = {
      id: verdictId,
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

    const sealed = await runInTransaction(dataSource, (queryRunner) =>
      sealer.seal(queryRunner, {
        record: snapshot,
        request: { city: 'Paris' },
        response: { tempC: 31 },
        sealedAt: new Date(),
      }),
    );

    return { verdictId, sealed };
  }

  /** What a DBA, a restore or a compromised migration can actually do. */
  async function tamper(packId: string, sql: string, params: unknown[]): Promise<void> {
    await dataSource.query(
      `ALTER TABLE "evidence_packs" DISABLE TRIGGER "trg_evidence_packs_append_only"`,
    );
    try {
      await dataSource.query(sql, [...params, packId]);
    } finally {
      await dataSource.query(
        `ALTER TABLE "evidence_packs" ENABLE TRIGGER "trg_evidence_packs_append_only"`,
      );
    }
  }

  it('reads back cleanly before anybody touches it', async () => {
    // The control. Without it, a test that always threw would look like success.
    const { verdictId } = await sealOne();

    const view = await reader.forBuyer(context.organizationId, verdictId);

    expect(view?.integrity.sealed).toBe(true);
  });

  it('detects a single mutated byte in the sealed core', async () => {
    const { verdictId, sealed } = await sealOne();

    // One character: FAIL becomes PASS. Nothing else about the row changes —
    // the hash column, the chain links and the digests are all untouched.
    await tamper(
      sealed.id,
      `UPDATE "evidence_packs"
          SET "core" = jsonb_set("core", '{verdict,status}', '"PASS"')
        WHERE "id" = $1`,
      [],
    );

    await expect(reader.forBuyer(context.organizationId, verdictId)).rejects.toMatchObject({
      errorCode: 'VERIFICATION_EVIDENCE_PACK_TAMPERED',
    });
  });

  it('detects a pack re-pointed at a different predecessor', async () => {
    // Rewriting history without touching a single verdict: keep every core,
    // relink the chain. The core hash alone would not catch this, which is why
    // seq and prevHash are inside the pre-image.
    const first = await sealOne();
    const second = await sealOne();

    await tamper(second.sealed.id, `UPDATE "evidence_packs" SET "prev_hash" = $1 WHERE "id" = $2`, [
      'f'.repeat(64),
    ]);
    void first;

    await expect(reader.forBuyer(context.organizationId, second.verdictId)).rejects.toMatchObject({
      errorCode: 'VERIFICATION_EVIDENCE_PACK_TAMPERED',
    });
  });

  it('cannot move the genesis pack at all: the CHECK outlives the disabled trigger', async () => {
    // `chk_evidence_packs_genesis` says seq = 1 exactly when prev_hash IS NULL.
    // A CHECK is not a trigger, so DISABLE TRIGGER does not switch it off —
    // renumbering the first pack of a chain is refused by the schema itself,
    // one layer below the read path.
    const { sealed } = await sealOne();

    await expect(
      tamper(sealed.id, `UPDATE "evidence_packs" SET "seq" = 99 WHERE "id" = $1`, []),
    ).rejects.toThrow(/chk_evidence_packs_genesis/);
  });

  it('detects a linked pack moved to a different position in the chain', async () => {
    // A pack with a predecessor CAN be renumbered without tripping a CHECK, so
    // this one has to be caught on read — which it is, because seq is inside
    // the hash pre-image rather than merely stored beside it.
    await sealOne();
    const second = await sealOne();

    await tamper(second.sealed.id, `UPDATE "evidence_packs" SET "seq" = 99 WHERE "id" = $1`, []);

    await expect(reader.forBuyer(context.organizationId, second.verdictId)).rejects.toMatchObject({
      errorCode: 'VERIFICATION_EVIDENCE_PACK_TAMPERED',
    });
  });
});
