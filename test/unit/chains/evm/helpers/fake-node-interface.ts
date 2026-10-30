import { decodeFunctionData, encodeFunctionResult } from 'viem';

import { NODE_INTERFACE_ADDRESS, NODE_INTERFACE_L1_ABI } from '@modules/chains/evm/evm-l1-gas';

/** 0.02 gwei, the L2 basefee measured on Robinhood Chain. */
export const L2_BASE_FEE = 20_000_000n;

/**
 * A `call` that answers `NodeInterface.gasEstimateL1Component` the way a Nitro
 * node does, or fails the way a non-Nitro chain or a down node does. Records the
 * `to` and `data` it was asked about.
 */
export function fakeNodeInterface(
  answer: { l1Gas: bigint; baseFee?: bigint } | Error,
): jest.Mock & { asked: { to: string; data: string }[] } {
  const asked: { to: string; data: string }[] = [];
  const call = jest.fn(async (args: { to: string; data: `0x${string}` }) => {
    if (args.to.toLowerCase() !== NODE_INTERFACE_ADDRESS.toLowerCase()) {
      throw new Error(`unexpected eth_call to ${args.to}`);
    }
    const decoded = decodeFunctionData({ abi: NODE_INTERFACE_L1_ABI, data: args.data });
    asked.push({ to: String(decoded.args[0]), data: String(decoded.args[2]) });
    if (answer instanceof Error) throw answer;
    return {
      data: encodeFunctionResult({
        abi: NODE_INTERFACE_L1_ABI,
        functionName: 'gasEstimateL1Component',
        result: [answer.l1Gas, answer.baseFee ?? L2_BASE_FEE, 1_000_000_000n],
      }),
    };
  });
  return Object.assign(call, { asked });
}
