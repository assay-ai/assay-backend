import { decodeFunctionResult, pad, toHex } from 'viem';

import {
  ASSAY_CONFIG_ABI,
  ASSAY_ESCROW_ABI,
  ASSAY_STAKE_ABI,
} from '@modules/chains/evm/abi/assay.abi';
import {
  EvmEscrowBalanceReader,
  EvmReaderClient,
} from '@modules/chains/evm/evm-escrow-balance-reader.service';
import { EvmStakeReader } from '@modules/chains/evm/evm-stake-reader.service';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment } from './evm-fixtures';

/**
 * The two EVM on-chain readers.
 *
 * ## What the decode is pinned against, and why it is not a stub object
 *
 * The fake RPC does not hand the readers a JavaScript object with twelve named
 * keys. It hands them **positionally encoded 32-byte words** and lets viem
 * decode them through the vendored ABI — because the failure this suite has to
 * catch is a field-NAME error in that ABI, and a stub that already carries the
 * names cannot see one.
 *
 * Nine of `Escrow`'s twelve fields are `uint64`. Transposing `seqHigh` and
 * `authNonce` changes no selector, no encoding length and no canonical form: it
 * passed 109 tests on this branch before this file existed. Every word below
 * therefore carries a **distinct** value, so a transposition lands a number in a
 * field that names a different quantity and the assertion says which.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const OTHER = CHAIN_IDS.BASE_SEPOLIA;
const DEPLOYMENT = deployment(TESTNET);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const USDC_DEVNET = ASSET_IDS.USDC_SOLANA_DEVNET;

const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const BUYER_ACCOUNT = toAccountId(TESTNET, BUYER);
const PROVIDER = '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2';
const PROVIDER_ACCOUNT = toAccountId(TESTNET, PROVIDER);

/** One ABI word. Every static field of these structs occupies exactly one. */
function word(value: bigint | string): string {
  return pad(typeof value === 'bigint' ? toHex(value) : (value as `0x${string}`), {
    size: 32,
  }).slice(2);
}

function returnData(words: readonly (bigint | string)[]): `0x${string}` {
  return `0x${words.map(word).join('')}` as `0x${string}`;
}

/**
 * `Escrow`, positionally, in `assay-evm/src/AssayEscrow.sol:83`'s declared order.
 *
 * The names are here as a comment on each line rather than as object keys — the
 * point of the fixture is that the ORDER is the only thing it asserts.
 */
function escrowWords(overrides: Partial<Record<string, bigint>> = {}): readonly bigint[] {
  const fields: readonly [string, bigint][] = [
    ['balance', 101n],
    ['seqHigh', 102n],
    ['authNonce', 103n],
    ['maxVoucherAmount', 104n],
    ['maxPerWindow', 105n],
    ['spentInWindow', 106n],
    ['windowStartedAt', 107n],
    ['withdrawRequested', 108n],
    ['withdrawAvailableAt', 109n],
    ['totalRedeemed', 110n],
    ['totalWithdrawn', 111n],
    ['totalFunded', 112n],
  ];
  return fields.map(([name, value]) => overrides[name] ?? value);
}

/** `ProviderStake`, positionally, in `assay-evm/src/AssayStake.sol:46`'s declared order. */
function stakeWords(overrides: Partial<Record<string, bigint>> = {}): readonly bigint[] {
  const fields: readonly [string, bigint][] = [
    ['bonded', 201n],
    ['unbonding', 202n],
    ['unbondingStartedAt', 203n],
    ['slashedInWindow', 204n],
    ['slashWindowStartedAt', 205n],
    ['pendingSlash', 206n],
    ['__gap', 207n],
    ['totalDeposited', 208n],
    ['totalWithdrawn', 209n],
    ['totalSlashed', 210n],
  ];
  return fields.map(([name, value]) => overrides[name] ?? value);
}

/** `ParamSet`, positionally, in `assay-evm/src/AssayConfig.sol`'s declared order. */
const PARAMS_WORDS: readonly (bigint | string)[] = [
  '0x000000000000000000000000000000000000dEaD', // treasury
  '0x00000000000000000000000000000000000000Ee', // redeemer
  1_209_600n, // unbondingPeriodSeconds — 14 days
  50_000_000n, // minimumStake
  1_000_000n, // penaltyAmount
  100_000_000n, // verifierDailyCap
  1_200n, // takeRateBps
  5_000n, // slashAgentBps
  3_000n, // slashPlatformBps
  2_000n, // slashCapBps
];

interface Reads {
  readonly escrow: Record<string, bigint>;
  readonly stake: Record<string, bigint>;
}

function client(
  reads: Partial<Reads> = {},
  spies: { readContract?: jest.Mock; multicall?: jest.Mock } = {},
): EvmReaderClient {
  const one = (address: string, functionName: string, args: readonly unknown[]): unknown => {
    if (functionName === 'escrowOf') {
      return decodeFunctionResult({
        abi: ASSAY_ESCROW_ABI,
        functionName: 'escrowOf',
        data: returnData(escrowWords(reads.escrow ?? {})),
      });
    }
    if (functionName === 'stakeOf') {
      return decodeFunctionResult({
        abi: ASSAY_STAKE_ABI,
        functionName: 'stakeOf',
        data: returnData(stakeWords(reads.stake ?? {})),
      });
    }
    if (functionName === 'params') {
      return decodeFunctionResult({
        abi: ASSAY_CONFIG_ABI,
        functionName: 'params',
        data: returnData(PARAMS_WORDS),
      });
    }
    throw new Error(`unexpected read of ${functionName} at ${address} with ${String(args)}`);
  };

  return {
    readContract: async (args) => {
      spies.readContract?.(args);
      return one(args.address, args.functionName, args.args);
    },
    multicall: async (args) => {
      spies.multicall?.(args);
      return args.contracts.map((c) => one(c.address, c.functionName, c.args));
    },
  };
}

function escrowReader(reads: Partial<Reads> = {}, spies = {}) {
  return new EvmEscrowBalanceReader(
    new Map<ChainId, EvmReaderClient>([[TESTNET, client(reads, spies)]]),
    new Map([[TESTNET, DEPLOYMENT]]),
  );
}

function stakeReader(reads: Partial<Reads> = {}, spies = {}) {
  return new EvmStakeReader(
    new Map<ChainId, EvmReaderClient>([[TESTNET, client(reads, spies)]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    { now: () => 1_800_000_000_000, paramsTtlMs: 60_000 },
  );
}

describe('EvmEscrowBalanceReader', () => {
  it('reads every field of the Escrow struct into the field of the same NAME', async () => {
    // The whole struct, decoded from positional words. A transposition of any
    // two same-typed fields in the vendored ABI lands here as a wrong number
    // under a right name.
    const reading = await escrowReader().read(BUYER_ACCOUNT, USDG);

    expect(reading).not.toBeNull();
    expect(MoneyUtil.toAtomic(reading!.balance)).toBe(101n);
    expect(reading!.balance.asset).toBe(USDG);
    expect(reading!.balance.decimals).toBe(6);
    expect(reading!.seqHigh).toBe(102n);
    expect(reading!.maxVoucherAmount).toBe(104n);
    expect(reading!.maxPerWindow).toBe(105n);
    expect(reading!.spentInWindow).toBe(106n);
    expect(reading!.windowStartedAt).toBe(107);
    expect(reading!.withdrawRequested).toBe(108n);
    expect(reading!.withdrawAvailableAt).toBe(109);
    expect(reading!.lifetime).toEqual({ funded: 112n, redeemed: 110n, withdrawn: 111n });
    expect(reading!.observedAt).toBeInstanceOf(Date);
  });

  it('returns null for a buyer who has never funded', async () => {
    // A Solidity mapping has no absence: an unfunded buyer reads back as an
    // all-zero struct, and `totalFunded === 0` is the only honest "nothing here".
    const zero = Object.fromEntries(
      [
        'balance',
        'seqHigh',
        'authNonce',
        'maxVoucherAmount',
        'maxPerWindow',
        'spentInWindow',
        'windowStartedAt',
        'withdrawRequested',
        'withdrawAvailableAt',
        'totalRedeemed',
        'totalWithdrawn',
        'totalFunded',
      ].map((name) => [name, 0n]),
    );

    await expect(escrowReader({ escrow: zero }).read(BUYER_ACCOUNT, USDG)).resolves.toBeNull();
  });

  it('does not report a zero balance as "no escrow" for a buyer who has withdrawn', async () => {
    // The control that stops `read` from being `() => null`, which satisfies
    // "returns null for an unfunded buyer" completely. This fixture violates
    // exactly one thing against the all-zero one above: `totalFunded`.
    const withdrawn = {
      balance: 0n,
      seqHigh: 0n,
      authNonce: 0n,
      maxVoucherAmount: 0n,
      maxPerWindow: 0n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      withdrawRequested: 0n,
      withdrawAvailableAt: 0n,
      totalRedeemed: 0n,
      totalWithdrawn: 5_000_000n,
      totalFunded: 5_000_000n,
    };

    await expect(escrowReader({ escrow: withdrawn }).read(BUYER_ACCOUNT, USDG)).resolves.toEqual(
      expect.objectContaining({ withdrawRequested: 0n, seqHigh: 0n }),
    );
  });

  it('reads the escrow contract named by the deployment, not the stake one', async () => {
    const readContract = jest.fn();
    await escrowReader({}, { readContract }).read(BUYER_ACCOUNT, USDG);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: DEPLOYMENT.escrow, functionName: 'escrowOf' }),
    );
    expect(readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ address: DEPLOYMENT.stake }),
    );
  });

  it('refuses an account on a chain this reader does not serve', async () => {
    await expect(escrowReader().read(toAccountId(OTHER, BUYER), USDG)).rejects.toThrow(
      /eip155:84532/,
    );
  });

  it('refuses an asset that is not this chain settlement asset', async () => {
    // A reading denominated in the wrong asset is a `Money` that arithmetic
    // will happily add to the right one.
    await expect(escrowReader().read(BUYER_ACCOUNT, USDC_DEVNET)).rejects.toThrow();

    // The control: the chain's own asset reads.
    await expect(escrowReader().read(BUYER_ACCOUNT, USDG)).resolves.not.toBeNull();
  });

  it('refuses a mixed-case address whose EIP-55 checksum does not verify', async () => {
    const typo = `${BUYER.slice(0, -1)}5`;
    await expect(escrowReader().read(`${TESTNET}:${typo}` as AccountId, USDG)).rejects.toThrow(
      /address/i,
    );
  });

  it('readMany issues ONE multicall and keys the result by account', async () => {
    const multicall = jest.fn();
    const other = toAccountId(TESTNET, PROVIDER);

    const found = await escrowReader({}, { multicall }).readMany([BUYER_ACCOUNT, other], USDG);

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(2);
    expect([...found.keys()]).toEqual([BUYER_ACCOUNT, other]);
    expect(MoneyUtil.toAtomic(found.get(BUYER_ACCOUNT)!.balance)).toBe(101n);
  });

  it('readMany maps an unfunded buyer to null rather than leaving it out', async () => {
    const zero = Object.fromEntries(
      Object.keys(await escrowFields()).map((name) => [name, 0n]),
    ) as Record<string, bigint>;

    const found = await escrowReader({ escrow: zero }).readMany([BUYER_ACCOUNT], USDG);

    expect(found.size).toBe(1);
    expect(found.get(BUYER_ACCOUNT)).toBeNull();
  });

  it('names the escrow contract as BOTH escrow addresses, in the port Solana vocabulary', async () => {
    // On EVM the contract is the account and the token holder at once. The
    // field names are `EscrowBalanceReaderPort`'s Solana vocabulary; inventing a
    // second port to rename two strings would fork the interface every caller
    // reads.
    await expect(escrowReader().escrowAddresses(BUYER_ACCOUNT, USDG)).resolves.toEqual({
      escrowPda: toAccountId(TESTNET, DEPLOYMENT.escrow),
      escrowTokenAccount: toAccountId(TESTNET, DEPLOYMENT.escrow),
    });
  });
});

describe('EvmStakeReader', () => {
  it('reads every field of the ProviderStake struct into the field of the same NAME', async () => {
    const found = await stakeReader().bondedStakeOf([PROVIDER_ACCOUNT]);
    const stake = found.get(PROVIDER_ACCOUNT);

    expect(stake).toBeDefined();
    // `bonded` is word 0 and `unbonding` word 1. A transposition swaps a
    // routable figure with one that is deliberately NOT routable.
    expect(MoneyUtil.toAtomic(stake!.bonded)).toBe(201n);
    expect(MoneyUtil.toAtomic(stake!.unbonding)).toBe(202n);
    expect(stake!.bonded.asset).toBe(USDG);
    expect(stake!.bonded.decimals).toBe(6);
    expect(stake!.account).toBe(PROVIDER_ACCOUNT);
  });

  it('never folds unbonding into bonded', async () => {
    // The one bug this reader exists not to have: a provider who has requested
    // a full unstake would otherwise go on taking paid traffic for the whole
    // unbonding period with a gate that says they are covered.
    const found = await stakeReader().bondedStakeOf([PROVIDER_ACCOUNT]);

    expect(MoneyUtil.toAtomic(found.get(PROVIDER_ACCOUNT)!.bonded)).not.toBe(201n + 202n);
  });

  it('derives unbondingCompletesAt from the CHAIN parameter, not a local constant', async () => {
    const found = await stakeReader().bondedStakeOf([PROVIDER_ACCOUNT]);
    const stake = found.get(PROVIDER_ACCOUNT)!;

    expect(stake.unbondingStartedAt).toEqual(new Date(203 * 1000));
    // 203 + 1 209 600, the `unbondingPeriodSeconds` in the ParamSet words.
    expect(stake.unbondingCompletesAt).toEqual(new Date((203 + 1_209_600) * 1000));
  });

  it('reports null dates when nothing is unbonding, never 1970', async () => {
    const found = await stakeReader({
      stake: { unbonding: 0n, unbondingStartedAt: 0n },
    }).bondedStakeOf([PROVIDER_ACCOUNT]);
    const stake = found.get(PROVIDER_ACCOUNT)!;

    expect(stake.unbondingStartedAt).toBeNull();
    expect(stake.unbondingCompletesAt).toBeNull();
  });

  it('omits a provider who has never staked, and keeps one who staked and withdrew', async () => {
    // Absence and zero are different answers — the port says so. On EVM the
    // mapping has no absence, so `totalDeposited === 0` is what stands in for
    // it, and a provider who staked and fully withdrew stays PRESENT at zero.
    const never = await stakeReader({
      stake: { bonded: 0n, unbonding: 0n, unbondingStartedAt: 0n, totalDeposited: 0n },
    }).bondedStakeOf([PROVIDER_ACCOUNT]);
    expect(never.size).toBe(0);

    const exited = await stakeReader({
      stake: {
        bonded: 0n,
        unbonding: 0n,
        unbondingStartedAt: 0n,
        totalDeposited: 5_000_000n,
      },
    }).bondedStakeOf([PROVIDER_ACCOUNT]);
    expect(MoneyUtil.toAtomic(exited.get(PROVIDER_ACCOUNT)!.bonded)).toBe(0n);
  });

  it('reads the stake contract named by the deployment, not the escrow one', async () => {
    const multicall = jest.fn();
    await stakeReader({}, { multicall }).bondedStakeOf([PROVIDER_ACCOUNT]);

    expect(multicall.mock.calls[0][0].contracts[0]).toEqual(
      expect.objectContaining({ address: DEPLOYMENT.stake, functionName: 'stakeOf' }),
    );
  });

  it('multicalls once for many providers on one chain', async () => {
    const multicall = jest.fn();
    const reader = stakeReader({}, { multicall });

    await reader.bondedStakeOf([PROVIDER_ACCOUNT, BUYER_ACCOUNT]);

    // One `stakeOf` multicall. `params()` is its own read and is memoised.
    const stakeCalls = multicall.mock.calls.filter(
      (call) => call[0].contracts[0]?.functionName === 'stakeOf',
    );
    expect(stakeCalls).toHaveLength(1);
    expect(stakeCalls[0][0].contracts).toHaveLength(2);
  });

  it('refuses an account on a chain this reader does not serve', async () => {
    await expect(stakeReader().bondedStakeOf([toAccountId(OTHER, PROVIDER)])).rejects.toThrow(
      /eip155:84532/,
    );
  });

  it('refuses a mixed-case address whose EIP-55 checksum does not verify', async () => {
    const typo = `${PROVIDER.slice(0, -1)}5`;
    await expect(stakeReader().bondedStakeOf([`${TESTNET}:${typo}` as AccountId])).rejects.toThrow(
      /address/i,
    );
  });

  it('answers an empty request without touching the chain', async () => {
    const multicall = jest.fn();
    await expect(stakeReader({}, { multicall }).bondedStakeOf([])).resolves.toEqual(new Map());
    expect(multicall).not.toHaveBeenCalled();
  });

  it('refuses a multicall reply that does not answer for exactly what was asked', async () => {
    // Unreadable must never resolve to empty: absence here means "this provider
    // has fully exited", which is what the rotation gate reads to let a
    // defector re-point their stake authority at an empty account.
    const short: EvmReaderClient = {
      readContract: async () =>
        decodeFunctionResult({
          abi: ASSAY_CONFIG_ABI,
          functionName: 'params',
          data: returnData(PARAMS_WORDS),
        }),
      multicall: async () => [],
    };
    const reader = new EvmStakeReader(
      new Map<ChainId, EvmReaderClient>([[TESTNET, short]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      { now: () => 0, paramsTtlMs: 60_000 },
    );

    await expect(reader.bondedStakeOf([PROVIDER_ACCOUNT])).rejects.toThrow(/multicall/i);
  });
});

/** The `Escrow` field names, read back off a real decode rather than retyped. */
async function escrowFields(): Promise<Record<string, bigint>> {
  return decodeFunctionResult({
    abi: ASSAY_ESCROW_ABI,
    functionName: 'escrowOf',
    data: returnData(escrowWords()),
  }) as unknown as Record<string, bigint>;
}
