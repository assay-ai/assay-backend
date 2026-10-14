import { Inject, Injectable } from '@nestjs/common';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import {
  NotChargedCallRow,
  NotChargedTotalsRow,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';

import { NOT_CHARGED_REASON_TEXT, notChargedReason } from '../domain/not-charged-reason';
import { TtlCache } from '../domain/ttl-cache';
import {
  PublicNotChargedCallDto,
  PublicNotChargedResponseDto,
  PublicNotChargedTotalsDto,
} from '../dto/get-public-not-charged.dto';

export const NOT_CHARGED_WINDOW_DAYS = 30;
export const NOT_CHARGED_RECENT_LIMIT = 20;
/** How long one answer is reused. The route is public, so it must be cheap. */
export const NOT_CHARGED_CACHE_MS = 60_000;
/**
 * The k-anonymity floor: the fewest distinct buyer organizations that must
 * stand behind a published figure. See {@link PublicNotChargedService}.
 */
export const NOT_CHARGED_MIN_BUYERS = 5;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The public "not charged" feed: recent paid calls the platform did not
 * charge for, and 30-day totals.
 *
 * Platform-wide by design — see `PaymentIntentRepository.findRecentNotCharged`
 * for why the read crosses tenants. This service adds names (tool, provider)
 * and the plain-language reason, and nothing keyed to a caller.
 *
 * ## The k-anonymity rule
 *
 * An anonymised row is still identifying when only one buyer could have made
 * it: on a tool one organization uses, "get_weather failed its check at 09:41"
 * is that organization's activity. So, with k = {@link NOT_CHARGED_MIN_BUYERS}:
 *
 * - **Rows.** A tool's not-charged calls are listed only when, within the
 *   window, they came from at least k distinct buyer organizations. Otherwise
 *   none of that tool's calls are listed.
 * - **Totals.** An asset's row is counted only when at least k distinct buyers
 *   made paid calls in it. Otherwise it is left out of every total.
 *
 * Whenever either rule removes something, `withheldForPrivacy` is true, so the
 * page never presents a suppressed figure as "nothing happened". The counts
 * the rule reads are distinct-organization counts computed in SQL; no
 * organization id ever leaves the repository.
 *
 * ## Cached in memory, per process
 *
 * One answer is reused for {@link NOT_CHARGED_CACHE_MS}, and concurrent
 * requests share the one in flight. The queries scan a 30-day slice of
 * `payment_intents` across every tenant; an unauthenticated route that ran
 * them per request would be a free amplifier.
 */
@Injectable()
export class PublicNotChargedService {
  private readonly cache = new TtlCache<PublicNotChargedResponseDto>(NOT_CHARGED_CACHE_MS);

  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly providers: ProviderRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
  ) {}

  read(now: Date = new Date()): Promise<PublicNotChargedResponseDto> {
    return this.cache.get('latest', () => this.load(now), now.getTime());
  }

  private async load(now: Date): Promise<PublicNotChargedResponseDto> {
    const since = toMinute(new Date(now.getTime() - NOT_CHARGED_WINDOW_DAYS * DAY_MS));

    const [buyersByTool, totals, tools] = await Promise.all([
      this.intents.countNotChargedBuyersByTool(since),
      this.intents.summarizeNotCharged(since),
      this.catalogue.listTools(),
    ]);

    const publishable = buyersByTool
      .filter((tool) => tool.buyers >= NOT_CHARGED_MIN_BUYERS)
      .map((tool) => tool.toolId);
    const rows = await this.intents.findRecentNotCharged(
      since,
      NOT_CHARGED_RECENT_LIMIT,
      publishable,
    );

    const toolNames = new Map(tools.map((tool) => [tool.id, tool.name]));
    const providerNames = await this.providerNames(rows);
    const counted = totals.filter((row) => row.buyers >= NOT_CHARGED_MIN_BUYERS);

    return {
      windowDays: NOT_CHARGED_WINDOW_DAYS,
      since: since.toISOString(),
      minBuyers: NOT_CHARGED_MIN_BUYERS,
      withheldForPrivacy:
        publishable.length < buyersByTool.length || counted.length < totals.length,
      totals: foldTotals(counted),
      recent: rows.flatMap((row) => {
        const call = toCall(row, toolNames, providerNames);
        return call ? [call] : [];
      }),
    };
  }

  /** At most {@link NOT_CHARGED_RECENT_LIMIT} distinct lookups, concurrently. */
  private async providerNames(
    rows: readonly NotChargedCallRow[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(rows.map((row) => row.providerId).filter((id): id is string => !!id))];
    const found = await Promise.all(
      ids.map((organizationId) => this.providers.findOne({ where: { organizationId } })),
    );
    const names = new Map<string, string>();
    found.forEach((row) => {
      if (row) names.set(row.organizationId, row.legalName);
    });
    return names;
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
  if (!outcome) return null;

  // Built field by field, never spread from the row, so a column added to the
  // query later cannot reach the public payload by accident.
  return {
    toolId: row.toolId,
    toolName: toolNames.get(row.toolId) ?? row.toolId,
    providerName: row.providerId ? (providerNames.get(row.providerId) ?? null) : null,
    price: { amount: row.priceAmount.toString(), asset: row.asset, decimals: row.decimals },
    reason: outcome.reason,
    reasonText: NOT_CHARGED_REASON_TEXT[outcome.reason],
    bucket: outcome.bucket,
    at: toMinute(row.createdAt).toISOString(),
  };
}

function toMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / MINUTE_MS) * MINUTE_MS);
}
