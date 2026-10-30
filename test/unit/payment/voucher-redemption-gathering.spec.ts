import { randomUUID } from 'node:crypto';

import { RedeemableIntent } from '@database/postgres/repositories/payment-intent.repository';
import { EVM_FEE_CAP_WAIVED_WITHIN_SECONDS } from '@modules/chains/evm/evm-l1-gas';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import {
  GatheringPolicy,
  loadRedeemGathering,
  NO_GATHERING,
} from '@modules/payment/constants/settlement-gathering.constants';
import { redeemGraceSeconds } from '@modules/payment/constants/voucher-redemption.constants';
import {
  RedeemOutcome,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { VoucherRedemptionService } from '@modules/payment/services/voucher-redemption.service';
import { noBlocks } from '../helpers/blocklist';

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
}

function build(options: {
  waiting?: Waiting | 'THROW';
  batchSize?: number;
  policy?: GatheringPolicy;
  rows?: number;
}) {
  const rows = Array.from({ length: options.rows ?? 3 }, (_, index) => pending(index + 1));
  const batches: RedeemVoucherRequest[][] = [];
  const singles: RedeemVoucherRequest[] = [];
  const outcome = (request: RedeemVoucherRequest): RedeemOutcome => ({
    kind: RedeemOutcomeKind.REDEEMED,
    signature: `sig-${request.seq}`,
    programError: null,
  });
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
    noBlocks(),
    () => NOW_MS,
    null,
    options.policy ?? GATHER,
  );
  return { service, payments, batches, singles };
}

describe('VoucherRedemptionService — gathering', () => {
  it('reads its defaults from the env: 20 vouchers or 900 s', () => {
    expect(loadRedeemGathering({})).toEqual({ minBatch: 20, maxWaitSeconds: 900 });
    expect(() => loadRedeemGathering({ REDEEM_MAX_WAIT_SECONDS: '7200' })).toThrow(
      /REDEEM_MAX_WAIT_SECONDS/,
    );
  });

  it('skips the pass below both thresholds, loading no rows', async () => {
    const { service, payments, batches } = build({});

    await service.run(ASSET);

    expect(payments.summarizeAwaitingRedemption).toHaveBeenCalledWith(
      ASSET,
      'SETTLED',
      'RAIL_B_VOUCHER',
      { orderedBySeq: false },
    );
    expect(payments.findAwaitingRedemption).not.toHaveBeenCalled();
    expect(batches).toEqual([]);
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
});
