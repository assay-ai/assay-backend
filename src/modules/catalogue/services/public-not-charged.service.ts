import { Injectable } from '@nestjs/common';

import {
  NotChargedCallRow,
  NotChargedTotalsRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';

import { NOT_CHARGED_REASON_TEXT, notChargedReason } from '../domain/not-charged-reason';
import { TtlCache } from '../domain/ttl-cache';
import {
  PublicNotChargedCallDto,
  PublicNotChargedResponseDto,
  PublicNotChargedTotalsDto,
} from '../dto/get-public-not-charged.dto';
import { PublicCatalogueService } from './public-catalogue.service';

export const NOT_CHARGED_WINDOW_DAYS = 30;
export const NOT_CHARGED_RECENT_LIMIT = 20;
/** Candidates read per load; the k rule chooses the published rows from these. */
export const NOT_CHARGED_CANDIDATE_LIMIT = 500;
/** How long one answer is reused. The route is public, so it must be cheap. */
export const NOT_CHARGED_CACHE_MS = 60_000;
/** The k-anonymity floor: distinct eligible buyers behind any published figure. */
export const NOT_CHARGED_MIN_BUYERS = 5;
/** A row is published only once it is at least this old. */
export const NOT_CHARGED_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** A buyer organization counts toward k only once it is at least this old. */
export const NOT_CHARGED_MIN_BUYER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The public "not charged" feed: paid calls the platform did not charge for,
 * and 30-day totals, readable by anybody.
 *
 * Platform-wide by design — see `PaymentIntentRepository.findNotChargedCandidates`
 * for why the read crosses tenants. Everything below exists so that the feed
 * cannot be used to learn what any one buyer did.
 *
 * ## Rows
 *
 * - **Delayed and coarse.** Only calls at least 24 h old are published, dated
 *   to the UTC day (`day: 'YYYY-MM-DD'`), never to the minute.
 * - **Eligible buyers only.** A call counts only when its organization was
 *   created at least 7 days ago and has at least one charged paid call. That
 *   raises the cost of lifting a tool over k with throwaway organizations.
 * - **k on what is actually published.** With k = {@link NOT_CHARGED_MIN_BUYERS},
 *   the published rows of each tool must come from at least k distinct buyers.
 *   The service picks the newest {@link NOT_CHARGED_RECENT_LIMIT} candidates,
 *   drops every tool whose rows in that selection come from fewer than k
 *   buyers, and repeats until the selection is stable — so the rule holds on
 *   the response itself, not on a wider set the response was cut from.
 * - **Listed providers only.** A row whose provider is not on the public
 *   provider list (ACTIVE, not blocked, serving) is dropped, never named.
 *
 * ## Totals
 *
 * Computed over **complete UTC days** only — `[today − 30 d, today)` — so they
 * change once a day and cannot be differenced minute by minute to isolate a
 * single call. An asset is counted only when at least k eligible buyers made
 * paid calls in it.
 *
 * `withheldForPrivacy` is true whenever either rule removed something, so the
 * page never reads a suppressed figure as "nothing happened".
 *
 * ## Cached in memory, per process
 *
 * One answer per {@link NOT_CHARGED_CACHE_MS}; concurrent requests share the
 * load in flight.
 */
@Injectable()
export class PublicNotChargedService {
  private readonly cache = new TtlCache<PublicNotChargedResponseDto>(NOT_CHARGED_CACHE_MS);

  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly catalogue: PublicCatalogueService,
  ) {}

  read(now: Date = new Date()): Promise<PublicNotChargedResponseDto> {
    return this.cache.get('latest', () => this.load(now), now.getTime());
  }

  private async load(now: Date): Promise<PublicNotChargedResponseDto> {
    const today = startOfUtcDay(now);
    const since = new Date(today.getTime() - NOT_CHARGED_WINDOW_DAYS * DAY_MS);
    const buyerCreatedBefore = new Date(now.getTime() - NOT_CHARGED_MIN_BUYER_AGE_MS);
    const rowsBefore = new Date(now.getTime() - NOT_CHARGED_MIN_AGE_MS);

    const [candidates, totals, providers, tools] = await Promise.all([
      this.intents.findNotChargedCandidates(
        { from: since, to: rowsBefore, buyerCreatedBefore },
        NOT_CHARGED_CANDIDATE_LIMIT,
      ),
      this.intents.summarizeNotCharged({ from: since, to: today, buyerCreatedBefore }),
      this.catalogue.listProviders(),
      this.catalogue.listTools(),
    ]);

    const providerNames = new Map(providers.providers.map((p) => [p.providerId, p.name]));
    const toolNames = new Map(tools.tools.map((tool) => [tool.id, tool.name]));

    const named = candidates.filter(
      (row) => row.providerId !== null && providerNames.has(row.providerId),
    );
    const { published, suppressed } = selectKAnonymous(
      named,
      NOT_CHARGED_RECENT_LIMIT,
      NOT_CHARGED_MIN_BUYERS,
    );
    const counted = totals.filter((row) => row.buyers >= NOT_CHARGED_MIN_BUYERS);

    return {
      windowDays: NOT_CHARGED_WINDOW_DAYS,
      since: since.toISOString(),
      until: today.toISOString(),
      minBuyers: NOT_CHARGED_MIN_BUYERS,
      withheldForPrivacy: suppressed || counted.length < totals.length,
      totals: foldTotals(counted),
      recent: published.flatMap((row) => {
        const call = toCall(row, toolNames, providerNames);
        return call ? [call] : [];
      }),
    };
  }
}

/**
 * The newest `limit` rows such that every tool among them is backed by at
 * least `k` distinct buyers **within the selection itself**.
 *
 * Greedy and monotone: take the newest `limit` rows of the tools still
 * allowed, ban every tool that falls short of `k` there, and repeat. A ban is
 * never lifted, so the loop ends after at most one pass per tool.
 * `suppressed` is true when any candidate row was left out by a ban.
 */
export function selectKAnonymous(
  rows: readonly NotChargedCallRow[],
  limit: number,
  k: number,
): { published: NotChargedCallRow[]; suppressed: boolean } {
  const banned = new Set<string>();

  for (;;) {
    const selection = rows.filter((row) => !banned.has(row.toolId)).slice(0, limit);

    const buyersByTool = new Map<string, Set<string>>();
    for (const row of selection) {
      const buyers = buyersByTool.get(row.toolId) ?? new Set<string>();
      buyers.add(row.buyer);
      buyersByTool.set(row.toolId, buyers);
    }

    const short = [...buyersByTool].filter(([, buyers]) => buyers.size < k);
    if (short.length === 0) return { published: selection, suppressed: banned.size > 0 };
    for (const [toolId] of short) banned.add(toolId);
  }
}

/** Adds the per-asset rows into the totals; amounts stay one entry per asset. */
export function foldTotals(rows: readonly NotChargedTotalsRow[]): PublicNotChargedTotalsDto {
  return {
    callsChecked: rows.reduce((sum, row) => sum + row.calls, 0),
    callsNotCharged: rows.reduce((sum, row) => sum + row.notChargedCalls, 0),
    callsFailedCheck: rows.reduce((sum, row) => sum + row.failedCheckCalls, 0),
    amountNotCharged: rows.map((row) => ({
      amount: row.notChargedAmount.toString(),
      asset: row.asset,
      decimals: row.decimals,
    })),
  };
}

function toCall(
  row: NotChargedCallRow,
  toolNames: ReadonlyMap<string, string>,
  providerNames: ReadonlyMap<string, string>,
): PublicNotChargedCallDto | null {
  const outcome = notChargedReason(row);
  const providerName = row.providerId ? providerNames.get(row.providerId) : undefined;
  if (!outcome || providerName === undefined) return null;

  // Built field by field, never spread from the row: `buyer` and any column
  // added to the query later cannot reach the public payload by accident.
  return {
    toolId: row.toolId,
    toolName: toolNames.get(row.toolId) ?? row.toolId,
    providerName,
    price: { amount: row.priceAmount.toString(), asset: row.asset, decimals: row.decimals },
    reason: outcome.reason,
    reasonText: NOT_CHARGED_REASON_TEXT[outcome.reason],
    bucket: outcome.bucket,
    day: row.createdAt.toISOString().slice(0, 10),
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Math.floor(value.getTime() / DAY_MS) * DAY_MS);
}
