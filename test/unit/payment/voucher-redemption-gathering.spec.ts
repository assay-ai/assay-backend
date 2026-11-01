import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { EVM_FEE_CAP_WAIVED_WITHIN_SECONDS } from '@modules/chains/evm/evm-l1-gas';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import {
  DEFAULT_REDEEM_MAX_WAIT_SECONDS,
  GatheringPolicy,
  loadCollectGathering,
  loadRedeemGathering,
  loadUrgentReplacementIntervalSeconds,
  NO_GATHERING,
  UrgentPassLimiter,
} from '@modules/payment/constants/settlement-gathering.constants';
import { redeemGraceSeconds } from '@modules/payment/constants/voucher-redemption.constants';
import {
  FEE_SPIKE_DEFERRED,
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

/**
 * Redemption gathering (owner decision 2026-10-30): on a chain that batches,
 * a pass waits until `REDEEM_MIN_BATCH` vouchers await, the oldest was issued
 * `REDEEM_MAX_WAIT_SECONDS` ago, or one is within the fee-cap waiver window of
 * its on-chain deadline — and a voucher sent alone (Solana) never waits.
 */
const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const CHAIN = chainIdOf(ASSET);
const NOW_SECONDS = 1_800_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const GATHER: GatheringPolicy = { minBatch: 20, maxWaitSeconds: 900 };

function pending(seq: number): RedeemableIntent {
  return {
    organizationId: 'org-1',
    id: `intent-${seq}`,
    agentAccount: `${CHAIN}:0x${seq.toString(16).padStart(40, 'a')}`,
    providerAccount: `${CHAIN}:0x${'b'.repeat(40)}`,
    assetId: ASSET,
    decimals: 6,
    priceAmount: '100000',
    requestHash: 'cd'.repeat(32),
    voucherSeq: String(seq),
    voucherSignature: `signature-${seq}`,
    voucherResourceHash: `sha256:${'ab'.repeat(32)}`,
    voucherIssuedAt: String(NOW_SECONDS - 10),
    expiresAt: new Date((NOW_SECONDS + 300) * 1000),
    holdId: randomUUID(),
    providerId: 'provider-1',
    providerAmount: '90000',
    platformFee: '10000',
    redemptionLastError: null,
    voucherDelegate: null,
    redemptionTxRefCount: 0,
  } as unknown as RedeemableIntent;
}

interface Waiting {
  count: number;
  oldestIssuedAt: Date | null;
  earliestExpiresAt: Date | null;
  replacementCount?: number;
}

function build(options: {
  waiting?: Waiting | 'THROW';
  batchSize?: number;
  policy?: GatheringPolicy;
  rows?: number;
  blocklist?: ReturnType<typeof noBlocks>;
  limiter?: UrgentPassLimiter;
  now?: () => number;
  deferAll?: boolean;
}) {
  const rows = Array.from({ length: options.rows ?? 3 }, (_, index) => pending(index + 1));
  const batches: RedeemVoucherRequest[][] = [];
  const singles: RedeemVoucherRequest[] = [];
  const outcome = (request: RedeemVoucherRequest): RedeemOutcome =>
    options.deferAll
      ? { kind: RedeemOutcomeKind.RETRY, signature: null, programError: FEE_SPIKE_DEFERRED }
      : {
          kind: RedeemOutcomeKind.REDEEMED,
          signature: `sig-${request.seq}`,
          programError: null,
        };
  const redeemer = {
    maxBatchSize: options.batchSize ?? 64,
    maxBatchSizeFor: () => options.batchSize ?? 64,
    requiresAscendingSeq: () => false,
    redeem: async (request: RedeemVoucherRequest) => {
      singles.push(request);
      return outcome(request);
    },
    redeemBatch: async (requests: readonly RedeemVoucherRequest[]) => {
      batches.push([...requests]);
      return requests.map(outcome);
    },
  };
  const payments = {
    summarizeAwaitingRedemption: jest.fn(async () => {
      if (options.waiting === 'THROW') throw new Error('database unavailable');
      return (
        options.waiting ?? {
          count: rows.length,
          oldestIssuedAt: new Date(NOW_MS - 10_000),
          earliestExpiresAt: new Date(NOW_MS + 300_000),
        }
      );
    }),
    findAwaitingRedemption: jest.fn().mockResolvedValue(rows),
    findRedemptionTxRefs: jest.fn().mockResolvedValue([]),
    lapseRedemption: jest.fn().mockResolvedValue(undefined),
    recordRedemptionError: jest.fn().mockResolvedValue(undefined),
    recordRedemptionRetry: jest.fn().mockResolvedValue(undefined),
    recordPayerBlocks: jest.fn().mockResolvedValue(0),
    recordProviderBlocks: jest.fn().mockResolvedValue(0),
  };
  const intents = {
    commitRedeemedHold: jest.fn().mockResolvedValue(undefined),
    releaseHold: jest.fn().mockResolvedValue(true),
    voidUnredeemed: jest.fn().mockResolvedValue(true),
  };
  const service = new VoucherRedemptionService(
    payments as never,
    intents as never,
    redeemer as never,
    { emit: async () => undefined } as never,
    options.blocklist ?? noBlocks(),
    options.now ?? (() => NOW_MS),
    null,
    null,
    options.policy ?? GATHER,
    options.limiter ?? new UrgentPassLimiter(300),
  );
  return { service, payments, batches, singles };
}

describe('VoucherRedemptionService — gathering', () => {
  it('reads its defaults from the env: 64 vouchers or 1,800 s', () => {
    expect(loadRedeemGathering({})).toEqual({ minBatch: 64, maxWaitSeconds: 1_800 });
    expect(() => loadRedeemGathering({ REDEEM_MAX_WAIT_SECONDS: '7200' })).toThrow(
      /REDEEM_MAX_WAIT_SECONDS/,
    );
  });

  it('reads the collect defaults from the env: 64 held payments or 21,600 s', () => {
    expect(loadCollectGathering({})).toEqual({ minBatch: 64, maxWaitSeconds: 21_600 });
    expect(() => loadCollectGathering({ COLLECT_MIN_BATCH: '65' })).toThrow(/COLLECT_MIN_BATCH/);
  });

  it('leaves an hour of recovery before the deadline trigger at the default wait', () => {
    // Vouchers reach the backend with as little as the redeem grace left. The
    // default wait plus the fee-cap waiver window must leave at least an hour
    // for a failed send, a dead process or an empty float to be put right.
    const recovery =
      redeemGraceSeconds(ASSET) -
      DEFAULT_REDEEM_MAX_WAIT_SECONDS -
      EVM_FEE_CAP_WAIVED_WITHIN_SECONDS;
    expect(recovery).toBeGreaterThanOrEqual(3_600);
  });

  it('skips the pass below both thresholds, loading no rows', async () => {
    const { service, payments, batches } = build({});

    await service.run(ASSET);

    expect(payments.summarizeAwaitingRedemption).toHaveBeenCalledWith(
      ASSET,
      'SETTLED',
      'RAIL_B_VOUCHER',
      { orderedBySeq: false, exclude: { organizationIds: [], walletKeys: [], chainAccounts: [] } },
    );
    expect(payments.findAwaitingRedemption).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
  });

  it('counts with the same blocked-party exclusions the pass then applies (review 2026-10-30 M-2)', async () => {
    const blocklist = blocklistOf({
      kind: BlockSubjectKind.ORGANIZATION,
      subject: '11111111-1111-4111-8111-111111111111',
    });
    const { service, payments } = build({ blocklist, rows: 25 });

    await service.run(ASSET);

    const counted = (payments.summarizeAwaitingRedemption.mock.calls[0] as unknown[])[3] as {
      exclude: { organizationIds: string[] };
    };
    expect(counted.exclude.organizationIds).toHaveLength(1);
    // The pass reads its queue with the very same set.
    const queued = (payments.findAwaitingRedemption.mock.calls[0] as unknown[])[4];
    expect(queued).toBe(counted.exclude);
  });

  it('runs at the count threshold', async () => {
    const { service, batches } = build({
      rows: 20,
      waiting: {
        count: 20,
        oldestIssuedAt: new Date(NOW_MS - 10_000),
        earliestExpiresAt: new Date(NOW_MS + 300_000),
      },
    });

    await service.run(ASSET);

    expect(batches.map((batch) => batch.length)).toEqual([20]);
  });

  it('runs at the age threshold', async () => {
    const { service, batches } = build({
      waiting: {
        count: 3,
        oldestIssuedAt: new Date(NOW_MS - 900_000),
        earliestExpiresAt: new Date(NOW_MS - 600_000),
      },
    });

    await service.run(ASSET);

    expect(batches.map((batch) => batch.length)).toEqual([3]);
  });

  it('runs when a voucher is within the fee-cap waiver window of its deadline', async () => {
    // Young by issue time (an implausible clock, to isolate the trigger), but
    // its deadline — `expiresAt` + the chain's grace — is inside the window.
    const deadlineInMs = (EVM_FEE_CAP_WAIVED_WITHIN_SECONDS - 60) * 1000;
    const { service, batches } = build({
      waiting: {
        count: 1,
        oldestIssuedAt: new Date(NOW_MS - 10_000),
        earliestExpiresAt: new Date(NOW_MS + deadlineInMs - redeemGraceSeconds(ASSET) * 1000),
      },
    });

    await service.run(ASSET);

    expect(batches).toHaveLength(1);
  });

  it('never gathers a chain that sends one voucher per transaction', async () => {
    const { service, payments, singles } = build({ batchSize: 1 });

    await service.run(ASSET);

    expect(payments.summarizeAwaitingRedemption).not.toHaveBeenCalled();
    expect(singles).toHaveLength(3);
  });

  it('runs the pass when the gathering check fails', async () => {
    const { service, batches } = build({ waiting: 'THROW' });

    await service.run(ASSET);

    expect(batches).toHaveLength(1);
  });

  it('a minimum batch of 1 turns gathering off', async () => {
    const { service, payments, batches } = build({ policy: NO_GATHERING });

    await service.run(ASSET);

    expect(payments.summarizeAwaitingRedemption).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
  });

  describe('debt replacement (SPEC H-1)', () => {
    const young = (replacementCount: number): Waiting => ({
      count: 1,
      oldestIssuedAt: new Date(NOW_MS - 10_000),
      earliestExpiresAt: new Date(NOW_MS + 300_000),
      replacementCount,
    });

    it('reads its interval from the env: 300 s by default, 60–3,600', () => {
      expect(loadUrgentReplacementIntervalSeconds({})).toBe(300);
      expect(
        loadUrgentReplacementIntervalSeconds({ REDEEM_URGENT_REPLACEMENT_INTERVAL_SECONDS: '600' }),
      ).toBe(600);
      expect(() =>
        loadUrgentReplacementIntervalSeconds({ REDEEM_URGENT_REPLACEMENT_INTERVAL_SECONDS: '10' }),
      ).toThrow(/REDEEM_URGENT_REPLACEMENT_INTERVAL_SECONDS/);
    });

    it('runs the pass at once for a replacement, below both gathering thresholds', async () => {
      const { service, batches } = build({ rows: 1, waiting: young(1) });

      await service.run(ASSET);

      expect(batches.map((batch) => batch.length)).toEqual([1]);
    });

    it('runs at most one urgent pass per asset per interval', async () => {
      let now = NOW_MS;
      const limiter = new UrgentPassLimiter(300);
      const { service, batches } = build({ rows: 1, waiting: young(1), limiter, now: () => now });

      await service.run(ASSET);
      now += 299_000;
      await service.run(ASSET);
      expect(batches).toHaveLength(1);

      now += 1_000;
      await service.run(ASSET);
      expect(batches).toHaveLength(2);
    });

    it('a pass gathering runs anyway does not use the urgent allowance', async () => {
      const limiter = new UrgentPassLimiter(300);
      const full = build({
        rows: 20,
        waiting: { ...young(1), count: 20 },
        limiter,
      });
      await full.service.run(ASSET);
      expect(limiter.nextAllowedAt(ASSET, NOW_MS)).toBeNull();

      const urgent = build({ rows: 1, waiting: young(1), limiter });
      await urgent.service.run(ASSET);
      expect(urgent.batches).toHaveLength(1);
    });

    it('still gathers when no replacement awaits', async () => {
      const { service, batches } = build({ rows: 1, waiting: young(0) });

      await service.run(ASSET);

      expect(batches).toEqual([]);
    });

    it('is bounded per asset, not globally', async () => {
      const limiter = new UrgentPassLimiter(300);
      expect(limiter.tryTake(ASSET, NOW_MS)).toBe(true);
      expect(limiter.tryTake(ASSET, NOW_MS + 1)).toBe(false);
      expect(limiter.tryTake('eip155:4663/erc20:0xother', NOW_MS + 1)).toBe(true);
    });

    it('still goes through the redeemer, so a fee-spike or budget deferral holds the row', async () => {
      // The redeemer owns the fee-spike and hourly-budget gates; the urgent
      // pass reaches it like any other and a deferral redeems nothing.
      const { service, batches, payments } = build({ rows: 1, waiting: young(1), deferAll: true });

      await service.run(ASSET);

      expect(batches).toHaveLength(1);
      expect(payments.lapseRedemption).not.toHaveBeenCalled();
    });
  });
});
