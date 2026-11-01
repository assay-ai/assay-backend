import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { CHANNEL_FEE_DUST_PER_ROW_ATOMIC } from '@modules/payment/constants/channel.constants';
import { CHANNEL_DOOR, ChannelDoorPort } from '@modules/payment/ports/channel-door.port';

import {
  ReconciliationFinding,
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '../ports/reconciliation.types';

/** What the escrow's channel door holds, as one reconciliation pass reads it. */
export interface ChannelBooksReading {
  /** `channelBooks.held`: Σ every channel bucket. `0` when the escrow has no door. */
  readonly held: bigint;
  /** `channelBooks.totalUnpaid`: payouts set aside after a failed transfer. */
  readonly totalUnpaid: bigint;
  /** Whether the door answered (`false` before the upgrade, or on a read failure). */
  readonly readable: boolean;
  readonly findings: readonly ReconciliationFinding[];
}

const NOTHING: ChannelBooksReading = Object.freeze({
  held: 0n,
  totalUnpaid: 0n,
  readable: false,
  findings: [],
});

/**
 * The channel half of the 5-minute reconciler (SPEC-W2 §1.2, v3 §5.7).
 *
 * The escrow's balance now backs four things, not two:
 * `balanceOf ≥ totalEscrowed + totalHeld + channelBooks.held + totalUnpaid`.
 * `ReconciliationService` takes `held` and `totalUnpaid` off what it calls
 * "outside every buyer escrow", and adds `totalUnpaid` to what the vault must
 * hold (money the ledger booked as paid out that the chain set aside). The
 * per-account walk already subtracts channel buckets
 * (`sumHeldOnChainByAccounts` counts both doors).
 *
 * The identities checked here, each a finding:
 * - `channelBooks.held == Σ HELD channel rows` (WARN while a landing is booked);
 * - per channel: on-chain `settled == settled_cumulative` (none in flight);
 *   `settled > last_accepted` or `settled < settled_cumulative` is CRITICAL
 *   and the channel stops admitting (DESYNC);
 * - per channel: Σ buckets == Σ HELD rows;
 * - `totalUnpaid == Σ unpaid` of every address the platform pays;
 * - per settlement: `charge == collected + refunded + held` (per-row fee
 *   dust tolerated on the split, never on the amounts).
 *
 * Never throws: a read that fails is a WARN finding and the run goes on.
 */
@Injectable()
export class ChannelReconciliationService {
  private readonly logger = new Logger(ChannelReconciliationService.name);

  constructor(
    @Optional() @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort | null = null,
    @Optional() private readonly channels: VoucherChannelRepository | null = null,
    @Optional() private readonly intents: PaymentIntentRepository | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /**
   * The last block the foreign-transaction scan covered, per asset: kept in
   * `channel_scan_cursors` so a restart resumes where it stopped (review
   * 2026-10-31 L3/L4); this map only stands in when the database is not wired.
   */
  private readonly scannedTo = new Map<string, bigint>();

  async read(asset: AssetId, treasury?: `0x${string}` | null): Promise<ChannelBooksReading> {
    if (!this.door || !asset.startsWith('eip155:')) return NOTHING;
    let books;
    try {
      books = await this.door.readBooks(asset, `0x${'0'.repeat(64)}`);
    } catch (error) {
      return {
        ...NOTHING,
        findings: [
          {
            code: ReconciliationFindingCode.RECONCILIATION_FAILED,
            severity: ReconciliationSeverity.WARN,
            summary:
              `channelBooks() on ${asset} could not be read: the channel door's held and set-aside ` +
              `money are unknown this pass, not zero.`,
            details: { asset, error: describe(error) },
          },
        ],
      };
    }
    if (books === null) return NOTHING;

    const findings: ReconciliationFinding[] = [];
    if (this.intents) {
      const mirrored = await this.intents.sumChannelHeldOnChain(asset);
      if (mirrored !== books.held) {
        findings.push({
          code: ReconciliationFindingCode.HELD_MIRROR_DRIFT,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Channel buckets on ${asset}: the escrow holds ${books.held}, the platform mirrors ` +
            `${mirrored} as held — drift ${books.held - mirrored}. Transient while a settle, collect ` +
            `or refund is booked; persistent means a missed ChannelSettled, ChannelCollected or ` +
            `ChannelRefunded.`,
          details: {
            asset,
            door: 'channel',
            held: books.held.toString(),
            mirrored: mirrored.toString(),
          },
        });
      }
    }
    findings.push(...(await this.foreign(asset)));
    if (this.channels) {
      findings.push(...(await this.perChannel(asset)));
      // The treasury receives every fee: its unpaid is part of totalUnpaid (L3).
      const payee =
        treasury ??
        (typeof this.door.treasury === 'function'
          ? await this.door.treasury(asset).catch(() => null)
          : null);
      findings.push(...(await this.unpaid(asset, books.totalUnpaid, payee)));
      findings.push(...(await this.settlements(asset)));
    }
    return { held: books.held, totalUnpaid: books.totalUnpaid, readable: true, findings };
  }

  /**
   * Channel events not sent by our redeemer (v3 §5.7, last bullet). Settle and
   * refund are redeemer-only on chain, so one from another sender means the
   * Config names another redeemer or the key is used elsewhere: CRITICAL,
   * paged at once (not a run severity: it says nothing about the vault, and
   * must not freeze withdrawals). A collect or an unpaid claim by a stranger is
   * the permissionless rescue after the 7-day timeout: WARN. Read only; the
   * scan advances a bounded window per pass.
   */
  private async foreign(asset: AssetId): Promise<ReconciliationFinding[]> {
    if (!this.door) return [];
    let scan;
    try {
      const stored = this.channels ? await this.channels.scanCursor(asset) : null;
      const from = stored ?? this.scannedTo.get(asset);
      scan = await this.door.foreignChannelTxs(
        asset,
        from === undefined || from === null ? null : from + 1n,
        FOREIGN_SCAN_BLOCKS,
      );
    } catch (error) {
      // Fails closed: an unscanned window is a finding, not silence.
      this.logger.warn(`channel foreign-transaction scan on ${asset}: ${describe(error)}`);
      return [
        {
          code: ReconciliationFindingCode.RECONCILIATION_FAILED,
          severity: ReconciliationSeverity.WARN,
          summary:
            `The scan for channel-door transactions not sent by this platform's redeemer on ${asset} ` +
            `failed; the window is scanned again next pass.`,
          details: { asset, error: describe(error) },
        },
      ];
    }
    this.scannedTo.set(asset, scan.toBlock);
    await this.channels
      ?.setScanCursor(asset, scan.toBlock)
      .catch((error: unknown) => this.logger.warn(`scan cursor of ${asset}: ${describe(error)}`));
    const findings: ReconciliationFinding[] = [];
    for (const tx of scan.foreign) {
      const redeemerOnly = tx.events.some((e) => REDEEMER_ONLY_EVENTS.has(e));
      const summary =
        `Channel-door transaction ${tx.txHash} on ${asset} was sent by ${tx.from}, not by this ` +
        `platform's redeemer (${tx.events.join(', ')}).` +
        (redeemerOnly
          ? ' Settle and refund are redeemer-only: another key holds the redeemer role. Investigate now.'
          : ' A collect or claim after the timeout is allowed to anyone; check why it was needed.');
      findings.push({
        code: ReconciliationFindingCode.CHANNEL_FOREIGN_TX,
        severity: ReconciliationSeverity.WARN,
        summary,
        details: { asset, txHash: tx.txHash, from: tx.from, events: tx.events.join(',') },
      });
      await this.alerts
        ?.emit({
          severity: redeemerOnly ? AlertSeverity.CRITICAL : AlertSeverity.WARN,
          name: 'channel_foreign_tx',
          summary,
          details: { asset, txHash: tx.txHash, from: tx.from, events: tx.events.join(',') },
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: tx.txHash,
        })
        .catch(() => undefined);
    }
    return findings;
  }

  /**
   * Lanes whose chain read was behind this database's booked `settled` on the
   * last pass (a lagging node is suspected until it repeats).
   */
  private readonly lagSeen = new Set<string>();

  /** The lane row as it is NOW (after the chain read); `null` when gone. */
  private async freshLane(channel: {
    channelRowId: string;
  }): Promise<{ accepted: bigint; settled: bigint; settling: boolean } | null> {
    const row = await this.channels!.findById(channel.channelRowId);
    if (!row) return null;
    return {
      accepted: BigInt(row.lastAcceptedCumulative),
      settled: BigInt(row.settledCumulative),
      settling: row.settlingTo !== null && row.settlingTo !== undefined,
    };
  }

  private async perChannel(asset: AssetId): Promise<ReconciliationFinding[]> {
    const findings: ReconciliationFinding[] = [];
    const mirror = await this.channels!.heldByChannel(asset);
    for (const channel of mirror) {
      let books;
      try {
        books = await this.door!.readBooks(asset, channel.key as `0x${string}`);
      } catch (error) {
        this.logger.warn(`channelBooks(${channel.key}) on ${asset}: ${describe(error)}`);
        continue;
      }
      if (!books) continue;
      const chainSettled = books.slot.settled;
      // The mirror was read once, before this lane's chain read: a call
      // admitted and settled in between makes the snapshot stale. The lane row
      // is re-read AFTER the chain read and judged on that (final review
      // 2026-11-01 F1 / ops F3).
      const fresh = await this.freshLane(channel);
      if (!fresh) continue;
      const lane = { ...channel, ...fresh };
      const above = chainSettled > lane.accepted;
      if (lane.settling && !above) {
        // A settlement in flight: its landing moves `settled`; judged next
        // pass. A chain above what was ever accepted is a breach regardless.
        this.lagSeen.delete(lane.channelRowId);
        continue;
      }
      const behind = !lane.settling && chainSettled < lane.settled;
      if (behind && !above && !this.lagSeen.has(lane.channelRowId)) {
        // The chain read is behind what this database booked from a landing:
        // most likely a node lagging behind the load balancer. WARN once; the
        // lane is stopped only if the next pass still reads it behind.
        this.lagSeen.add(lane.channelRowId);
        findings.push({
          code: ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Channel ${lane.key} on ${asset}: the chain read settled ${chainSettled}, below the ` +
            `${lane.settled} this platform booked. Likely a lagging node; the channel is stopped if ` +
            `the next pass reads it behind again.`,
          details: {
            asset,
            key: lane.key,
            chainSettled: chainSettled.toString(),
            settled: lane.settled.toString(),
          },
        });
        continue;
      }
      if (above || behind) {
        this.lagSeen.delete(lane.channelRowId);
        // A settlement this platform never accepted, or a database ahead of the
        // chain that persisted over two passes: stop the channel.
        await this.channels!.setStatus(lane.channelRowId, VoucherChannelStatus.DESYNC, 'RECONCILE');
        findings.push({
          code: ReconciliationFindingCode.CHANNEL_STATE_BREACH,
          severity: ReconciliationSeverity.CRITICAL,
          summary:
            `CHANNEL ${lane.key} on ${asset}: the chain settled ${chainSettled}, the platform ` +
            `accepted ${lane.accepted} and recorded ${lane.settled} as settled. The channel ` +
            `stops admitting; find the settlement this database does not know. Once explained, ` +
            `an operator clears it (POST /operator/channels/clear-reconcile).`,
          details: {
            asset,
            key: lane.key,
            chainSettled: chainSettled.toString(),
            accepted: lane.accepted.toString(),
            settled: lane.settled.toString(),
          },
        });
        continue;
      }
      this.lagSeen.delete(lane.channelRowId);
      if (!lane.settling && chainSettled !== lane.settled) {
        findings.push({
          code: ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Channel ${lane.key} on ${asset}: settled ${chainSettled} on chain, ${lane.settled} ` +
            `in the mirror, with nothing in flight — a landing not booked yet.`,
          details: {
            asset,
            key: lane.key,
            chainSettled: chainSettled.toString(),
            settled: lane.settled.toString(),
          },
        });
      }
      const buckets = books.slot.h1 + books.slot.h2;
      if (!lane.settling && buckets !== lane.held) {
        findings.push({
          code: ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT,
          severity: ReconciliationSeverity.WARN,
          summary:
            `Channel ${lane.key} on ${asset}: its buckets hold ${buckets}, its held calls sum to ` +
            `${lane.held}.`,
          details: {
            asset,
            key: lane.key,
            buckets: buckets.toString(),
            held: lane.held.toString(),
          },
        });
      }
    }
    return findings;
  }

  private async unpaid(
    asset: AssetId,
    totalUnpaid: bigint,
    treasury: `0x${string}` | null,
  ): Promise<ReconciliationFinding[]> {
    if (totalUnpaid === 0n) return [];
    const addresses = new Set(await this.channels!.providerAddresses(asset));
    if (treasury) addresses.add(treasury.toLowerCase());
    let sum = 0n;
    for (const address of addresses) {
      try {
        const books = await this.door!.readBooks(
          asset,
          `0x${'0'.repeat(64)}`,
          address as `0x${string}`,
        );
        sum += books?.unpaid ?? 0n;
      } catch {
        return [];
      }
    }
    const findings: ReconciliationFinding[] = [
      {
        code: ReconciliationFindingCode.CHANNEL_UNPAID,
        severity: ReconciliationSeverity.WARN,
        summary:
          `${totalUnpaid} on ${asset} is set aside in the escrow after failed payout transfers ` +
          `(a frozen provider or treasury). It is paid with claimUnpaid once the freeze lifts.`,
        details: { asset, totalUnpaid: totalUnpaid.toString(), known: sum.toString() },
      },
    ];
    if (sum !== totalUnpaid) {
      findings.push({
        code: ReconciliationFindingCode.CHANNEL_UNPAID,
        severity: ReconciliationSeverity.WARN,
        summary:
          `totalUnpaid on ${asset} is ${totalUnpaid} but the addresses this platform pays account for ` +
          `${sum}: a payout was set aside for an address no channel names.`,
        details: { asset, totalUnpaid: totalUnpaid.toString(), known: sum.toString() },
      });
    }
    return findings;
  }

  private async settlements(asset: AssetId): Promise<ReconciliationFinding[]> {
    const breaks = await this.channels!.settlementIdentityBreaks(asset);
    return breaks.map((broken) => ({
      code: ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT,
      severity: ReconciliationSeverity.WARN,
      summary:
        `Channel settlement ${broken.settlementId} on ${asset} charged ${broken.charge} but its calls ` +
        `are ${broken.collected} collected + ${broken.refunded} refunded + ${broken.held} held.`,
      details: {
        asset,
        settlementId: broken.settlementId,
        charge: broken.charge.toString(),
        collected: broken.collected.toString(),
        refunded: broken.refunded.toString(),
        held: broken.held.toString(),
        feeDustPerRow: CHANNEL_FEE_DUST_PER_ROW_ATOMIC.toString(),
      },
    }));
  }
}

/** Blocks one pass scans for foreign channel transactions. */
const FOREIGN_SCAN_BLOCKS = 5_000n;
const REDEEMER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'ChannelSettled',
  'ChannelOpened',
  'ChannelSettleSkipped',
  'ChannelBucketDeferred',
  'ChannelRefunded',
  'ChannelRefundSkipped',
]);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
