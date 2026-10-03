import {
  buildEvidenceCore,
  computeContentHash,
  digestBody,
  reconstructVerdict,
  verifyPackIntegrity,
} from '@modules/verification/domain/evidence/pack';
import type { BuildEvidenceCoreInput } from '@modules/verification/domain/evidence/pack.types';

/**
 * The pure half of the evidence pack: what goes in the sealed document, and the hash that
 * makes it checkable. No clock, no repository, no I/O — the sealer supplies
 * every value, including `sealedAt`, for the same reason the verdict engine
 * takes an injected `evaluatedAt`.
 */
const SEALED_AT = new Date('2026-08-21T09:00:00.000Z');
const EVALUATED_AT = new Date('2026-08-21T08:59:58.500Z');
const CREATED_AT = new Date('2026-08-21T08:59:57.000Z');

const judged: BuildEvidenceCoreInput = {
  record: {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    intentId: '33333333-3333-4333-8333-333333333333',
    toolId: '44444444-4444-4444-8444-444444444444',
    providerId: '55555555-5555-4555-8555-555555555555',
    verdictStatus: 'FAIL',
    reasonCode: 'SCHEMA_MISMATCH',
    reason: 'response did not match the tool output schema',
    score: 0.25,
    costUsd: 0.004,
    settlementOutcome: 'REFUND',
    policyId: 'policy.weather',
    policyVersion: 2,
    decisionPolicyId: 'decision.default',
    decisionPolicyVersion: 7,
    lifecycle: 'ACTIVE',
    sampleRate: 0.077,
    sampled: true,
    sampleSelector: 0.0412,
    sampleDisplay: '1 in 13 calls',
    stages: [{ stage: 'SCHEMA', status: 'FAILED', code: 'missing_field', detail: null, score: 0 }],
    verifiers: [{ id: 'schema', vote: 'FAIL' }],
    tally: { fail: 1, pass: 0 },
    decidedBy: { clause: 'any_fail' },
    evaluatedAt: EVALUATED_AT,
    createdAt: CREATED_AT,
  },
  decisionDocument: { verifiers: ['schema'], otherwise: 'PASS' },
  verificationDocument: { schema: { required: ['tempC'] } },
  request: { city: 'Paris' },
  response: { tempF: 88 },
  sealedAt: SEALED_AT,
};

describe('the evidence core', () => {
  it('carries every field the evidence pack names, as pure JSON', () => {
    const core = buildEvidenceCore(judged);

    expect(core.schema).toBe('x402/evidence-pack/v1');
    expect(core.verdict).toEqual({
      status: 'FAIL',
      reasonCode: 'SCHEMA_MISMATCH',
      reason: 'response did not match the tool output schema',
      score: 0.25,
      costUsd: 0.004,
    });
    expect(core.stages).toEqual(judged.record.stages);
    expect(core.policy).toEqual({
      decisionPolicyId: 'decision.default',
      decisionPolicyVersion: 7,
      decisionDocument: { verifiers: ['schema'], otherwise: 'PASS' },
      verificationPolicyId: 'policy.weather',
      verificationPolicyVersion: 2,
      verificationDocument: { schema: { required: ['tempC'] } },
      lifecycle: 'ACTIVE',
    });
    expect(core.sampling).toEqual({
      sampleRate: 0.077,
      sampled: true,
      sampleSelector: 0.0412,
      sampleDisplay: '1 in 13 calls',
    });
  });

  it('renders timestamps as ISO strings, never as Date objects', () => {
    // Not a style choice: `canonicalJson` refuses a Date rather than coercing
    // it, so a core holding one cannot be hashed at all.
    const core = buildEvidenceCore(judged);

    expect(core.timestamps).toEqual({
      requestedAt: '2026-08-21T08:59:57.000Z',
      evaluatedAt: '2026-08-21T08:59:58.500Z',
      sealedAt: '2026-08-21T09:00:00.000Z',
    });
    expect(() => computeContentHash({ core, seq: 1, prevHash: null })).not.toThrow();
  });

  it('digests the bodies rather than embedding them', () => {
    const core = buildEvidenceCore(judged);

    expect(core.bodyDigests.request).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(core.bodyDigests.response).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(core)).not.toContain('Paris');
    // Not the digits `88`: a 64-character hex digest contains any given pair
    // about a fifth of the time, so that assertion would fail at random. The
    // body's KEYS cannot appear in a digest.
    expect(JSON.stringify(core)).not.toContain('tempF');
    expect(JSON.stringify(core)).not.toContain('city');
  });

  it('digests a body-less call as null, not as the digest of an empty object', () => {
    // `null` and `{}` are different calls, and hashing the second for the first
    // would make an absent body indistinguishable from an empty one.
    expect(digestBody(null)).toBeNull();
    expect(digestBody({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('builds a whole core for an UNVERIFIED record, with policy null', () => {
    const core = buildEvidenceCore({
      ...judged,
      record: {
        ...judged.record,
        verdictStatus: 'UNVERIFIED',
        reasonCode: 'NO_DECISION_POLICY',
        score: null,
        policyId: null,
        policyVersion: null,
        decisionPolicyId: null,
        decisionPolicyVersion: null,
        lifecycle: null,
      },
      decisionDocument: null,
      verificationDocument: null,
    });

    expect(core.policy).toBeNull();
    expect(core.verdict.status).toBe('UNVERIFIED');
    expect(core.timestamps.sealedAt).toBe('2026-08-21T09:00:00.000Z');
    expect(core.bodyDigests.response).toMatch(/^sha256:/);
  });

  it('records that no model judged this call, rather than omitting the question', () => {
    // Nothing implements SEMANTIC_JUDGE yet, so no record carries a modelId.
    // `null` says "no model" — an absent key would read as "we did not look".
    expect(buildEvidenceCore(judged).semantic).toBeNull();
  });
});

describe('the content hash', () => {
  it('is the same whatever order the core was assembled in', () => {
    const core = buildEvidenceCore(judged);
    // Rebuilt with the keys in the opposite insertion order, values untouched.
    // NOT `JSON.stringify(core, keys)` — the second argument is a replacer
    // allowlist applied at every level, so it strips nested keys and produces a
    // genuinely different document, which then hashes differently and looks
    // like a bug in the hash.
    const reordered = Object.fromEntries(Object.entries(core).reverse()) as typeof core;

    expect(computeContentHash({ core: reordered, seq: 1, prevHash: null })).toBe(
      computeContentHash({ core, seq: 1, prevHash: null }),
    );
  });

  it('changes when one byte of the core changes', () => {
    const core = buildEvidenceCore(judged);
    const tampered = { ...core, verdict: { ...core.verdict, reasonCode: 'SCHEMA_MISMATCh' } };

    expect(computeContentHash({ core: tampered, seq: 1, prevHash: null })).not.toBe(
      computeContentHash({ core, seq: 1, prevHash: null }),
    );
  });

  it('changes when the chain position or the predecessor changes', () => {
    const core = buildEvidenceCore(judged);
    const at1 = computeContentHash({ core, seq: 1, prevHash: null });
    const at2 = computeContentHash({ core, seq: 2, prevHash: at1 });
    const at2Elsewhere = computeContentHash({ core, seq: 2, prevHash: 'f'.repeat(64) });

    expect(new Set([at1, at2, at2Elsewhere]).size).toBe(3);
  });

  it('does not care whether seq arrived as a number or as a bigint string', () => {
    // Postgres returns bigint as a string. A hash that disagreed with itself
    // across that boundary would fail to verify on every read.
    const core = buildEvidenceCore(judged);

    expect(computeContentHash({ core, seq: '2', prevHash: 'a'.repeat(64) })).toBe(
      computeContentHash({ core, seq: 2, prevHash: 'a'.repeat(64) }),
    );
  });

  it('is 64 lower-case hex with no prefix, which is what the column accepts', () => {
    expect(computeContentHash({ core: buildEvidenceCore(judged), seq: 1, prevHash: null })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe('verifying a pack', () => {
  const sealed = (() => {
    const core = buildEvidenceCore(judged);
    return {
      core,
      seq: '1',
      prevHash: null,
      contentHash: computeContentHash({ core, seq: 1, prevHash: null }),
    };
  })();

  it('accepts a pack that still hashes to its stored digest', () => {
    expect(verifyPackIntegrity(sealed)).toBe(true);
  });

  it('rejects a pack whose core was edited', () => {
    const tampered = {
      ...sealed,
      core: { ...sealed.core, verdict: { ...sealed.core.verdict, status: 'PASS' } },
    };

    expect(verifyPackIntegrity(tampered)).toBe(false);
  });

  it('accepts a pack whose bodies are gone', () => {
    // The whole reason bodies are digested rather than embedded: 72 hours from
    // now the body row is deleted and this must still verify.
    expect(verifyPackIntegrity({ ...sealed })).toBe(true);
  });

  it('rejects a pack re-pointed at a different predecessor', () => {
    expect(verifyPackIntegrity({ ...sealed, seq: '2', prevHash: 'b'.repeat(64) })).toBe(false);
  });
});

describe('reconstructing the verdict', () => {
  it('produces the same verdict the record carries', () => {
    const core = buildEvidenceCore(judged);

    expect(reconstructVerdict(core)).toEqual({
      status: judged.record.verdictStatus,
      reasonCode: judged.record.reasonCode,
      reason: judged.record.reason,
      score: judged.record.score,
      settlementOutcome: judged.record.settlementOutcome,
      decisionPolicyId: judged.record.decisionPolicyId,
      decisionPolicyVersion: judged.record.decisionPolicyVersion,
      evaluatedAt: '2026-08-21T08:59:58.500Z',
    });
  });

  it('reconstructs from the core alone, after a round trip through JSON', () => {
    const { core } = JSON.parse(JSON.stringify({ core: buildEvidenceCore(judged) })) as {
      core: ReturnType<typeof buildEvidenceCore>;
    };

    expect(reconstructVerdict(core).status).toBe('FAIL');
  });
});
