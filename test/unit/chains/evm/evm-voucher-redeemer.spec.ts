import { Logger } from '@nestjs/common';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  toFunctionSelector,
} from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import { EvmReaderClient } from '@modules/chains/evm/evm-escrow-balance-reader.service';
import {
  EVM_CLOCK_DRIFT_ALERT,
  EVM_EXPIRY_HELD_LOG_TAG,
  EVM_REDEEM_BATCH_BASE_GAS,
  EVM_REDEEM_PER_VOUCHER_GAS,
  EvmVoucherRedeemer,
} from '@modules/chains/evm/evm-voucher-redeemer.service';
import { EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM } from '@modules/chains/evm/evm-l1-gas';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import { EvmSendFloat } from '@modules/chains/evm/evm-send-float';
import { EvmRedeemerHourlyBudget } from '@modules/chains/evm/evm-redeemer-hourly-budget';
import { EvmSendRejectedError } from '@modules/chains/evm/evm-send-rejected.error';
import {
  EvmRelayedCall,
  EvmRelayResult,
  EvmRelayerPort,
  EvmValueTransfer,
} from '@modules/chains/evm/ports/evm-relayer.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  FEE_SPIKE_DEFERRED,
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import { Alert, AlertPort } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment } from './evm-fixtures';
import { L2_BASE_FEE, fakeNodeInterface } from './helpers/fake-node-interface';

/**
 * `EvmVoucherRedeemer` — pre-validate the batch, and retry singly.
 *
 * `redeemVoucherBatch` is atomic: one bad voucher reverts all 64. So there are
 * exactly two obligations, both stated in the imperative in assay-evm's
 * `docs/gas.md`, and both unenforceable on chain —
 * every assertion below is about one of them.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

/** The redeemer key's address — `Config.params().redeemer`. */
const REDEEMER = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const PROVIDER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
const NOW = 1_800_000_000;

/** Distinct payers, so a batch may hold one of each. */
function payerAddress(index: number): `0x${string}` {
  return getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);
}

const HEALTHY_ESCROW = {
  balance: 5_000_000n,
  seqHigh: 0n,
  authNonce: 0n,
  maxVoucherAmount: 2_000_000n,
  maxPerWindow: 10_000_000n,
  spentInWindow: 0n,
  windowStartedAt: BigInt(NOW - 3_600),
  withdrawRequested: 0n,
  withdrawAvailableAt: 0n,
  totalRedeemed: 0n,
  totalWithdrawn: 0n,
  totalFunded: 5_000_000n,
};

const PARAMS = {
  treasury: '0x000000000000000000000000000000000000dEaD',
  redeemer: REDEEMER,
  unbondingPeriodSeconds: 1_209_600n,
  minimumStake: 50_000_000n,
  penaltyAmount: 1_000_000n,
  verifierDailyCap: 100_000_000n,
  takeRateBps: 1_200,
  slashAgentBps: 5_000,
  slashPlatformBps: 3_000,
  slashCapBps: 2_000,
};

function request(
  index: number,
  overrides: Partial<RedeemVoucherRequest> = {},
): RedeemVoucherRequest {
  return {
    payer: toAccountId(TESTNET, payerAddress(index)),
    provider: toAccountId(TESTNET, PROVIDER),
    amount: MoneyUtil.of('1000000', USDG, 6),
    asset: USDG,
    resourceHash: `sha256:${'ab'.repeat(32)}`,
    requestHash: 'cd'.repeat(32),
    seq: '10',
    issuedAt: NOW - 10,
    expiresAt: NOW + 60,
    signature: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
    ...overrides,
  };
}

interface ChainState {
  paused: boolean;
  redeemer: string;
  minimumStake: bigint;
  bonded: bigint;
  /** `stakeOf(provider).pendingSlash`: reserved by standing slash records. */
  pendingSlash: bigint;
  /** Per payer ADDRESS (lower case). Anything absent uses `HEALTHY_ESCROW`. */
  escrows: Record<string, Record<string, bigint>>;
  /** `payer:delegate` (lower case) → the delegate's grant. */
  delegations: Record<string, Record<string, unknown>>;
  /** What an `eth_call` of the redemption answers: null = it would settle. */
  simulateRevert: string | null;
  /** Every simulated function, in order. */
  simulated: string[];
  /** The `account` (msg.sender) every simulation was run from, in order. */
  simulatedFrom: string[];
  /** The `eth_call` itself fails (an outage, no revert data). */
  simulateOutage: boolean;
  /** Whether the escrow has the tighten delay (D-21), as the probe reports it. */
  tightenDelay: boolean;
  /** `payer:delegate` (lower case) → what `effectiveCapsOf` answers, when set. */
  effective: Record<string, readonly [bigint, bigint, bigint, bigint]>;
  /** Every function the multicalls read, in order. */
  read: string[];
  /**
   * `payer:seq` (payer lower case) → `HeldStatus` (1 Held, 2 Collected,
   * 3 Refunded). Anything absent is 0, `None`: the seq is unused.
   */
  held: Record<string, number>;
  /** `block.timestamp` as Multicall3 answers it; `NOW` unless a test moves it. */
  blockTimestamp: number;
  /** `payer:seq` → the provider and amount the held record names. */
  heldTerms: Record<string, { provider: string; amount: bigint }>;
  /** This process's wall clock, seconds. */
  wallClock: number;
  /** The client's `eth_call` to NodeInterface; absent = a client without `call`. */
  nodeInterface: jest.Mock | null;
  /** The `gas` every simulation was run with, in order. */
  simulatedGas: bigint[];
}

function harness(
  overrides: Partial<ChainState> = {},
  float: EvmSendFloat | null = null,
  hourly: Pick<EvmRedeemerHourlyBudget, 'take' | 'settle'> | null = null,
) {
  const state: ChainState = {
    paused: false,
    redeemer: REDEEMER,
    minimumStake: 50_000_000n,
    bonded: 50_000_000n,
    pendingSlash: 0n,
    escrows: {},
    delegations: {},
    simulateRevert: null,
    simulated: [],
    simulatedFrom: [],
    simulateOutage: false,
    tightenDelay: false,
    effective: {},
    read: [],
    held: {},
    blockTimestamp: NOW,
    heldTerms: {},
    wallClock: NOW,
    nodeInterface: null,
    simulatedGas: [],
    ...overrides,
  };

  const answer = (functionName: string, args: readonly unknown[]): unknown => {
    switch (functionName) {
      case 'params':
        return { ...PARAMS, redeemer: state.redeemer, minimumStake: state.minimumStake };
      case 'paused':
        return state.paused;
      case 'escrowOf': {
        const key = String(args[0]).toLowerCase();
        return { ...HEALTHY_ESCROW, ...(state.escrows[key] ?? {}) };
      }
      case 'stakeOf':
        return { bonded: state.bonded, unbonding: 0n, pendingSlash: state.pendingSlash };
      case 'getCurrentBlockTimestamp':
        return BigInt(state.blockTimestamp);
      case 'held': {
        const key = `${String(args[0]).toLowerCase()}:${String(args[1])}`;
        return {
          provider: state.heldTerms[key]?.provider ?? PROVIDER,
          amount: state.heldTerms[key]?.amount ?? 0n,
          takeRateBps: 0,
          status: state.held[key] ?? 0,
          collectableAt: 0n,
        };
      }
      case 'delegationOf': {
        const key = `${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`;
        return {
          maxVoucherAmount: 0n,
          maxPerWindow: 0n,
          spentInWindow: 0n,
          windowStartedAt: 0n,
          validUntil: 0n,
          listPosition: 0,
          revoked: false,
          ...(state.delegations[key] ?? {}),
        };
      }
      case 'effectiveCapsOf': {
        const key = `${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`;
        if (state.effective[key]) return state.effective[key];
        const escrow = answer('escrowOf', [args[0]]) as Record<string, bigint>;
        const grant = answer('delegationOf', args) as {
          maxVoucherAmount: bigint;
          maxPerWindow: bigint;
          validUntil: bigint;
          revoked: boolean;
        };
        const canSign = grant.validUntil >= BigInt(NOW) && !grant.revoked;
        return [
          escrow.maxVoucherAmount,
          escrow.maxPerWindow,
          canSign ? grant.maxVoucherAmount : 0n,
          canSign ? grant.maxPerWindow : 0n,
        ];
      }
      case 'redeemVoucher':
      case 'redeemVoucherBatch':
        state.simulated.push(functionName);
        if (state.simulateOutage) throw new Error('fetch failed');
        if (state.simulateRevert !== null) {
          throw Object.assign(new Error('execution reverted'), {
            data: toFunctionSelector(`${state.simulateRevert}()`),
          });
        }
        return undefined;
      default:
        throw new Error(`unexpected read of ${functionName}`);
    }
  };

  const client: EvmReaderClient = {
    readContract: async (args) => {
      const from = (args as { account?: string }).account;
      if (from !== undefined) state.simulatedFrom.push(from);
      const gas = (args as { gas?: bigint }).gas;
      if (gas !== undefined) state.simulatedGas.push(gas);
      return answer(args.functionName, args.args);
    },
    ...(state.nodeInterface ? { call: state.nodeInterface } : {}),
    multicall: async (args) =>
      args.contracts.map((c) => {
        state.read.push(c.functionName);
        return answer(c.functionName, c.args);
      }),
  };

  const sendCall = jest.fn<Promise<EvmRelayResult>, [EvmRelayedCall]>().mockResolvedValue({
    hash: '0xfeed',
    status: 'SUCCESS',
    revertReason: null,
    gasUsed: 100_000n,
    blockNumber: 1n,
  });

  const redeemerPort: EvmRelayerPort = {
    name: 'fake-redeemer',
    address: async () => toAccountId(TESTNET, REDEEMER),
    balanceWei: async () => 10n ** 18n,
    sendCall,
    sendValue: async (_transfer: EvmValueTransfer) => {
      throw new Error('the redeemer must never send value');
    },
  };

  const emitted: Alert[] = [];
  const alerts: AlertPort = {
    emit: async (alert: Alert) => {
      emitted.push(alert);
    },
  } as unknown as AlertPort;

  const redeemer = new EvmVoucherRedeemer(
    new Map<ChainId, EvmReaderClient>([[TESTNET, client]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    redeemerPort,
    alerts,
    { now: () => state.wallClock * 1000 },
    { isLive: async () => state.tightenDelay },
    null,
    float,
    hourly,
  );

  return { redeemer, sendCall, emitted, state };
}

function calledFunction(call: EvmRelayedCall): string {
  return decodeFunctionData({ abi: ASSAY_ESCROW_ABI, data: call.data }).functionName;
}

function batchedPayers(call: EvmRelayedCall): string[] {
  const decoded = decodeFunctionData({ abi: ASSAY_ESCROW_ABI, data: call.data });
  const vouchers = decoded.args?.[0] as readonly { payer: string }[];
  return vouchers.map((v) => v.payer.toLowerCase());
}

describe('EvmVoucherRedeemer', () => {
  it('takes 64 in one transaction, and says so', () => {
    const { redeemer } = harness();
    expect(redeemer.maxBatchSize).toBe(64);
    expect(redeemer.maxBatchSize).toBe(EVM_CONSTANTS.MAX_REDEEM_BATCH);
  });

  it('redeems a single voucher through redeemVoucher, not the batch entry point', async () => {
    const { redeemer, sendCall } = harness();

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(outcome.signature).toBe('0xfeed');
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucher');
  });

  it('batches many through redeemVoucherBatch, in the order it was handed', async () => {
    const { redeemer, sendCall } = harness();

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'REDEEMED', 'REDEEMED']);
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucherBatch');
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([
      payerAddress(0).toLowerCase(),
      payerAddress(1).toLowerCase(),
      payerAddress(2).toLowerCase(),
    ]);
  });

  it('never submits a voucher pre-validation refused, and still reports it', async () => {
    // Payer 1's escrow has already used seq 10, so their voucher is dead.
    // Submitting it would revert the batch and take two good ones with it.
    const { redeemer, sendCall } = harness({
      held: { [`${payerAddress(1).toLowerCase()}:10`]: 1 },
    });

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([
      payerAddress(0).toLowerCase(),
      payerAddress(2).toLowerCase(),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'UNREDEEMABLE', 'REDEEMED']);
    expect(outcomes[1].programError).toBe('VoucherSeqUsed');
    expect(outcomes[1].signature).toBeNull();
  });

  /** D-23: each `(payer, seq)` once, in any order. */
  describe('per-seq replay (D-23)', () => {
    it('redeems a lower seq after a higher one: seq <= seqHigh is not refused', async () => {
      const { redeemer, sendCall, state } = harness({
        escrows: { [payerAddress(0).toLowerCase()]: { seqHigh: 11n } },
      });

      const outcome = await redeemer.redeem(request(0, { seq: '10' }));

      expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
      expect(sendCall).toHaveBeenCalledTimes(1);
      expect(state.read).toContain('held');
    });

    it.each([
      ['held', 1],
      ['collected', 2],
      ['refunded', 3],
    ])('refuses a %s seq as VoucherSeqUsed, and sends nothing', async (_, status) => {
      const { redeemer, sendCall } = harness({
        held: { [`${payerAddress(0).toLowerCase()}:10`]: status },
      });

      const outcome = await redeemer.redeem(request(0));

      expect(outcome).toEqual({
        kind: RedeemOutcomeKind.UNREDEEMABLE,
        signature: null,
        programError: 'VoucherSeqUsed',
      });
      expect(sendCall).not.toHaveBeenCalled();
    });

    it('batches several seqs of ONE payer, out of order, in one transaction', async () => {
      const { redeemer, sendCall } = harness();

      const outcomes = await redeemer.redeemBatch([
        request(0, { seq: '12' }),
        request(0, { seq: '10' }),
        request(0, { seq: '11' }),
      ]);

      expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'REDEEMED', 'REDEEMED']);
      expect(sendCall).toHaveBeenCalledTimes(1);
      expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucherBatch');
      expect(batchedPayers(sendCall.mock.calls[0][0])).toHaveLength(3);
    });

    it('applies an earlier item’s spend to the next one of the same payer', async () => {
      // 1.5 USDG in the escrow: the first 1.0 settles, the second does not fit
      // and is left out instead of reverting the batch.
      const { redeemer, sendCall } = harness({
        escrows: { [payerAddress(0).toLowerCase()]: { balance: 1_500_000n } },
      });

      const outcomes = await redeemer.redeemBatch([
        request(0, { seq: '10' }),
        request(0, { seq: '11' }),
      ]);

      expect(outcomes.map((o) => o.programError)).toEqual([null, 'EscrowInsufficient']);
      expect(batchedPayers(sendCall.mock.calls[0][0])).toHaveLength(1);
    });

    it('says it does not require ascending seq', () => {
      expect(harness().redeemer.requiresAscendingSeq()).toBe(false);
    });
  });

  it('sends nothing at all when pre-validation refuses every item', async () => {
    const { redeemer, sendCall } = harness({ minimumStake: 60_000_000n });

    const outcomes = await redeemer.redeemBatch([request(0), request(1)]);

    expect(sendCall).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.programError)).toEqual([
      'ProviderBelowMinimumStake',
      'ProviderBelowMinimumStake',
    ]);
    // Retryable: the provider can top their stake back up.
    expect(outcomes.map((o) => o.kind)).toEqual(['RETRY', 'RETRY']);
  });

  it('reads the provider stake against the minimum live (review M3)', async () => {
    const below = harness({ minimumStake: 60_000_000n });
    await expect(below.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(true);

    const fine = harness();
    await expect(fine.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(false);
  });

  it('reads FREE bonded stake: bonded less what standing slash records reserve (D-26)', async () => {
    // 60 bonded, 11 reserved by pending/disputed records: 49 free, below 50.
    const reserved = harness({ bonded: 60_000_000n, pendingSlash: 11_000_000n });
    await expect(reserved.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(true);
    const outcomes = await reserved.redeemer.redeemBatch([request(0)]);
    expect(outcomes.map((o) => [o.kind, o.programError])).toEqual([
      ['RETRY', 'ProviderBelowMinimumStake'],
    ]);
    expect(reserved.sendCall).not.toHaveBeenCalled();
    expect(reserved.state.read).toContain('stakeOf');

    // Exactly the minimum free passes; more reserved than bonded floors at zero.
    const exact = harness({ bonded: 60_000_000n, pendingSlash: 10_000_000n });
    await expect(exact.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(false);
    const over = harness({ bonded: 60_000_000n, pendingSlash: 90_000_000n });
    await expect(over.redeemer.providerBelowMinimumStake(request(0))).resolves.toBe(true);
  });

  describe('decides expiry on the chain clock, not this process’s (review 2026-10-23 L-4)', () => {
    const deadline = NOW + 60 + EVM_CONSTANTS.REDEEM_GRACE_SECONDS;

    it('redeems a voucher the wall clock calls expired while the chain still accepts it', async () => {
      const { redeemer, sendCall } = harness({
        blockTimestamp: deadline - 5,
        wallClock: deadline + 30,
      });
      const outcome = await redeemer.redeem(request(0));
      expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });

    it('refuses VoucherExpired once the chain is past the deadline, the wall clock within tolerance', async () => {
      // The chain 101 s ahead of the wall clock: inside the 120 s tolerance.
      const { redeemer, sendCall, state } = harness({ wallClock: deadline - 100 });
      state.blockTimestamp = deadline + 1;
      const outcome = await redeemer.redeem(request(0));
      expect(outcome).toMatchObject({
        kind: RedeemOutcomeKind.UNREDEEMABLE,
        programError: 'VoucherExpired',
      });
      expect(sendCall).not.toHaveBeenCalled();
    });

    describe('a chain clock more than 120 s ahead never finalizes an expiry alone', () => {
      let warn: jest.SpyInstance;
      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      });
      afterEach(() => warn.mockRestore());

      it('holds the decision (bare RETRY, tagged log) while the wall clock says the voucher is live', async () => {
        const { redeemer, sendCall, state } = harness();
        state.blockTimestamp = deadline + 1; // 7,261 s ahead of the wall clock
        const outcome = await redeemer.redeem(request(0));
        expect(outcome).toEqual({
          kind: RedeemOutcomeKind.RETRY,
          signature: null,
          programError: null,
        });
        expect(sendCall).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
          EVM_EXPIRY_HELD_LOG_TAG,
        );

        // Batched too.
        const batch = await redeemer.redeemBatch([request(0), request(1)]);
        expect(batch.map((o) => [o.kind, o.programError])).toEqual([
          [RedeemOutcomeKind.RETRY, null],
          [RedeemOutcomeKind.RETRY, null],
        ]);
      });

      it('holds a VoucherExpired the simulation answers, too', async () => {
        const { redeemer, state } = harness();
        state.blockTimestamp = NOW + 121;
        state.simulateRevert = 'VoucherExpired';
        await expect(redeemer.redeem(request(0))).resolves.toMatchObject({
          kind: RedeemOutcomeKind.RETRY,
          programError: null,
        });
      });

      it('finalizes it once the wall clock (plus the tolerance) is past the deadline as well', async () => {
        const { redeemer, state } = harness({ wallClock: deadline - 119 });
        state.blockTimestamp = deadline + 200; // 319 s ahead
        await expect(redeemer.redeem(request(0))).resolves.toMatchObject({
          kind: RedeemOutcomeKind.UNREDEEMABLE,
          programError: 'VoucherExpired',
        });
      });
    });

    it('alerts when block.timestamp is more than 120 s from the wall clock, and not within it', async () => {
      const near = harness();
      near.state.blockTimestamp = NOW + 120;
      await near.redeemer.redeem(request(0));
      expect(near.emitted.filter((a) => a.name === EVM_CLOCK_DRIFT_ALERT)).toHaveLength(0);

      const far = harness();
      far.state.blockTimestamp = NOW - 121;
      await far.redeemer.redeem(request(0));
      const drift = far.emitted.filter((a) => a.name === EVM_CLOCK_DRIFT_ALERT);
      expect(drift).toHaveLength(1);
      expect(drift[0].details).toMatchObject({ driftSeconds: -121 });
    });
  });

  describe('usedSeqRecord: what held(payer, seq) says about this voucher (M-B1)', () => {
    const key = `${payerAddress(0).toLowerCase()}:10`;

    it.each([
      [1, 'HELD'],
      [2, 'COLLECTED'],
      [3, 'REFUNDED'],
    ])(
      'answers the status (%s → %s) when the record names this voucher’s provider and amount (F-L3)',
      async (status, expected) => {
        const { redeemer } = harness({
          held: { [key]: status },
          heldTerms: { [key]: { provider: PROVIDER, amount: 1_000_000n } },
        });
        await expect(redeemer.usedSeqRecord(request(0))).resolves.toBe(expected);
      },
    );

    it('cannot tell (throws) on a HeldStatus this build does not know', async () => {
      const { redeemer } = harness({
        held: { [key]: 4 },
        heldTerms: { [key]: { provider: PROVIDER, amount: 1_000_000n } },
      });
      await expect(redeemer.usedSeqRecord(request(0))).rejects.toThrow(/HeldStatus 4/);
    });

    it('MISMATCH when it names another provider or another amount', async () => {
      const other = harness({
        held: { [key]: 2 },
        heldTerms: { [key]: { provider: payerAddress(9), amount: 1_000_000n } },
      });
      await expect(other.redeemer.usedSeqRecord(request(0))).resolves.toBe('MISMATCH');
      const amount = harness({
        held: { [key]: 1 },
        heldTerms: { [key]: { provider: PROVIDER, amount: 999_999n } },
      });
      await expect(amount.redeemer.usedSeqRecord(request(0))).resolves.toBe('MISMATCH');
    });

    it('NONE when the seq is unused', async () => {
      const { redeemer } = harness();
      await expect(redeemer.usedSeqRecord(request(0))).resolves.toBe('NONE');
    });
  });

  it('retries SINGLY when the batch reverts, and never re-submits the batch', async () => {
    const { redeemer, sendCall } = harness();
    sendCall.mockResolvedValueOnce({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'EscrowInsufficient',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    await redeemer.redeemBatch([request(0), request(1), request(2)]);

    // One batch attempt, then three singles. A fourth batch call is the bug
    // this test exists for: it reverts identically, for ever.
    expect(sendCall).toHaveBeenCalledTimes(4);
    expect(calledFunction(sendCall.mock.calls[0][0])).toBe('redeemVoucherBatch');
    for (const [call] of sendCall.mock.calls.slice(1)) {
      expect(calledFunction(call)).toBe('redeemVoucher');
    }
  });

  it('reports each single retry on its OWN item, not the batch verdict', async () => {
    // The failure this catches: marking all three UNREDEEMABLE (or all three
    // RETRY) because the batch said EscrowInsufficient, when only one of them
    // was short.
    const { redeemer, sendCall } = harness();
    const reverted = (reason: string): EvmRelayResult => ({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: reason,
      gasUsed: 10n,
      blockNumber: 1n,
    });
    const ok = (hash: string): EvmRelayResult => ({
      hash,
      status: 'SUCCESS',
      revertReason: null,
      gasUsed: 10n,
      blockNumber: 1n,
    });

    sendCall
      .mockResolvedValueOnce(reverted('EscrowInsufficient'))
      .mockResolvedValueOnce(ok('0xa'))
      .mockResolvedValueOnce(reverted('EscrowInsufficient'))
      .mockResolvedValueOnce(ok('0xc'));

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes.map((o) => o.kind)).toEqual(['REDEEMED', 'RETRY', 'REDEEMED']);
    expect(outcomes.map((o) => o.signature)).toEqual(['0xa', null, '0xc']);
  });

  it('keeps a pre-validation refusal on its own row through a batch revert', async () => {
    // The refused item is not in the batch and must not be in the retry either
    // — its outcome came from the pre-validation and is still the right one.
    const { redeemer, sendCall } = harness({
      held: { [`${payerAddress(1).toLowerCase()}:10`]: 2 },
    });
    sendCall.mockResolvedValueOnce({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'EscrowInsufficient',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    // 1 batch + 2 singles. The refused one was never sent, twice over.
    expect(sendCall).toHaveBeenCalledTimes(3);
    expect(outcomes[1].kind).toBe(RedeemOutcomeKind.UNREDEEMABLE);
    expect(outcomes[1].programError).toBe('VoucherSeqUsed');
  });

  it('refuses the SAME voucher twice in one batch, before anything is read', async () => {
    // The second copy would fail `VoucherSeqUsed` because the first already
    // used the seq, and take the whole batch with it.
    const { redeemer, sendCall, state } = harness();

    await expect(redeemer.redeemBatch([request(0), request(0)])).rejects.toThrow(/twice/i);
    expect(state.read).toEqual([]);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('refuses a batch of 65 and accepts a batch of 64', async () => {
    const { redeemer } = harness();
    const sixtyFour = Array.from({ length: 64 }, (_, i) => request(i));

    await expect(redeemer.redeemBatch([...sixtyFour, request(64)])).rejects.toThrow(/64/);
    await expect(redeemer.redeemBatch(sixtyFour)).resolves.toHaveLength(64);
  });

  it('an unknown revert is RETRY, never UNREDEEMABLE, and it alerts', async () => {
    // Absorbing a hold because the reason could not be read charges a buyer for
    // nothing. The alert is the other half.
    const { redeemer, sendCall, emitted } = harness();
    sendCall.mockResolvedValue({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: 'UNKNOWN_REVERT:0xdeadbeef',
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const [outcome] = await redeemer.redeemBatch([request(0)]);

    expect(outcome.kind).toBe(RedeemOutcomeKind.RETRY);
    expect(outcome.programError).toBe('UNKNOWN_REVERT:0xdeadbeef');
    expect(emitted.length).toBeGreaterThan(0);
  });

  it.each([
    ['ProgramPaused', RedeemOutcomeKind.PAUSED],
    ['NotRedeemer', RedeemOutcomeKind.MISCONFIGURED],
    ['AssetDecimalsNotSix', RedeemOutcomeKind.MISCONFIGURED],
    ['VoucherSeqUsed', RedeemOutcomeKind.UNREDEEMABLE],
    ['SignerIsNotPayer', RedeemOutcomeKind.UNREDEEMABLE],
    ['MalleableSignature', RedeemOutcomeKind.UNREDEEMABLE],
    ['VoucherSeqGapTooLarge', RedeemOutcomeKind.UNREDEEMABLE],
    ['DelegateWindowLimitExceeded', RedeemOutcomeKind.RETRY],
    // A re-grant or a raised cap before the deadline revives the same voucher,
    // so these are retried until then (review-buyer-debt M3).
    ['DelegateVoucherExceedsPerCallLimit', RedeemOutcomeKind.RETRY],
    ['DelegateIsRevoked', RedeemOutcomeKind.RETRY],
    ['DelegateIsExpired', RedeemOutcomeKind.RETRY],
    ['EscrowInsufficient', RedeemOutcomeKind.RETRY],
    ['VoucherNotYetValid', RedeemOutcomeKind.RETRY],
    ['ProviderBelowMinimumStake', RedeemOutcomeKind.RETRY],
  ])('maps the revert %s to %s', async (reason, kind) => {
    const { redeemer, sendCall } = harness();
    sendCall.mockResolvedValue({
      hash: '0xbad',
      status: 'REVERTED',
      revertReason: reason,
      gasUsed: 10n,
      blockNumber: 1n,
    });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(kind);
    expect(outcome.programError).toBe(reason);
    expect(outcome.signature).toBeNull();
  });

  it('refuses a seq more than MAX_SEQ_GAP above seqHigh before simulating or sending', async () => {
    const seqHigh = 5n;
    const gap = BigInt(EVM_CONSTANTS.MAX_SEQ_GAP);
    const { redeemer, sendCall, state } = harness({
      escrows: { [payerAddress(0).toLowerCase()]: { seqHigh } },
    });

    const refused = await redeemer.redeem(request(0, { seq: (seqHigh + gap + 1n).toString() }));

    expect(refused).toMatchObject({
      kind: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherSeqGapTooLarge',
    });
    expect(state.simulated).toEqual([]);
    expect(sendCall).not.toHaveBeenCalled();

    // Exactly the gap is the chain's own boundary, and settles.
    const accepted = await redeemer.redeem(request(0, { seq: (seqHigh + gap).toString() }));
    expect(accepted.kind).toBe(RedeemOutcomeKind.REDEEMED);
  });

  it('reports PAUSED without sending, when the chain says paused', async () => {
    const { redeemer, sendCall } = harness({ paused: true });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.PAUSED);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('reports MISCONFIGURED without sending, when its key is not the configured redeemer', async () => {
    // `msg.sender != p.redeemer` refuses EVERY hold identically until an admin
    // acts. Retrying would burn a fee per hold per pass for ever; absorbing
    // would hand every buyer their money back for a one-transaction fix.
    const { redeemer, sendCall } = harness({ redeemer: PROVIDER });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.MISCONFIGURED);
    expect(outcome.programError).toBe('NotRedeemer');
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('sends to the escrow contract, never to the payer or the stake contract', async () => {
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0));

    expect(sendCall.mock.calls[0][0].to).toBe(toAccountId(TESTNET, DEPLOYMENT.escrow));
  });

  it('budgets gas that stays well under the chain transaction ceiling at 64', async () => {
    // `ArbGasInfo.getGasAccountingParams()` → `maxTxGasLimit = 32,000,000` on
    // both 4663 and 46630. A budget that exceeded it would be a batch the node
    // refuses outright, which is not a revert and carries no reason.
    const { redeemer, sendCall } = harness();
    await redeemer.redeemBatch(Array.from({ length: 64 }, (_, i) => request(i)));

    const gas = sendCall.mock.calls[0][0].gasLimit;
    expect(gas).toBe(EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * 64n);
    expect(gas).toBeLessThan(32_000_000n);
    // And above the worst measured batch of 64 (5,235,730), or the batch runs
    // out of gas having spent it.
    expect(gas).toBeGreaterThan(5_235_730n);
  });

  it('refuses a batch that spans two chains', async () => {
    const { redeemer } = harness();

    await expect(
      redeemer.redeemBatch([
        request(0),
        request(1, { payer: `${CHAIN_IDS.BASE_SEPOLIA}:${payerAddress(1)}` as AccountId }),
      ]),
    ).rejects.toThrow();
  });

  it('answers an empty batch with an empty array and no transaction', async () => {
    const { redeemer, sendCall } = harness();

    await expect(redeemer.redeemBatch([])).resolves.toEqual([]);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('carries the signed voucher fields onto the wire unchanged', async () => {
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0, { seq: '10', amount: MoneyUtil.of('1000000', USDG, 6) }));

    const decoded = decodeFunctionData({
      abi: ASSAY_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    const voucher = decoded.args?.[0] as Record<string, unknown>;
    expect(voucher).toEqual({
      payer: payerAddress(0),
      provider: getAddress(PROVIDER),
      amount: 1_000_000n,
      // `sha256:` is this codebase's prefix, not a chain value — the contract
      // signs 32 raw bytes.
      resourceHash: `0x${'ab'.repeat(32)}`,
      requestHash: `0x${'cd'.repeat(32)}`,
      seq: 10n,
      issuedAt: BigInt(NOW - 10),
      expiresAt: BigInt(NOW + 60),
    });
    expect(decoded.args?.[1]).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`);
  });

  it('accepts the requestHash exactly as a platform-recorded intent carries it', async () => {
    // `VoucherService.record` stores `voucher.requestHash` verbatim, and on this
    // platform that is `computeRequestHash`'s `sha256:<64 hex>`.
    // `VoucherRedemptionService` replays that column unchanged, so a redeemer
    // that accepted only bare hex refused EVERY voucher the platform itself had
    // recorded — `yarn testnet:e2` never saw it because it passed bare hex.
    const { redeemer, sendCall } = harness();

    await redeemer.redeem(request(0, { requestHash: `sha256:${'cd'.repeat(32)}` }));

    const decoded = decodeFunctionData({
      abi: ASSAY_ESCROW_ABI,
      data: sendCall.mock.calls[0][0].data,
    });
    expect((decoded.args?.[0] as Record<string, unknown>).requestHash).toBe(`0x${'cd'.repeat(32)}`);
  });

  it('refuses a signature that is not a 65-byte secp256k1 tuple', async () => {
    const { redeemer } = harness();

    await expect(redeemer.redeem(request(0, { signature: 'not-hex' }))).rejects.toThrow(
      /signature/i,
    );
  });

  // ── Review S2-2: nothing the chain would refuse is ever broadcast ─────────

  describe('simulates before every broadcast', () => {
    it('does not broadcast a batch the chain would refuse; it goes to the singles, which simulate too', async () => {
      const { redeemer, sendCall, state } = harness({ simulateRevert: 'SignerIsNotPayer' });
      const outcomes = await redeemer.redeemBatch([request(0), request(1)]);
      expect(sendCall).not.toHaveBeenCalled();
      expect(state.simulated).toEqual(['redeemVoucherBatch', 'redeemVoucher', 'redeemVoucher']);
      expect(outcomes.map((o) => o.kind)).toEqual([
        RedeemOutcomeKind.UNREDEEMABLE,
        RedeemOutcomeKind.UNREDEEMABLE,
      ]);
    });

    it('does not broadcast a single redemption the chain would refuse', async () => {
      const { redeemer, sendCall } = harness({ simulateRevert: 'DelegateIsRevoked' });
      const outcome = await redeemer.redeem(request(0));
      expect(sendCall).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        kind: RedeemOutcomeKind.RETRY,
        programError: 'DelegateIsRevoked',
      });
    });

    it('simulates with the redeemer as sender and the gas it will send', async () => {
      const { redeemer, sendCall, state } = harness();
      await redeemer.redeem(request(0));
      expect(state.simulated).toEqual(['redeemVoucher']);
      // `msg.sender` of the simulation is the REDEEMER port's account — the
      // key that will send — never some other relayer.
      expect(state.simulatedFrom).toEqual([REDEEMER]);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the simulation cannot be answered (an outage, not a revert)', async () => {
      const { redeemer, sendCall } = harness({ simulateOutage: true });
      await expect(redeemer.redeem(request(0))).rejects.toThrow('fetch failed');
      expect(sendCall).not.toHaveBeenCalled();
    });
  });

  describe('pre-validates a delegate-signed voucher against the delegate’s grant', () => {
    const DELEGATE = '0x5555555555555555555555555555555555555555';
    const grantKey = (index: number) => `${payerAddress(index).toLowerCase()}:${DELEGATE}`;
    const live = {
      maxVoucherAmount: 2_000_000n,
      maxPerWindow: 5_000_000n,
      validUntil: BigInt(NOW + 3600),
      listPosition: 1,
    };

    it.each([
      ['revoked', { ...live, revoked: true }, 'DelegateIsRevoked', RedeemOutcomeKind.RETRY],
      [
        'lapsed',
        { ...live, validUntil: BigInt(NOW - 1) },
        'DelegateIsExpired',
        RedeemOutcomeKind.RETRY,
      ],
      ['never authorised', { validUntil: 0n }, 'SignerIsNotPayer', RedeemOutcomeKind.UNREDEEMABLE],
      [
        'over its per-voucher cap',
        { ...live, maxVoucherAmount: 999_999n },
        'DelegateVoucherExceedsPerCallLimit',
        RedeemOutcomeKind.RETRY,
      ],
      [
        'over its window',
        { ...live, spentInWindow: 4_500_000n, windowStartedAt: BigInt(NOW) },
        'DelegateWindowLimitExceeded',
        RedeemOutcomeKind.RETRY,
      ],
    ])('a %s delegate is refused before anything is sent', async (_name, grant, error, kind) => {
      const { redeemer, sendCall, state } = harness();
      state.delegations[grantKey(0)] = grant;
      const outcome = await redeemer.redeem(
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
      );
      expect(outcome).toMatchObject({ kind, programError: error });
      expect(sendCall).not.toHaveBeenCalled();
      expect(state.simulated).toEqual([]);
    });

    it('batches a live delegate’s voucher, and keeps a revoked one out of the batch', async () => {
      const { redeemer, sendCall, state } = harness();
      state.delegations[grantKey(0)] = live;
      state.delegations[grantKey(1)] = { ...live, revoked: true };
      const outcomes = await redeemer.redeemBatch([
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
        request(1, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
        request(2),
      ]);
      expect(sendCall).toHaveBeenCalledTimes(1);
      const call = sendCall.mock.calls[0][0];
      const decoded = decodeFunctionData({ abi: ASSAY_ESCROW_ABI, data: call.data });
      expect((decoded.args as unknown as unknown[][])[0]).toHaveLength(2);
      expect(outcomes.map((o) => o.kind)).toEqual([
        RedeemOutcomeKind.REDEEMED,
        RedeemOutcomeKind.RETRY,
        RedeemOutcomeKind.REDEEMED,
      ]);
    });
  });

  describe('on an escrow with the tighten delay (D-21), reads the EFFECTIVE caps', () => {
    const DELEGATE = '0x5555555555555555555555555555555555555555';
    const grantKey = (index: number) => `${payerAddress(index).toLowerCase()}:${DELEGATE}`;
    const ownKey = (index: number) =>
      `${payerAddress(index).toLowerCase()}:0x0000000000000000000000000000000000000000`;
    const live = {
      maxVoucherAmount: 2_000_000n,
      maxPerWindow: 5_000_000n,
      validUntil: BigInt(NOW + 3600),
      listPosition: 1,
    };

    it('does not ask effectiveCapsOf before the upgrade is seen', async () => {
      const { redeemer, state } = harness();
      await redeemer.redeem(request(0));
      expect(state.read).not.toContain('effectiveCapsOf');
    });

    it('redeems a voucher over a cap the payer lowered less than an hour ago', async () => {
      const { redeemer, sendCall, state } = harness({ tightenDelay: true });
      // Stored per-voucher cap lowered to 0.5; the chain still holds 2 for an hour.
      state.escrows[payerAddress(0).toLowerCase()] = { maxVoucherAmount: 500_000n };
      state.effective[ownKey(0)] = [2_000_000n, 10_000_000n, 0n, 0n];
      const outcome = await redeemer.redeem(request(0));
      expect(state.read).toContain('effectiveCapsOf');
      expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });

    it('still refuses over the stored cap once no hold is left', async () => {
      const { redeemer, sendCall, state } = harness({ tightenDelay: true });
      state.escrows[payerAddress(0).toLowerCase()] = { maxVoucherAmount: 500_000n };
      const outcome = await redeemer.redeem(request(0));
      expect(outcome).toMatchObject({ programError: 'VoucherExceedsPerCallLimit' });
      expect(sendCall).not.toHaveBeenCalled();
    });

    it('redeems a revoked delegate’s voucher inside the grace, and batches it', async () => {
      const { redeemer, sendCall, state } = harness({ tightenDelay: true });
      state.delegations[grantKey(0)] = { ...live, revoked: true };
      state.effective[grantKey(0)] = [2_000_000n, 10_000_000n, 2_000_000n, 5_000_000n];
      const outcomes = await redeemer.redeemBatch([
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
        request(1),
      ]);
      expect(outcomes.map((o) => o.kind)).toEqual([
        RedeemOutcomeKind.REDEEMED,
        RedeemOutcomeKind.REDEEMED,
      ]);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });

    it('names a revoked delegate past its grace DelegateIsRevoked, retried (M3)', async () => {
      const { redeemer, sendCall, state } = harness({ tightenDelay: true });
      state.delegations[grantKey(0)] = { ...live, revoked: true };
      const outcome = await redeemer.redeem(
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
      );
      expect(outcome).toMatchObject({
        kind: RedeemOutcomeKind.RETRY,
        programError: 'DelegateIsRevoked',
      });
      expect(sendCall).not.toHaveBeenCalled();
    });

    it('applies the delegate’s held caps, not its lowered stored ones', async () => {
      const { redeemer, sendCall, state } = harness({ tightenDelay: true });
      state.delegations[grantKey(0)] = { ...live, maxVoucherAmount: 500_000n };
      state.effective[grantKey(0)] = [2_000_000n, 10_000_000n, 2_000_000n, 5_000_000n];
      const outcome = await redeemer.redeem(
        request(0, { delegate: toAccountId(TESTNET, getAddress(DELEGATE)) }),
      );
      expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
      expect(sendCall).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * REGRESSION (review 2026-10-15 P-1): `VoucherSeqUsed` (D-23; formerly
   * `VoucherSeqNotIncreasing`) is also what a voucher that already landed gets. The redeemer records each transaction
   * before its broadcast, and can say afterwards whether one of them redeemed
   * this voucher — so the job commits it instead of absorbing it.
   */
  describe('a landing this process did not observe', () => {
    it('records the transaction on the voucher before it is broadcast', async () => {
      const { redeemer, sendCall } = harness();
      const recordAttempt = jest.fn().mockResolvedValue(undefined);
      await redeemer.redeem(request(0, { recordAttempt }));
      const call = sendCall.mock.calls[0][0];
      expect(recordAttempt).not.toHaveBeenCalled();
      await call.beforeBroadcast?.(`0x${'aa'.repeat(32)}`);
      expect(recordAttempt).toHaveBeenCalledWith(`0x${'aa'.repeat(32)}`);
    });

    it('records one batch transaction on every voucher it carries', async () => {
      const { redeemer, sendCall } = harness();
      const first = jest.fn().mockResolvedValue(undefined);
      const second = jest.fn().mockResolvedValue(undefined);
      await redeemer.redeemBatch([
        request(0, { recordAttempt: first }),
        request(1, { recordAttempt: second }),
      ]);
      await sendCall.mock.calls[0][0].beforeBroadcast?.(`0x${'bb'.repeat(32)}`);
      expect(first).toHaveBeenCalledWith(`0x${'bb'.repeat(32)}`);
      expect(second).toHaveBeenCalledWith(`0x${'bb'.repeat(32)}`);
    });

    const LANDED = `0x${'01'.repeat(32)}` as const;
    const REVERTED = `0x${'02'.repeat(32)}` as const;
    const PENDING = `0x${'03'.repeat(32)}` as const;
    const DROPPED = `0x${'04'.repeat(32)}` as const;

    function redeemedLog(payer: `0x${string}`, seq: bigint, requestHash: `0x${string}`) {
      return {
        address: DEPLOYMENT.escrow,
        topics: encodeEventTopics({
          abi: ASSAY_ESCROW_ABI,
          eventName: 'VoucherRedeemed',
          args: { payer, provider: getAddress(PROVIDER) },
        }) as [`0x${string}`, ...`0x${string}`[]],
        data: encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint64' },
            { type: 'uint64' },
            { type: 'uint64' },
            { type: 'uint16' },
            { type: 'uint64' },
          ],
          [requestHash, `0x${'ab'.repeat(32)}`, 1_000_000n, 120_000n, seq, 1_200, 0n],
        ),
      };
    }

    function chainWith(logsFor: (hash: string) => ReturnType<typeof redeemedLog>[]) {
      const notFound = (name: string) => Object.assign(new Error('could not be found'), { name });
      const client = {
        readContract: async () => undefined,
        multicall: async () => [],
        getTransactionReceipt: async ({ hash }: { hash: string }) => {
          if (hash === PENDING || hash === DROPPED) {
            throw notFound('TransactionReceiptNotFoundError');
          }
          return { status: hash === REVERTED ? 'reverted' : 'success', logs: logsFor(hash) };
        },
        getTransaction: async ({ hash }: { hash: string }) => {
          if (hash === DROPPED) throw notFound('TransactionNotFoundError');
          return {};
        },
      };
      return new EvmVoucherRedeemer(
        new Map([[TESTNET, client as unknown as EvmReaderClient]]),
        new Map([[TESTNET, DEPLOYMENT]]),
        {} as EvmRelayerPort,
        { emit: async () => undefined } as unknown as AlertPort,
        { now: () => NOW * 1000 },
      );
    }

    const requestHash = `0x${'cd'.repeat(32)}` as const;

    it('names the mined transaction that emitted VoucherRedeemed for this payer and seq', async () => {
      const redeemer = chainWith((hash) =>
        hash === LANDED ? [redeemedLog(payerAddress(0), 10n, requestHash)] : [],
      );
      await expect(redeemer.findLanding(request(0), [DROPPED, REVERTED, LANDED])).resolves.toBe(
        LANDED,
      );
    });

    it('answers null when no recorded transaction redeemed this voucher', async () => {
      // A landed transaction for ANOTHER seq, and one for another payer, are not this one.
      const redeemer = chainWith(() => [
        redeemedLog(payerAddress(0), 11n, requestHash),
        redeemedLog(payerAddress(1), 10n, requestHash),
      ]);
      await expect(redeemer.findLanding(request(0), [LANDED, REVERTED, DROPPED])).resolves.toBe(
        null,
      );
    });

    it('cannot tell while a recorded transaction is still pending', async () => {
      const redeemer = chainWith(() => []);
      await expect(redeemer.findLanding(request(0), [PENDING])).rejects.toThrow(/pending/);
    });
  });
});

/**
 * Review 2026-10-24 wave 2 M-2: is the provider short of FREE stake only
 * because of records it did not cause (foreign, or signed by a dead key)?
 */
describe('EvmVoucherRedeemer.providerShortOnlyByUnplannedSlashes (M-2)', () => {
  const MINIMUM = 100_000_000n;
  const id = (n: number) => n.toString(16).padStart(64, '0');

  function build(
    stake: { bonded: bigint; pendingSlash: bigint },
    records: { requestId: string; reserved: bigint; status: number; provider?: string }[],
  ) {
    const multicalls: unknown[] = [];
    const client = {
      readContract: async () => undefined,
      multicall: async (args: { contracts: { functionName: string; args: unknown[] }[] }) => {
        multicalls.push(args);
        return args.contracts.map((call) => {
          if (call.functionName === 'params') return { minimumStake: MINIMUM };
          if (call.functionName === 'stakeOf') return { ...stake, unbonding: 0n };
          const record = records.find((r) => `0x${r.requestId}` === call.args[0])!;
          return {
            provider: record.provider ?? PROVIDER,
            status: record.status,
            reserved: record.reserved,
          };
        });
      },
    };
    const asked: [string, string][] = [];
    const redeemer = new EvmVoucherRedeemer(
      new Map([[TESTNET, client as unknown as EvmReaderClient]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      {} as EvmRelayerPort,
      { emit: async () => undefined } as unknown as AlertPort,
      { now: () => NOW * 1000 },
      null,
      {
        standingNotPlanned: async (chainId: string, provider: string) => {
          asked.push([chainId, provider]);
          return records.map(({ requestId, reserved }) => ({ requestId, reserved }));
        },
      },
    );
    return { redeemer, multicalls, asked };
  }

  it('is true when only the unplanned reservations take free stake below the minimum', async () => {
    // bonded 150, pending 51 (51 stolen-key records of 1): free 99 < 100; without them 150.
    const { redeemer, asked } = build({ bonded: 150_000_000n, pendingSlash: 51_000_000n }, [
      { requestId: id(1), reserved: 51_000_000n, status: 1 },
    ]);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(request(0))).resolves.toBe(true);
    expect(asked).toEqual([[TESTNET, PROVIDER.toLowerCase()]]);
  });

  it('is false when the provider is below the minimum for its own reasons too', async () => {
    // bonded 90 < 100 whatever is reserved.
    const { redeemer } = build({ bonded: 90_000_000n, pendingSlash: 1_000_000n }, [
      { requestId: id(1), reserved: 1_000_000n, status: 4 },
    ]);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(request(0))).resolves.toBe(false);
  });

  it('is false when its own records keep it short after the unplanned ones are taken out', async () => {
    // pending 60 = 10 unplanned + 50 of its own: without the 10, free is 140 - 50 = 90 < 100.
    const { redeemer } = build({ bonded: 140_000_000n, pendingSlash: 60_000_000n }, [
      { requestId: id(1), reserved: 10_000_000n, status: 1 },
    ]);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(request(0))).resolves.toBe(false);
  });

  it('counts only records the chain still holds against this provider', async () => {
    const { redeemer } = build({ bonded: 150_000_000n, pendingSlash: 51_000_000n }, [
      { requestId: id(1), reserved: 51_000_000n, status: 3 }, // already cancelled
      { requestId: id(2), reserved: 51_000_000n, status: 1, provider: payerAddress(9) },
    ]);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(request(0))).resolves.toBe(false);
  });

  it('is false, and reads nothing on chain, when there is no unplanned record', async () => {
    const { redeemer, multicalls } = build({ bonded: 0n, pendingSlash: 0n }, []);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(request(0))).resolves.toBe(false);
    expect(multicalls).toEqual([]);
  });

  it('reuses one answer per provider for a short while', async () => {
    const { redeemer, multicalls } = build({ bonded: 150_000_000n, pendingSlash: 51_000_000n }, [
      { requestId: id(1), reserved: 51_000_000n, status: 1 },
    ]);
    await redeemer.providerShortOnlyByUnplannedSlashes(request(0));
    await redeemer.providerShortOnlyByUnplannedSlashes(request(1));
    expect(multicalls).toHaveLength(1);
  });
});

describe('EvmVoucherRedeemer — the L1 half of the gas (Nitro)', () => {
  const budget = (n: number) => EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * BigInt(n);

  it('with an L1 part of 0, sends and simulates with the execution budget alone', async () => {
    const { redeemer, sendCall, state } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
    });

    await redeemer.redeem(request(0));

    expect(sendCall.mock.calls[0][0].gasLimit).toBe(budget(1));
    expect(state.simulatedGas).toEqual([budget(1)]);
  });

  it('adds the L1 part x 1.2 to the limit it simulates and sends with', async () => {
    const nodeInterface = fakeNodeInterface({ l1Gas: 300_000n });
    const { redeemer, sendCall, state } = harness({ nodeInterface });

    await redeemer.redeemBatch([request(0), request(1)]);

    const limit = budget(2) + 360_000n;
    expect(sendCall.mock.calls[0][0].gasLimit).toBe(limit);
    expect(state.simulatedGas).toEqual([limit]);
    // Asked about the exact calldata that was sent.
    expect(nodeInterface.asked[0].data).toBe(sendCall.mock.calls[0][0].data);
  });

  it('defers a single redemption above the cost cap: RETRY FeeSpikeDeferred, nothing sent', async () => {
    const { redeemer, sendCall, state } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 11_800_000n }),
    });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome).toEqual({
      kind: RedeemOutcomeKind.RETRY,
      signature: null,
      programError: FEE_SPIKE_DEFERRED,
    });
    expect(FEE_SPIKE_DEFERRED).toBe('FeeSpikeDeferred');
    expect(sendCall).not.toHaveBeenCalled();
    expect(state.simulated).toEqual([]);
  });

  it('sends anyway above the cost cap when the voucher is near its on-chain deadline', async () => {
    // Deferring past `expiresAt + REDEEM_GRACE_SECONDS` would lose the payment,
    // not the gas: within the waiver window the cap gives way, up to the
    // hard ceiling. 1.52M gas at 0.02 gwei is 3.04e-5 ETH: over 1e-5, under 5e-5.
    const { redeemer, sendCall } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 1_000_000n }),
    });

    const expiresAt = NOW - EVM_CONSTANTS.REDEEM_GRACE_SECONDS + 600;
    const outcome = await redeemer.redeem(request(0, { issuedAt: expiresAt - 60, expiresAt }));

    expect(outcome.programError).not.toBe(FEE_SPIKE_DEFERRED);
    expect(sendCall).toHaveBeenCalledTimes(1);
  });

  it('defers even a voucher near its deadline above the hard ceiling: the waiver is bounded', async () => {
    // 14.48M gas at 0.02 gwei is 2.9e-4 ETH, above the 5e-5 ceiling.
    const { redeemer, sendCall, state } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 11_800_000n }),
    });

    const expiresAt = NOW - EVM_CONSTANTS.REDEEM_GRACE_SECONDS + 600;
    const outcome = await redeemer.redeem(request(0, { issuedAt: expiresAt - 60, expiresAt }));

    expect(outcome).toEqual({
      kind: RedeemOutcomeKind.RETRY,
      signature: null,
      programError: FEE_SPIKE_DEFERRED,
    });
    expect(sendCall).not.toHaveBeenCalled();
    expect(state.simulated).toEqual([]);
  });

  it('defers a whole batch above the cap without splitting it, and keeps its refusals', async () => {
    const { redeemer, sendCall } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 20_000_000n }),
      paused: false,
      escrows: { [payerAddress(1).toLowerCase()]: { balance: 0n } },
    });

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes[0].programError).toBe(FEE_SPIKE_DEFERRED);
    expect(outcomes[2].programError).toBe(FEE_SPIKE_DEFERRED);
    expect(outcomes[1].programError).not.toBe(FEE_SPIKE_DEFERRED);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('scales the cap per voucher: what defers one still sends in a batch of 64', async () => {
    // Just over the one-voucher cap, far under 64 of them.
    const l1Gas = EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM / L2_BASE_FEE;
    const single = harness({ nodeInterface: fakeNodeInterface({ l1Gas }) });
    expect((await single.redeemer.redeem(request(0))).programError).toBe(FEE_SPIKE_DEFERRED);

    const batch = harness({ nodeInterface: fakeNodeInterface({ l1Gas: l1Gas * 4n }) });
    const requests = Array.from({ length: 64 }, (_, i) => request(i));
    const outcomes = await batch.redeemer.redeemBatch(requests);
    expect(outcomes.every((o) => o.kind === RedeemOutcomeKind.REDEEMED)).toBe(true);
    expect(batch.sendCall).toHaveBeenCalledTimes(1);
  });

  it('falls back to L1 = 0 when NodeInterface fails', async () => {
    const { redeemer, sendCall } = harness({
      nodeInterface: fakeNodeInterface(new Error('execution reverted')),
    });

    const outcome = await redeemer.redeem(request(0));

    expect(outcome.kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(sendCall.mock.calls[0][0].gasLimit).toBe(budget(1));
  });
});

describe('EvmVoucherRedeemer — sized to the redeemer float', () => {
  const GWEI = 1_000_000_000n;
  const budget = (n: number) => EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * BigInt(n);
  const RESERVE = 100_000_000_000_000n; // 1e14

  function float(balanceWei: bigint, reserve = RESERVE) {
    return new EvmSendFloat(
      {
        balanceWei: async () => balanceWei,
        feesPerGas: async () => ({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 0n }),
      },
      reserve,
    );
  }

  /** A voucher within the fee-cap waiver window of its on-chain deadline. */
  function urgent(index: number): RedeemVoucherRequest {
    const expiresAt = NOW - EVM_CONSTANTS.REDEEM_GRACE_SECONDS + 600;
    return request(index, { issuedAt: expiresAt - 60, expiresAt });
  }

  it('cuts the batch to what the float pays over the reserve, and leaves the rest unattempted', async () => {
    // Two fit (440k gas × 1 gwei), three do not (560k).
    const { redeemer, sendCall } = harness({}, float(budget(2) * GWEI + RESERVE));

    const outcomes = await redeemer.redeemBatch([0, 1, 2, 3].map((i) => request(i)));

    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual(
      [0, 1].map((i) => payerAddress(i).toLowerCase()),
    );
    expect(sendCall.mock.calls[0][0].gasLimit).toBe(budget(2));
    expect(outcomes[0].kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(outcomes[1].kind).toBe(RedeemOutcomeKind.REDEEMED);
    // Empty: "not attempted", which the redemption pass blocks for the pass.
    expect(outcomes[2]).toBeUndefined();
    expect(outcomes[3]).toBeUndefined();
  });

  it('ends the pass, broadcasting and recording nothing, when not even one fits', async () => {
    const { redeemer, sendCall, state } = harness({}, float(budget(1) * GWEI + RESERVE - 1n));
    const recordAttempt = jest.fn(async () => undefined);

    const error = await redeemer
      .redeemBatch([request(0, { recordAttempt }), request(1, { recordAttempt })])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvmSendRejectedError);
    expect((error as EvmSendRejectedError).reason).toBe('INSUFFICIENT_FUNDS');
    expect((error as EvmSendRejectedError).hash).toBeNull();
    expect(sendCall).not.toHaveBeenCalled();
    expect(state.simulated).toEqual([]);
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('refuses a single the float cannot pay the same way', async () => {
    const { redeemer, sendCall } = harness({}, float(RESERVE));

    await expect(redeemer.redeem(request(0))).rejects.toBeInstanceOf(EvmSendRejectedError);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('lets an urgent voucher spend the reserve, and pays it before anything else', async () => {
    // Above the reserve there is nothing; the reserve covers one redemption.
    const reserve = budget(1) * GWEI;
    const { redeemer, sendCall } = harness({}, float(reserve, reserve));

    const outcomes = await redeemer.redeemBatch([request(0), request(1), urgent(2)]);

    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([payerAddress(2).toLowerCase()]);
    expect(outcomes[2].kind).toBe(RedeemOutcomeKind.REDEEMED);
    // Not thrown away with a throw: the ordinary ones are just not attempted.
    expect(outcomes[0]).toBeUndefined();
    expect(outcomes[1]).toBeUndefined();
  });

  it('keeps what an earlier batch did when the node refuses the next one for funds', async () => {
    const { redeemer, sendCall } = harness({}, float(10n ** 18n));
    sendCall
      .mockResolvedValueOnce({
        hash: '0xfeed',
        status: 'SUCCESS',
        revertReason: null,
        gasUsed: 1n,
        blockNumber: 1n,
      })
      .mockRejectedValueOnce(new EvmSendRejectedError('INSUFFICIENT_FUNDS', '0xabc'));

    const outcomes = await redeemer.redeemBatch([urgent(0), request(1)]);

    expect(outcomes[0].kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(outcomes[1]).toBeUndefined();
  });

  it('sends an urgent voucher as its own batch, so it does not lift the fee cap for the rest', async () => {
    const { redeemer, sendCall } = harness({
      nodeInterface: fakeNodeInterface({ l1Gas: 1_000_000n }),
    });

    const outcomes = await redeemer.redeemBatch([request(0), urgent(1), request(2)]);

    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([payerAddress(1).toLowerCase()]);
    expect(outcomes[1].kind).toBe(RedeemOutcomeKind.REDEEMED);
    expect(outcomes[0].programError).toBe(FEE_SPIKE_DEFERRED);
    expect(outcomes[2].programError).toBe(FEE_SPIKE_DEFERRED);
  });

  it('sends urgent and ordinary vouchers as two batches, urgent first, when fees are normal', async () => {
    const { redeemer, sendCall } = harness();

    const outcomes = await redeemer.redeemBatch([request(0), urgent(1)]);

    expect(sendCall).toHaveBeenCalledTimes(2);
    expect(batchedPayers(sendCall.mock.calls[0][0])).toEqual([payerAddress(1).toLowerCase()]);
    expect(batchedPayers(sendCall.mock.calls[1][0])).toEqual([payerAddress(0).toLowerCase()]);
    expect(outcomes.every((o) => o.kind === RedeemOutcomeKind.REDEEMED)).toBe(true);
  });
});

describe('EvmVoucherRedeemer — the hourly spend budget (review 2026-10-30 I-1)', () => {
  const budgetGas = (n: number) =>
    EVM_REDEEM_BATCH_BASE_GAS + EVM_REDEEM_PER_VOUCHER_GAS * BigInt(n);

  function hourly(admit: boolean) {
    return {
      take: jest.fn(async () => (admit ? { ticket: null } : null)),
      settle: jest.fn(async () => undefined),
    };
  }

  function urgentRequest(index: number): RedeemVoucherRequest {
    const expiresAt = NOW - EVM_CONSTANTS.REDEEM_GRACE_SECONDS + 600;
    return request(index, { issuedAt: expiresAt - 60, expiresAt });
  }

  it('charges a send gasLimit x basefee, after the simulation, then settles it to gasUsed x basefee', async () => {
    const budget = hourly(true);
    const { redeemer, sendCall, state } = harness(
      { nodeInterface: fakeNodeInterface({ l1Gas: 0n }) },
      null,
      budget,
    );

    await redeemer.redeem(request(0));

    expect(state.simulated).toEqual(['redeemVoucher']);
    expect(budget.take).toHaveBeenCalledWith(
      TESTNET,
      budgetGas(1) * L2_BASE_FEE,
      false,
      expect.stringContaining('redeemVoucher'),
    );
    expect(sendCall).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledWith({ ticket: null }, 100_000n * L2_BASE_FEE);
  });

  it('defers a single redemption the budget refuses: RETRY FeeSpikeDeferred, nothing sent', async () => {
    const budget = hourly(false);
    const { redeemer, sendCall } = harness(
      { nodeInterface: fakeNodeInterface({ l1Gas: 0n }) },
      null,
      budget,
    );

    const outcome = await redeemer.redeem(request(0));

    expect(outcome).toEqual({
      kind: RedeemOutcomeKind.RETRY,
      signature: null,
      programError: FEE_SPIKE_DEFERRED,
    });
    expect(sendCall).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it('defers a whole batch the budget refuses, without splitting it into singles', async () => {
    const budget = hourly(false);
    const { redeemer, sendCall } = harness(
      { nodeInterface: fakeNodeInterface({ l1Gas: 0n }) },
      null,
      budget,
    );

    const outcomes = await redeemer.redeemBatch([request(0), request(1), request(2)]);

    expect(outcomes.every((o) => o.programError === FEE_SPIKE_DEFERRED)).toBe(true);
    expect(sendCall).not.toHaveBeenCalled();
    expect(budget.take).toHaveBeenCalledTimes(1);
  });

  it('tells the budget which sends are urgent, so it may stretch for them', async () => {
    const budget = hourly(true);
    const { redeemer } = harness({ nodeInterface: fakeNodeInterface({ l1Gas: 0n }) }, null, budget);

    await redeemer.redeemBatch([request(0), urgentRequest(1)]);

    expect(budget.take.mock.calls.map((call) => (call as unknown[])[2])).toEqual([true, false]);
  });

  it('charges the per-item cap when no fee is known (no basefee, no float)', async () => {
    const budget = hourly(true);
    const { redeemer } = harness({}, null, budget);

    await redeemer.redeem(request(0));

    expect((budget.take.mock.calls[0] as unknown[])[1]).toBe(
      EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM,
    );
    expect(budget.settle).not.toHaveBeenCalled();
  });
});
