import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import {
  DelegateSpendRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { agentLabelOf, formatNoticeDay } from '@modules/notification/domain/notice-text';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { formatPaymentKeyAmount, paymentKeyEnding } from '@modules/payment/domain/payment-key-text';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  PAYMENT_KEY_DAILY_SUMMARY_CONFIG,
  PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY,
  PAYMENT_KEY_DAILY_SUMMARY_LOCK_TTL_SECONDS,
  PAYMENT_KEY_DAILY_SUMMARY_MAX_KEYS_IN_BODY,
  PaymentKeyDailySummaryConfig,
} from '../constants/payment-key-daily-summary.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PaymentKeyDailySummaryResult =
  | { readonly skipped: true }
  | {
      readonly skipped: false;
      /** The UTC day summarised, `YYYY-MM-DD`. */
      readonly day: string;
      readonly organizations: number;
      readonly keys: number;
    };

/** One payment key's line in an organization's summary. */
export interface PaymentKeySpend {
  readonly credentialId: string | null;
  readonly agentId: string;
  readonly chainId: string;
  readonly keyEnding: string;
  readonly calls: number;
  /** One entry per asset; amounts are atomic units as decimal strings. */
  readonly spend: ReadonlyArray<{
    readonly asset: string;
    readonly decimals: number;
    readonly amount: string;
  }>;
}

/**
 * `payment_key.daily_summary`: once a day, each organization whose payment
 * keys spent anything the day before (UTC) hears how much, per key — paid
 * calls and the exact amount (spec §7.9 "Detection", §7.10 item 6). With the
 * first-spend notice it is how a person notices a key on a stolen laptop or
 * used by malware (threats T2, T12) before its caps run out.
 *
 * ## The window and idempotency
 *
 * The window is the previous UTC calendar day, `[00:00, 24:00)`, so every run
 * on a given day computes the same summary. Sending is idempotent per
 * organization per day twice over: the catalogue's `ONCE_PER_UTC_DAY` rule,
 * keyed by the day summarised, suppresses a second notice from a retry or
 * another replica, and the job lock (`SET … NX EX`) keeps a second replica
 * from doing the work at all. Without Redis the run is skipped rather than
 * risk sending twice; the next day's run summarises the next day.
 *
 * ## What it says
 *
 * Key names, agent labels, the key's last eight characters, call counts and
 * exact amounts (sums of `numeric(78,0)`, formatted from `bigint`). No full
 * address, token or signature. A key with no spend has no line, and an
 * organization with no spend gets no notice.
 *
 * Runs in the scheduler app only (`AccountSchedulerModule`).
 */
@Injectable()
export class PaymentKeyDailySummaryService {
  private readonly logger = new Logger(PaymentKeyDailySummaryService.name);

  constructor(
    private readonly intents: PaymentIntentRepository,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(PAYMENT_KEY_DAILY_SUMMARY_CONFIG) private readonly config: PaymentKeyDailySummaryConfig,
    // Read only to name keys and agents in the body.
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
    @Optional() @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis | null,
  ) {}

  async run(): Promise<PaymentKeyDailySummaryResult> {
    if (!(await this.takeLock())) return { skipped: true };

    const now = new Date(this.config.now());
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - DAY_MS);
    const day = from.toISOString().slice(0, 10);

    const rows = await this.intents.sumDelegateSpendByKey(from, to);
    const byOrganization = new Map<string, DelegateSpendRow[]>();
    for (const row of rows) {
      const list = byOrganization.get(row.organizationId) ?? [];
      list.push(row);
      byOrganization.set(row.organizationId, list);
    }

    let keys = 0;
    for (const [organizationId, orgRows] of byOrganization) {
      try {
        keys += await this.summarise(organizationId, orgRows, { day, from, to });
      } catch (error) {
        this.logger.error(
          `Payment-key summary for org ${organizationId} failed: ${describe(error)}`,
        );
      }
    }
    return { skipped: false, day, organizations: byOrganization.size, keys };
  }

  private async summarise(
    organizationId: string,
    rows: readonly DelegateSpendRow[],
    window: { readonly day: string; readonly from: Date; readonly to: Date },
  ): Promise<number> {
    const spends = groupByKey(rows);
    const lines: string[] = [];
    for (const spend of spends.slice(0, PAYMENT_KEY_DAILY_SUMMARY_MAX_KEYS_IN_BODY)) {
      lines.push(`${await this.keyPhrase(organizationId, spend)}: ${spendPhrase(spend)}`);
    }
    const more = spends.length - lines.length;
    const dayLabel = formatNoticeDay(window.from);

    await this.notifications.notify({
      organizationId,
      event: NotificationEvent.PAYMENT_KEY_DAILY_SUMMARY,
      title: `Payment key spend on ${dayLabel} (UTC)`,
      body:
        `Your payment keys made paid calls on ${dayLabel} (UTC). ${lines.join('; ')}` +
        `${more > 0 ? `; and ${more} more ${more === 1 ? 'key' : 'keys'}` : ''}. ` +
        `If you do not recognise a key or its spend, revoke it.`,
      payload: {
        day: window.day,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        keys: spends,
      },
      dedupeKey: `payment-key-daily-summary:${window.day}`,
    });
    return spends.length;
  }

  /** `Key "Laptop" of "research-bot" (payment key ending 1A2B9F3C)`: names, never ids. */
  private async keyPhrase(organizationId: string, spend: PaymentKeySpend): Promise<string> {
    const [name, label] = await Promise.all([
      this.credentialName(organizationId, spend.credentialId),
      agentLabelOf(this.agents, organizationId, spend.agentId),
    ]);
    return (
      `${name ? `Key "${name}"` : 'A key'}${label ? ` of "${label}"` : ''} ` +
      `(payment key ending ${spend.keyEnding})`
    );
  }

  private async credentialName(
    organizationId: string,
    credentialId: string | null,
  ): Promise<string | null> {
    if (!credentialId) return null;
    try {
      const credential = await this.credentials.findOne({
        where: { id: credentialId, organizationId },
      });
      return credential?.name?.trim() || null;
    } catch {
      return null;
    }
  }

  private async takeLock(): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn('Payment-key daily summary skipped: no Redis for the job lock');
      return false;
    }
    try {
      const taken = await this.redis.set(
        PAYMENT_KEY_DAILY_SUMMARY_LOCK_KEY,
        '1',
        'EX',
        PAYMENT_KEY_DAILY_SUMMARY_LOCK_TTL_SECONDS,
        'NX',
      );
      return taken === 'OK';
    } catch (error) {
      this.logger.warn(
        `Payment-key daily summary skipped: the job lock could not be taken (${describe(error)})`,
      );
      return false;
    }
  }
}

/** One entry per (credential, key), its assets folded together; most calls first. */
function groupByKey(rows: readonly DelegateSpendRow[]): PaymentKeySpend[] {
  const byKey = new Map<
    string,
    {
      credentialId: string | null;
      agentId: string;
      chainId: string;
      delegate: string;
      calls: number;
      spend: Array<{ asset: string; decimals: number; amount: bigint }>;
    }
  >();
  for (const row of rows) {
    const key = `${row.credentialId ?? ''}|${row.delegate}`;
    const entry = byKey.get(key) ?? {
      credentialId: row.credentialId,
      agentId: row.agentId,
      chainId: row.chainId,
      delegate: row.delegate,
      calls: 0,
      spend: [],
    };
    entry.calls += row.calls;
    const same = entry.spend.find((s) => s.asset === row.assetId && s.decimals === row.decimals);
    if (same) same.amount += row.amount;
    else entry.spend.push({ asset: row.assetId, decimals: row.decimals, amount: row.amount });
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .filter((entry) => entry.calls > 0)
    .sort((a, b) => b.calls - a.calls || a.delegate.localeCompare(b.delegate))
    .map((entry) => ({
      credentialId: entry.credentialId,
      agentId: entry.agentId,
      chainId: entry.chainId,
      keyEnding: paymentKeyEnding(entry.delegate),
      calls: entry.calls,
      spend: entry.spend.map((s) => ({
        asset: s.asset,
        decimals: s.decimals,
        amount: s.amount.toString(),
      })),
    }));
}

/** `12 paid calls, 0.120000 USDG`. */
function spendPhrase(spend: PaymentKeySpend): string {
  const amounts = spend.spend
    .map((s) => formatPaymentKeyAmount(s.amount, s.asset, s.decimals))
    .join(' + ');
  return `${spend.calls} paid ${spend.calls === 1 ? 'call' : 'calls'}, ${amounts}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
