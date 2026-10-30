import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  LANDING_SETTLE_SECONDS,
  LANDING_UNKNOWN_ALERT_SECONDS,
  VOUCHER_REDEMPTION_ALERTS,
} from '@modules/payment/constants/voucher-redemption.constants';
import { VoucherRedemptionJob } from '@modules/payment/jobs/voucher-redemption.job';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  UsedSeqRecord,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { AlertAggregation, AlertSeverity } from '@shared/alerting';

import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';

import { addBlock, noBlocks } from '../helpers/blocklist';

/**
 * REGRESSION (review 2026-10-15 P-1): a redemption that LANDED but was not
 * observed — its receipt timed out, or a second, overlapping pass reached the
 * same row — came back `VoucherSeqNotIncreasing` on the next attempt and was
 * absorbed: the chain had paid the provider, and the ledger recorded that the
 * platform owed them the same amount again. The job now records each
 * transaction before its broadcast and asks the chain whether one of them
 * redeemed the voucher before absorbing anything.
 */

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const NOW = 1_800_000_000;
const PROVIDER_ORG_UUID = '44444444-4444-4444-8444-444444444444';

function row() {
  return {
    organizationId: 'org-1',
    id: 'intent-1',
    agentAccount: `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`,
    providerAccount: `${CHAIN_IDS.SOLANA_DEVNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
    assetId: USDC,
    decimals: getAssetMetadata(USDC).decimals,
    priceAmount: '1000000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: '1',
    voucherSignature: 'sig',
    voucherResourceHash: 'sha256:' + 'ab'.repeat(32),
    voucherIssuedAt: String(NOW - 10),
    voucherDelegate: null,
    expiresAt: new Date((NOW + 300) * 1000),
    holdId: randomUUID(),
    providerId: PROVIDER_ORG_UUID,
    providerAmount: '800000',
    platformFee: '200000',
  };
}

/**
 * The chain: a transaction is recorded, then mined at once; its receipt is
 * observed later (or never). `seq <= seqHigh` is refused as the contract does.
 */
class ChainRedeemer {
  seqHigh = 0n;
  readonly maxBatchSize = 1;
  sends = 0;
  /** Hashes that redeemed a voucher, by seq. */
  readonly landed = new Map<string, string>();
  pendingLookup = false;
  /** The chain's clock has passed the voucher's deadline: `VoucherExpired` comes first. */
  expired = false;
  /** A lagging RPC node: it has never seen any transaction. */
  lagging = false;

  constructor(private readonly receipt: () => Promise<void>) {}

  async redeemBatch(): Promise<RedeemOutcome[]> {
    return [];
  }

  async redeem(r: RedeemVoucherRequest): Promise<RedeemOutcome> {
    if (this.expired) {
      return {
        kind: RedeemOutcomeKind.UNREDEEMABLE,
        signature: null,
        programError: 'VoucherExpired',
      };
    }
    if (BigInt(r.seq) <= this.seqHigh) {
      return {
        kind: RedeemOutcomeKind.UNREDEEMABLE,
        signature: null,
        programError: 'VoucherSeqNotIncreasing',
      };
    }
    this.sends += 1;
    const hash = `0x${String(this.sends).padStart(64, '0')}`;
    await r.recordAttempt?.(hash);
    this.seqHigh = BigInt(r.seq);
    this.landed.set(r.seq, hash);
    await this.receipt();
    return { kind: RedeemOutcomeKind.REDEEMED, signature: hash, programError: null };
  }

  async findLanding(r: RedeemVoucherRequest, refs: readonly string[]): Promise<string | null> {
    if (this.pendingLookup) throw new Error('still pending');
    if (this.lagging) return null;
    const hash = this.landed.get(r.seq);
    return hash !== undefined && refs.includes(hash) ? hash : null;
  }
}

/**
 * The `eip155` chain since D-23: each `(payer, seq)` once, in any order. A used
 * seq is refused `VoucherSeqUsed` — also what a voucher that already landed
 * gets.
 */
class EvmChainRedeemer {
  readonly maxBatchSize = 1;
  sends = 0;
  /** Seqs with a `held(payer, seq)` record, ours or not. */
  readonly used = new Set<string>();
  /** Hashes that redeemed a voucher, by seq. */
  readonly landed = new Map<string, string>();

  constructor(private readonly receipt: () => Promise<void>) {}

  requiresAscendingSeq(): boolean {
    return false;
  }

  async redeemBatch(): Promise<RedeemOutcome[]> {
    return [];
  }

  async redeem(r: RedeemVoucherRequest): Promise<RedeemOutcome> {
    if (this.used.has(r.seq)) {
      return {
        kind: RedeemOutcomeKind.UNREDEEMABLE,
        signature: null,
        programError: 'VoucherSeqUsed',
      };
    }
    this.sends += 1;
    const hash = `0x${String(this.sends).padStart(64, '0')}`;
    await r.recordAttempt?.(hash);
    this.used.add(r.seq);
    this.landed.set(r.seq, hash);
    await this.receipt();
    return { kind: RedeemOutcomeKind.REDEEMED, signature: hash, programError: null };
  }

  async findLanding(r: RedeemVoucherRequest, refs: readonly string[]): Promise<string | null> {
    const hash = this.landed.get(r.seq);
    return hash !== undefined && refs.includes(hash) ? hash : null;
  }
}

/**
 * The `eip155` redeemer as it ships: it can also read `held(payer, seq)` and
 * say whether the record that makes the seq used is this voucher's (M-B1).
 */
class EvmRecordRedeemer extends EvmChainRedeemer {
  record: UsedSeqRecord | Error = 'HELD';
  readonly asked: RedeemVoucherRequest[] = [];

  async usedSeqRecord(r: RedeemVoucherRequest): Promise<UsedSeqRecord> {
    this.asked.push(r);
    if (this.record instanceof Error) throw this.record;
    return this.record;
  }
}

function build(
  redeemer: ChainRedeemer | EvmChainRedeemer,
  clock: { nowSeconds: number } = { nowSeconds: NOW },
  blocklist = noBlocks(),
) {
  const refs = new Map<string, string[]>();
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ heldStatus: null }),
    releaseHold: jest.fn().mockResolvedValue(true),
    voidUnredeemed: jest.fn().mockResolvedValue(true),
  };
  const payments = {
    recordRedemptionRetry: jest.fn().mockResolvedValue(undefined),
    findAwaitingRedemption: jest
      .fn()
      .mockImplementation(async () =>
        intents.commitRedeemedHold.mock.calls.length > 0 ? [] : [row()],
      ),
    recordRedemptionTxRef: jest.fn(async (_org: string, id: string, ref: string) => {
      refs.set(id, [...(refs.get(id) ?? []), ref]);
    }),
    findRedemptionTxRefs: jest.fn(async (_org: string, id: string) => refs.get(id) ?? []),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
  };
  const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    alerts as never,
    blocklist,
    () => clock.nowSeconds * 1000,
  );
  return { service, intents, payments, alerts };
}

describe('VoucherRedemptionService — a landing this process did not observe', () => {
  it('receipt timeout: the next pass commits the hold with the landed transaction, absorbs nothing', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const { service, intents, payments } = build(redeemer);

    await service.run(USDC);
    expect(payments.recordRedemptionTxRef).toHaveBeenCalledTimes(1);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();

    await service.run(USDC);
    expect(redeemer.sends).toBe(1);
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('overlapping passes: the second one finds the first one’s transaction instead of absorbing', async () => {
    let release!: () => void;
    const redeemer = new ChainRedeemer(() => new Promise<void>((resolve) => (release = resolve)));
    const { service, intents } = build(redeemer);

    const first = service.run(USDC);
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.run(USDC);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(redeemer.sends).toBe(1);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
  });

  it('keeps the hold open, absorbing nothing, while the chain cannot tell yet', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('timeout');
    });
    const { service, intents } = build(redeemer);
    await service.run(USDC);
    redeemer.pendingLookup = true;
    await service.run(USDC);

    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  });

  it('a provider blocked after its voucher landed unobserved: committed, not forfeited', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const blocklist = noBlocks();
    const { service, intents } = build(redeemer, undefined, blocklist);
    await service.run(USDC);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();

    addBlock(blocklist, { kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_ORG_UUID });
    await service.run(USDC);

    expect(redeemer.sends).toBe(1);
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('turns into buyer debt a voucher none of whose own transactions landed', async () => {
    const redeemer = new ChainRedeemer(async () => undefined);
    redeemer.seqHigh = 5n; // a higher seq of this payer already landed
    const { service, intents, payments } = build(redeemer);
    await service.run(USDC);

    expect(redeemer.sends).toBe(0);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      'VoucherSeqNotIncreasing',
    );
  });
});

describe('VoucherRedemptionService — VoucherSeqUsed on eip155 (D-23)', () => {
  it('a landed but unobserved voucher comes back VoucherSeqUsed and is committed, not charged twice', async () => {
    const redeemer = new EvmChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const { service, intents, payments } = build(redeemer);

    await service.run(USDC);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();

    await service.run(USDC);
    expect(redeemer.sends).toBe(1);
    expect(payments.findRedemptionTxRefs).toHaveBeenCalledWith('org-1', 'intent-1');
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  describe('no transaction of its own landed it: the chain’s record decides (M-B1)', () => {
    it('a record naming its provider and amount is committed as redeemed unobserved — no debt', async () => {
      const redeemer = new EvmRecordRedeemer(async () => undefined);
      redeemer.used.add('1');
      const { service, intents, payments, alerts } = build(redeemer);

      await service.run(USDC);

      expect(redeemer.sends).toBe(0);
      expect(redeemer.asked.map((r) => r.seq)).toEqual(['1']);
      expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
        'org-1',
        'intent-1',
        'unobserved:seq=1',
      );
      expect(payments.lapseRedemption).not.toHaveBeenCalled();
      expect(intents.releaseHold).not.toHaveBeenCalled();
      expect(alerts.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_UNOBSERVED,
          severity: AlertSeverity.WARN,
        }),
      );
    });

    it('a record for another provider or amount is an anomaly: paged, hold open, no debt', async () => {
      const redeemer = new EvmRecordRedeemer(async () => undefined);
      redeemer.used.add('1');
      redeemer.record = 'MISMATCH';
      const { service, intents, payments, alerts } = build(redeemer);

      await service.run(USDC);

      expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
      expect(payments.lapseRedemption).not.toHaveBeenCalled();
      expect(intents.releaseHold).not.toHaveBeenCalled();
      expect(alerts.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_ANOMALY,
          severity: AlertSeverity.CRITICAL,
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        }),
      );
    });

    it.each([
      ['REFUNDED', null],
      ['COLLECTED', null],
    ] as const)(
      'a %s record of this voucher with no hold of ours recorded is an anomaly: never booked, no debt (F-L3)',
      async (record, heldStatus) => {
        const redeemer = new EvmRecordRedeemer(async () => undefined);
        redeemer.used.add('1');
        redeemer.record = record;
        const { service, intents, payments, alerts } = build(redeemer);
        intents.findById.mockResolvedValue({ heldStatus });

        await service.run(USDC);

        expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
        expect(payments.lapseRedemption).not.toHaveBeenCalled();
        expect(intents.releaseHold).not.toHaveBeenCalled();
        expect(alerts.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_ANOMALY,
            severity: AlertSeverity.CRITICAL,
            details: expect.objectContaining({ record }),
          }),
        );
      },
    );

    it('a COLLECTED record our own row already holds is ours: nothing new booked, nothing paged (F-L3)', async () => {
      for (const heldStatus of ['HELD', 'COLLECTED']) {
        const redeemer = new EvmRecordRedeemer(async () => undefined);
        redeemer.used.add('1');
        redeemer.record = 'COLLECTED';
        const { service, intents, payments, alerts } = build(redeemer);
        intents.findById.mockResolvedValue({ heldStatus });

        await service.run(USDC);

        expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
        expect(payments.lapseRedemption).not.toHaveBeenCalled();
        expect(intents.releaseHold).not.toHaveBeenCalled();
        expect(alerts.emit).not.toHaveBeenCalled();
      }
    });

    it('decides before a forfeit too: a provider cause on record does not release a held payment', async () => {
      const redeemer = new EvmRecordRedeemer(async () => undefined);
      redeemer.used.add('1');
      const { service, intents, payments } = build(redeemer);
      payments.findAwaitingRedemption.mockImplementation(async () =>
        intents.commitRedeemedHold.mock.calls.length > 0
          ? []
          : [{ ...row(), redemptionLastError: 'ProviderBelowMinimumStake' }],
      );

      await service.run(USDC);

      expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
        'org-1',
        'intent-1',
        'unobserved:seq=1',
      );
      expect(intents.releaseHold).not.toHaveBeenCalled();
    });

    it('a record read that says unused, or fails, keeps the hold open for the next pass', async () => {
      for (const record of ['NONE', new Error('rpc down')] as const) {
        const redeemer = new EvmRecordRedeemer(async () => undefined);
        redeemer.used.add('1');
        redeemer.record = record;
        const { service, intents, payments, alerts } = build(redeemer);

        await service.run(USDC);

        expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
        expect(payments.lapseRedemption).not.toHaveBeenCalled();
        expect(intents.releaseHold).not.toHaveBeenCalled();
        expect(alerts.emit).not.toHaveBeenCalled();
      }
    });

    it('a record that still reads unused past the landing window is paged, never debt', async () => {
      const redeemer = new EvmRecordRedeemer(async () => undefined);
      redeemer.used.add('1');
      redeemer.record = 'NONE';
      const clock = { nowSeconds: NOW + 300 + 120 + 1_800 + LANDING_SETTLE_SECONDS + 1 };
      const { service, payments, alerts } = build(redeemer, clock);

      await service.run(USDC);

      expect(payments.lapseRedemption).not.toHaveBeenCalled();
      expect(alerts.emit).toHaveBeenCalledWith(
        expect.objectContaining({ name: VOUCHER_REDEMPTION_ALERTS.SEQ_USED_ANOMALY }),
      );
    });
  });

  it('without a record reader, a seq used by no transaction of its own becomes buyer debt, named VoucherSeqUsed', async () => {
    const redeemer = new EvmChainRedeemer(async () => undefined);
    redeemer.used.add('1');
    const { service, intents, payments } = build(redeemer);

    await service.run(USDC);

    expect(redeemer.sends).toBe(0);
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
    expect(payments.lapseRedemption).toHaveBeenCalledWith('org-1', 'intent-1', 'VoucherSeqUsed');
  });

  it('a lower seq after a higher one is redeemed, not lost', async () => {
    // seq 5 of this payer already landed; on Solana seq 1 would now be dead.
    const redeemer = new EvmChainRedeemer(async () => undefined);
    redeemer.used.add('5');
    const { service, intents, payments } = build(redeemer);

    await service.run(USDC);

    expect(redeemer.sends).toBe(1);
    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
  });
});

describe('VoucherRedemptionService — every refusal, and a lagging node', () => {
  /** Past the voucher's on-chain deadline (`expires_at` + skew + grace). */
  const PAST_DEADLINE = NOW + 300 + 120 + 1_800 + 1;

  /**
   * Final review N-2: prevalidation answers `VoucherExpired` before it looks at
   * `seq_high`, so a landed-but-unobserved redemption retried late was
   * absorbed through the other refusal.
   */
  it('looks for its own landing on VoucherExpired too, and absorbs nothing', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const clock = { nowSeconds: NOW };
    const { service, intents } = build(redeemer, clock);
    await service.run(USDC);

    redeemer.expired = true;
    clock.nowSeconds = PAST_DEADLINE + 3_600;
    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  /**
   * Final review N-7: a node a few blocks behind says "not found" for a mined
   * hash. That is "unknown" until the recorded transaction is old enough that
   * every node would have it; only then is the voucher closed.
   */
  it('treats "not found" as unknown while its own transaction is recent', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const clock = { nowSeconds: NOW };
    const { service, intents, payments } = build(redeemer, clock);
    await service.run(USDC);

    redeemer.lagging = true;
    redeemer.expired = true;
    clock.nowSeconds = PAST_DEADLINE;
    await service.run(USDC);
    expect(intents.releaseHold).not.toHaveBeenCalled();

    expect(payments.lapseRedemption).not.toHaveBeenCalled();

    clock.nowSeconds = PAST_DEADLINE + 3_600;
    await service.run(USDC);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    // Only a receipt timeout, never a refusal: the platform's failure, voided.
    expect(payments.lapseRedemption).not.toHaveBeenCalled();
    expect(intents.voidUnredeemed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'intent-1' }),
      'voided:PLATFORM_UNREDEEMED',
    );
  });

  /**
   * Round-two review R2-6: a landing lookup that keeps failing (a pruned RPC,
   * an outage) left the row at the head of the queue with its hold open, and
   * nothing absorbed or alerted. Past the landing window plus
   * {@link LANDING_UNKNOWN_ALERT_SECONDS} it pages; the hold still stays open.
   */
  it('pages once the landing has stayed unknown long past the window, absorbing nothing', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const clock = { nowSeconds: NOW };
    const { service, intents, alerts } = build(redeemer, clock);
    await service.run(USDC);

    redeemer.pendingLookup = true;
    redeemer.expired = true;
    const unknown = () =>
      alerts.emit.mock.calls.filter(
        ([alert]) => alert.name === VOUCHER_REDEMPTION_ALERTS.LANDING_UNKNOWN,
      );

    clock.nowSeconds = PAST_DEADLINE + LANDING_SETTLE_SECONDS + LANDING_UNKNOWN_ALERT_SECONDS - 60;
    await service.run(USDC);
    expect(unknown()).toEqual([]);

    clock.nowSeconds = PAST_DEADLINE + LANDING_SETTLE_SECONDS + LANDING_UNKNOWN_ALERT_SECONDS;
    await service.run(USDC);
    expect(unknown()).toEqual([
      [
        expect.objectContaining({
          severity: AlertSeverity.CRITICAL,
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: 'intent-1',
          details: expect.objectContaining({ intentId: 'intent-1', seq: '1' }),
        }),
      ],
    ]);
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  });
});

describe('VoucherRedemptionJob', () => {
  it('never runs two passes at once', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      VoucherRedemptionJob.prototype.handleRedemption,
    ) as { waitForCompletion?: boolean };
    expect(options.waitForCompletion).toBe(true);
  });
});
