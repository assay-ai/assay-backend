import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PROVIDER_TOOL_MAX_TIER } from '@modules/tool/ports/tool.types';

import { ProviderToolQualityDto } from '../dto/provider-tools.dto';
import {
  NO_UPHELD_DISPUTES,
  UPHELD_DISPUTES,
  UpheldDisputesPort,
} from '../ports/upheld-disputes.port';
import { providerPolicyId } from './provider-tool-policy.service';

export const QUALITY_WINDOW_DAYS = 30;

/**
 * A provider tool's quality (design spec §7.6 "Verification"), from what is
 * measured about its one implementation over 30 days (UTC):
 *
 * ```text
 * schema       paid calls whose answer broke the output schema (refunded on the call)
 * rules        the declared rules' verdicts, judged in shadow
 * SLA          verified and failed calls in closed SLA windows
 * disputes     decided and upheld buyer disputes — through UPHELD_DISPUTES, `null` until measured
 * ```
 *
 * `quality` is the share of calls with none of those against them. No
 * cross-provider check exists for a provider tool, and its tier is capped
 * at VERIFIED: it can never be GUARANTEED.
 */
@Injectable()
export class ProviderToolQualityService {
  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Optional()
    @Inject(UPHELD_DISPUTES)
    private readonly disputes: UpheldDisputesPort = NO_UPHELD_DISPUTES,
  ) {}

  async of(tool: {
    readonly id: string;
    readonly name: string;
    readonly ownerOrgId: string | null;
  }): Promise<ProviderToolQualityDto> {
    const since = new Date(Date.now() - QUALITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const providerId = tool.ownerOrgId;
    const [calls] = (await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE verification_verdict IS NOT NULL)::int AS calls,
              count(*) FILTER (WHERE verification_verdict = 'SCHEMA_FAIL')::int AS "schemaFailures"
         FROM payment_intents
        WHERE tool_id = $1 AND provider_id = $2 AND created_at >= $3`,
      [tool.id, providerId, since],
    )) as { calls: number; schemaFailures: number }[];
    const [rules] = (await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE verdict_status IS NOT NULL)::int AS judged,
              count(*) FILTER (WHERE verdict_status = 'FAIL')::int AS failed
         FROM verification_records
        WHERE tool_id = $1 AND provider_id = $2 AND decision_policy_id = $3
          AND created_at >= $4`,
      [tool.id, providerId, providerPolicyId(tool.name), since],
    )) as { judged: number; failed: number }[];
    const [sla] = (await this.dataSource.query(
      `SELECT COALESCE(sum(verified_calls), 0)::int AS verified,
              COALESCE(sum(failed_calls), 0)::int AS failed
         FROM sla_windows
        WHERE tool_id = $1 AND provider_id = $2 AND status = 'CLOSED' AND closed_at >= $3`,
      [tool.id, providerId, since],
    )) as { verified: number; failed: number }[];
    const disputes = providerId ? await this.disputes.countsFor(providerId, tool.id, since) : null;

    const total = calls?.calls ?? 0;
    const schemaFailures = calls?.schemaFailures ?? 0;
    const rulesFailed = rules?.failed ?? 0;
    const upheld = disputes?.upheld ?? 0;
    const bad = Math.min(total, schemaFailures + rulesFailed + upheld);
    return {
      windowDays: QUALITY_WINDOW_DAYS,
      calls: total,
      schemaFailures,
      schemaPassRate: total > 0 ? round((total - schemaFailures) / total) : null,
      rulesJudged: rules?.judged ?? 0,
      rulesFailed,
      rulesPassRate: (rules?.judged ?? 0) > 0 ? round(1 - rulesFailed / rules.judged) : null,
      slaVerifiedCalls: sla?.verified ?? 0,
      slaFailedCalls: sla?.failed ?? 0,
      slaFailureRate: (sla?.verified ?? 0) > 0 ? round(sla.failed / sla.verified) : null,
      disputesDecided: disputes?.decided ?? null,
      disputesUpheld: disputes ? disputes.upheld : null,
      quality: total > 0 ? round((total - bad) / total) : null,
      maxTier: PROVIDER_TOOL_MAX_TIER,
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
