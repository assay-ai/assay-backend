import { decodeFunctionData, toFunctionSelector } from 'viem';

import { X402_ESCROW_HOLD_ABI } from '@modules/chains/evm/abi/x402-hold.abi';
import { EvmHeldPayments } from '@modules/chains/evm/evm-held-payments.service';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { HeldStatus } from '@modules/payment/ports/held-payments.port';

const CHAIN = 'eip155:46630' as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3` as AssetId;
const ESCROW = '0x1111111111111111111111111111111111111111';
const CONFIG = '0x2222222222222222222222222222222222222222';
const PAYER = `${CHAIN}:0x3333333333333333333333333333333333333333` as AccountId;

function build(readResult: unknown | Error) {
  const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const sent: Array<{ data: `0x${string}`; to: string }> = [];
  const client = {
    readContract: jest.fn((args: { functionName: string; args: readonly unknown[] }) => {
      reads.push(args);
      return readResult instanceof Error ? Promise.reject(readResult) : Promise.resolve(readResult);
    }),
    multicall: jest.fn(),
  };
  const redeemer = {
    sendCall: jest.fn((call: { data: `0x${string}`; to: string }) => {
      sent.push(call);
      return Promise.resolve({ hash: '0xabc', status: 'SUCCESS', revertReason: null });
    }),
  };
  const service = new EvmHeldPayments(
    new Map([[CHAIN, client as never]]),
    new Map([[CHAIN, { escrow: ESCROW, config: CONFIG } as unknown as EvmDeployment]]),
    redeemer as never,
  );
  return { service, reads, sent };
}

describe('EvmHeldPayments — the "redeem into hold" ABI (G3.B1)', () => {
  it('pins the selectors the contract upgrade must match', () => {
    const selectors = Object.fromEntries(
      X402_ESCROW_HOLD_ABI.filter((item) => item.type === 'function').map((item) => [
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

    const decoded = sent.map((call) =>
      decodeFunctionData({ abi: X402_ESCROW_HOLD_ABI, data: call.data }),
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
});
