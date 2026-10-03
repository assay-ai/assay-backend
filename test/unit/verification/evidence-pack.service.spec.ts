import { EvidenceBodyEntity } from '@database/postgres/entities/evidence-body.entity';
import { EvidencePackEntity } from '@database/postgres/entities/evidence-pack.entity';
import { EvidenceBodyRepository } from '@database/postgres/repositories/evidence-body.repository';
import { EvidencePackRepository } from '@database/postgres/repositories/evidence-pack.repository';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { buildEvidenceCore, computeContentHash } from '@modules/verification/domain/evidence/pack';
import type { EvidenceCore } from '@modules/verification/domain/evidence/pack.types';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = '22222222-2222-4222-8222-222222222222';
const PROVIDER = '55555555-5555-4555-8555-555555555555';
const VERDICT = '11111111-1111-4111-8111-111111111111';
const SEALED_AT = new Date('2026-08-21T09:00:00.000Z');

function core(): EvidenceCore {
  return buildEvidenceCore({
    record: {
      id: VERDICT,
      organizationId: ORG,
      intentId: '33333333-3333-4333-8333-333333333333',
      toolId: '44444444-4444-4444-8444-444444444444',
      providerId: PROVIDER,
      verdictStatus: 'FAIL',
      reasonCode: 'SCHEMA_MISMATCH',
      reason: 'the response did not match the schema',
      score: 0.2,
      costUsd: 0.003,
      settlementOutcome: 'REFUND',
      policyId: 'policy.weather',
      policyVersion: 2,
      decisionPolicyId: 'decision.default',
      decisionPolicyVersion: 7,
      lifecycle: 'ACTIVE',
      sampleRate: 0.077,
      sampled: true,
      sampleSelector: 0.04,
      sampleDisplay: '1 in 13 calls',
      stages: [
        { stage: 'SCHEMA', status: 'FAILED', code: 'missing_field', detail: null, score: 0 },
      ],
      verifiers: null,
      tally: null,
      decidedBy: null,
      evaluatedAt: new Date('2026-08-21T08:59:59.000Z'),
      createdAt: new Date('2026-08-21T08:59:58.000Z'),
    },
    decisionDocument: { verifiers: ['schema'] },
    verificationDocument: { schema: { required: ['tempC'] } },
    request: { city: 'Paris' },
    response: { tempF: 88 },
    sealedAt: SEALED_AT,
  });
}

function pack(overrides: Partial<EvidencePackEntity> = {}): EvidencePackEntity {
  const document = core();
  const seq = '4';
  const prevHash = 'a'.repeat(64);

  return {
    id: 'pack-1',
    organizationId: ORG,
    providerId: PROVIDER,
    verdictId: VERDICT,
    intentId: document.intentId,
    seq,
    core: document as unknown as Record<string, unknown>,
    requestSha256: document.bodyDigests.request,
    responseSha256: document.bodyDigests.response,
    contentHash: computeContentHash({ core: document, seq, prevHash }),
    prevHash,
    sealedAt: SEALED_AT,
    bodyExpiresAt: new Date('2026-08-24T09:00:00.000Z'),
    ...overrides,
  } as EvidencePackEntity;
}

function build(row: EvidencePackEntity | null, body: EvidenceBodyEntity | null) {
  const packs = {
    findByVerdictId: jest.fn().mockResolvedValue(row),
    findByVerdictIdForProvider: jest.fn().mockResolvedValue(row),
  } as unknown as EvidencePackRepository;
  const bodies = {
    findByPackId: jest.fn().mockResolvedValue(body),
  } as unknown as EvidenceBodyRepository;

  return { service: new EvidencePackService(packs, bodies), packs, bodies };
}

const storedBody = {
  request: { city: 'Paris' },
  response: { tempF: 88 },
} as unknown as EvidenceBodyEntity;

describe('reading a sealed evidence pack', () => {
  it('returns the pack with its chain position and the bodies as sealed', async () => {
    const { service } = build(pack(), storedBody);

    const view = await service.forBuyer(ORG, VERDICT);

    expect(view?.integrity).toEqual({
      sealed: true,
      seq: 4,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prevHash: 'a'.repeat(64),
      sealedAt: SEALED_AT,
      bodyState: 'RAW',
    });
    expect(view?.request).toEqual({ city: 'Paris' });
    expect(view?.pinnedPolicy).toMatchObject({ policyId: 'decision.default', policyVersion: 7 });
  });

  it('reports DIGESTED and no bodies once the body row is gone, and still verifies', async () => {
    const { service } = build(pack(), null);

    const view = await service.forBuyer(ORG, VERDICT);

    expect(view?.integrity.bodyState).toBe('DIGESTED');
    expect(view?.request).toBeNull();
    expect(view?.response).toBeNull();
    // The digests outlive the bodies — this is what a provider checks their own
    // copy against after the window closes.
    expect(view?.bodyDigests.response).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns null when no pack exists, leaving the fallback to the caller', async () => {
    const { service } = build(null, null);

    expect(await service.forBuyer(ORG, VERDICT)).toBeNull();
  });

  it('refuses to serve a pack whose core no longer matches its hash', async () => {
    // The core is readonly by type — which is the point of the type — so the
    // tamper is done the way a real one would be: by writing over the stored
    // JSON, not through the domain's own interface.
    const tampered = pack();
    const rewritten = JSON.parse(JSON.stringify(tampered.core)) as { verdict: { status: string } };
    rewritten.verdict.status = 'PASS';
    (tampered as { core: unknown }).core = rewritten;

    const { service } = build(tampered, storedBody);

    await expectErrorCodeAsync(
      () => service.forBuyer(ORG, VERDICT),
      VerificationErrorCode.VERIFICATION_EVIDENCE_PACK_TAMPERED,
    );
  });

  it('tolerates the char(64) padding Postgres returns', async () => {
    // `content_hash` is `char(64)`, and a driver that hands back a padded value
    // would fail every verification for a reason invisible in any log line.
    const padded = pack();
    (padded as { contentHash: string }).contentHash = `${padded.contentHash}   `;

    const { service } = build(padded, storedBody);

    expect((await service.forBuyer(ORG, VERDICT))?.integrity.sealed).toBe(true);
  });
});

describe('the provider view of a pack', () => {
  it('omits the buyer chain position entirely', async () => {
    const { service } = build(pack(), storedBody);

    const view = await service.forProvider(PROVIDER, VERDICT);

    expect(view.integrity).toEqual({
      sealed: true,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sealedAt: SEALED_AT,
      bodyState: 'RAW',
    });
    expect(view.integrity).not.toHaveProperty('seq');
    expect(view.integrity).not.toHaveProperty('prevHash');
    expect(JSON.stringify(view)).not.toContain('"seq"');
  });

  it('gives the provider the same bodies and the same stage results', async () => {
    const { service } = build(pack(), storedBody);

    const view = await service.forProvider(PROVIDER, VERDICT);

    expect(view.request).toEqual({ city: 'Paris' });
    expect(view.stageResults).toHaveLength(1);
    expect(view.pinnedPolicy).toMatchObject({ policyVersion: 7 });
  });

  it('404s rather than serving a pack that is not this provider’s', async () => {
    const { service } = build(null, null);

    await expectErrorCodeAsync(
      () => service.forProvider(PROVIDER, VERDICT),
      VerificationErrorCode.VERIFICATION_EVIDENCE_PACK_NOT_FOUND,
    );
  });
});
