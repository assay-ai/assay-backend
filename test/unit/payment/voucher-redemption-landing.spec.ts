import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { VoucherRedemptionJob } from '@modules/payment/jobs/voucher-redemption.job';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';

import { noBlocks } from '../helpers/blocklist';

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
    providerId: 'prov-org',
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

function build(redeemer: ChainRedeemer, clock: { nowSeconds: number } = { nowSeconds: NOW }) {
  const refs = new Map<string, string[]>();
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
  };
  const ledger = { appendNow: jest.fn().mockResolvedValue(undefined) };
  const payments = {
    findAwaitingRedemption: jest
      .fn()
      .mockImplementation(async () =>
        intents.commitRedeemedHold.mock.calls.length > 0 ? [] : [row()],
      ),
    recordRedemptionTxRef: jest.fn(async (_org: string, id: string, ref: string) => {
      refs.set(id, [...(refs.get(id) ?? []), ref]);
    }),
    findRedemptionTxRefs: jest.fn(async (_org: string, id: string) => refs.get(id) ?? []),
  };
  const alerts = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    ledger as never,
    redeemer as never,
    alerts as never,
    noBlocks(),
    () => clock.nowSeconds * 1000,
  );
  return { service, intents, ledger, payments };
}

describe('VoucherRedemptionService — a landing this process did not observe', () => {
  it('receipt timeout: the next pass commits the hold with the landed transaction, absorbs nothing', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const { service, intents, ledger, payments } = build(redeemer);

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
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  it('overlapping passes: the second one finds the first one’s transaction instead of absorbing', async () => {
    let release!: () => void;
    const redeemer = new ChainRedeemer(() => new Promise<void>((resolve) => (release = resolve)));
    const { service, intents, ledger } = build(redeemer);

    const first = service.run(USDC);
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.run(USDC);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(redeemer.sends).toBe(1);
    expect(ledger.appendNow).not.toHaveBeenCalled();
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
    const { service, intents, ledger } = build(redeemer);
    await service.run(USDC);
    redeemer.pendingLookup = true;
    await service.run(USDC);

    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
    expect(intents.commitRedeemedHold).not.toHaveBeenCalled();
  });

  it('still absorbs a voucher none of whose own transactions landed', async () => {
    const redeemer = new ChainRedeemer(async () => undefined);
    redeemer.seqHigh = 5n; // a higher seq of this payer already landed
    const { service, intents, ledger } = build(redeemer);
    await service.run(USDC);

    expect(redeemer.sends).toBe(0);
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ chainTxRef: 'platform_absorbed:VoucherSeqNotIncreasing' }),
    );
    expect(intents.releaseHold).toHaveBeenCalled();
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
    const { service, intents, ledger } = build(redeemer, clock);
    await service.run(USDC);

    redeemer.expired = true;
    clock.nowSeconds = PAST_DEADLINE + 3_600;
    await service.run(USDC);

    expect(intents.commitRedeemedHold).toHaveBeenCalledWith(
      'org-1',
      'intent-1',
      redeemer.landed.get('1'),
    );
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();
  });

  /**
   * Final review N-7: a node a few blocks behind says "not found" for a mined
   * hash. That is "unknown" until the recorded transaction is old enough that
   * every node would have it; only then is the voucher absorbed.
   */
  it('treats "not found" as unknown while its own transaction is recent', async () => {
    const redeemer = new ChainRedeemer(async () => {
      throw new Error('WaitForTransactionReceiptTimeoutError');
    });
    const clock = { nowSeconds: NOW };
    const { service, intents, ledger } = build(redeemer, clock);
    await service.run(USDC);

    redeemer.lagging = true;
    redeemer.expired = true;
    clock.nowSeconds = PAST_DEADLINE;
    await service.run(USDC);
    expect(ledger.appendNow).not.toHaveBeenCalled();
    expect(intents.releaseHold).not.toHaveBeenCalled();

    clock.nowSeconds = PAST_DEADLINE + 3_600;
    await service.run(USDC);
    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ chainTxRef: 'platform_absorbed:VoucherExpired' }),
    );
    expect(intents.releaseHold).toHaveBeenCalled();
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
