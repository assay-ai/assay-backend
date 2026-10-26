import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';

import { PolicyLifecycle } from '../domain/aggregation/decision-policy.types';
import { PromotionEvidence, falsePositiveRateOf } from '../domain/lifecycle/promotion';
import { VerdictStatus } from '../domain/verdict';
import { VerificationErrors } from '../errors/verification.errors';

/** An operator's verdict on a trial verdict. */
export enum TrialLabel {
  /** The policy judged this call correctly. */
  POLICY_RIGHT = 'POLICY_RIGHT',
  /** It did not. On a FAIL, that is a false positive. */
  POLICY_WRONG = 'POLICY_WRONG',
}

/** The counts the promotion gate reads, measured from `verification_records`. */
export interface MeasuredEvidence {
  /** Judged calls this version decided while in SHADOW. */
  readonly shadowCalls: number;
  /** Of those, how many an operator labelled. */
  readonly labelledSamples: number;
  /** Labelled calls the policy failed and the operator said it got wrong. */
  readonly falsePositives: number;
  readonly falsePositiveRate: number | null;
  /** Calls the policy failed that nobody has labelled yet. */
  readonly unlabelledFails: number;
  /** Labels per operator id. */
  readonly labellers: Readonly<Record<string, number>>;
  readonly source: 'verification_records';
  readonly computedAt: string;
}

/** What a promotion stores on the policy row: the measured counts and who asked. */
export interface ComputedPromotionEvidence extends PromotionEvidence, MeasuredEvidence {}

export interface ShadowRecordQuery {
  readonly policyId: string;
  readonly version: number;
  /** `false`: unlabelled only; `true`: labelled only; absent: both. */
  readonly labelled?: boolean;
  /** The last record id of the previous page. */
  readonly cursor?: string;
  readonly limit: number;
}

export interface ShadowRecordPage {
  readonly records: VerificationRecordEntity[];
  readonly nextCursor: string | null;
}

/**
 * The promotion gate's evidence, computed by the server from the trial
 * verdicts and their labels — never typed in by an operator.
 *
 * Reads span tenants: a policy belongs to a tool, and its trial calls were
 * made by every buyer of it. This is an operator-only service.
 */
@Injectable()
export class PolicyEvidenceService {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  async evidenceFor(
    policyId: string,
    version: number,
    manager?: EntityManager,
  ): Promise<MeasuredEvidence> {
    const runner = manager ?? this.dataSource.manager;
    const [counts] = (await runner.query(
      `SELECT count(*)::int AS "shadowCalls",
              count("label")::int AS "labelledSamples",
              count(*) FILTER (WHERE "label" = $3 AND "verdict_status" = $4)::int AS "falsePositives",
              count(*) FILTER (WHERE "label" IS NULL AND "verdict_status" = $4)::int AS "unlabelledFails"
         FROM "verification_records"
        WHERE "decision_policy_id" = $1 AND "decision_policy_version" = $2
          AND "lifecycle" = 'SHADOW' AND "verdict_status" IS NOT NULL`,
      [policyId, version, TrialLabel.POLICY_WRONG, VerdictStatus.FAIL],
    )) as {
      shadowCalls: number;
      labelledSamples: number;
      falsePositives: number;
      unlabelledFails: number;
    }[];
    const byLabeller = (await runner.query(
      `SELECT "labelled_by" AS "operatorId", count(*)::int AS "count"
         FROM "verification_records"
        WHERE "decision_policy_id" = $1 AND "decision_policy_version" = $2
          AND "lifecycle" = 'SHADOW' AND "label" IS NOT NULL
        GROUP BY "labelled_by"
        ORDER BY "labelled_by"`,
      [policyId, version],
    )) as { operatorId: string; count: number }[];

    return {
      shadowCalls: counts.shadowCalls,
      labelledSamples: counts.labelledSamples,
      falsePositives: counts.falsePositives,
      falsePositiveRate: falsePositiveRateOf({
        shadowCalls: counts.shadowCalls,
        labelledSamples: counts.labelledSamples,
        falsePositives: counts.falsePositives,
        requestedBy: '',
        approvedBy: '',
      }),
      unlabelledFails: counts.unlabelledFails,
      labellers: Object.fromEntries(byLabeller.map((row) => [row.operatorId, row.count])),
      source: 'verification_records',
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Trial verdicts of one policy version, in a fixed pseudo-random order
   * (`md5(id)`): the same for everybody and every reload, and not one an
   * operator can steer towards the passes.
   */
  async listShadowRecords(query: ShadowRecordQuery): Promise<ShadowRecordPage> {
    const qb = this.records()
      .createQueryBuilder('r')
      .where('r.decision_policy_id = :policyId', { policyId: query.policyId })
      .andWhere('r.decision_policy_version = :version', { version: query.version })
      .andWhere(`r.lifecycle = 'SHADOW'`)
      .andWhere('r.verdict_status IS NOT NULL');
    if (query.labelled === true) qb.andWhere('r.label IS NOT NULL');
    if (query.labelled === false) qb.andWhere('r.label IS NULL');
    if (query.cursor) {
      qb.andWhere(
        new Brackets((where) =>
          where
            .where('md5(r.id::text) > md5(CAST(:cursor AS text))', { cursor: query.cursor })
            .orWhere(
              '(md5(r.id::text) = md5(CAST(:cursor AS text)) AND r.id > CAST(:cursor AS uuid))',
            ),
        ),
      );
    }
    const rows = await qb
      .orderBy('md5(r.id::text)', 'ASC')
      .addOrderBy('r.id', 'ASC')
      .limit(query.limit + 1)
      .getMany();
    const page = rows.slice(0, query.limit);
    return {
      records: page,
      nextCursor: rows.length > query.limit ? page[page.length - 1].id : null,
    };
  }

  async findRecord(recordId: string): Promise<VerificationRecordEntity | null> {
    return this.records().findOne({ where: { id: recordId } });
  }

  /**
   * Label one trial verdict.
   *
   * Refused unless the record is a judged SHADOW verdict whose policy version
   * is still SHADOW, the labeller did not register that version, and nobody
   * else labelled it first (the same operator may correct their own label).
   * The final write re-checks all of it in its `WHERE`, so a promotion or a
   * second labeller racing this one cannot slip a label past the rules.
   */
  async label(input: {
    readonly recordId: string;
    readonly label: TrialLabel;
    readonly operatorId: string;
    readonly note?: string | null;
  }): Promise<VerificationRecordEntity> {
    const record = await this.findRecord(input.recordId);
    if (!record) throw VerificationErrors.recordNotFound({ recordId: input.recordId });
    if (record.lifecycle !== PolicyLifecycle.SHADOW || record.verdictStatus === null) {
      throw VerificationErrors.labelRefused({
        reason: 'only a trial (SHADOW) verdict is labelled',
      });
    }
    const policy = await this.dataSource.getRepository(VerificationPolicyEntity).findOne({
      where: {
        policyId: record.decisionPolicyId ?? '',
        policyVersion: record.decisionPolicyVersion ?? 0,
      },
    });
    if (!policy || policy.lifecycle !== PolicyLifecycle.SHADOW) {
      throw VerificationErrors.labelRefused({
        reason: 'this policy version is no longer in trial',
      });
    }
    if (policy.createdBy === input.operatorId) {
      throw VerificationErrors.labelRefused({
        reason: 'the operator who registered a policy cannot label its calls',
      });
    }
    if (record.label !== null && record.labelledBy !== input.operatorId) {
      throw VerificationErrors.labelRefused({ reason: 'another operator labelled this call' });
    }

    const result = await this.records()
      .createQueryBuilder()
      .update(VerificationRecordEntity)
      .set({
        label: input.label,
        labelledBy: input.operatorId,
        labelledAt: () => 'now()',
        labelNote: input.note ?? null,
      })
      .where('id = :id', { id: input.recordId })
      .andWhere(`lifecycle = 'SHADOW'`)
      .andWhere('(label IS NULL OR labelled_by = :by)', { by: input.operatorId })
      .andWhere(
        `EXISTS (SELECT 1 FROM verification_policies p
                  WHERE p.policy_id = decision_policy_id
                    AND p.policy_version = decision_policy_version
                    AND p.lifecycle = 'SHADOW' AND p.created_by <> :by)`,
        { by: input.operatorId },
      )
      .execute();
    if ((result.affected ?? 0) === 0) {
      throw VerificationErrors.labelRefused({
        reason: 'the call or its policy changed while labelling; reload',
      });
    }
    return (await this.findRecord(input.recordId)) as VerificationRecordEntity;
  }

  private records(): Repository<VerificationRecordEntity> {
    return this.dataSource.getRepository(VerificationRecordEntity);
  }
}
