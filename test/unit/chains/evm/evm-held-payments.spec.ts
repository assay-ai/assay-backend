import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  toFunctionSelector,
} from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';

import { ASSAY_ESCROW_HOLD_ABI } from '@modules/chains/evm/abi/assay-hold.abi';
import { EvmHeldPayments } from '@modules/chains/evm/evm-held-payments.service';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { HeldStatus } from '@modules/payment/ports/held-payments.port';

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
  };
  const redeemer = {
    address: jest.fn(() => Promise.resolve(`${CHAIN}:0x5555555555555555555555555555555555555555`)),
    sendCall: jest.fn((call: { data: `0x${string}`; to: string }) => {
      sent.push(call);
      return Promise.resolve({ hash: '0xabc', status: 'SUCCESS', revertReason: null });
    }),
  };
  const service = new EvmHeldPayments(
    new Map([[CHAIN, client as never]]),
    new Map([[CHAIN, { escrow: ESCROW, config: CONFIG } as unknown as EvmDeployment]]),
    redeemer as never,
    options.live ? new Set([CHAIN]) : new Set(),
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
