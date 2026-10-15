import { Injectable } from '@nestjs/common';

import {
  CallExportCursor,
  CallExportRow,
  PaymentIntentPeriod,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { isAssetId } from '@modules/chains/ports/caip.types';
import {
  PROVIDER_FORFEIT_PREFIX,
  UNCOLLECTED_PREFIX,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  CallReconciliationClass,
  classifyForReconciliation,
} from '@modules/provider/domain/call-reconciliation';
import { csvLine } from '@modules/provider/domain/csv';
import { ApiErrors } from '@shared/api';

import { GetProviderCallsExportQueryDto } from '../dto/get-provider-calls-export.dto';
import { ProviderErrors } from '../errors/provider.errors';

/**
 * `GET /providers/me/calls/export` — one CSV row per call.
 *
 * ## Why this is not a `ListQueryDto` / `CursorPageDto` endpoint
 *
 * `docs/api-list-contract.md` is strict for a reason this endpoint does not
 * share. The contract exists for **UI-paged collections** — a screen that
 * fetches one page, renders it, and fetches the next on demand, where a stale
 * total or a double-counted row on page 2 is the failure mode. A finance
 * export is a different animal: a provider's own tooling pulls the *whole*
 * window in one request and reconciles it as a set, so a `pageInfo.nextCursor`
 * the caller has to loop on manually is friction with no UI on the other end
 * to justify it, and a JSON envelope cannot wrap a CSV file without stopping
 * it from being a CSV file. This is the discussion the contract doc asks for
 * before diverging — recorded here rather than as a silent exception.
 *
 * What the contract's *principles* still bind:
 *
 *  - **No silent caps** (`docs/api-list-contract.md`). {@link EXPORT_MAX_ROWS}
 *    is real, and a window that exceeds it is visible in the response —
 *    `X-Assay-Export-Truncated` / `X-Assay-Export-Row-Count` /
 *    `X-Assay-Export-Total-Matching` headers, set before the first CSV byte,
 *    never a file that silently stops short with no signal.
 *  - **Streamed, not buffered.** {@link ProviderCallsExportService.prepare}
 *    counts the window with one `COUNT(*)`, then hands back an async
 *    generator that pages the rows in batches of {@link EXPORT_BATCH_SIZE} —
 *    a month of calls must not become a multi-hundred-megabyte array sitting
 *    in one process's heap.
 *  - **Scoped exactly like `ProviderEarningsService`.** See that class's doc
 *    comment; the reasoning is identical and is not repeated here.
 */
@Injectable()
export class ProviderCallsExportService {
  constructor(private readonly intents: PaymentIntentRepository) {}

  async prepare(
    providerId: string,
    query: GetProviderCallsExportQueryDto,
  ): Promise<CallExportResult> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (!(from.getTime() < to.getTime())) {
      throw ProviderErrors.invalidTimeRange({ from: query.from, to: query.to });
    }
    if (query.asset !== undefined && !isAssetId(query.asset)) {
      throw ApiErrors.invalidFilter({ filter: 'asset', value: query.asset });
    }

    const period: Required<PaymentIntentPeriod> = { from, to };
    const totalMatching = await this.intents.countCallsForExport(providerId, period, query.asset);
    const rowCount = Math.min(totalMatching, EXPORT_MAX_ROWS);

    return {
      meta: {
        totalMatching,
        rowCount,
        truncated: totalMatching > EXPORT_MAX_ROWS,
      },
      header: CSV_HEADER,
      rows: this.streamRows(providerId, period, query.asset, rowCount),
    };
  }

  private async *streamRows(
    providerId: string,
    period: Required<PaymentIntentPeriod>,
    asset: string | undefined,
    rowCount: number,
  ): AsyncGenerator<CallExportCsvRow> {
    let after: CallExportCursor | null = null;
    let emitted = 0;

    while (emitted < rowCount) {
      const take = Math.min(EXPORT_BATCH_SIZE, rowCount - emitted);
      const page = await this.intents.findCallsPageForExport(
        providerId,
        period,
        asset,
        after,
        take,
      );
      if (page.length === 0) break;

      for (const row of page) {
        yield toCsvRow(row);
        emitted += 1;
        if (emitted >= rowCount) break;
      }

      const last = page[page.length - 1];
      after = { createdAt: last.createdAt, id: last.id };

      if (page.length < take) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The visible cap. A month of calls for one high-traffic provider is a real
 * number, not an edge case, and 50,000 rows (roughly one call every 50 seconds
 * for 30 days) is chosen to be well above any MVP provider's actual volume
 * while still bounding the worst case — a misconfigured `from`/`to` spanning a
 * year — to a file a spreadsheet tool can still open.
 */
export const EXPORT_MAX_ROWS = 50_000;

/** Rows fetched per round-trip to Postgres while streaming. */
export const EXPORT_BATCH_SIZE = 1_000;

export interface CallExportMeta {
  /** How many calls the window actually matched, before any cap. */
  readonly totalMatching: number;
  /** How many rows this response actually emits — `min(totalMatching, EXPORT_MAX_ROWS)`. */
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface CallExportResult {
  readonly meta: CallExportMeta;
  readonly header: readonly string[];
  readonly rows: AsyncGenerator<CallExportCsvRow>;
}

/** One CSV row, already ordered to match {@link CSV_HEADER}. */
export type CallExportCsvRow = ReadonlyArray<string | number | null>;

export const CSV_HEADER: readonly string[] = Object.freeze([
  'call_id',
  'intent_id',
  'created_at',
  'tool_id',
  'status',
  'classification',
  'reason',
  'verification_verdict',
  'provider_amount',
  'platform_fee',
  'price_amount',
  'asset',
  'decimals',
]);

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toCsvRow(row: CallExportRow): CallExportCsvRow {
  const classification = classifyForReconciliation({
    callClass: row.callClass as 'PAID' | 'FREE' | 'TEST' | 'EXPLORATION',
    status: row.status as
      | 'CREATED'
      | 'FUNDS_SECURED'
      | 'PROVIDER_EXECUTING'
      | 'VERIFYING'
      | 'SETTLED'
      | 'REFUNDED'
      | 'VOIDED'
      | 'EXPIRED',
    classification: row.classification as 'DATA_RESULT' | 'SYSTEM_ERROR' | 'REQUEST_ERROR' | null,
    awaitingRedemption: row.awaitingRedemption,
    debtOutstanding: row.debtOutstanding,
    uncollected:
      row.absorbedReason !== null ||
      (row.redemptionLastError?.startsWith(UNCOLLECTED_PREFIX) ?? false),
    forfeited: row.redemptionLastError?.startsWith(PROVIDER_FORFEIT_PREFIX) ?? false,
    credited: row.credited,
  });
  // Forfeited by the provider: nothing was collected, credited or taken.
  const forfeited = classification === CallReconciliationClass.PROVIDER_FORFEITED;
  // Never collected (a written-off debt, or a legacy absorb): nothing was
  // credited or taken, and nobody owes it — the platform never pays.
  const uncollected = classification === CallReconciliationClass.PAID_UNCOLLECTED;
  // SETTLED but classified PENDING: no credit was written for it.
  const uncredited = row.status === 'SETTLED' && classification === CallReconciliationClass.PENDING;
  const debt = classification === CallReconciliationClass.PAID_BUYER_DEBT;

  return [
    row.callId,
    row.id,
    row.createdAt.toISOString(),
    row.toolId,
    row.status,
    classification,
    forfeited || (uncollected && row.absorbedReason === null)
      ? row.redemptionLastError
      : uncollected
        ? `${UNCOLLECTED_PREFIX}legacy_platform_absorbed:${row.absorbedReason}`
        : debt
          ? `buyer_debt:${row.redemptionLastError ?? 'unknown'}`
          : uncredited
            ? (row.statusReason ?? 'settled, no credit recorded')
            : row.statusReason,
    row.verificationVerdict,
    forfeited || uncollected ? '0' : row.providerAmount,
    forfeited || uncollected ? '0' : row.platformFee,
    row.priceAmount,
    row.asset,
    row.decimals,
  ];
}

/** Re-exported so callers building test fixtures do not import the domain file separately. */
export { CallReconciliationClass };

/** Writes the header line, then every row, CRLF-terminated. */
export async function writeExportCsv(
  result: CallExportResult,
  write: (chunk: string) => void,
): Promise<void> {
  write(csvLine(result.header));
  for await (const row of result.rows) {
    write(csvLine(row));
  }
}
