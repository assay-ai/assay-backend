import { Injectable } from '@nestjs/common';

import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { MoneyUtil } from '@shared/utils/money.util';

import { utcDayStart, utcHourStart, utcMonthStart } from '../domain/spend-window.util';

/** What an agent has spent so far, denominated in the policy's own asset. */
export interface AgentSpendUsage {
  readonly spendThisHour: Money;
  readonly spendToday: Money;
  readonly spendThisMonth: Money;
}

/**
 * The `payment_intents` half of spend-policy enforcement.
 *
 * A thin, single-purpose wrapper around
 * `PaymentIntentRepository.sumSpendByAgent` — its own doc comment carries the
 * real reasoning (which statuses count as spend, why one query answers both
 * the daily and the monthly question). This class exists so that
 * `SpendPolicyEnforcementService` (the cap check) and `SpendPolicyService`
 * (`GET /spend-policy`'s live-usage block) read the same number the
 * same way — computing it twice, even correctly, is how a screen and an
 * enforcement decision end up disagreeing about "how much have I spent today".
 */
@Injectable()
export class SpendUsageService {
  constructor(private readonly intents: PaymentIntentRepository) {}

  /**
   * `Σ` price over this hour, today and this calendar month (all UTC), in
   * `assetId`. No period includes the call this is being checked
   * *before* — the caller adds the pending call's price on top of these to
   * decide whether it would breach a cap.
   */
  async spendSoFar(
    organizationId: string,
    agentId: string,
    assetId: AssetId,
    decimals: number,
  ): Promise<AgentSpendUsage> {
    const now = new Date();
    const totals = await this.intents.sumSpendByAgent(
      organizationId,
      agentId,
      assetId,
      utcHourStart(now),
      utcDayStart(now),
      utcMonthStart(now),
    );

    return {
      spendThisHour: MoneyUtil.of(totals.thisHour, assetId, decimals),
      spendToday: MoneyUtil.of(totals.today, assetId, decimals),
      spendThisMonth: MoneyUtil.of(totals.thisMonth, assetId, decimals),
    };
  }
}
