import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CallAttribution } from '@modules/toolset/domain/attribution';

/**
 * Stamps which MCP URL a paid call came through onto its payment intent
 * (design spec §7.8).
 *
 * A separate write after the intent exists, rather than another field on
 * `PaymentIntentService.create` and `VoucherService.redeem`: the payment
 * module stays unaware of URLs, and attribution is bookkeeping that must
 * never refuse or delay a call — a failed stamp is logged, not thrown.
 *
 * Plain SQL against the five columns rather than fields on
 * `PaymentIntentEntity`, for the same reason: the payment record's entity is
 * the payment module's, and every read of it would otherwise select columns
 * only Servers in use reads (`ConnectUrlsService`, also plain SQL).
 */
@Injectable()
export class CallAttributionWriter {
  private readonly logger = new Logger(CallAttributionWriter.name);

  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  async stampIntent(
    organizationId: string,
    intentId: string,
    attribution: CallAttribution | null,
  ): Promise<void> {
    if (!attribution) return;
    try {
      await this.dataSource.query(
        `UPDATE "payment_intents"
            SET "endpoint_kind" = $3, "toolset_id" = $4, "toolset_version" = $5,
                "endpoint_handle" = $6, "view_filter" = $7
          WHERE "organization_id" = $1 AND "id" = $2`,
        [
          organizationId,
          intentId,
          attribution.endpointKind,
          attribution.toolsetId,
          attribution.toolsetVersion,
          attribution.endpointHandle,
          attribution.viewFilter === null ? null : JSON.stringify(attribution.viewFilter),
        ],
      );
    } catch (error) {
      this.logger.warn(
        `intent ${intentId}: attribution not recorded. ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
