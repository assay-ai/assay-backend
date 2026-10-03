import { PaymentIntentEntity } from '../entities/payment-intent.entity';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SlaWindowCallEntity } from '../entities/sla-window-call.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** One grouped count for the evidence pack's failing-call breakdown. */
export interface SlaWindowFailureGroup {
  readonly key: string;
  readonly count: string;
}

/**
 * `sla_window_calls`.
 *
 * `insert()` is the inherited method and it is the whole write path —
 * `SlaWindowService.postCall` calls it directly and catches
 * `uq_sla_window_calls_intent` as the idempotency signal, the same shape
 * `VerificationSettlementService.enqueue` already uses for
 * `uq_verification_records_intent`. Nothing here wraps that; a wrapper would
 * only hide the constraint name the service's `catch` has to name anyway.
 *
 * The read finders exist because `ProviderSlaWindowsService.getEvidence` calls
 * them — the live SLA position screen's "Recent failures 9 · MIN_ARRAY_LENGTH 6
 * · FRESHNESS 3 · agents: ag_7K2 (4), 5 others", which is a grouped count, not
 * the individual rows.
 */
@Injectable()
export class SlaWindowCallRepository extends OrganizationScopedRepository<SlaWindowCallEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(SlaWindowCallEntity, dataSource);
  }

  /** Every call posted to one window, oldest first, capped at `limit`. */
  async findByWindow(
    organizationId: string,
    windowId: string,
    limit: number,
  ): Promise<SlaWindowCallEntity[]> {
    return this.createQueryBuilder('call')
      .where('call.organizationId = :organizationId', { organizationId })
      .andWhere('call.windowId = :windowId', { windowId })
      .orderBy('call.postedAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  /** Failing calls in one window, grouped by `reason_code`, most common first. */
  async countFailuresByReasonCode(
    organizationId: string,
    windowId: string,
  ): Promise<SlaWindowFailureGroup[]> {
    return this.createQueryBuilder('call')
      .select('COALESCE(call.reasonCode, :unknown)', 'key')
      .addSelect('COUNT(*)', 'count')
      .where('call.organizationId = :organizationId', { organizationId })
      .andWhere('call.windowId = :windowId', { windowId })
      .andWhere('call.countedAsFailure = true')
      .setParameter('unknown', 'unknown')
      .groupBy('key')
      .orderBy('count', 'DESC')
      .getRawMany<SlaWindowFailureGroup>();
  }

  /** Failing calls in one window, grouped by `agent_id`, most active first. */
  async countFailuresByAgentId(
    organizationId: string,
    windowId: string,
  ): Promise<SlaWindowFailureGroup[]> {
    return this.createQueryBuilder('call')
      .select('call.agentId', 'key')
      .addSelect('COUNT(*)', 'count')
      .where('call.organizationId = :organizationId', { organizationId })
      .andWhere('call.windowId = :windowId', { windowId })
      .andWhere('call.countedAsFailure = true')
      .groupBy('call.agentId')
      .orderBy('count', 'DESC')
      .getRawMany<SlaWindowFailureGroup>();
  }

  /**
   * What each agent spent in one window, for the compensation split.
   *
   * ## Why this joins `payment_intents` instead of reading this table alone
   *
   * Two of the three values a ledger credit needs are not on `sla_window_calls`
   * and cannot be recovered from it:
   *
   * - **`organization_id` on this table is the *provider's* org**, not the
   *   agent's — it is written as `intent.providerId`. Crediting it would pay
   *   the penalty back to the provider who was penalised.
   * - **`agent_id` has no FK to `agents` and does not reliably join to it.** A
   *   config-session agent has no `agents` row at all, so the lookup misses for
   *   exactly the callers the demo and every local stack use.
   *
   * `payment_intents` carries both honestly: `organization_id` is the payer's
   * and `agent_account` is already the CAIP-10 ledger account id used
   * everywhere else.
   *
   * ## Why every call counts, not only the failures
   *
   * The compensation rule divides the share by **spend in the window**. A
   * failed call is withheld and contributes nothing on its own, which falls out
   * of the sum rather than needing a clause: it is a consequence of the rule,
   * not an exception to it. Filtering to failures would instead pay only the
   * agents who were served badly *and happened to be charged*, which is a
   * different and much smaller set.
   *
   * Cross-organization by construction — the rows name several tenants and
   * there is no single calling one, the same shape the sweepers already use.
   */
  async sumSpendByAgent(windowId: string): Promise<AgentWindowSpend[]> {
    return this.manager
      .createQueryBuilder(SlaWindowCallEntity, 'call')
      .innerJoin(PaymentIntentEntity, 'intent', 'intent.id = call.intentId')
      .select('intent.organization_id', 'organizationId')
      .addSelect('intent.agent_account', 'agentAccount')
      .addSelect('SUM(call.price_amount)', 'spend')
      .where('call.windowId = :windowId', { windowId })
      .groupBy('intent.organization_id')
      .addGroupBy('intent.agent_account')
      .getRawMany<AgentWindowSpend>();
  }
}

/** One agent's total spend inside a window — see {@link SlaWindowCallRepository.sumSpendByAgent}. */
export interface AgentWindowSpend {
  /** The **agent's** organization, off `payment_intents`. */
  readonly organizationId: string;
  /** CAIP-10, and the ledger account id the credit is written against. */
  readonly agentAccount: string;
  /** Minor units, as a numeric string — `SUM` over `numeric(78,0)`. */
  readonly spend: string;
}
