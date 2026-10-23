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

  /**
   * What each agent's DATA_FAIL calls in one window were priced at — the
   * weight of the pro-rata, on-chain compensation (`slash/domain/prorata-slash.ts`).
   *
   * Differs from {@link sumSpendByAgent} on purpose, and both are right for
   * their rule: the ledger split divides an agent share already in the vault
   * by *spend*, while the on-chain pro-rata rule pays the agents that were
   * **harmed**, weighted by the price of the calls that harmed them.
   * `counted_as_failure` is the SLA numerator — the DATA_FAIL verdicts; a
   * SYSTEM_ERROR or REQUEST_ERROR never posts a window row at all.
   *
   * `asset_id` is filtered so a window that once mixed assets (E1) can only
   * weigh calls priced in the asset the penalty is denominated in. The agent
   * comes off `payment_intents.agent_account` (CAIP-10, the payer's own
   * account) for the reason {@link sumSpendByAgent} documents.
   */
  /**
   * Per payer: the failed calls of a window to this provider, what was paid
   * for them (the voucher amount of each) and how much of it settled — the
   * evidence follow-up C5 checks a slash's beneficiary and share against.
   */
  async failedCallPaymentsByAgent(
    windowId: string,
    assetId: string,
    providerId: string,
  ): Promise<
    { agentAccount: string; failedCalls: string; paid: string | null; redeemed: string | null }[]
  > {
    return this.manager
      .createQueryBuilder(SlaWindowCallEntity, 'call')
      .innerJoin(PaymentIntentEntity, 'intent', 'intent.id = call.intentId')
      .select('intent.agent_account', 'agentAccount')
      .addSelect('COUNT(*)', 'failedCalls')
      .addSelect('SUM(call.price_amount)', 'paid')
      .addSelect(`SUM(call.price_amount) FILTER (WHERE intent.status = 'SETTLED')`, 'redeemed')
      .where('call.windowId = :windowId', { windowId })
      .andWhere('call.countedAsFailure = true')
      .andWhere('call.assetId = :assetId', { assetId })
      .andWhere('intent.provider_id = :providerId', { providerId })
      .groupBy('intent.agent_account')
      .orderBy('intent.agent_account', 'ASC')
      .getRawMany();
  }

  /**
   * The payers of this window's failed calls to `providerId` who are LINKED to
   * that provider (review 2026-10-23 M-1, self-slashing): a slash part paying
   * one of them would hand the provider's own side the 60% share, and its
   * record would fill the provider's slash window ahead of honest buyers'.
   *
   * `providerId` is the provider's organization id, as on `payment_intents`
   * and `slash_proposals`. Linked means any of: the call was paid by the
   * provider's own organization or by the tool's publishing organization; the
   * paying agent belongs to one of those; or the paying wallet is a payout or
   * stake wallet the provider enrolled, or the primary wallet of an agent of
   * either organization.
   * Wallets are compared by address, case-insensitively, on any chain.
   * Returns the agent accounts as stored on the intents.
   */
  async linkedAgentAccounts(
    windowId: string,
    assetId: string,
    providerId: string,
    toolId: string | null,
  ): Promise<string[]> {
    const rows = (await this.manager.query(
      `WITH owner AS (
         -- provider_id IS the provider's organization (providerId == organizationId,
         -- see SlashProposalEntity); a providers row by that id is read too.
         SELECT $3::uuid AS org
         UNION
         SELECT p.organization_id FROM providers p WHERE p.id = $3
         UNION
         SELECT t.owner_org_id FROM tools t WHERE t.id = $4 AND t.owner_org_id IS NOT NULL
       ),
       wallet AS (
         SELECT lower(split_part(e.payout_account_id, ':', 3)) AS address
           FROM provider_chain_enrolments e WHERE e.organization_id IN (SELECT org FROM owner)
         UNION
         SELECT lower(split_part(e.stake_authority_account_id, ':', 3))
           FROM provider_chain_enrolments e
          WHERE e.organization_id IN (SELECT org FROM owner)
            AND e.stake_authority_account_id IS NOT NULL
         UNION
         SELECT lower(split_part(a.primary_account_id, ':', 3))
           FROM agents a
          WHERE a.organization_id IN (SELECT org FROM owner)
            AND a.primary_account_id IS NOT NULL
       )
       SELECT DISTINCT intent.agent_account AS "agentAccount"
         FROM sla_window_calls call
         JOIN payment_intents intent ON intent.id = call.intent_id
        WHERE call.window_id = $1
          AND call.counted_as_failure = true
          AND call.asset_id = $2
          AND intent.provider_id = $3
          AND (intent.organization_id IN (SELECT org FROM owner)
               OR EXISTS (SELECT 1 FROM agents a
                           WHERE a.id = intent.agent_id
                             AND a.organization_id IN (SELECT org FROM owner))
               OR lower(split_part(intent.agent_account, ':', 3)) IN (SELECT address FROM wallet))`,
      [windowId, assetId, providerId, toolId],
    )) as { agentAccount: string }[];
    return rows.map((row) => row.agentAccount);
  }

  async sumFailedPriceByAgent(
    windowId: string,
    assetId: string,
    // Only calls routed to this provider (review H-2's evidence check).
    providerId?: string,
  ): Promise<AgentWindowSpend[]> {
    const query = this.manager
      .createQueryBuilder(SlaWindowCallEntity, 'call')
      .innerJoin(PaymentIntentEntity, 'intent', 'intent.id = call.intentId')
      .select('intent.organization_id', 'organizationId')
      .addSelect('intent.agent_account', 'agentAccount')
      .addSelect('SUM(call.price_amount)', 'spend')
      .where('call.windowId = :windowId', { windowId })
      .andWhere('call.countedAsFailure = true')
      .andWhere('call.assetId = :assetId', { assetId });
    if (providerId) query.andWhere('intent.provider_id = :providerId', { providerId });
    return query
      .groupBy('intent.organization_id')
      .addGroupBy('intent.agent_account')
      .orderBy('intent.agent_account', 'ASC')
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
