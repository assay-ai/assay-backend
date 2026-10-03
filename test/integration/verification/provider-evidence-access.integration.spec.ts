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
 * Who can read a pack, against real rows.
 *
 * The scoping here is the unusual one on this platform and the reason it needs
 * a database rather than a mock: the pack's `organization_id` is the **buyer**,
 * so the provider's read is a deliberate cross-tenant query keyed on
 * `provider_id`. Faking the repository would assert that the service calls a
 * method; only a real query proves the predicate selects the right row and
 * excludes the wrong one.
 */
describe('who can read an evidence pack', () => {
  let context: EvidenceTestContext;
  let dataSource: DataSource;
  let sealer: EvidencePackSealerService;
  let reader: EvidencePackService;

  const PROVIDER = randomUUID();
  const OTHER_PROVIDER = randomUUID();

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

  async function sealFor(providerId: string, organizationId = context.organizationId) {
    const verdictId = await context.insertVerdict(organizationId);
    const record: EvidenceRecordSnapshot = {
      id: verdictId,
      organizationId,
      intentId: randomUUID(),
      toolId: randomUUID(),
      providerId,
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

    await runInTransaction(dataSource, (queryRunner) =>
      sealer.seal(queryRunner, {
        record,
        request: { city: 'Paris' },
        response: { tempF: 88 },
        sealedAt: new Date(),
      }),
    );

    return verdictId;
  }

  it('lets the provider who served the call read its pack', async () => {
    const verdictId = await sealFor(PROVIDER);

    const view = await reader.forProvider(PROVIDER, verdictId);

    expect(view.id).toBe(verdictId);
    expect(view.request).toEqual({ city: 'Paris' });
    expect(view.response).toEqual({ tempF: 88 });
    expect(view.integrity.sealed).toBe(true);
  });

  it('reads across the tenant boundary on purpose: the pack belongs to the buyer', async () => {
    // The provider's own organization is not the pack's organization, and that
    // is exactly why the buyer-scoped route could never answer this question.
    const verdictId = await sealFor(PROVIDER);

    const [row] = (await dataSource.query(
      `SELECT "organization_id", "provider_id" FROM "evidence_packs" WHERE "verdict_id" = $1`,
      [verdictId],
    )) as Array<{ organization_id: string; provider_id: string }>;

    expect(row.organization_id).toBe(context.organizationId);
    expect(row.provider_id).toBe(PROVIDER);
    expect(row.organization_id).not.toBe(PROVIDER);
    await expect(reader.forProvider(PROVIDER, verdictId)).resolves.toBeDefined();
  });

  it('404s a provider asking about a call they did not serve', async () => {
    const verdictId = await sealFor(PROVIDER);

    await expect(reader.forProvider(OTHER_PROVIDER, verdictId)).rejects.toMatchObject({
      errorCode: 'VERIFICATION_EVIDENCE_PACK_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('never leaks the buyer chain position, even when the chain is long', async () => {
    // Four packs for one buyer: the fourth sits at seq 4, which is the number
    // that must not reach a provider.
    await sealFor(OTHER_PROVIDER);
    await sealFor(OTHER_PROVIDER);
    await sealFor(OTHER_PROVIDER);
    const verdictId = await sealFor(PROVIDER);

    const view = await reader.forProvider(PROVIDER, verdictId);

    expect(JSON.stringify(view)).not.toContain('"seq"');
    expect(JSON.stringify(view)).not.toContain('prevHash');
    // …while the buyer's own view does carry it.
    const buyer = await reader.forBuyer(context.organizationId, verdictId);
    expect(buyer?.integrity.seq).toBe(4);
  });

  it('still answers after the bodies expire, with digests instead', async () => {
    const verdictId = await sealFor(PROVIDER);
    await dataSource.query(`DELETE FROM "evidence_bodies"`);

    const view = await reader.forProvider(PROVIDER, verdictId);

    expect(view.integrity.bodyState).toBe('DIGESTED');
    expect(view.request).toBeNull();
    expect(view.bodyDigests.response).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
