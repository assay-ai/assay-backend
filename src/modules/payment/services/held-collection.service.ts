import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  PaymentIntentRepository,
  RedemptionExclusions,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockedRole, BlockSubjectKind, subjectKey } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { CHAIN_STATE_GATE, ChainStateGatePort } from '@modules/chains/ports/chain-state-gate.port';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
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
/** Past-timeout collects per asset per pass: one transaction each. */
const MAX_TIMEOUT_SINGLES_PER_PASS = 8;
/** `refundHeldBatch` transactions per asset per pass for blocked providers. */
const MAX_REFUND_BATCHES_PER_ASSET = 4;

/**
 * How long before the chain's timeout a record is already treated as past it:
 * sent singly, never in a batch. A batch sent just before the timeout and
 * mined after it races a stranger's `collectHeld` the same way, so the rule
 * starts this much early.
 */
export const TIMEOUT_RACE_MARGIN_SECONDS = 15 * 60;
/** A blocked provider's held payment still unrefunded this close to the timeout is paged. */
export const BLOCKED_REFUND_WARN_SECONDS = 24 * 3600;

export const HELD_PAST_TIMEOUT_ALERT = 'held_payment_past_timeout';
export const BLOCKED_HELD_UNREFUNDED_ALERT = 'held_payment_blocked_provider_unrefunded';

type HeldMove = 'collect' | 'refund';

/** The provider-side blocks of one pass: the platform blocklist and the chains' own. */
interface ProviderBlocks {
  /** For the queries: organizations, wallet keys and on-chain accounts of every held chain. */
  readonly exclude: RedemptionExclusions;
  /** CAIP-10 accounts the on-chain blocklists refuse, lower-case. */
  readonly chainAccounts: ReadonlySet<string>;
}

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
 *
 * ## Past the timeout: one by one
 *
 * From `collectableAt + HELD_TIMEOUT_SECONDS` anyone may collect a record, so
 * a stranger can collect one of a batch first and revert the whole atomic
 * batch. Such records (from {@link TIMEOUT_RACE_MARGIN_SECONDS} before) are
 * sent singly, never batched; a single collect that fails is answered by
 * reading `held()` — a record already `COLLECTED` or `REFUNDED` is booked, not
 * retried.
 *
 * ## A blocked provider: refunded at once, never collected
 *
 * When the platform blocks a provider — an operator's account block (`A-9`) on
 * its organization or its payout wallet, or the payout address on the chain's
 * own blocklist — every payment of it still held is refunded to the buyer on
 * the next pass (`refundHeldBatch`, chunked; the provider forfeits, as at
 * redemption), and none is ever collected for it. One still unrefunded within
 * {@link BLOCKED_REFUND_WARN_SECONDS} of the timeout is paged: after it the
 * refund is closed for good.
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
    if (!this.held) return booked;

    const blocks = await this.providerBlocks(exclusions);
    // Refunds first: a blocked provider's payments leave the hold before
    // anything else is sent on the shared key.
    try {
      await this.refundBlocked(blocks);
    } catch (error) {
      this.logger.error(`Refunding blocked providers' held payments threw: ${describe(error)}`);
    }

    // Past (or about to pass) the timeout: `passTimeout`, one by one.
    booked += await this.collectRailB(
      (
        await this.payments.findCollectable(
          PaymentRail.RAIL_B_VOUCHER,
          MAX_HELD_BATCH * 4,
          exclusions,
        )
      ).filter((row) => !nearTimeout(row.collectableAt)),
      blocks,
    );
    booked += await this.passTimeout(blocks);

    try {
      await this.pageBlockedNearTimeout(blocks);
    } catch (error) {
      this.logger.error(`Paging blocked providers' held payments threw: ${describe(error)}`);
    }
    return booked;
  }

  /**
   * Past the chain's timeout: an undisputed (or rejected) payment is collected
   * for the provider, singly; a disputed one, or a blocked provider's, is only
   * synced — booked if someone collected (or the refund landed) — and paged
   * while still held.
   */
  private async passTimeout(blocks: ProviderBlocks): Promise<number> {
    const rows = (
      await this.payments.findHeldPastTimeout(
        HELD_TIMEOUT_SECONDS - TIMEOUT_RACE_MARGIN_SECONDS,
        MAX_HELD_BATCH,
      )
    ).filter((row) => row.rail === PaymentRail.RAIL_B_VOUCHER);
    const disputed = (row: PaymentIntentEntity) =>
      row.disputeOutcome === 'OPEN' || row.disputeOutcome === 'UPHELD';
    let booked = 0;
    const toCollect: PaymentIntentEntity[] = [];
    for (const row of rows) {
      try {
        if (this.providerBlockCause(row, blocks)) {
          // Never collected for a blocked provider. Before the timeout the
          // refund pass has it; after it, only what the chain did is booked.
          if (pastTimeout(row.collectableAt)) booked += await this.syncBlocked(row, blocks);
        } else if (disputed(row)) {
          if (pastTimeout(row.collectableAt)) booked += await this.sync(row, blocks);
        } else {
          toCollect.push(row);
        }
      } catch (error) {
        await this.backOff(row, error);
      }
    }
    return booked + (await this.collectRailB(toCollect, blocks));
  }

  /** Books what the chain did to a disputed held payment; pages while it is still held. */
  private async sync(row: PaymentIntentEntity, blocks: ProviderBlocks): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const record = await held.readHeld(row.assetId as AssetId, this.keyOf(row));
    if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
      return this.book(row, record.status, null, blocks);
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

  /** Books what the chain did to a blocked provider's payment past the timeout (paged elsewhere). */
  private async syncBlocked(row: PaymentIntentEntity, blocks: ProviderBlocks): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const record = await held.readHeld(row.assetId as AssetId, this.keyOf(row));
    if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
      return this.book(row, record.status, null, blocks);
    }
    return 0;
  }

  private async collectRailB(
    rows: readonly PaymentIntentEntity[],
    blocks: ProviderBlocks,
  ): Promise<number> {
    if (!this.held || rows.length === 0) return 0;
    let booked = 0;
    for (const [asset, group] of byAsset(rows)) {
      const eligible = group.filter(
        (row) =>
          !blocks.chainAccounts.has(row.agentAccount.toLowerCase()) &&
          // Never collected for a blocked provider: the refund pass has it.
          this.providerBlockCause(row, blocks) === null,
      );
      // One batch per asset per pass: the redeemer key is shared.
      booked += await this.moveChunk(
        'collect',
        asset as AssetId,
        eligible.slice(0, MAX_HELD_BATCH),
        blocks,
      );
    }
    return booked;
  }

  /**
   * Refunds every payment still held of a blocked provider, while
   * `refundHeld` is open: up to {@link MAX_REFUND_BATCHES_PER_ASSET} batches
   * of {@link MAX_HELD_BATCH} per asset per pass. Idempotent: only what the
   * chain still holds is sent, and the booking reads the chain back.
   */
  private async refundBlocked(blocks: ProviderBlocks): Promise<void> {
    const rows = await this.payments.findHeldOfBlockedProviders(
      PaymentRail.RAIL_B_VOUCHER,
      blocks.exclude,
      HELD_TIMEOUT_SECONDS,
      MAX_HELD_BATCH * MAX_REFUND_BATCHES_PER_ASSET,
    );
    for (const [asset, group] of byAsset(rows)) {
      for (let at = 0; at < group.length; at += MAX_HELD_BATCH) {
        await this.moveChunk(
          'refund',
          asset as AssetId,
          group.slice(at, at + MAX_HELD_BATCH),
          blocks,
        );
      }
    }
  }

  /**
   * Collects or refunds one chunk of one asset. Only what the chain still
   * holds goes into a transaction: a record already collected or refunded (a
   * booking that did not land) is booked. A record at or near the timeout is
   * sent singly ({@link TIMEOUT_RACE_MARGIN_SECONDS}); the rest go in one
   * batch, and singly — a few, each with its own back-off — if it is refused.
   * Returns how many were booked as collected.
   */
  private async moveChunk(
    move: HeldMove,
    asset: AssetId,
    rows: readonly PaymentIntentEntity[],
    blocks: ProviderBlocks,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    let booked = 0;

    const batchable: PaymentIntentEntity[] = [];
    const late: PaymentIntentEntity[] = [];
    for (const row of rows) {
      try {
        const record = await held.readHeld(asset, this.keyOf(row));
        if (record?.status === HeldStatus.HELD) {
          // Past the timeout `refundHeld` is closed: nothing to send (paged).
          if (move === 'refund' && pastTimeout(record.collectableAt)) continue;
          const isLate = nearTimeout(record.collectableAt) || nearTimeout(row.collectableAt);
          (isLate ? late : batchable).push(row);
        } else if (record === null || record.status === HeldStatus.NONE) {
          // No record where one must be (a lagging node, a wrong deployment):
          // back off rather than read it again every minute.
          await this.backOff(row, new Error(`held() read ${record?.status ?? 'nothing'}`));
        } else booked += await this.book(row, record.status, null, blocks);
      } catch (error) {
        await this.backOff(row, error);
      }
    }

    let singles = late.slice(0, MAX_TIMEOUT_SINGLES_PER_PASS);
    if (batchable.length > 0) {
      try {
        const { txRef } = await this.send(
          move,
          asset,
          batchable.map((row) => this.keyOf(row)),
        );
        for (const row of batchable) booked += await this.book(row, done(move), txRef, blocks);
      } catch (error) {
        // Refused in simulation, or failed: singly, a few per pass, each with
        // its own back-off, so one paused or blocked party cannot stop the rest.
        this.logger.warn(
          `${move}HeldBatch of ${batchable.length} on ${asset} failed (${describe(error)}); ` +
            `sending up to ${MAX_SINGLES_PER_PASS} singly`,
        );
        singles = [...batchable.slice(0, MAX_SINGLES_PER_PASS), ...singles];
      }
    }
    for (const row of singles) booked += await this.sendOne(move, asset, row, blocks);
    return booked;
  }

  /**
   * One record, one transaction. A failure is answered by reading `held()`:
   * a stranger may have collected it first (anyone may, past the timeout), or
   * an earlier send landed — a record no longer `HELD` is booked, not retried.
   */
  private async sendOne(
    move: HeldMove,
    asset: AssetId,
    row: PaymentIntentEntity,
    blocks: ProviderBlocks,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    try {
      const { txRef } = await this.send(move, asset, [this.keyOf(row)]);
      return await this.book(row, done(move), txRef, blocks);
    } catch (error) {
      try {
        const record = await held.readHeld(asset, this.keyOf(row));
        if (record?.status === HeldStatus.COLLECTED || record?.status === HeldStatus.REFUNDED) {
          return await this.book(row, record.status, null, blocks);
        }
      } catch {
        // Unreadable: backed off below, read again on the next try.
      }
      await this.backOff(row, error);
      return 0;
    }
  }

  private send(move: HeldMove, asset: AssetId, keys: readonly HeldKey[]) {
    const held = this.held as HeldPaymentsPort;
    return move === 'collect' ? held.collect(asset, keys) : held.refund(asset, keys);
  }

  /**
   * Books a chain status for a row; with a transaction, the status is read
   * back first. Returns 1 when it was a collect.
   */
  private async book(
    row: PaymentIntentEntity,
    status: HeldStatus | null,
    txRef: string | null,
    blocks: ProviderBlocks,
  ): Promise<number> {
    const held = this.held as HeldPaymentsPort;
    const confirmed = txRef
      ? (await held.readHeld(row.assetId as AssetId, this.keyOf(row)))?.status
      : status;
    if (confirmed === HeldStatus.COLLECTED) {
      await this.intents.bookHeldCollected(row.organizationId, row.id, txRef);
      return 1;
    }
    if (confirmed !== HeldStatus.REFUNDED) return 0;
    const cause = this.providerBlockCause(row, blocks);
    if (row.disputeOutcome === 'UPHELD') {
      await this.intents.refundHeldForDispute(row.organizationId, row.id, 'DISPUTE_UPHELD');
    } else if (cause) {
      await this.intents.bookBlockedProviderRefund(row.organizationId, row.id, cause, txRef);
    } else {
      this.logger.error(
        `Intent ${row.id}: the escrow refunded its held payment but neither an upheld ` +
          `dispute nor a blocked provider explains it; not booked — investigate`,
      );
    }
    return 0;
  }

  /** Pages every blocked provider's payment still held within a day of the timeout. */
  private async pageBlockedNearTimeout(blocks: ProviderBlocks): Promise<void> {
    const rows = await this.payments.findBlockedHeldNearTimeout(
      PaymentRail.RAIL_B_VOUCHER,
      blocks.exclude,
      HELD_TIMEOUT_SECONDS,
      BLOCKED_REFUND_WARN_SECONDS,
      MAX_HELD_BATCH,
    );
    for (const row of rows) {
      const timeoutAt = new Date(
        (row.collectableAt as Date).getTime() + HELD_TIMEOUT_SECONDS * 1000,
      );
      const past = Date.now() >= timeoutAt.getTime();
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: BLOCKED_HELD_UNREFUNDED_ALERT,
        summary:
          `Intent ${row.id}: a blocked provider's held payment is not refunded and the ` +
          `chain's timeout ${past ? 'has passed' : 'is less than 24 h away'} ` +
          `(${timeoutAt.toISOString()}) — after it refundHeld is closed and anyone may ` +
          `collect it for the provider`,
        details: {
          intentId: row.id,
          providerId: row.providerId ?? 'none',
          cause: this.providerBlockCause(row, blocks) ?? 'unknown',
          lastError: row.heldLastError ?? 'none',
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: row.id,
      });
    }
  }

  private async backOff(row: PaymentIntentEntity, error: unknown): Promise<void> {
    this.logger.warn(`Held payment ${row.id}: ${describe(error)}; backing off`);
    await this.payments.recordHeldFailure(row.organizationId, row.id, describe(error));
  }

  private keyOf(row: PaymentIntentEntity): HeldKey {
    return { payer: row.agentAccount as AccountId, seq: row.voucherSeq as string };
  }

  /**
   * Why the row's provider is blocked, in the redemption job's names
   * (`VoucherRedemptionService.providerBlockCause`), or `null`: its
   * organization or payout wallet on the platform blocklist, or the payout
   * address on its chain's.
   */
  private providerBlockCause(row: PaymentIntentEntity, blocks: ProviderBlocks): string | null {
    const blocked = this.blocklist.firstBlocked([
      { role: BlockedRole.PROVIDER, kind: BlockSubjectKind.ORGANIZATION, subject: row.providerId },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: row.providerAccount },
    ]);
    if (blocked) return blocked.role === BlockedRole.PROVIDER ? 'ProviderBlocked' : 'PayeeBlocked';
    if (row.providerAccount && blocks.chainAccounts.has(row.providerAccount.toLowerCase())) {
      return 'PayeeBlockedOnChain';
    }
    return null;
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

  /** The off-chain blocklist plus the on-chain blocklist of every chain something is held on. */
  private async providerBlocks(exclusions: RedemptionExclusions): Promise<ProviderBlocks> {
    const chainAccounts = new Set<string>();
    if (this.chainState?.blockedAccounts) {
      const chains = new Set(
        (await this.payments.findHeldAssetIds(PaymentRail.RAIL_B_VOUCHER)).map((asset) =>
          chainIdOf(asset as AssetId),
        ),
      );
      for (const chain of chains) {
        for (const account of await this.chainBlocked(chain)) chainAccounts.add(account);
      }
    }
    return { exclude: { ...exclusions, chainAccounts: [...chainAccounts] }, chainAccounts };
  }

  /** The on-chain blocklist of a chain, lower-case; empty when unknown. */
  private async chainBlocked(chainId: ChainId): Promise<readonly string[]> {
    if (!this.chainState?.blockedAccounts) return [];
    try {
      const accounts = await this.chainState.blockedAccounts(chainId);
      return accounts.map((account) => account.toLowerCase());
    } catch {
      return [];
    }
  }
}

/** The chain status a landed move leaves. */
function done(move: HeldMove): HeldStatus {
  return move === 'collect' ? HeldStatus.COLLECTED : HeldStatus.REFUNDED;
}

/** Whether the chain's timeout has passed for a record collectable at `at`. */
function pastTimeout(at: Date | null): boolean {
  return at !== null && Date.now() >= at.getTime() + HELD_TIMEOUT_SECONDS * 1000;
}

/** {@link pastTimeout}, {@link TIMEOUT_RACE_MARGIN_SECONDS} early: sent singly from then. */
function nearTimeout(at: Date | null): boolean {
  return (
    at !== null &&
    Date.now() >= at.getTime() + (HELD_TIMEOUT_SECONDS - TIMEOUT_RACE_MARGIN_SECONDS) * 1000
  );
}

function byAsset(rows: readonly PaymentIntentEntity[]): Map<string, PaymentIntentEntity[]> {
  const groups = new Map<string, PaymentIntentEntity[]>();
  for (const row of rows) groups.set(row.assetId, [...(groups.get(row.assetId) ?? []), row]);
  return groups;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
