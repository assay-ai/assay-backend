import { Inject, Injectable } from '@nestjs/common';

import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';

import {
  GetProviderQualityQueryDto,
  GetProviderQualityResponseDto,
  ProviderVerdictMixEntryDto,
} from '../dto/get-provider-quality.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { PROVIDER_REGISTRY, ProviderRegistryPort } from '../ports/provider-registry.port';

/** Mirrors `ProviderVerdictMixEntryDto`'s description — matched against `record.verdictStatus IS NULL`. */
const VERDICT_EXPR = "COALESCE(record.verdictStatus, 'PENDING')";

interface VerdictRow {
  readonly verdict: string;
  readonly calls: string;
}

/**
 * `GET /providers/me/quality`.
 *
 * Two different data sources, on purpose. `paidQualityRate`/`freeQualityRate`/
 * `availabilityRate` come straight from `ProviderStats` — see the DTO comment
 * for why recomputing the paid/free split here would risk folding two figures
 * the port keeps deliberately separate. `verdictMix` is this endpoint's own
 * computation: a **cross-organization** aggregate over `verification_records`,
 * the same pattern and the same justification as `ProviderTrafficService`
 * (a provider's calls span every buyer org, not its own).
 */
@Injectable()
export class ProviderQualityService {
  constructor(
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort,
    private readonly records: VerificationRecordRepository,
  ) {}

  async getQuality(
    providerId: string,
    query: GetProviderQualityQueryDto,
  ): Promise<GetProviderQualityResponseDto> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (!(from.getTime() < to.getTime())) {
      throw ProviderErrors.invalidTimeRange({ from: query.from, to: query.to });
    }

    const states = await this.registry.findRoutingStates([providerId]);
    const stats = states.get(providerId)?.stats;

    const rows = await this.records
      .createQueryBuilder('record')
      .select(VERDICT_EXPR, 'verdict')
      .addSelect('COUNT(*)', 'calls')
      .where('record.organizationId IS NOT NULL')
      .andWhere('record.providerId = :providerId', { providerId })
      .andWhere('record.createdAt >= :from', { from })
      .andWhere('record.createdAt < :to', { to })
      .groupBy(VERDICT_EXPR)
      .getRawMany<VerdictRow>();

    const totalCalls = rows.reduce((total, row) => total + Number(row.calls), 0);
    const verdictMix: ProviderVerdictMixEntryDto[] = rows
      .map((row) => ({
        verdict: row.verdict,
        calls: Number(row.calls),
        share: totalCalls === 0 ? 0 : Number(row.calls) / totalCalls,
      }))
      .sort((a, b) => b.calls - a.calls);

    return {
      paidQualityRate: stats?.paidQualityRate ?? null,
      freeQualityRate: stats?.freeQualityRate ?? null,
      availabilityRate: stats?.availabilityRate ?? null,
      from: query.from,
      to: query.to,
      verdictMix,
      totalCalls,
    };
  }
}
