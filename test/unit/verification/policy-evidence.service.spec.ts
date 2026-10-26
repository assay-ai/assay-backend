import { DataSource } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import {
  PolicyEvidenceService,
  TrialLabel,
} from '@modules/verification/services/policy-evidence.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The gate's evidence is counted from `verification_records`, never typed in.
 * The counts themselves are SQL and are exercised against Postgres in
 * `verification-promotion.integration.spec.ts`; here, what the service asks
 * for and the label refusals that never reach a write.
 */
function build(options: {
  readonly counts?: Record<string, number>;
  readonly labellers?: { operatorId: string; count: number }[];
  readonly record?: Partial<VerificationRecordEntity> | null;
  readonly policy?: Partial<VerificationPolicyEntity> | null;
}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const update = jest.fn();
  const dataSource = {
    manager: {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return sql.includes('GROUP BY')
          ? (options.labellers ?? [])
          : [
              options.counts ?? {
                shadowCalls: 0,
                labelledSamples: 0,
                falsePositives: 0,
                unlabelledFails: 0,
              },
            ];
      },
    },
    getRepository: (entity: unknown) =>
      entity === VerificationRecordEntity
        ? {
            findOne: async () => options.record ?? null,
            createQueryBuilder: () => ({ update }),
          }
        : { findOne: async () => options.policy ?? null },
  } as unknown as DataSource;
  return { service: new PolicyEvidenceService(dataSource), queries, update };
}

const SHADOW_RECORD = {
  id: 'r1',
  lifecycle: 'SHADOW',
  verdictStatus: 'FAIL',
  decisionPolicyId: 'get_x.default',
  decisionPolicyVersion: 2,
  label: null,
  labelledBy: null,
};
const SHADOW_POLICY = {
  policyId: 'get_x.default',
  policyVersion: 2,
  lifecycle: 'SHADOW',
  createdBy: 'author',
};

describe('PolicyEvidenceService.evidenceFor', () => {
  it('counts trial records of exactly this version, and false positives as wrong FAILs', async () => {
    const { service, queries } = build({
      counts: { shadowCalls: 600, labelledSamples: 120, falsePositives: 3, unlabelledFails: 7 },
      labellers: [
        { operatorId: 'adj-1', count: 70 },
        { operatorId: 'adj-2', count: 50 },
      ],
    });

    const evidence = await service.evidenceFor('get_x.default', 2);

    expect(evidence).toMatchObject({
      shadowCalls: 600,
      labelledSamples: 120,
      falsePositives: 3,
      falsePositiveRate: 0.025,
      unlabelledFails: 7,
      labellers: { 'adj-1': 70, 'adj-2': 50 },
      source: 'verification_records',
    });
    expect(Number.isNaN(Date.parse(evidence.computedAt))).toBe(false);
    for (const { sql, params } of queries) {
      expect(sql).toContain(`"lifecycle" = 'SHADOW'`);
      expect(sql).toContain('"decision_policy_version" = $2');
      expect(params.slice(0, 2)).toEqual(['get_x.default', 2]);
    }
    expect(queries[0].params.slice(2)).toEqual([TrialLabel.POLICY_WRONG, 'FAIL']);
  });

  it('reports no rate, not zero, when nothing is labelled', async () => {
    const { service } = build({});
    expect((await service.evidenceFor('p', 1)).falsePositiveRate).toBeNull();
  });
});

describe('PolicyEvidenceService.label refusals', () => {
  const label = (service: PolicyEvidenceService, operatorId = 'adj-1') =>
    service.label({ recordId: 'r1', label: TrialLabel.POLICY_WRONG, operatorId });

  it('refuses an unknown record', async () => {
    const { service } = build({ record: null });
    await expectErrorCodeAsync(
      () => label(service),
      VerificationErrorCode.VERIFICATION_RECORD_NOT_FOUND,
    );
  });

  it('refuses a live (ACTIVE) verdict', async () => {
    const { service, update } = build({
      record: { ...SHADOW_RECORD, lifecycle: 'ACTIVE' },
      policy: SHADOW_POLICY,
    });
    await expectErrorCodeAsync(
      () => label(service),
      VerificationErrorCode.VERIFICATION_LABEL_REFUSED,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses once the policy version left SHADOW', async () => {
    const { service, update } = build({
      record: SHADOW_RECORD,
      policy: { ...SHADOW_POLICY, lifecycle: 'ACTIVE' },
    });
    await expectErrorCodeAsync(
      () => label(service),
      VerificationErrorCode.VERIFICATION_LABEL_REFUSED,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses the operator who registered the policy', async () => {
    const { service, update } = build({ record: SHADOW_RECORD, policy: SHADOW_POLICY });
    await expectErrorCodeAsync(
      () => label(service, 'author'),
      VerificationErrorCode.VERIFICATION_LABEL_REFUSED,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to overwrite another operator’s label', async () => {
    const { service, update } = build({
      record: { ...SHADOW_RECORD, label: 'POLICY_RIGHT', labelledBy: 'adj-2' },
      policy: SHADOW_POLICY,
    });
    await expectErrorCodeAsync(
      () => label(service),
      VerificationErrorCode.VERIFICATION_LABEL_REFUSED,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
