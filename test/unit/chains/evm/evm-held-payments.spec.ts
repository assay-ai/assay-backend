import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';

import { ASSAY_ESCROW_HOLD_ABI } from '@modules/chains/evm/abi/assay-hold.abi';
import {
  EvmHeldPayments,
  HeldSendDeferredError,
} from '@modules/chains/evm/evm-held-payments.service';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { HeldStatus } from '@modules/payment/ports/held-payments.port';
import { FEE_SPIKE_DEFERRED } from '@modules/payment/ports/voucher-redeemer.port';

import { EvmSendFloat } from '@modules/chains/evm/evm-send-float';
import { EvmRedeemerHourlyBudget } from '@modules/chains/evm/evm-redeemer-hourly-budget';
import { EvmSendRejectedError } from '@modules/chains/evm/evm-send-rejected.error';
import { HELD_TIMEOUT_SECONDS } from '@modules/payment/ports/held-payments.port';

import { L2_BASE_FEE, fakeNodeInterface } from './helpers/fake-node-interface';

const CHAIN = 'eip155:46630' as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3` as AssetId;
const ESCROW = '0x1111111111111111111111111111111111111111';
const CONFIG = '0x2222222222222222222222222222222222222222';
const PAYER = `${CHAIN}:0x3333333333333333333333333333333333333333` as AccountId;

function build(
  readResult: unknown | Error,
  options: {
    receipt?: unknown;
    live?: boolean;
    simulateRevert?: boolean;
    logs?: readonly unknown[];
    estimate?: bigint | Error;
    simulateError?: Error;
    nodeInterface?: jest.Mock;
    float?: EvmSendFloat;
    now?: number;
    hourly?: Pick<EvmRedeemerHourlyBudget, 'take' | 'settle' | 'paused'>;
    sendResult?: Record<string, unknown>;
  } = {},
) {
  const reads: Array<{
    functionName: string;
    args: readonly unknown[];
    account?: string;
    gas?: bigint;
  }> = [];
  const sent: Array<{
    data: `0x${string}`;
    to: string;
    boundQueueWait?: boolean;
    gasLimit?: bigint;
  }> = [];
  const revert = Object.assign(new Error('reverted'), { name: 'ContractFunctionRevertedError' });
  const estimates: Array<{ functionName: string; account?: string }> = [];
  const client = {
    readContract: jest.fn(
      (args: { functionName: string; args: readonly unknown[]; account?: string }) => {
        reads.push(args);
        if (args.account) {
          if (options.simulateError) return Promise.reject(options.simulateError);
          return options.simulateRevert ? Promise.reject(revert) : Promise.resolve(undefined);
        }
        return readResult instanceof Error
          ? Promise.reject(readResult)
          : Promise.resolve(readResult);
      },
    ),
    multicall: jest.fn(),
    estimateContractGas: jest.fn((args: { functionName: string; account?: string }) => {
      estimates.push(args);
      const estimate = options.estimate ?? 100_000n;
      return estimate instanceof Error ? Promise.reject(estimate) : Promise.resolve(estimate);
    }),
    getTransactionReceipt: jest.fn(() => Promise.resolve(options.receipt ?? null)),
    getBlockNumber: jest.fn(() => Promise.resolve(100_000n)),
    getLogs: jest.fn(() => Promise.resolve(options.logs ?? [])),
    ...(options.nodeInterface ? { call: options.nodeInterface } : {}),
  };
  const redeemer = {
    address: jest.fn(() => Promise.resolve(`${CHAIN}:0x5555555555555555555555555555555555555555`)),
    sendCall: jest.fn((call: { data: `0x${string}`; to: string }) => {
      sent.push(call);
      return Promise.resolve(
        options.sendResult ?? { hash: '0xabc', status: 'SUCCESS', revertReason: null },
      );
    }),
  };
  const service = new EvmHeldPayments(
    new Map([[CHAIN, client as never]]),
    new Map([[CHAIN, { escrow: ESCROW, config: CONFIG } as unknown as EvmDeployment]]),
    redeemer as never,
    options.live ? new Set([CHAIN]) : new Set(),
    options.float ?? null,
    () => options.now ?? Date.now(),
    options.hourly ?? null,
  );
  return { service, reads, sent, estimates };
}

function log(eventName: string, args: Record<string, unknown>, address: string = ESCROW) {
  const abi = [...ASSAY_ESCROW_HOLD_ABI, ...ASSAY_ESCROW_ABI];
  const data = encodeEventTopics({ abi, eventName: eventName as never, args: args as never });
  const event = abi.find((item) => item.type === 'event' && item.name === eventName)!;
  const nonIndexed = (
    event as unknown as { inputs: { indexed?: boolean; name: string; type: string }[] }
  ).inputs.filter((input) => !input.indexed);
  return {
    address,
    topics: data,
    data: encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name]) as never),
  };
}

describe('EvmHeldPayments — the "redeem into hold" ABI (G3.B1)', () => {
  it('pins the selectors the contract upgrade must match', () => {
    const selectors = Object.fromEntries(
      ASSAY_ESCROW_HOLD_ABI.filter((item) => item.type === 'function').map((item) => [
        item.name + (item.inputs.length === 2 && item.inputs[0].type === 'address[]' ? '[]' : ''),
        toFunctionSelector(item),
      ]),
    );
    expect(selectors).toEqual({
      held: toFunctionSelector('held(address,uint64)'),
      totalHeld: toFunctionSelector('totalHeld()'),
      collectHeld: toFunctionSelector('collectHeld(address,uint64)'),
      'collectHeldBatch[]': toFunctionSelector('collectHeldBatch(address[],uint64[])'),
      refundHeld: toFunctionSelector('refundHeld(address,uint64)'),
      'refundHeldBatch[]': toFunctionSelector('refundHeldBatch(address[],uint64[])'),
    });
  });

  it('reads held(payer, seq) and maps the status enum', async () => {
    const { service, reads } = build({
      provider: '0x4444444444444444444444444444444444444444',
      amount: 1_000_000n,
      takeRateBps: 1000,
      status: 1,
      collectableAt: 1_800_000_000n,
    });

    const record = await service.readHeld(ASSET, { payer: PAYER, seq: '7' });

    expect(record).toMatchObject({
      status: HeldStatus.HELD,
      amount: 1_000_000n,
      collectableAt: new Date(1_800_000_000_000),
    });
    expect(reads[0]).toMatchObject({ functionName: 'held', args: [expect.any(String), 7n] });
  });

  it('reads null when the escrow has no hold yet (a revert)', async () => {
    const revert = Object.assign(new Error('reverted'), { name: 'ContractFunctionRevertedError' });
    const { service } = build(revert);
    await expect(service.readHeld(ASSET, { payer: PAYER, seq: '1' })).resolves.toBeNull();
    await expect(service.totalHeld(ASSET)).resolves.toBeNull();
  });

  it('sends collectHeld for one, collectHeldBatch for many, with the redeemer', async () => {
    const { service, sent } = build(null);

    await service.collect(ASSET, [{ payer: PAYER, seq: '1' }]);
    await service.collect(ASSET, [
      { payer: PAYER, seq: '2' },
      { payer: PAYER, seq: '3' },
    ]);
    await service.refund(ASSET, [{ payer: PAYER, seq: '4' }]);

    expect(sent.every((call) => call.boundQueueWait === true)).toBe(true);
    const decoded = sent.map((call) =>
      decodeFunctionData({ abi: ASSAY_ESCROW_HOLD_ABI, data: call.data }),
    );
    expect(decoded.map((call) => call.functionName)).toEqual([
      'collectHeld',
      'collectHeldBatch',
      'refundHeld',
    ]);
    expect(decoded[1].args?.[1]).toEqual([2n, 3n]);
    expect(sent[0].to).toBe(`${CHAIN}:${ESCROW}`);
  });

  it('refuses an empty or oversized batch', async () => {
    const { service } = build(null);
    await expect(service.collect(ASSET, [])).rejects.toBeDefined();
    const many = Array.from({ length: 65 }, (_, i) => ({ payer: PAYER, seq: String(i + 1) }));
    await expect(service.refund(ASSET, many)).rejects.toBeDefined();
  });

  it('simulates first: a refusal sends nothing', async () => {
    const { service, sent } = build(null, { simulateRevert: true });
    await expect(service.collect(ASSET, [{ payer: PAYER, seq: '1' }])).rejects.toMatchObject({
      name: 'HeldSendRefusedError',
    });
    expect(sent).toEqual([]);
  });

  describe('gas limit (BUG-PROD-COLLECT-01)', () => {
    const one = [{ payer: PAYER, seq: '1' }];
    const three = [
      { payer: PAYER, seq: '1' },
      { payer: PAYER, seq: '2' },
      { payer: PAYER, seq: '3' },
    ];
    const simulated = (reads: Array<{ account?: string; gas?: bigint }>) =>
      reads.filter((read) => read.account).map((read) => read.gas);

    it('sends with the estimate x 1.25, and pre-checks with the same limit', async () => {
      const { service, sent, reads, estimates } = build(null, { estimate: 133_696n });
      await service.collect(ASSET, one);
      expect(estimates).toEqual([
        expect.objectContaining({
          functionName: 'collectHeld',
          account: '0x5555555555555555555555555555555555555555',
        }),
      ]);
      expect(sent[0].gasLimit).toBe(167_120n);
      expect(simulated(reads)).toEqual([167_120n]);
    });

    it('caps the padded estimate at the ceiling (400k for one move)', async () => {
      const { service, sent } = build(null, { estimate: 1_000_000n });
      await service.refund(ASSET, one);
      expect(sent[0].gasLimit).toBe(400_000n);
    });

    it('falls back to 180k when the estimate fails', async () => {
      const { service, sent, reads } = build(null, { estimate: new Error('code 3') });
      await service.collect(ASSET, one);
      expect(sent[0].gasLimit).toBe(180_000n);
      expect(simulated(reads)).toEqual([180_000n]);
    });

    it('scales a batch: fallback 180k + 60k each, ceiling 400k + 120k each', async () => {
      const failed = build(null, { estimate: new Error('outage') });
      await failed.service.collect(ASSET, three);
      expect(failed.sent[0].gasLimit).toBe(300_000n);

      const capped = build(null, { estimate: 2_000_000n });
      await capped.service.collect(ASSET, three);
      expect(capped.sent[0].gasLimit).toBe(640_000n);

      const padded = build(null, { estimate: 167_287n });
      await padded.service.collect(ASSET, three);
      expect(padded.sent[0].gasLimit).toBe(209_109n);
    });

    describe('the L1 half (Nitro)', () => {
      it('with an L1 part of 0, is exactly the estimate x 1.25', async () => {
        const { service, sent } = build(null, {
          estimate: 133_696n,
          nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
        });
        await service.collect(ASSET, one);
        expect(sent[0].gasLimit).toBe(167_120n);
      });

      it('caps execution only: the prod 609758 estimate is no longer cut to 520000', async () => {
        // Two moves (cap 520k), estimate 609,758 of which 480,000 is L1.
        const nodeInterface = fakeNodeInterface({ l1Gas: 480_000n });
        const { service, sent, reads } = build(null, { estimate: 609_758n, nodeInterface });
        await service.collect(ASSET, three.slice(0, 2));
        // (609758 - 480000) x 1.25 = 162198 (rounded up), + 480000 x 1.2.
        expect(sent[0].gasLimit).toBe(162_198n + 576_000n);
        expect(simulated(reads)).toEqual([162_198n + 576_000n]);
        expect(nodeInterface.asked[0]).toEqual({ to: ESCROW, data: sent[0].data });
      });

      it('adds L1 to the fixed fallback when the estimate fails', async () => {
        const { service, sent } = build(null, {
          estimate: new Error('outage'),
          nodeInterface: fakeNodeInterface({ l1Gas: 100_000n }),
        });
        await service.refund(ASSET, one);
        expect(sent[0].gasLimit).toBe(180_000n + 120_000n);
      });

      it('defers above the cost cap: FeeSpikeDeferred, nothing simulated or sent', async () => {
        const { service, sent, reads } = build(null, {
          estimate: 12_000_000n,
          nodeInterface: fakeNodeInterface({ l1Gas: 11_800_000n }),
        });
        const error = await service.collect(ASSET, one).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HeldSendDeferredError);
        expect((error as Error).message.startsWith(`${FEE_SPIKE_DEFERRED}: `)).toBe(true);
        expect(sent).toEqual([]);
        expect(simulated(reads)).toEqual([]);
      });

      it('falls back to L1 = 0 when NodeInterface fails', async () => {
        const { service, sent } = build(null, {
          estimate: 133_696n,
          nodeInterface: fakeNodeInterface(new Error('method not found')),
        });
        await service.collect(ASSET, one);
        expect(sent[0].gasLimit).toBe(167_120n);
      });
    });

    it('names an empty revert as out of gas, with the limit and the estimate', async () => {
      const empty = Object.assign(new Error('EVM RPC eth_call failed: code 3'), {
        name: 'ContractFunctionRevertedError',
      });
      const withEstimate = build(null, { estimate: 100_000n, simulateError: empty });
      await expect(withEstimate.service.collect(ASSET, one)).rejects.toMatchObject({
        name: 'HeldSendRefusedError',
        message: 'held send refused: out of gas at limit 125000 (estimate 100000)',
      });
      expect(withEstimate.sent).toEqual([]);

      const noEstimate = build(null, { estimate: new Error('code 3'), simulateError: empty });
      await expect(noEstimate.service.collect(ASSET, one)).rejects.toMatchObject({
        message: 'held send refused: out of gas at limit 180000 (estimate failed)',
      });
    });

    it('keeps the contract reason when the revert carries data', async () => {
      const guarded = Object.assign(new Error('HeldNotYetCollectable'), {
        name: 'ContractFunctionRevertedError',
        signature: '0x3e5b55ad',
      });
      const { service } = build(null, { simulateError: guarded });
      await expect(service.collect(ASSET, one)).rejects.toMatchObject({
        message: 'held send refused: HeldNotYetCollectable',
      });
    });
    it('names the Errors.sol error when the node returned its selector', async () => {
      const rpc = Object.assign(new Error('EVM RPC eth_call failed: code 3'), {
        data: '0x3e5b55ad',
      });
      const wrapped = Object.assign(
        new Error('The contract function "collectHeld" reverted with the following signature'),
        { name: 'ContractFunctionRevertedError', cause: rpc },
      );
      const { service, sent } = build(null, { simulateError: wrapped });
      await expect(service.collect(ASSET, one)).rejects.toMatchObject({
        name: 'HeldSendRefusedError',
        message: expect.stringMatching(/^held send refused: HeldNotYetCollectable: The contract/),
      });
      expect(sent).toEqual([]);
    });
  });

  describe('classifyRedemption — from the receipt (review P0-1)', () => {
    const PAYER_ADDRESS = '0x3333333333333333333333333333333333333333';
    const PROVIDER = '0x4444444444444444444444444444444444444444';
    const HASH = `0x${'ab'.repeat(32)}`;

    it('a PaymentHeld log: held, with its collectableAt', async () => {
      const { service } = build(null, {
        receipt: {
          status: 'success',
          logs: [
            log('PaymentHeld', {
              payer: PAYER_ADDRESS,
              seq: 7n,
              provider: PROVIDER,
              amount: 1_000_000n,
              collectableAt: 1_800_000_000n,
            }),
          ],
        },
      });
      await expect(
        service.classifyRedemption(ASSET, HASH, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'HELD', collectableAt: new Date(1_800_000_000_000) });
    });

    it('a bare VoucherRedeemed: paid at redemption (before the upgrade)', async () => {
      const { service } = build(null, {
        live: true,
        receipt: {
          status: 'success',
          logs: [
            log('VoucherRedeemed', {
              payer: PAYER_ADDRESS,
              provider: PROVIDER,
              requestHash: `0x${'00'.repeat(32)}`,
              resourceHash: `0x${'00'.repeat(32)}`,
              amount: 1_000_000n,
              fee: 100_000n,
              seq: 7n,
              takeRateBps: 1000,
              spentInWindow: 1_000_000n,
            }),
          ],
        },
      });
      await expect(
        service.classifyRedemption(ASSET, HASH, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'PAID' });
    });

    it('no receipt, or another seq’s logs: unknown', async () => {
      const { service } = build(null);
      await expect(
        service.classifyRedemption(ASSET, HASH, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'UNKNOWN' });
    });

    it('no hash: the record; on a live hold a revert is unknown, never paid', async () => {
      const revert = Object.assign(new Error('reverted'), {
        name: 'ContractFunctionRevertedError',
      });
      await expect(
        build(revert, { live: true }).service.classifyRedemption(ASSET, null, {
          payer: PAYER,
          seq: '7',
        }),
      ).resolves.toEqual({ kind: 'UNKNOWN' });
      await expect(
        build(revert, { live: false }).service.classifyRedemption(ASSET, null, {
          payer: PAYER,
          seq: '7',
        }),
      ).resolves.toEqual({ kind: 'PAID' });
    });

    const held = (address: string = ESCROW) =>
      log(
        'PaymentHeld',
        {
          payer: PAYER_ADDRESS,
          seq: 7n,
          provider: PROVIDER,
          amount: 1_000_000n,
          collectableAt: 1_800_000_000n,
        },
        address,
      );

    it('a reverted receipt is never held or paid', async () => {
      const { service } = build(null, { receipt: { status: 'reverted', logs: [held()] } });
      await expect(
        service.classifyRedemption(ASSET, HASH, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'UNKNOWN' });
    });

    it('a PaymentHeld emitted by another contract is ignored', async () => {
      const { service } = build(null, {
        receipt: { status: 'success', logs: [held('0x9999999999999999999999999999999999999999')] },
      });
      await expect(
        service.classifyRedemption(ASSET, HASH, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'UNKNOWN' });
    });

    it('no hash and no record: placed from the escrow’s recent logs', async () => {
      const revert = Object.assign(new Error('reverted'), {
        name: 'ContractFunctionRevertedError',
      });
      const { service } = build(revert, { live: true, logs: [held()] });
      await expect(
        service.classifyRedemption(ASSET, null, { payer: PAYER, seq: '7' }),
      ).resolves.toEqual({ kind: 'HELD', collectableAt: new Date(1_800_000_000_000) });
    });
  });

  describe('holdLive', () => {
    it('is the flag, or the escrow answering totalHeld() — before the flag flips', async () => {
      await expect(build(0n, { live: true }).service.holdLive(ASSET)).resolves.toBe(true);
      await expect(build(5n).service.holdLive(ASSET)).resolves.toBe(true);
      const revert = Object.assign(new Error('reverted'), {
        name: 'ContractFunctionRevertedError',
      });
      await expect(build(revert).service.holdLive(ASSET)).resolves.toBe(false);
    });
  });
});

describe('EvmHeldPayments — the hold timeout and the redeemer float', () => {
  const one = [{ payer: PAYER, seq: '7' }];
  const NOW_MS = 1_900_000_000_000;
  const GWEI = 1_000_000_000n;

  /** A HELD record whose timeout is `secondsLeft` from NOW_MS. */
  function heldRecord(secondsLeft: number) {
    return {
      provider: '0x4444444444444444444444444444444444444444',
      amount: 1_000_000n,
      takeRateBps: 1000,
      status: 1,
      collectableAt: BigInt(NOW_MS / 1000 + secondsLeft - HELD_TIMEOUT_SECONDS),
    };
  }

  function float(balanceWei: bigint, reserve: bigint) {
    return new EvmSendFloat(
      {
        balanceWei: async () => balanceWei,
        feesPerGas: async () => ({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 0n }),
      },
      reserve,
    );
  }

  it('waives the cost cap for a record within the waiver window of its hold timeout', async () => {
    // 250k execution + 1.2M L1 at 0.02 gwei is 2.9e-5 ETH: over the cap, under the ceiling.
    const { service, sent } = build(heldRecord(600), {
      estimate: 1_200_000n,
      nodeInterface: fakeNodeInterface({ l1Gas: 1_000_000n }),
      now: NOW_MS,
    });

    await service.refund(ASSET, one);

    expect(sent).toHaveLength(1);
  });

  it('defers even a record near its timeout above the hard ceiling: the waiver is bounded', async () => {
    const { service, sent, reads } = build(heldRecord(600), {
      estimate: 12_000_000n,
      nodeInterface: fakeNodeInterface({ l1Gas: 11_800_000n }),
      now: NOW_MS,
    });

    const error = await service.refund(ASSET, one).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HeldSendDeferredError);
    expect((error as Error).message).toMatch(/hard ceiling/);
    expect(sent).toEqual([]);
    expect(reads.filter((read) => read.account)).toEqual([]);
  });

  it('defers a move the hourly budget refuses, after the simulation and before the send', async () => {
    const hourly = {
      take: jest.fn(async () => null),
      settle: jest.fn(async () => undefined),
      paused: jest.fn(() => false),
    };
    const { service, sent, reads } = build(heldRecord(86_400), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
    });

    const error = await service.collect(ASSET, one).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HeldSendDeferredError);
    expect((error as Error).message.startsWith(`${FEE_SPIKE_DEFERRED}: `)).toBe(true);
    expect(reads.filter((read) => read.account)).toHaveLength(1);
    expect(sent).toEqual([]);
    // Charged gasLimit x basefee; urgency is passed lazily.
    const [, wei, urgent] = hourly.take.mock.calls[0] as unknown as [unknown, bigint, unknown];
    expect(wei).toBe(125_000n * L2_BASE_FEE);
    expect(typeof urgent).toBe('function');
  });

  it('sends a move the hourly budget admits', async () => {
    const hourly = {
      take: jest.fn(async () => ({ ticket: null })),
      settle: jest.fn(async () => undefined),
      paused: jest.fn(() => false),
    };
    const { service, sent } = build(heldRecord(86_400), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
    });

    await service.collect(ASSET, one);

    expect(sent).toHaveLength(1);
  });

  it('settles at the receipt gasUsed x effectiveGasPrice (review 2026-10-30 M-2)', async () => {
    const hourly = {
      take: jest.fn(async () => ({ ticket: null })),
      settle: jest.fn(async () => undefined),
      paused: jest.fn(() => false),
    };
    const { service } = build(heldRecord(86_400), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
      sendResult: {
        hash: '0xabc',
        status: 'SUCCESS',
        revertReason: null,
        gasUsed: 80_000n,
        effectiveGasPrice: 5n,
      },
    });

    await service.collect(ASSET, one);

    expect(hourly.settle).toHaveBeenCalledWith({ ticket: null }, 400_000n);
  });

  /** Review 2026-10-30 M-7: a spent budget is not re-estimated or re-simulated. */
  it('defers before estimating or simulating while the budget is paused', async () => {
    const hourly = {
      take: jest.fn(async () => ({ ticket: null })),
      settle: jest.fn(async () => undefined),
      paused: jest.fn(() => true),
    };
    const { service, sent, reads, estimates } = build(heldRecord(86_400), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
    });

    const error = await service.collect(ASSET, one).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HeldSendDeferredError);
    expect(estimates).toEqual([]);
    expect(reads.filter((read) => read.account)).toEqual([]);
    expect(hourly.take).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('with only the ordinary lane paused, goes on for a record near its timeout', async () => {
    const hourly = {
      take: jest.fn(async () => ({ ticket: null })),
      settle: jest.fn(async () => undefined),
      paused: jest.fn((_chain: unknown, urgent: boolean) => !urgent),
    };
    const near = build(heldRecord(60), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
    });
    await near.service.refund(ASSET, one);
    expect(near.sent).toHaveLength(1);

    const far = build(heldRecord(86_400), {
      nodeInterface: fakeNodeInterface({ l1Gas: 0n }),
      now: NOW_MS,
      hourly,
    });
    await expect(far.service.refund(ASSET, one)).rejects.toBeInstanceOf(HeldSendDeferredError);
    expect(far.estimates).toEqual([]);
  });

  it('still defers a record far from its timeout, and one already past it', async () => {
    for (const secondsLeft of [86_400, -60]) {
      const { service, sent } = build(heldRecord(secondsLeft), {
        estimate: 1_200_000n,
        nodeInterface: fakeNodeInterface({ l1Gas: 1_000_000n }),
        now: NOW_MS,
      });

      await expect(service.refund(ASSET, one)).rejects.toBeInstanceOf(HeldSendDeferredError);
      expect(sent).toEqual([]);
    }
  });

  it('refuses, before simulating or sending, a move the float cannot pay over its reserve', async () => {
    // 100k estimate x 1.25 = 125k gas at 1 gwei; the float holds one wei less over the reserve.
    const { service, sent, reads } = build(heldRecord(86_400), {
      float: float(125_000n * GWEI + 1_000n - 1n, 1_000n),
      now: NOW_MS,
    });

    const error = await service.collect(ASSET, one).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvmSendRejectedError);
    expect((error as EvmSendRejectedError).reason).toBe('INSUFFICIENT_FUNDS');
    expect(sent).toEqual([]);
    expect(reads.filter((read) => read.account !== undefined)).toEqual([]);
  });

  it('lets a move near its timeout spend the reserve', async () => {
    const { service, sent } = build(heldRecord(600), {
      float: float(125_000n * GWEI, 10n ** 18n),
      now: NOW_MS,
    });

    await service.refund(ASSET, one);

    expect(sent).toHaveLength(1);
  });

  it('sends when the float covers the move over its reserve', async () => {
    const { service, sent } = build(heldRecord(86_400), {
      float: float(125_000n * GWEI + 1_000n, 1_000n),
      now: NOW_MS,
    });

    await service.collect(ASSET, one);

    expect(sent).toHaveLength(1);
  });
});
