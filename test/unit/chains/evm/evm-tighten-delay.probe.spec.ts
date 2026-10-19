import { ContractFunctionRevertedError, zeroAddress } from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import { EvmReaderClient } from '@modules/chains/evm/evm-escrow-balance-reader.service';
import {
  EVM_TIGHTEN_DELAY_REPROBE_MS,
  EvmTightenDelayProbe,
} from '@modules/chains/evm/evm-tighten-delay.probe';
import { CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';

import { deployment } from './evm-fixtures';

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const PAYER = toAccountId(TESTNET, '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');

/** What viem throws for a call the old implementation has no selector for (measured on 46630). */
function unknownSelectorRevert(): Error {
  const cause = new ContractFunctionRevertedError({
    abi: ASSAY_ESCROW_ABI,
    functionName: 'effectiveCapsOf',
    data: '0x',
  });
  return Object.assign(new Error('The contract function "effectiveCapsOf" reverted.'), {
    name: 'ContractFunctionExecutionError',
    cause,
  });
}

function probeOver(answer: () => Promise<unknown>) {
  let now = 1_000_000;
  const readContract = jest.fn(async (args: { functionName: string; args: readonly unknown[] }) => {
    expect(args.functionName).toBe('effectiveCapsOf');
    expect(args.args).toEqual([zeroAddress, zeroAddress]);
    return answer();
  });
  const client = { readContract, multicall: jest.fn() } as unknown as EvmReaderClient;
  const probe = new EvmTightenDelayProbe(
    new Map<ChainId, EvmReaderClient>([[TESTNET, client]]),
    new Map([[TESTNET, deployment(TESTNET)]]),
    { now: () => now },
  );
  return {
    probe,
    readContract,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('EvmTightenDelayProbe (assay-evm D-21)', () => {
  it('is live once effectiveCapsOf answers, and never asks again', async () => {
    const { probe, readContract } = probeOver(async () => [0n, 0n, 0n, 0n]);
    await expect(probe.isLive(TESTNET)).resolves.toBe(true);
    await expect(probe.isLive(TESTNET)).resolves.toBe(true);
    await expect(probe.holdsTightening(PAYER)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('is not live while the old implementation reverts, and asks again a minute later', async () => {
    let upgraded = false;
    const { probe, readContract, advance } = probeOver(async () => {
      if (!upgraded) throw unknownSelectorRevert();
      return [0n, 0n, 0n, 0n];
    });
    await expect(probe.isLive(TESTNET)).resolves.toBe(false);
    upgraded = true;
    // Believed until the re-probe interval passes: one eth_call a minute.
    await expect(probe.isLive(TESTNET)).resolves.toBe(false);
    expect(readContract).toHaveBeenCalledTimes(1);
    advance(EVM_TIGHTEN_DELAY_REPROBE_MS);
    await expect(probe.isLive(TESTNET)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('throws an RPC failure rather than caching it as "not upgraded"', async () => {
    let fail = true;
    const { probe, readContract } = probeOver(async () => {
      if (fail) throw new Error('fetch failed');
      return [0n, 0n, 0n, 0n];
    });
    await expect(probe.isLive(TESTNET)).rejects.toThrow('fetch failed');
    fail = false;
    await expect(probe.isLive(TESTNET)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('answers the settlement port false when it cannot tell — the strict side', async () => {
    const { probe } = probeOver(async () => {
      throw new Error('fetch failed');
    });
    await expect(probe.holdsTightening(PAYER)).resolves.toBe(false);
  });

  it('is false for a chain it has no escrow on, Solana included, without a read', async () => {
    const { probe, readContract } = probeOver(async () => [0n, 0n, 0n, 0n]);
    await expect(
      probe.holdsTightening(
        toAccountId(CHAIN_IDS.SOLANA_DEVNET, '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'),
      ),
    ).resolves.toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });
});
