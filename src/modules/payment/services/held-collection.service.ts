import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  PaymentIntentRepository,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { CHAIN_STATE_GATE, ChainStateGatePort } from '@modules/chains/ports/chain-state-gate.port';
import { AccountId, AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

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
/** Single sends allowed per pass when a batch is refused (the shared redeemer queue). */
const MAX_SINGLES_PER_PASS = 8;

export const HELD_PAST_TIMEOUT_ALERT = 'held_payment_past_timeout';

/**
 * Collects held payments once their dispute window has passed (G3.B1, "redeem
 * into hold"): rail B with `collectHeldBatch` — the REDEEMER, so only in the
 * scheduler — rail A by crediting the provider in the ledger. Never one an
 * open or upheld dispute holds, and never one with a blocked party.
 *
 * The redeemer key is shared with the redemption job (which runs at second 0;
 * this one at second 30): one batch per asset per pass, at most
 * {@link MAX_SINGLES_PER_PASS} single sends when a batch is refused, every send
 * simulated first and given up rather than queued long (`boundQueueWait`).
 * A row that fails backs off (1, 2, 4 … minutes, at most an hour), so a stuck
 * row neither blocks the pass nor burns gas every minute.
 *
 * The provider is credited only once the chain says `COLLECTED`
 * (`PaymentIntentService.bookHeldCollected`), and every booking is idempotent.
 * Past the chain's timeout a disputed payment is never collected here (an
 * upheld refund may still be pending): its record is only read, booked once
 * someone collects it, and paged.
 */
@Injectable()
export class HeldCollectionService {
  private readonly logger = new Logger(HeldCollectionService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    private readonly blocklist: AccountBlocklistService,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    @Optional() @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort | null = null,
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
  ) {}

  /** One pass. Returns how many payments were booked as collected. */
  async run(): Promise<number> {
    let booked = 0;
    const exclusions = this.exclusions();

    // Rail A: the ledger only. One bad row must not stop the rest, or rail B.
    for (const row of await this.payments.findCollectable(
      PaymentRail.RAIL_A_PER_CALL,
      RAIL_A_BATCH,
      exclusions,
    )) {
      try {
        await this.intents.bookHeldCollected(row.organizationId, row.id, null);
        booked += 1;
      } catch (error) {
        await this.backOff(row, error);
      }
    }

    booked += await this.collectRailB(
      await this.payments.findCollectable(
        PaymentRail.RAIL_B_VOUCHER,
        MAX_HELD_BATCH * 4,
        exclusions,
      ),
    );
    booked += await this.passTimeout();
    return booked;
  }

  /**
   * Past the chain's timeout: an undisputed (or rejected) payment is collected
   * for the provider; a disputed one is only synced — booked if someone
   * collected (or the refund landed) — and paged while still held.
   */
  private async passTimeout(): Promise<number> {
    const rows = (
      await this.payments.findHeldPastTimeout(HELD_TIMEOUT_SECONDS, MAX_HELD_BATCH)
    ).filter((row) => row.rail === PaymentRail.RAIL_B_VOUCHER);
    const disputed = (row: PaymentIntentEntity) =>
      row.disputeOutcome === 'OPEN' || row.disputeOutcome === 'UPHELD';
    let booked = await this.collectRailB(rows.filter((row) => !disputed(row)));
    for (const row of rows.filter(disputed)) {
      try {
        booked += await this.sync(row);
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    return booked;
  }

  /** Books what the chain did to a disputed held payment; pages while it is still held. */
  private async sync(row: PaymentIntentEntity): Promise<number> {
    const held = this.held;
    if (!held) return 0;
    const record = await held.readHeld(row.assetId as AssetId, this.keyOf(row));
    if (record?.status === HeldStatus.COLLECTED) {
      await this.intents.bookHeldCollected(row.organizationId, row.id, null);
      return 1;
    }
    if (record?.status === HeldStatus.REFUNDED && row.disputeOutcome === 'UPHELD') {
      await this.intents.refundHeldForDispute(row.organizationId, row.id, 'DISPUTE_UPHELD');
      return 0;
    }
    await this.alerts.emit({
      severity: AlertSeverity.CRITICAL,
      name: HELD_PAST_TIMEOUT_ALERT,
      summary:
        `Intent ${row.id}: a disputed held payment is past the chain's 7-day timeout — ` +
        `refundHeld is closed and anyone may collect it for the provider`,
      details: { intentId: row.id, disputeOutcome: row.disputeOutcome ?? 'none' },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: row.id,
    });
    return 0;
  }

  private async collectRailB(rows: readonly PaymentIntentEntity[]): Promise<number> {
    if (!this.held || rows.length === 0) return 0;
    let booked = 0;
    const byAsset = new Map<string, PaymentIntentEntity[]>();
    for (const row of rows) {
      byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row]);
    }
    for (const [asset, group] of byAsset) {
      const blocked = await this.chainBlocked(asset as AssetId);
      const eligible = group.filter(
        (row) =>
          !blocked.has(row.agentAccount.toLowerCase()) &&
          !blocked.has((row.providerAccount ?? '').toLowerCase()),
      );
      // One batch per asset per pass: the redeemer key is shared.
      booked += await this.collectChunk(asset as AssetId, eligible.slice(0, MAX_HELD_BATCH));
    }
    return booked;
  }

  private async collectChunk(
    asset: AssetId,
    rows: readonly PaymentIntentEntity[],
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    let booked = 0;

    // Only what the chain still holds goes into the transaction: a record
    // already collected or refunded (a booking that did not land) is booked.
    const toSend: PaymentIntentEntity[] = [];
    for (const row of rows) {
      try {
        const record = await held.readHeld(asset, this.keyOf(row));
        if (record?.status === HeldStatus.HELD) toSend.push(row);
        else booked += await this.book(row, record?.status ?? null, null);
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    if (toSend.length === 0) return booked;

    try {
      const { txRef } = await held.collect(
        asset,
        toSend.map((row) => this.keyOf(row)),
      );
      for (const row of toSend) booked += await this.book(row, HeldStatus.COLLECTED, txRef);
      return booked;
    } catch (error) {
      // Refused in simulation, or failed: singly, a few per pass, each with
      // its own back-off, so one paused or blocked party cannot stop the rest.
      this.logger.warn(
        `collectHeldBatch of ${toSend.length} on ${asset} failed (${describe(error)}); ` +
          `collecting up to ${MAX_SINGLES_PER_PASS} singly`,
      );
    }
    for (const row of toSend.slice(0, MAX_SINGLES_PER_PASS)) {
      try {
        const { txRef } = await held.collect(asset, [this.keyOf(row)]);
        booked += await this.book(row, HeldStatus.COLLECTED, txRef);
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    return booked;
  }

  /** Books a chain status read back for a row. Returns 1 when it was a collect. */
  private async book(
    row: PaymentIntentEntity,
    status: HeldStatus | null,
    txRef: string | null,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const confirmed =
      status === HeldStatus.COLLECTED && txRef
        ? (await held.readHeld(row.assetId as AssetId, this.keyOf(row)))?.status
        : status;
    if (confirmed === HeldStatus.COLLECTED) {
      await this.intents.bookHeldCollected(row.organizationId, row.id, txRef);
      return 1;
    }
    if (confirmed === HeldStatus.REFUNDED && row.disputeOutcome === 'UPHELD') {
      await this.intents.refundHeldForDispute(row.organizationId, row.id, 'DISPUTE_UPHELD');
    } else if (confirmed === HeldStatus.REFUNDED) {
      this.logger.error(
        `Intent ${row.id}: the escrow refunded its held payment but no upheld dispute ` +
          `explains it; not booked — investigate`,
      );
    }
    return 0;
  }

  private async backOff(row: PaymentIntentEntity, error: unknown): Promise<void> {
    this.logger.warn(`Held payment ${row.id}: ${describe(error)}; backing off`);
    await this.payments.recordHeldFailure(row.organizationId, row.id, describe(error));
  }

  private keyOf(row: PaymentIntentEntity): HeldKey {
    return { payer: row.agentAccount as AccountId, seq: row.voucherSeq as string };
  }

  /** The off-chain blocklist, as the redemption job reads it. */
  private exclusions(): RedemptionExclusions {
    const organizationIds: string[] = [];
    const walletKeys: string[] = [];
    for (const hit of this.blocklist.list()) {
      const key = subjectKey(hit.subjectKind, hit.subject);
      if (!key) continue;
      (hit.subjectKind === BlockSubjectKind.ORGANIZATION ? organizationIds : walletKeys).push(key);
    }
    return { organizationIds, walletKeys, chainAccounts: [] };
  }

  /** The on-chain blocklist of the asset's chain, lower-case; empty when unknown. */
  private async chainBlocked(asset: AssetId): Promise<ReadonlySet<string>> {
    if (!this.chainState?.blockedAccounts) return new Set();
    try {
      const accounts = await this.chainState.blockedAccounts(chainIdOf(asset));
      return new Set(accounts.map((account) => account.toLowerCase()));
    } catch {
      return new Set();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
