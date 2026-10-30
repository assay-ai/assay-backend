import { toFunctionSelector } from 'viem';

import {
  EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM,
  NODE_INTERFACE_L1_ABI,
  estimateL1Gas,
  exceedsCostCap,
  paddedL1Gas,
} from '@modules/chains/evm/evm-l1-gas';

import { L2_BASE_FEE, fakeNodeInterface } from './helpers/fake-node-interface';

/**
 * `estimateL1Gas` — Nitro's L1 half of a transaction, and the rule that it can
 * only ever ADD to what was sent before: any failure is an L1 part of 0.
 */
const ESCROW = '0x1111111111111111111111111111111111111111';
const DATA = '0xdeadbeef';

describe('estimateL1Gas', () => {
  it('pins the NodeInterface selector', () => {
    expect(toFunctionSelector(NODE_INTERFACE_L1_ABI[0])).toBe(
      toFunctionSelector('gasEstimateL1Component(address,bool,bytes)'),
    );
  });

  it('reads the L1 part and the L2 basefee for the exact call', async () => {
    const call = fakeNodeInterface({ l1Gas: 845_000n });
    const estimate = await estimateL1Gas({ call }, { to: ESCROW, data: DATA });
    expect(estimate).toEqual({ l1Gas: 845_000n, l2BaseFee: L2_BASE_FEE });
    expect(call.asked).toEqual([{ to: ESCROW, data: DATA }]);
  });

  it.each([
    ['a node error', { call: fakeNodeInterface(new Error('execution reverted')) }],
    ['an empty answer (nothing at 0x…C8)', { call: async () => ({ data: '0x' }) }],
    ['garbage', { call: async () => ({ data: '0x1234' }) }],
    ['a client without call', {}],
    ['no client', undefined],
  ])('is L1 = 0 with no basefee on %s', async (_label, client) => {
    await expect(estimateL1Gas(client, { to: ESCROW, data: DATA })).resolves.toEqual({
      l1Gas: 0n,
      l2BaseFee: null,
    });
  });

  it('pads the L1 part 20 %, rounding up', () => {
    expect(paddedL1Gas(0n)).toBe(0n);
    expect(paddedL1Gas(845_000n)).toBe(1_014_000n);
    expect(paddedL1Gas(1n)).toBe(2n);
  });

  it('caps cost only when the basefee is known', () => {
    const cap = EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM;
    const atCap = cap / L2_BASE_FEE;
    expect(exceedsCostCap(atCap, L2_BASE_FEE, cap)).toBe(false);
    expect(exceedsCostCap(atCap + 1n, L2_BASE_FEE, cap)).toBe(true);
    expect(exceedsCostCap(10n ** 12n, null, cap)).toBe(false);
  });
});
