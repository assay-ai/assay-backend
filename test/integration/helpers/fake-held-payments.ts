import { AssetId } from '@modules/chains/ports/caip.types';
import {
  HELD_TIMEOUT_SECONDS,
  HeldKey,
  HeldPaymentsPort,
  HeldRecord,
  HeldStatus,
  HeldTxResult,
  RedemptionClass,
} from '@modules/payment/ports/held-payments.port';

/**
 * The escrow's `held[payer][seq]` in memory, with the contract's rules
 * (analysis §5): collect only a `HELD` record and only from `collectableAt`;
 * refund only a `HELD` record and only before `collectableAt + HELD_TIMEOUT`.
 * Each succeeds at most once, so collect and refund can never both happen.
 */
export class FakeHeldPayments implements HeldPaymentsPort {
  readonly records = new Map<string, HeldRecord & { asset: string }>();
  readonly sent: Array<{ op: 'collect' | 'refund'; keys: readonly HeldKey[] }> = [];
  /** When set, the next `collect` throws (a reverted batch). */
  failNextCollect = false;
  /** While set, every `refund` throws (a failing refund transaction). */
  failRefunds = false;
  /** Keys (`payer|seq`) whose collect always fails (a stuck row). */
  readonly stuck = new Set<string>();
  /** The hold is live on the chain (`EVM_HOLD_LIVE_CHAINS`). */
  live = true;
  /** How `readHeld` answers: normally, `null` (no hold / a lagging node), or by throwing. */
  readMode: 'normal' | 'null' | 'throw' = 'normal';
  /** Per key, what the redemption's receipt says; default: HELD if a record exists, else PAID. */
  readonly receipts = new Map<string, RedemptionClass | 'THROW'>();
  private tx = 0;

  /** What `redeemVoucher` does after the upgrade: the payment goes into the hold. */
  redeemInto(asset: string, key: HeldKey, amount: bigint, collectableAt: Date): void {
    this.records.set(this.keyOf(key), {
      asset,
      status: HeldStatus.HELD,
      provider: '0xprovider',
      amount,
      takeRateBps: 1000,
      collectableAt,
    });
  }

  /** Moves a record's `collectableAt` (time passing). */
  setCollectableAt(key: HeldKey, at: Date): void {
    const record = this.records.get(this.keyOf(key));
    if (record) this.records.set(this.keyOf(key), { ...record, collectableAt: at });
  }

  holdLive(): Promise<boolean> {
    return Promise.resolve(this.live);
  }

  classifyRedemption(
    _asset: AssetId,
    _txRef: string | null,
    key: HeldKey,
  ): Promise<RedemptionClass> {
    const forced = this.receipts.get(this.keyOf(key));
    if (forced === 'THROW') return Promise.reject(new Error('receipt read failed'));
    if (forced) return Promise.resolve(forced);
    const record = this.records.get(this.keyOf(key));
    return Promise.resolve(
      record ? { kind: 'HELD', collectableAt: record.collectableAt } : { kind: 'PAID' },
    );
  }

  /** Marks a key: the receipt reads as `kind`. */
  receiptSays(key: HeldKey, kind: RedemptionClass | 'THROW'): void {
    this.receipts.set(this.keyOf(key), kind);
  }

  /** Marks a key whose collect always fails. */
  stick(key: HeldKey): void {
    this.stuck.add(this.keyOf(key));
  }

  readHeld(_asset: AssetId, key: HeldKey): Promise<HeldRecord | null> {
    if (this.readMode === 'throw') return Promise.reject(new Error('RPC node unavailable'));
    if (this.readMode === 'null') return Promise.resolve(null);
    const record = this.records.get(this.keyOf(key));
    return Promise.resolve(
      record ?? {
        status: HeldStatus.NONE,
        provider: '0x0',
        amount: 0n,
        takeRateBps: 0,
        collectableAt: new Date(0),
      },
    );
  }

  collect(_asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    if (this.failNextCollect) {
      this.failNextCollect = false;
      return Promise.reject(new Error('collectHeldBatch reverted'));
    }
    const now = Date.now();
    for (const key of keys) {
      const record = this.records.get(this.keyOf(key));
      if (
        !record ||
        record.status !== HeldStatus.HELD ||
        record.collectableAt.getTime() > now ||
        this.stuck.has(this.keyOf(key))
      ) {
        return Promise.reject(new Error(`collectHeld refused for ${key.seq}`));
      }
    }
    for (const key of keys) this.set(key, HeldStatus.COLLECTED);
    this.sent.push({ op: 'collect', keys });
    return Promise.resolve({ txRef: this.nextTx() });
  }

  refund(_asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    if (this.failRefunds) return Promise.reject(new Error('refundHeld transaction failed'));
    const now = Date.now();
    for (const key of keys) {
      const record = this.records.get(this.keyOf(key));
      if (
        !record ||
        record.status !== HeldStatus.HELD ||
        now >= record.collectableAt.getTime() + HELD_TIMEOUT_SECONDS * 1000
      ) {
        return Promise.reject(new Error(`refundHeld refused for ${key.seq}`));
      }
    }
    for (const key of keys) this.set(key, HeldStatus.REFUNDED);
    this.sent.push({ op: 'refund', keys });
    return Promise.resolve({ txRef: this.nextTx() });
  }

  /** Anyone collecting after the timeout (the provider's favour). */
  collectAsAnyone(key: HeldKey): void {
    this.set(key, HeldStatus.COLLECTED);
  }

  totalHeld(asset: AssetId): Promise<bigint | null> {
    let total = 0n;
    for (const record of this.records.values()) {
      if (record.asset === asset && record.status === HeldStatus.HELD) total += record.amount;
    }
    return Promise.resolve(total);
  }

  collectHoldSeconds(): Promise<number | null> {
    return Promise.resolve(3600);
  }

  private set(key: HeldKey, status: HeldStatus): void {
    const record = this.records.get(this.keyOf(key));
    if (record) this.records.set(this.keyOf(key), { ...record, status });
  }

  private keyOf(key: HeldKey): string {
    return `${key.payer.toLowerCase()}|${key.seq}`;
  }

  private nextTx(): string {
    this.tx += 1;
    return `0x${this.tx.toString(16).padStart(64, '0')}`;
  }
}
