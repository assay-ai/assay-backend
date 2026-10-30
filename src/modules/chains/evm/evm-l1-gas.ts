import { decodeFunctionResult, encodeFunctionData } from 'viem';

/**
 * The L1 half of a transaction's gas on an Arbitrum Nitro chain, and the rule
 * for when it costs too much to send now.
 *
 * Robinhood Chain (4663, 46630) is Nitro. Its `eth_estimateGas` answers L2
 * execution gas **plus** the L1 data-posting cost converted into L2 gas units
 * (`posterCost / L2 basefee`), and the gas limit of the transaction must cover
 * both. With the L2 basefee near 0.02 gwei the L1 half swings with the L1
 * price: `setLimitsBySig` estimated about 108k with an L1 part of 0, and during
 * a spike about 952k, of which about 845k was L1. A fixed budget with no L1 part
 * then cannot pay its poster cost, and a ceiling meant for execution refuses a
 * call that only got briefly more expensive.
 *
 * `NodeInterface` (`0x…C8`) is virtual — `eth_getCode` is empty — and answers
 * `eth_call` only. `gasEstimateL1Component` does **not** execute the call, so it
 * is cheap and answers for a call that would revert. On a chain that is not
 * Nitro, or when the RPC cannot answer, {@link estimateL1Gas} returns an L1
 * part of 0 and no basefee, which is exactly the behaviour before this file.
 */
export const NODE_INTERFACE_ADDRESS = '0x00000000000000000000000000000000000000C8' as const;

/** Nitro's `NodeInterface.gasEstimateL1Component`, the one function used here. */
export const NODE_INTERFACE_L1_ABI = [
  {
    type: 'function',
    name: 'gasEstimateL1Component',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'contractCreation', type: 'bool' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [
      { name: 'gasEstimateForL1', type: 'uint64' },
      { name: 'baseFee', type: 'uint256' },
      { name: 'l1BaseFeeEstimate', type: 'uint256' },
    ],
  },
] as const;

/**
 * The most wei one background send (a redemption, a held collect or refund) may
 * cost, **per item it carries**.
 *
 * A single `redeemVoucher` at its 320k budget and a 0.02 gwei basefee costs
 * about 6.4e-6 ETH; this is about 8× that, so an ordinary spike still sends and
 * only an extreme one waits (`FEE_SPIKE_DEFERRED`). Per item, because a batch
 * of 64 legitimately carries 64 times the calldata, and so about 64 times the
 * L1 part. Deferring costs nothing but time: the hold stays and the next pass
 * asks again.
 */
export const EVM_BACKGROUND_SEND_MAX_COST_WEI_PER_ITEM = 50_000_000_000_000n; // 0.00005 ETH

/**
 * How close to the point of no return a background send stops waiting for fees
 * to fall: within this many seconds of a voucher's on-chain deadline
 * (`expiresAt + REDEEM_GRACE_SECONDS`) or of a held payment's timeout, the
 * cost cap is waived and the send goes out at whatever the fees are.
 *
 * Deferring past that point would not save the gas, it would trade it for the
 * payment itself: an expired voucher is voided and its provider is never paid,
 * and a refund deferred past the hold's timeout can no longer be sent. A spike
 * that outlasts the deadline costs cents here; the payment it saves is the
 * reason the send exists. Several passes wide, so one failed pass still leaves
 * room for another.
 */
export const EVM_FEE_CAP_WAIVED_WITHIN_SECONDS = 1_800;

/** The margin on the L1 part, the same 20 % the estimates elsewhere get. */
const L1_MARGIN_NUM = 12n;
const L1_MARGIN_DEN = 10n;

/** The one read this needs. Optional, so a client without it reads as "not Nitro". */
export interface EvmL1GasClient {
  call?(args: {
    account?: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
  }): Promise<{ data?: `0x${string}` } | unknown>;
}

export interface EvmL1GasEstimate {
  /** The L1 data-posting cost in L2 gas units, unpadded. 0 when unknown. */
  readonly l1Gas: bigint;
  /** The L2 basefee in wei per gas, which is what a Nitro transaction pays; null when unknown. */
  readonly l2BaseFee: bigint | null;
}

const NO_L1: EvmL1GasEstimate = { l1Gas: 0n, l2BaseFee: null };

/**
 * `NodeInterface.gasEstimateL1Component(to, false, data)`. Never throws: any
 * failure — no `call` on the client, a revert, a node that is down, an empty
 * answer from a chain with nothing at `0x…C8` — is {@link NO_L1}, so the caller
 * behaves as it did before L1 was counted.
 */
export async function estimateL1Gas(
  client: unknown,
  call: { to: `0x${string}`; data: `0x${string}`; account?: `0x${string}` },
): Promise<EvmL1GasEstimate> {
  const reader = client as EvmL1GasClient | null | undefined;
  if (typeof reader?.call !== 'function') return NO_L1;
  try {
    const answer = (await reader.call({
      ...(call.account ? { account: call.account } : {}),
      to: NODE_INTERFACE_ADDRESS,
      data: encodeFunctionData({
        abi: NODE_INTERFACE_L1_ABI,
        functionName: 'gasEstimateL1Component',
        args: [call.to, false, call.data],
      }),
    })) as { data?: `0x${string}` } | undefined;
    if (!answer?.data || answer.data === '0x') return NO_L1;
    const [l1Gas, baseFee] = decodeFunctionResult({
      abi: NODE_INTERFACE_L1_ABI,
      functionName: 'gasEstimateL1Component',
      data: answer.data,
    });
    return { l1Gas: BigInt(l1Gas), l2BaseFee: BigInt(baseFee) > 0n ? BigInt(baseFee) : null };
  } catch {
    return NO_L1;
  }
}

/** The L1 part with its 20 % margin, rounded up. */
export function paddedL1Gas(l1Gas: bigint): bigint {
  return (l1Gas * L1_MARGIN_NUM + L1_MARGIN_DEN - 1n) / L1_MARGIN_DEN;
}

/**
 * Whether `gasLimit` at the L2 basefee would cost more than `maxWei`. The
 * basefee, not `maxFeePerGas`: Nitro charges the basefee and ignores the tip, so
 * `gasLimit × basefee` is the most the send can actually cost. An unknown
 * basefee is never "too much" — the check then does not exist, as before.
 */
export function exceedsCostCap(
  gasLimit: bigint,
  l2BaseFee: bigint | null,
  maxWei: bigint,
): boolean {
  return l2BaseFee !== null && gasLimit * l2BaseFee > maxWei;
}
