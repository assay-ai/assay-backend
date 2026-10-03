import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import {
  StageResult,
  StageStatus,
  VERIFICATION_PIPELINE,
  VerificationStage,
} from '@modules/verification/domain/stage';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { DecisionTrigger, VerifierOutcome } from '@modules/verification/domain/aggregation';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import {
  EvidencePackService,
  SealedEvidenceView,
} from '@modules/verification/services/evidence-pack.service';
import { VerdictService } from '@modules/verification/services/verdict.service';
import { SortDirection } from '@shared/api';
import { ListVerdictsQueryDto } from '@modules/verification/dto/list-verdicts.dto';

import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORG = 'org-11111111-1111-4111-8111-111111111111';

function buildRecord(overrides: Partial<VerificationRecordEntity> = {}): VerificationRecordEntity {
  return {
    id: 'record-1',
    organizationId: ORG,
    intentId: 'intent-1',
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

function buildPolicy(overrides: Partial<VerificationPolicyEntity> = {}): VerificationPolicyEntity {
  return {
    id: 'policy-row-1',
    policyId: 'search_web.default',
    policyVersion: 1,
    toolId: 'tool-1',
    lifecycle: 'ACTIVE',
    decisionDocument: {
      id: 'search_web.default',
      version: 1,
      verifiers: [],
      clauses: [],
      otherwise: 'PASS',
    },
    verificationDocument: null,
    createdBy: 'operator',
    promotedAt: new Date('2026-08-01T00:00:00.000Z'),
    promotedBy: 'operator',
    promotionEvidence: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    version: 1,
    ...overrides,
  } as unknown as VerificationPolicyEntity;
}

function stageResult(
  stage: VerificationStage,
  status: StageStatus,
  patch: Partial<StageResult> = {},
): StageResult {
  return { stage, status, code: null, detail: null, score: null, ...patch };
}

function listQuery(overrides: Partial<ListVerdictsQueryDto> = {}): ListVerdictsQueryDto {
  return Object.assign(
    new ListVerdictsQueryDto(),
    { limit: 10, order: SortDirection.DESC },
    overrides,
  );
}

function build(
  rows: VerificationRecordEntity[] = [],
  policy: VerificationPolicyEntity | null = null,
  /**
   * `null` means "no sealed pack for this verdict", which is the pre-evidence-pack
   * fallback these cases exercise. A test that wants the sealed path passes a
   * view; the sealed path's own behaviour is covered in
   * `evidence-pack.service.spec.ts`.
   */
  sealed: SealedEvidenceView | null = null,
) {
  const fake = fakeQueryBuilder(rows);
  const findVersion = jest.fn().mockResolvedValue(policy);
  const records = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    findOneBy: jest.fn(),
  } as unknown as VerificationRecordRepository;
  const policies = {
    findVersion,
  } as unknown as VerificationPolicyRepository;

  const forBuyer = jest.fn().mockResolvedValue(sealed);
  const packs = { forBuyer } as unknown as EvidencePackService;

  return {
    service: new VerdictService(records, policies, packs),
    records,
    policies,
    packs,
    forBuyer,
    fake,
    findVersion,
  };
}

describe('VerdictService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = build([buildRecord()]);

    await service.list(ORG, listQuery());

    const orgWhere = fake.wheres.find((w) => w.sql.includes('record.organizationId'));
    expect(orgWhere?.params).toEqual({ organizationId: ORG });
  });

  it('AND-s every filter and OR-s repeated values within verdictStatus', async () => {
    const { service, fake } = build([buildRecord()]);

    await service.list(
      ORG,
      listQuery({
        verdictStatus: [VerdictStatus.FAIL, VerdictStatus.MISAPPLIED],
        toolId: 'tool-1',
        providerId: 'provider-1',
        sampled: true,
        policyId: 'search_web.decision',
      }),
    );

    expect(fake.wheres.find((w) => w.sql.includes('record.verdictStatus'))?.params).toEqual({
      verdictStatus: [VerdictStatus.FAIL, VerdictStatus.MISAPPLIED],
    });
    expect(fake.wheres.find((w) => w.sql.includes('record.toolId'))?.params).toEqual({
      toolId: 'tool-1',
    });
    expect(fake.wheres.find((w) => w.sql.includes('record.providerId'))?.params).toEqual({
      providerId: 'provider-1',
    });
    expect(fake.wheres.find((w) => w.sql.includes('record.sampled'))?.params).toEqual({
      sampled: true,
    });
    // `policyId` filters on `decisionPolicyId` — see `ListVerdictsQueryDto`.
    expect(fake.wheres.find((w) => w.sql.includes('record.decisionPolicyId'))?.params).toEqual({
      policyId: 'search_web.decision',
    });
  });

  it('does not filter on sampled when the query omits it — false is a real filter value, not "unset"', async () => {
    const { service, fake } = build([buildRecord()]);

    await service.list(ORG, listQuery({ sampled: false }));

    expect(fake.wheres.find((w) => w.sql.includes('record.sampled'))?.params).toEqual({
      sampled: false,
    });
  });

  it('maps each row to the slim list shape', async () => {
    const { service } = build([
      buildRecord({
        verdictStatus: 'FAIL',
        reasonCode: 'schema_invalid',
        score: 0.2,
        sampled: true,
        decisionPolicyId: 'search_web.decision',
        decisionPolicyVersion: 2,
      }),
    ]);

    const page = await service.list(ORG, listQuery());

    expect(page.items[0]).toMatchObject({
      id: 'record-1',
      intentId: 'intent-1',
      toolId: 'tool-1',
      providerId: 'provider-1',
      verdictStatus: 'FAIL',
      reasonCode: 'schema_invalid',
      score: 0.2,
      sampled: true,
      decisionPolicyId: 'search_web.decision',
      decisionPolicyVersion: 2,
      state: 'JUDGED',
    });
  });

  it('signals hasMore via pageInfo when more than `limit` rows come back', async () => {
    const rows = [
      buildRecord({ id: 'a', createdAt: new Date('2026-08-10T10:00:02.000Z') }),
      buildRecord({ id: 'b', createdAt: new Date('2026-08-10T10:00:01.000Z') }),
    ];
    const { service } = build(rows);

    const page = await service.list(ORG, listQuery({ limit: 1 }));

    expect(page.items).toHaveLength(1);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextCursor).not.toBeNull();
  });
});

describe('VerdictService.getById', () => {
  it('404s when the record does not belong to this organization', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(service.getById(ORG, { id: 'nope' })).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_VERDICT_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('fills in NOT_REACHED for every stage the pipeline never reached — never omitted, never a pass', async () => {
    const stored: StageResult[] = [
      stageResult(VerificationStage.SCHEMA, StageStatus.PASSED, { score: 1 }),
      stageResult(VerificationStage.DETERMINISTIC_RULES, StageStatus.FAILED, {
        code: 'insufficient_results',
        score: 0.31,
      }),
    ];
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(
      buildRecord({ stages: stored, verdictStatus: 'FAIL' }),
    );

    const verdict = await service.getById(ORG, { id: 'record-1' });

    expect(verdict.stageResults).toHaveLength(4);
    expect(verdict.stageResults.map((row) => row.stage)).toEqual(VERIFICATION_PIPELINE);
    const byStage = new Map(verdict.stageResults.map((row) => [row.stage, row]));
    expect(byStage.get(VerificationStage.SCHEMA)).toMatchObject({
      status: StageStatus.PASSED,
      passed: true,
    });
    expect(byStage.get(VerificationStage.CROSS_CHECK)).toMatchObject({
      status: StageStatus.NOT_REACHED,
      passed: false,
    });
    expect(byStage.get(VerificationStage.SEMANTIC)).toMatchObject({
      status: StageStatus.NOT_REACHED,
      passed: false,
    });
  });

  it('parses verifiers, tally and decidedBy off the stored JSON columns', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(
      buildRecord({
        verifiers: [
          {
            verifierId: 'schema',
            outcome: VerifierOutcome.PASS,
            code: null,
            detail: null,
            score: 1,
            costUsd: 0,
            stage: VerificationStage.SCHEMA,
          },
        ],
        tally: {
          declared: 4,
          votes: 2,
          passed: 1,
          failed: 1,
          misapplied: 0,
          unavailable: 2,
          abstained: 0,
          failedFraction: 0.5,
          unregistered: 0,
        },
        decidedBy: {
          clauseIndex: 2,
          trigger: DecisionTrigger.FAILURES_AT_LEAST,
          label: '2 of 4 checks did not pass',
        },
      }),
    );

    const verdict = await service.getById(ORG, { id: 'record-1' });

    expect(verdict.verifiers).toEqual([
      {
        verifierId: 'schema',
        outcome: VerifierOutcome.PASS,
        code: null,
        detail: null,
        score: 1,
        costUsd: 0,
        stage: VerificationStage.SCHEMA,
      },
    ]);
    expect(verdict.tally).toMatchObject({ declared: 4, votes: 2, failedFraction: 0.5 });
    expect(verdict.decidedBy).toEqual({
      clauseIndex: 2,
      trigger: DecisionTrigger.FAILURES_AT_LEAST,
      label: '2 of 4 checks did not pass',
    });
  });

  it('is null for verifiers/tally/decidedBy that were never judged, not fabricated', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(buildRecord({ state: 'PENDING' }));

    const verdict = await service.getById(ORG, { id: 'record-1' });

    expect(verdict.verifiers).toEqual([]);
    expect(verdict.tally).toBeNull();
    expect(verdict.decidedBy).toBeNull();
    expect(verdict.stageResults.every((row) => row.status === StageStatus.NOT_REACHED)).toBe(true);
  });
});

describe('VerdictService.getEvidence', () => {
  it('404s when the record does not belong to this organization', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(service.getEvidence(ORG, { id: 'nope' })).rejects.toMatchObject({
      errorCode: VerificationErrorCode.VERIFICATION_VERDICT_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('carries the request, response, output schema and the sampling proof', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(
      buildRecord({
        request: { query: 'weather in Paris' },
        response: { results: [] },
        outputSchema: { type: 'object' },
        sampleRate: 0.08,
        sampled: true,
        sampleSelector: 0.02,
        sampleDisplay: '1 in 13 calls at this price',
      }),
    );

    const evidence = await service.getEvidence(ORG, { id: 'record-1' });

    expect(evidence.request).toEqual({ query: 'weather in Paris' });
    expect(evidence.response).toEqual({ results: [] });
    expect(evidence.outputSchema).toEqual({ type: 'object' });
    expect(evidence.sampling).toEqual({
      sampleRate: 0.08,
      sampled: true,
      sampleSelector: 0.02,
      sampleDisplay: '1 in 13 calls at this price',
    });
  });

  it('pins the exact policy document via decisionPolicyId/decisionPolicyVersion', async () => {
    const policy = buildPolicy({ policyId: 'search_web.decision', policyVersion: 3 });
    const { service, records, findVersion } = build([], policy);
    (records.findOneBy as jest.Mock).mockResolvedValue(
      buildRecord({ decisionPolicyId: 'search_web.decision', decisionPolicyVersion: 3 }),
    );

    const evidence = await service.getEvidence(ORG, { id: 'record-1' });

    expect(findVersion).toHaveBeenCalledWith('search_web.decision', 3);
    expect(evidence.pinnedPolicy).toMatchObject({
      policyId: 'search_web.decision',
      policyVersion: 3,
      lifecycle: 'ACTIVE',
    });
    expect(evidence.pinnedPolicy?.decisionDocument).toBeDefined();
  });

  it('names no policy for a record that has not been judged yet — a null pinnedPolicy, not a fabricated one', async () => {
    const { service, records, findVersion } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(buildRecord({ state: 'PENDING' }));

    const evidence = await service.getEvidence(ORG, { id: 'record-1' });

    expect(evidence.pinnedPolicy).toBeNull();
    expect(findVersion).not.toHaveBeenCalled();
  });

  /**
   * A verdict judged before evidence packs existed has no pack, and says so.
   *
   * The distinction the field exists to draw: one of these two payloads is
   * evidence and the other is a rendering of a mutable row. Nothing was
   * backfilled, so this branch is permanent for the calls that predate the
   * migration.
   */
  it('labels an unsealed verdict as a view rather than evidence', async () => {
    const { service, records } = build();
    (records.findOneBy as jest.Mock).mockResolvedValue(buildRecord());

    const evidence = await service.getEvidence(ORG, { id: 'record-1' });

    expect(evidence.integrity).toBeNull();
    expect(evidence.bodyDigests).toBeNull();
  });

  it('serves the sealed pack, not the record, when one exists', async () => {
    const sealed = {
      request: { city: 'Paris' },
      response: { tempC: 31 },
      stageResults: [],
      sampling: { sampleRate: 0.05, sampled: false, sampleSelector: 0.9, sampleDisplay: null },
      pinnedPolicy: null,
      evaluatedAt: new Date('2026-08-21T08:59:59.000Z'),
      integrity: {
        sealed: true,
        seq: 3,
        contentHash: 'c'.repeat(64),
        prevHash: 'b'.repeat(64),
        sealedAt: new Date('2026-08-21T09:00:00.000Z'),
        bodyState: 'RAW' as const,
      },
      bodyDigests: { request: `sha256:${'1'.repeat(64)}`, response: `sha256:${'2'.repeat(64)}` },
    };
    const { service, records, findVersion } = build([], null, sealed);
    (records.findOneBy as jest.Mock).mockResolvedValue(buildRecord());

    const evidence = await service.getEvidence(ORG, { id: 'record-1' });

    expect(evidence.integrity?.seq).toBe(3);
    expect(evidence.response).toEqual({ tempC: 31 });
    // The record's own policy lookup is not consulted: the pack pinned it at
    // judgement, and re-resolving it now could return a different document.
    expect(findVersion).not.toHaveBeenCalled();
  });
});
