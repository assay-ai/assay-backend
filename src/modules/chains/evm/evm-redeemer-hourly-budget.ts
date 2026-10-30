import { Logger } from '@nestjs/common';

import { AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { ChainId } from '../ports/caip.types';
import {
  EVM_HOURLY_WEI_WINDOW_SECONDS,
  EvmHourlyWeiWindow,
  EvmWeiBudgetAnswer,
  EvmWeiBudgetEntry,
  EvmWeiBudgetTicket,
  shareOf,
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
 * per-item cap when neither is) when admitted, and replaced by what the receipt
 * says it cost, `gasUsed × effectiveGasPrice` (review 2026-10-30 M-2), once it
 * is in. A send that threw keeps its estimate charged: it may have been sent.
 */
export const EVM_REDEEMER_HOURLY_SPEND_WEI_ENV = 'EVM_REDEEMER_HOURLY_SPEND_WEI';
export const DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI = 300_000_000_000_000n; // 0.0003 ETH

/** How far past the budget an urgent send may take the hour's sum. */
export const EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER = 2n;

/**
 * The most of the hourly budget ONE provider's redemptions may take, in basis
 * points (review 2026-10-30 I-2, owner decision): 2,500 = 25 %.
 * `EVM_REDEEMER_PROVIDER_SHARE_BPS`. The urgent lane has the same share of its
 * 2× allowance. Without it one provider's queue (a burst of its own calls, or a
 * buyer farming it) spent the whole hour and every other provider waited.
 *
 * Counted per provider ACCOUNT in the same script as the global sum, so the two
 * cannot disagree. A batch may mix providers: each provider's part of the
 * charge is the batch estimate split by item count. Of the two ways to keep a
 * mixed batch within the shares this takes the simpler: the whole batch is
 * charged at once, all or nothing, and when the script refuses because of
 * providers' shares (not the global sum) it names them; the redeemer drops
 * their items, deferred like a spent budget, and charges the rest once more.
 * Held collects and refunds are charged to the global sum only: each follows a
 * redemption its provider's share already paid for.
 */
export const EVM_REDEEMER_PROVIDER_SHARE_BPS_ENV = 'EVM_REDEEMER_PROVIDER_SHARE_BPS';
export const DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS = 2_500;

/** DI token: the {@link EvmRedeemerHourlyBudget}, or `null` in a process without Redis. */
export const EVM_REDEEMER_HOURLY_BUDGET = 'EVM_REDEEMER_HOURLY_BUDGET';

/** The alert a send refused by the budget raises: WARN, or CRITICAL when an urgent one was. */
export const EVM_REDEEMER_BUDGET_SPENT_ALERT = 'evm_redeemer_hourly_budget_spent';

/** WARN, once an hour per provider: its share of the budget is spent and its redemptions wait. */
export const EVM_REDEEMER_PROVIDER_SHARE_SPENT_ALERT = 'evm_redeemer_provider_share_spent';

/**
 * Redis could not count, and urgent sends went out uncounted (review 2026-10-30
 * M-1): WARN when the first does, CRITICAL when the outage cap stops one.
 */
export const EVM_REDEEMER_BUDGET_UNCOUNTED_ALERT = 'evm_redeemer_hourly_budget_uncounted';

/** `assay:evm-redeemer-hourly-wei:<chainId>`: a sorted set of admitted charges, scored by instant. */
export const EVM_REDEEMER_HOURLY_KEY_PREFIX = 'assay:evm-redeemer-hourly-wei';

export function redeemerHourlyKey(chainId: ChainId): string {
  return `${EVM_REDEEMER_HOURLY_KEY_PREFIX}:${chainId}`;
}

/** `assay:evm-redeemer-hourly-wei:<chainId>:provider:<account>`: one provider's part of the hour. */
export function redeemerProviderHourlyKey(chainId: ChainId, provider: string): string {
  return `${redeemerHourlyKey(chainId)}:provider:${provider.toLowerCase()}`;
}

/**
 * An admitted send. `ticket` is `null` when the send was admitted without being
 * counted (an urgent send while Redis could not answer).
 */
export interface EvmRedeemerAdmission {
  readonly ticket: EvmWeiBudgetTicket | null;
}

/**
 * {@link EvmRedeemerHourlyBudget.takeFor}'s answer: admitted, or deferred.
 * `overShare` names the providers (lowercased) whose share refused it while the
 * global sum still had room; empty when the global budget itself is spent.
 */
export interface EvmRedeemerVerdict {
  readonly admitted: boolean;
  /** Set when admitted. */
  readonly admission: EvmRedeemerAdmission | null;
  /** Empty when admitted, or when the global budget itself refused. */
  readonly overShare: readonly string[];
}

export interface EvmRedeemerHourlyBudgetOptions {
  /** {@link DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS}. */
  readonly providerShareBps?: number;
}

/** Uncounted urgent sends of one Redis outage, per chain (M-1). */
interface OutageSpend {
  readonly startedAt: number;
  spentWei: bigint;
}

/**
 * The redeemer's hourly spend budget, per chain, in Redis, with a share per
 * provider ({@link DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS}).
 *
 * Taken immediately before the send, after the cost cap, the float and the
 * simulation, so a send any of them refused costs nothing from it.
 *
 * **While spent, nothing is simulated** (review 2026-10-30 M-7). A refusal
 * remembers, in this process, when enough of the hour leaves the window for
 * the refused charge to fit (the script answers it); until then
 * {@link paused} says so, and the redeemer defers without estimating or
 * simulating. Per lane (ordinary, urgent) and per provider. A settle clears
 * the chain's pauses: a charge replaced by a smaller actual cost frees room.
 *
 * When Redis cannot answer, an ordinary send is deferred (it loses nothing by
 * waiting) and an urgent one is sent uncounted: refusing it would turn a cache
 * outage into lapsed vouchers. Uncounted is not unbounded (review 2026-10-30
 * M-1): this process sends at most ONE hourly budget of urgent wei per outage
 * window (an hour from the first uncounted send), then defers them too, and
 * alerts at both points.
 */
export class EvmRedeemerHourlyBudget {
  private readonly logger = new Logger(EvmRedeemerHourlyBudget.name);
  private readonly window: EvmHourlyWeiWindow;
  readonly providerShareBps: number;
  /** `<chainId>|<lane>[|<provider>]` → local ms until which a send there is deferred unasked. */
  private readonly pausedUntil = new Map<string, number>();
  private readonly outages = new Map<ChainId, OutageSpend>();

  constructor(
    cache: CacheService,
    private readonly alerts: AlertPort,
    readonly limitWei: bigint = DEFAULT_EVM_REDEEMER_HOURLY_SPEND_WEI,
    private readonly now: () => number = () => Date.now(),
    options: EvmRedeemerHourlyBudgetOptions = {},
  ) {
    this.window = new EvmHourlyWeiWindow(cache);
    this.providerShareBps = options.providerShareBps ?? DEFAULT_EVM_REDEEMER_PROVIDER_SHARE_BPS;
  }

  /** One provider's most per hour: its share of the budget, or of the urgent allowance. */
  providerLimitWei(urgent: boolean): bigint {
    return shareOf(this.laneLimit(urgent), this.providerShareBps);
  }

  /**
   * Whether a send on this lane (and, given `provider`, of this provider) was
   * refused recently enough that asking again cannot succeed yet (M-7). Local
   * and free: callers ask it before estimating or simulating anything.
   */
  paused(chainId: ChainId, urgent: boolean, provider?: string): boolean {
    const now = this.now();
    const lanes = urgent ? ['urgent'] : ['ordinary'];
    return lanes.some((lane) => {
      const keys = [pauseKey(chainId, lane)];
      if (provider !== undefined) keys.push(pauseKey(chainId, lane, provider));
      return keys.some((key) => {
        const until = this.pausedUntil.get(key);
        if (until === undefined) return false;
        if (until > now) return true;
        this.pausedUntil.delete(key);
        return false;
      });
    });
  }

  /**
   * Charges `wei` for one send with no provider part (a held move). Within the
   * budget it is admitted; over it, only an urgent send is, up to 2× the
   * budget. `urgent` may be lazy: it is asked only when the ordinary budget
   * refuses. `null`: deferred.
   */
  async take(
    chainId: ChainId,
    wei: bigint,
    urgent: boolean | (() => Promise<boolean>),
    purpose: string,
  ): Promise<EvmRedeemerAdmission | null> {
    const verdict = await this.takeFor(chainId, wei, urgent, purpose, []);
    return verdict.admitted ? verdict.admission : null;
  }

  /**
   * Charges `wei` for one redemption send carrying `providers` (one entry per
   * item, the item's provider account): the global sum and each provider's
   * part, in one script, all or nothing. See {@link take} for the lanes.
   */
  async takeFor(
    chainId: ChainId,
    wei: bigint,
    urgent: boolean | (() => Promise<boolean>),
    purpose: string,
    providers: readonly string[],
  ): Promise<EvmRedeemerVerdict> {
    const parts = providerParts(wei, providers);
    let isUrgent: boolean | null = null;
    const resolveUrgent = async (): Promise<boolean> =>
      (isUrgent ??= typeof urgent === 'function' ? await urgent() : urgent);
    let answer: EvmWeiBudgetAnswer;
    try {
      answer = await this.window.takeAll(this.entries(chainId, wei, parts, false));
      if (answer.admitted) return admitted(answer.ticket);
      this.pause(chainId, 'ordinary', parts, answer);
      if (await resolveUrgent()) {
        const stretched = await this.window.takeAll(this.entries(chainId, wei, parts, true));
        if (stretched.admitted) {
          this.logger.warn(
            `the redeemer's hourly budget of ${this.limitWei} wei on ${chainId} (or a provider's ` +
              `share of it) is spent; ${purpose} (${wei} wei) is near its deadline and was ` +
              `admitted past it`,
          );
          return admitted(stretched.ticket);
        }
        answer = stretched;
        this.pause(chainId, 'urgent', parts, answer);
      }
    } catch (error) {
      const sent = await resolveUrgent().catch(() => false);
      return this.uncounted(chainId, wei, sent, purpose, error);
    }

    const wasUrgent = isUrgent === true;
    const globalSpent = answer.refused.some((refusal) => refusal.index === 0);
    if (globalSpent) {
      this.logger.warn(
        `the redeemer's hourly budget on ${chainId} is spent (${this.limitWei} wei` +
          `${wasUrgent ? `, ${this.laneLimit(true)} wei for urgent sends` : ''}); ` +
          `${purpose} (${wei} wei) deferred`,
      );
      await this.alert(chainId, wei, wasUrgent, purpose);
      return deferred([]);
    }
    const overShare = answer.refused.map((refusal) => parts[refusal.index - 1].provider);
    for (const provider of overShare) {
      this.logger.warn(
        `provider ${provider} has spent its ${this.providerLimitWei(wasUrgent)} wei share of the ` +
          `redeemer's hourly budget on ${chainId}; its part of ${purpose} is deferred`,
      );
      await this.alertProvider(chainId, provider, wasUrgent);
    }
    return deferred(overShare);
  }

  /** The send's receipt is in: its charge becomes what it cost. Never throws. */
  async settle(admission: EvmRedeemerAdmission, actualWei: bigint): Promise<void> {
    if (!admission.ticket) return;
    await this.window.settle(admission.ticket, actualWei);
    // Room may have freed: let the next send on this chain ask again.
    const wholeKey = admission.ticket.parts[0]?.key ?? '';
    const chainId = wholeKey.slice(EVM_REDEEMER_HOURLY_KEY_PREFIX.length + 1);
    for (const key of [...this.pausedUntil.keys()]) {
      if (key.startsWith(`${chainId}|`)) this.pausedUntil.delete(key);
    }
  }

  private laneLimit(urgent: boolean): bigint {
    return urgent ? this.limitWei * EVM_REDEEMER_URGENT_BUDGET_MULTIPLIER : this.limitWei;
  }

  private entries(
    chainId: ChainId,
    wei: bigint,
    parts: readonly { provider: string; wei: bigint }[],
    urgent: boolean,
  ): EvmWeiBudgetEntry[] {
    const providerLimit = this.providerLimitWei(urgent);
    return [
      { key: redeemerHourlyKey(chainId), wei, limit: this.laneLimit(urgent) },
      ...parts.map((part) => ({
        key: redeemerProviderHourlyKey(chainId, part.provider),
        wei: part.wei,
        limit: providerLimit,
      })),
    ];
  }

  /** Remembers a refusal until the script says room frees (M-7). */
  private pause(
    chainId: ChainId,
    lane: 'ordinary' | 'urgent',
    parts: readonly { provider: string }[],
    answer: EvmWeiBudgetAnswer,
  ): void {
    if (answer.admitted) return;
    const now = this.now();
    for (const refusal of answer.refused) {
      const provider = refusal.index === 0 ? undefined : parts[refusal.index - 1]?.provider;
      this.pausedUntil.set(pauseKey(chainId, lane, provider), now + refusal.retryAfterMs);
    }
  }

  /**
   * Redis could not count. An ordinary send is deferred; an urgent one is sent
   * uncounted, within this process's cap of one hourly budget per outage window.
   */
  private async uncounted(
    chainId: ChainId,
    wei: bigint,
    urgent: boolean,
    purpose: string,
    error: unknown,
  ): Promise<EvmRedeemerVerdict> {
    const reason = error instanceof Error ? error.message : String(error);
    if (!urgent) {
      this.logger.error(
        `the redeemer's hourly budget on ${chainId} could not be counted; ${purpose} is ` +
          `deferred. ${reason}`,
      );
      return deferred([]);
    }
    const now = this.now();
    let outage = this.outages.get(chainId);
    if (!outage || now - outage.startedAt >= EVM_HOURLY_WEI_WINDOW_SECONDS * 1000) {
      outage = { startedAt: now, spentWei: 0n };
      this.outages.set(chainId, outage);
    }
    if (outage.spentWei + wei > this.limitWei) {
      this.logger.error(
        `the redeemer's hourly budget on ${chainId} could not be counted, and this process ` +
          `has already sent ${outage.spentWei} wei uncounted this outage (cap ${this.limitWei}); ` +
          `${purpose} (${wei} wei) is deferred although near its deadline. ${reason}`,
      );
      await this.alertUncounted(chainId, outage.spentWei, true);
      return deferred([]);
    }
    const first = outage.spentWei === 0n;
    outage.spentWei += wei;
    this.logger.error(
      `the redeemer's hourly budget on ${chainId} could not be counted; ${purpose} is near its ` +
        `deadline and is sent uncounted (${outage.spentWei} of ${this.limitWei} wei this outage). ` +
        reason,
    );
    if (first) await this.alertUncounted(chainId, outage.spentWei, false);
    return admitted(null);
  }

  /**
   * Once an hour per chain and severity. WARN: ordinary sends wait, which costs
   * nothing yet. CRITICAL: an urgent send was refused, and the payment it
   * carries lapses at its deadline unless the budget frees up first.
   */
  private async alert(chainId: ChainId, wei: bigint, urgent: boolean, purpose: string) {
    await this.emit(chainId, {
      severity: urgent ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
      name: EVM_REDEEMER_BUDGET_SPENT_ALERT,
      summary: urgent
        ? `The redeemer's hourly spend budget on ${chainId} is spent past the urgent allowance; ` +
          `a send near its deadline was deferred and may lapse into buyer debt`
        : `The redeemer's hourly spend budget on ${chainId} is spent; background sends are deferred`,
      details: {
        chainId,
        budgetWei: this.limitWei.toString(),
        urgentBudgetWei: this.laneLimit(true).toString(),
        refusedWei: wei.toString(),
        urgent: urgent ? 1 : 0,
        purpose,
      },
      dedupeKey: `${chainId}:${urgent ? 'urgent' : 'ordinary'}`,
    });
  }

  /** WARN, once an hour per chain and provider: that provider's redemptions wait. */
  private async alertProvider(chainId: ChainId, provider: string, urgent: boolean) {
    await this.emit(chainId, {
      severity: AlertSeverity.WARN,
      name: EVM_REDEEMER_PROVIDER_SHARE_SPENT_ALERT,
      summary:
        `Provider ${provider} has spent its share of the redeemer's hourly budget on ${chainId}; ` +
        `its redemptions are deferred until the share frees up`,
      details: {
        chainId,
        provider,
        shareBps: this.providerShareBps,
        shareWei: this.providerLimitWei(urgent).toString(),
        urgent: urgent ? 1 : 0,
      },
      dedupeKey: `${chainId}:${provider}`,
    });
  }

  /** M-1: WARN at the first uncounted send of an outage, CRITICAL when its cap stops one. */
  private async alertUncounted(chainId: ChainId, spentWei: bigint, capped: boolean) {
    await this.emit(chainId, {
      severity: capped ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
      name: EVM_REDEEMER_BUDGET_UNCOUNTED_ALERT,
      summary: capped
        ? `Redis cannot count the redeemer's hourly budget on ${chainId}, and this process's ` +
          `cap on uncounted urgent sends is reached; vouchers near their deadline are deferred`
        : `Redis cannot count the redeemer's hourly budget on ${chainId}; urgent sends go out ` +
          `uncounted, up to one hourly budget per process`,
      details: {
        chainId,
        uncountedWei: spentWei.toString(),
        capWei: this.limitWei.toString(),
        capped: capped ? 1 : 0,
      },
      dedupeKey: `${chainId}:${capped ? 'uncounted-capped' : 'uncounted'}`,
    });
  }

  private async emit(
    chainId: ChainId,
    alert: {
      severity: AlertSeverity;
      name: string;
      summary: string;
      details: Record<string, string | number>;
      dedupeKey: string;
    },
  ) {
    try {
      await this.alerts.emit({
        ...alert,
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        suppressionWindowSeconds: EVM_HOURLY_WEI_WINDOW_SECONDS,
      });
    } catch (error) {
      this.logger.error(
        `the redeemer budget alert on ${chainId} failed: ${(error as Error).message}`,
      );
    }
  }
}

function admitted(ticket: EvmWeiBudgetTicket | null): EvmRedeemerVerdict {
  return { admitted: true, admission: { ticket }, overShare: [] };
}

function deferred(overShare: readonly string[]): EvmRedeemerVerdict {
  return { admitted: false, admission: null, overShare };
}

function pauseKey(chainId: ChainId, lane: string, provider?: string): string {
  return provider === undefined
    ? `${chainId}|${lane}`
    : `${chainId}|${lane}|${provider.toLowerCase()}`;
}

/**
 * Each provider's part of a charge of `wei` for `providers` (one per item):
 * the charge split by item count, rounded down. Lowercased accounts.
 */
function providerParts(
  wei: bigint,
  providers: readonly string[],
): { provider: string; wei: bigint }[] {
  if (providers.length === 0) return [];
  const counts = new Map<string, number>();
  for (const provider of providers) {
    const key = provider.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const n = BigInt(providers.length);
  return [...counts].map(([provider, count]) => ({ provider, wei: (wei * BigInt(count)) / n }));
}
