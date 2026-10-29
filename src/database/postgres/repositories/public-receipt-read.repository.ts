import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  DEBT_VOIDED_PREFIX,
  PROVIDER_FORFEIT_PREFIX,
  UNCOLLECTED_PREFIX,
} from '@modules/payment/constants/voucher-redemption.constants';

/** Why a settled call was not collected, as a fixed label. The cause text never leaves the database. */
export type PublicCollectionCause = 'FORFEITED' | 'WRITTEN_OFF' | 'VOIDED_REFUND' | 'VOIDED_VOID';

/**
 * The only columns the public receipt reads, in the shape it reads them.
 *
 * Every field is a number, a boolean, a timestamp, an id, or a **fixed label
 * computed in SQL**. There is no free-text column here on purpose:
 * `payment_intents.redemption_last_error` / `status_reason` and the stage
 * `detail` strings can quote a call's content, so they are reduced to labels
 * or dropped inside the query and never reach this process.
 */
export interface PublicReceiptRow {
  readonly status: string;
  readonly classification: string | null;
  readonly verificationVerdict: string | null;
  readonly asset: string;
  readonly decimals: number;
  readonly priceAmount: string;
  readonly toolId: string;
  readonly providerId: string | null;
  readonly hasHold: boolean;
  readonly holdReleased: boolean;
  readonly lapsed: boolean;
  readonly collectionCause: PublicCollectionCause | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
  /** The published sampling sentence, validated again by the mapper. */
  readonly sampleDisplay: string | null;
  /** `[{ stage, status }]` only: `detail`, `code`, `score` are dropped in SQL. */
  readonly stages: ReadonlyArray<{ stage: unknown; status: unknown }>;
}

export const PUBLIC_RECEIPT_SQL = `
SELECT
  i.status                                   AS "status",
  i.classification                           AS "classification",
  i.verification_verdict                     AS "verificationVerdict",
  i.asset_id                                 AS "asset",
  i.decimals                                 AS "decimals",
  i.price_amount::text                       AS "priceAmount",
  i.tool_id                                  AS "toolId",
  i.provider_id                              AS "providerId",
  (i.hold_id IS NOT NULL)                    AS "hasHold",
  (i.hold_released_at IS NOT NULL)           AS "holdReleased",
  (i.redemption_lapsed_at IS NOT NULL)       AS "lapsed",
  CASE
    WHEN starts_with(i.redemption_last_error, $2) THEN 'FORFEITED'
    WHEN starts_with(i.redemption_last_error, $3) THEN 'WRITTEN_OFF'
    WHEN i.redemption_last_error = $5 THEN 'VOIDED_REFUND'
    WHEN starts_with(i.redemption_last_error, $4) THEN 'VOIDED_VOID'
  END                                        AS "collectionCause",
  i.created_at                               AS "createdAt",
  r.settled_at                               AS "settledAt",
  r.sample_display                           AS "sampleDisplay",
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('stage', s.e ->> 'stage', 'status', s.e ->> 'status'))
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.stages) = 'array' THEN r.stages ELSE '[]'::jsonb END
    ) AS s(e)
  ), '[]'::jsonb)                            AS "stages"
FROM payment_intents i
JOIN organizations o ON o.id = i.organization_id
LEFT JOIN verification_records r
  ON r.intent_id = i.id AND r.organization_id = i.organization_id
WHERE i.id = $1
  AND i.call_class = 'PAID'
  AND o.receipts_public = true
LIMIT 1`;

/**
 * Cross-tenant read behind `GET /public/explorer/calls/:id`.
 *
 * Deliberately a single fixed SQL statement, not a repository over the entities:
 * it never loads a `PaymentIntentEntity` or `VerificationRecordEntity`, so a column
 * added to either table later is not read here, and `verification_records.request`
 * and `.response` (the call's own data) are never in this process. A call whose
 * organization turned the switch off is simply not found.
 */
@Injectable()
export class PublicReceiptReadRepository {
  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  async findPublicReceiptRow(intentId: string): Promise<PublicReceiptRow | null> {
    const rows: PublicReceiptRow[] = await this.dataSource.query(PUBLIC_RECEIPT_SQL, [
      intentId,
      // Bare prefixes for starts_with(): no LIKE, so a `%` or `_` in a prefix is never a wildcard.
      PROVIDER_FORFEIT_PREFIX,
      UNCOLLECTED_PREFIX,
      DEBT_VOIDED_PREFIX,
      `${DEBT_VOIDED_PREFIX}REFUND`,
    ]);
    return rows[0] ?? null;
  }
}
