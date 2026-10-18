import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';

import {
  HELD_PAYMENTS,
  HELD_TIMEOUT_SECONDS,
  HeldKey,
  HeldPaymentsPort,
  HeldStatus,
  MAX_HELD_BATCH,
} from '../ports/held-payments.port';
import { PaymentRail } from '../ports/payment.types';
import { PaymentIntentService } from './payment-intent.service';

/** Rail-A held credits booked per pass. */
const RAIL_A_BATCH = 500;

/**
 * Collects held payments once their dispute window has passed (G3.B1, "redeem
 * into hold"): rail B with `collectHeldBatch` (the REDEEMER, up to 64 a
 * transaction, in seq order per payer), rail A by crediting the provider in
 * the ledger. Never one an open or upheld dispute holds. A rejected dispute's
 * payment is collected at once ({@link collectIntent}).
 *
 * The provider is credited only once the chain says `COLLECTED`
 * (`PaymentIntentService.bookHeldCollected`), and every booking is idempotent,
 * so a pass that dies half-way repeats harmlessly. A record found `REFUNDED`
 * (a refund whose booking did not land) is booked as the refund it was.
 */
@Injectable()
export class HeldCollectionService {
  private readonly logger = new Logger(HeldCollectionService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    @Optional() @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort | null = null,
  ) {}

  /** One pass. Returns how many payments were booked as collected. */
  async run(): Promise<number> {
    let booked = 0;
    for (const row of await this.payments.findCollectable(
      PaymentRail.RAIL_A_PER_CALL,
      RAIL_A_BATCH,
    )) {
      await this.intents.bookHeldCollected(row.organizationId, row.id, null);
      booked += 1;
    }
    booked += await this.collectRailB(
      await this.payments.findCollectable(PaymentRail.RAIL_B_VOUCHER, MAX_HELD_BATCH),
    );
    // Past the chain's timeout anyone may collect, whatever the dispute: book
    // what the chain did, and collect what is still held (the provider's due).
    booked += await this.collectRailB(
      (await this.payments.findHeldPastTimeout(HELD_TIMEOUT_SECONDS, MAX_HELD_BATCH)).filter(
        (row) => row.rail === PaymentRail.RAIL_B_VOUCHER,
      ),
    );
    return booked;
  }

  /**
   * Collects one call now, if it is past its window (a rejected dispute). A
   * call still inside its window waits for the job. `force` collects it even
   * though a dispute holds it — only past the chain's timeout, when a refund is
   * no longer possible.
   */
  async collectIntent(organizationId: string, intentId: string): Promise<boolean> {
    const row = await this.payments.findOneBy({ organizationId, id: intentId });
    if (!row || row.heldStatus !== 'HELD' || !row.collectableAt) return false;
    if (row.collectableAt.getTime() > Date.now()) return false;
    if (row.rail === PaymentRail.RAIL_A_PER_CALL) {
      await this.intents.bookHeldCollected(organizationId, intentId, null);
      return true;
    }
    return (await this.collectRailB([row])) > 0;
  }

  private async collectRailB(rows: readonly PaymentIntentEntity[]): Promise<number> {
    if (!this.held || rows.length === 0) return 0;
    let booked = 0;
    const byAsset = new Map<string, PaymentIntentEntity[]>();
    for (const row of rows) {
      byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row]);
    }
    for (const [asset, group] of byAsset) {
      for (let i = 0; i < group.length; i += MAX_HELD_BATCH) {
        booked += await this.collectChunk(asset as AssetId, group.slice(i, i + MAX_HELD_BATCH));
      }
    }
    return booked;
  }

  private async collectChunk(
    asset: AssetId,
    rows: readonly PaymentIntentEntity[],
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const keyOf = (row: PaymentIntentEntity): HeldKey => ({
      payer: row.agentAccount as AccountId,
      seq: row.voucherSeq as string,
    });

    // Only what the chain still holds goes into the transaction: a record
    // already collected or refunded (a booking that did not land) is booked.
    const records = await Promise.all(rows.map((row) => held.readHeld(asset, keyOf(row))));
    const toSend = rows.filter((_, index) => records[index]?.status === HeldStatus.HELD);

    let txRef: string | null = null;
    if (toSend.length > 0) {
      try {
        txRef = (await held.collect(asset, toSend.map(keyOf))).txRef;
      } catch (error) {
        // One paused or blocked party reverts the whole batch: collect singly.
        this.logger.warn(
          `collectHeldBatch of ${toSend.length} on ${asset} failed (${describe(error)}); ` +
            `collecting singly`,
        );
        for (const row of toSend) {
          try {
            await held.collect(asset, [keyOf(row)]);
          } catch (single) {
            this.logger.warn(`collectHeld ${row.id} failed: ${describe(single)}`);
          }
        }
      }
    }

    let booked = 0;
    for (const row of rows) {
      const record = await held.readHeld(asset, keyOf(row));
      if (record?.status === HeldStatus.COLLECTED) {
        await this.intents.bookHeldCollected(row.organizationId, row.id, txRef);
        booked += 1;
      } else if (record?.status === HeldStatus.REFUNDED && row.disputeOutcome === 'UPHELD') {
        await this.intents.refundHeldForDispute(row.organizationId, row.id, 'DISPUTE_UPHELD');
      } else if (record?.status === HeldStatus.REFUNDED) {
        this.logger.error(
          `Intent ${row.id}: the escrow refunded its held payment but no upheld dispute ` +
            `explains it; not booked — investigate`,
        );
      }
    }
    return booked;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
