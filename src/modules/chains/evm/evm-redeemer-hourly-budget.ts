import { Logger } from '@nestjs/common';

import { AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ChainId } from '../ports/caip.types';
import {
  EVM_HOURLY_WEI_WINDOW_SECONDS,
  EvmHourlyWeiWindow,
  EvmWeiBudgetTicket,
} from './evm-hourly-wei-budget';

/**
 * How much wei the REDEEMER key may spend per hour on one chain, across every
 * background send it makes: redemptions (single and batch) and held collects and
 * refunds. `EVM_REDEEMER_HOURLY_SPEND_WEI`; default 0.0003 ETH (review
 * 2026-10-30 I-1).
 *
 * The per-item cap and its hard ceiling (`evm-l1-gas.ts`) bound what ONE send
 * may cost; nothing bounded how many such sends an hour could make, so a long
 * spike with a full queue could still spend the float in an hour. A send this
 * would take over the budget is deferred exactly like a fee spike
 * (`FeeSpikeDeferred`: nothing signed, the next pass asks again).
 *
 * A deadline-URGENT send (a voucher or a held refund within
 * `EVM_FEE_CAP_WAIVED_WITHIN_SECONDS` of its deadline) may take the hour's sum
 * up to {@link EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER}× the budget: deferring it
 * would lose the payment, not the gas, but even urgency is not unlimited. An
 * urgent voucher refused there lapses at its deadline into buyer debt, which
 * operators can void (two-person approval).
 *
 * Charged at the estimate (`gasLimit × L2 basefee`, the most a Nitro send can
 * cost; at the float's `maxFeePerGas` when the basefee is unknown, and at the
 * per-item cap when neither is) when admitted, and replaced by `gasUsed × the
 * same fee` once the receipt is in. The basefee of the block it lands in may
 * differ a little from the one read; the hour's sum is an estimate either way.
 */
export const EVM_REDEEMER_HOURLY_SPEND_WEI_ENV = 'EVM_REDEEMER_HOURLY_SPEND_WEI';
export const DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI = 300_000_000_000_000n; // 0.0003 ETH

/** How far past the budget an urgent send may take the hour's sum. */
export const EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER = 2n;

/** DI token: the {@link EvmRedeemerHourlyBudget}, or `null` in a process without Redis. */
export const EVM_REDEEMER_HOURLY_BUDGET = 'EVM_REDEEMER_HOURLY_BUDGET';

/** The alert a send refused by the budget raises: WARN, or CRITICAL when an urgent one was. */
export const EVM_REDEEMER_BUDGET_SPENT_ALERT = 'evm_redeemer_hourly_budget_spent';

/** `assay:evm-redeemer-hourly-wei:<chainId>`: a sorted set of admitted charges, scored by instant. */
export const EVM_REDEEMER_HOURLY_KEY_PREFIX = 'assay:evm-redeemer-hourly-wei';

export function redeemerHourlyKey(chainId: ChainId): string {
  return `${EVM_REDEEMER_HOURLY_KEY_PREFIX}:${chainId}`;
}

/**
 * An admitted send. `ticket` is `null` when the send was admitted without being
 * counted (an urgent send while Redis could not answer).
 */
export interface EvmRedeemerAdmission {
  readonly ticket: EvmWeiBudgetTicket | null;
}

/**
 * The redeemer's hourly spend budget, per chain, in Redis.
 *
 * Taken immediately before the send, after the cost cap, the float and the
 * simulation, so a send any of them refused costs nothing from it.
 *
 * When Redis cannot answer, an ordinary send is deferred (it loses nothing by
 * waiting) and an urgent one is sent uncounted: refusing it would turn a cache
 * outage into lapsed vouchers, and the hard ceiling still bounds what it costs.
 */
export class EvmRedeemerHourlyBudget {
  private readonly logger = new Logger(EvmRedeemerHourlyBudget.name);
  private readonly window: EvmHourlyWeiWindow;

  constructor(
    cache: CacheService,
    private readonly alerts: AlertPort,
    readonly limitWei: bigint = DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI,
    now: () => number = () => Date.now(),
  ) {
    this.window = new EvmHourlyWeiWindow(cache, now);
  }

  /**
   * Charges `wei` for one send. Within the budget it is admitted; over it, only
   * an urgent send is, up to 2× the budget. `urgent` may be lazy: it is asked
   * only when the ordinary budget refuses. `null`: deferred.
   */
  async take(
    chainId: ChainId,
    wei: bigint,
    urgent: boolean | (() => Promise<boolean>),
    purpose: string,
  ): Promise<EvmRedeemerAdmission | null> {
    const key = redeemerHourlyKey(chainId);
    let isUrgent: boolean | null = null;
    const resolveUrgent = async (): Promise<boolean> =>
      (isUrgent ??= typeof urgent === 'function' ? await urgent() : urgent);
    try {
      const ordinary = await this.window.take(key, wei, this.limitWei);
      if (ordinary) return { ticket: ordinary };
      if (await resolveUrgent()) {
        const stretched = await this.window.take(
          key,
          wei,
          this.limitWei * EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER,
        );
        if (stretched) {
          this.logger.warn(
            `the redeemer's hourly budget of ${this.limitWei} wei on ${chainId} is spent; ` +
              `${purpose} (${wei} wei) is near its deadline and was admitted past it`,
          );
          return { ticket: stretched };
        }
      }
    } catch (error) {
      const sent = await resolveUrgent().catch(() => false);
      this.logger.error(
        `the redeemer's hourly budget on ${chainId} could not be counted; ${purpose} ` +
          `${sent ? 'is near its deadline and is sent uncounted' : 'is deferred'}. ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return sent ? { ticket: null } : null;
    }
    const wasUrgent = isUrgent === true;
    this.logger.warn(
      `the redeemer's hourly budget on ${chainId} is spent (${this.limitWei} wei` +
        `${wasUrgent ? `, ${this.limitWei * EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER} wei for urgent sends` : ''}); ` +
        `${purpose} (${wei} wei) deferred`,
    );
    await this.alert(chainId, wei, wasUrgent, purpose);
    return null;
  }

  /** The send's receipt is in: its charge becomes what it cost. Never throws. */
  async settle(admission: EvmRedeemerAdmission, actualWei: bigint): Promise<void> {
    if (admission.ticket) await this.window.settle(admission.ticket, actualWei);
  }

  /**
   * Once an hour per chain and severity. WARN: ordinary sends wait, which costs
   * nothing yet. CRITICAL: an urgent send was refused, and the payment it
   * carries lapses at its deadline unless the budget frees up first.
   */
  private async alert(chainId: ChainId, wei: bigint, urgent: boolean, purpose: string) {
    try {
      await this.alerts.emit({
        severity: urgent ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
        name: EVM_REDEEMER_BUDGET_SPENT_ALERT,
        summary: urgent
          ? `The redeemer's hourly spend budget on ${chainId} is spent past the urgent allowance; ` +
            `a send near its deadline was deferred and may lapse into buyer debt`
          : `The redeemer's hourly spend budget on ${chainId} is spent; background sends are deferred`,
        details: {
          chainId,
          budgetWei: this.limitWei.toString(),
          urgentBudgetWei: (this.limitWei * EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER).toString(),
          refusedWei: wei.toString(),
          urgent: urgent ? 1 : 0,
          purpose,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: `${chainId}:${urgent ? 'urgent' : 'ordinary'}`,
        suppressionWindowSeconds: EVM_HOURLY_WEI_WINDOW_SECONDS,
      });
    } catch (error) {
      this.logger.error(
        `the redeemer budget alert on ${chainId} failed: ${(error as Error).message}`,
      );
    }
  }
}
