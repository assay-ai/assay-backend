import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';

import {
  EVM_STAKE_GAS_CEILING,
  EvmStakeIntentBuilder,
  EvmStakeIntentClient,
} from '@modules/chains/evm/evm-stake-intent-builder.service';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { Eip155UnsignedTransaction } from '@modules/chains/ports/unsigned-chain-transaction';
import {
  GAS_NOT_SPONSORED_REASON,
  StakeIntentKind,
  StakeIntentRequest,
} from '@modules/provider/ports/stake-intent-builder.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';
import { deployment } from './evm-fixtures';

/**
 * `EvmStakeIntentBuilder` — a provider's stake doors on eip155.
 *
 * The ABI the calldata is decoded against is written out here from
 * `assay-evm/src/X402Stake.sol`, not imported from the builder, so a builder that
 * encoded the wrong function or the wrong argument order fails here rather than
 * agreeing with itself.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(TESTNET);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

const PROVIDER = '0x31b1DF6F36ec62075a3BE03a5C0BebB06534bA72';
const PROVIDER_ACCOUNT = toAccountId(TESTNET, PROVIDER);
const TREASURY = '0xD75ba4a2BA90Cb110E32FF4d87e1D1352434C687';
const STRANGER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const TREASURY_ACCOUNT = toAccountId(TESTNET, TREASURY);

const STAKE_ABI = parseAbi([
  'function depositStake(uint64 amount)',
  'function depositStakeFor(address provider, uint64 amount)',
  'function requestUnstake(uint64 amount)',
  'function withdrawStake(uint64 amount)',
  'event StakeDeposited(address indexed provider, address indexed funder, uint64 amount, uint128 bonded)',
]);

const MAX_FEE = 10_000_000n;

/** The block every fixture receipt is mined in, and its timestamp. */
const BLOCK = 4_242n;
const BLOCK_TIME = 1_790_000_000n;
/** The slash executed one hour before that block. */
const EXECUTED_AT = new Date(Number(BLOCK_TIME - 3_600n) * 1000);
const EXPECTED = { funder: TREASURY_ACCOUNT, after: EXECUTED_AT };

function usdg(atomic: bigint) {
  return MoneyUtil.of(atomic, USDG, 6);
}

interface Chain {
  tokenBalance: Map<string, bigint>;
  nativeBalance: Map<string, bigint>;
  nonce: number;
  receipts: Map<string, Awaited<ReturnType<EvmStakeIntentClient['getTransactionReceipt']>>>;
  /** Block timestamps, seconds. */
  blockTimes: Map<bigint, bigint>;
}

function client(chain: Chain): EvmStakeIntentClient {
  return {
    readContract: jest.fn(async (args) => {
      if (args.functionName !== 'balanceOf') throw new Error(`unexpected ${args.functionName}`);
      return chain.tokenBalance.get((args.args[0] as string).toLowerCase()) ?? 0n;
    }),
    getBalance: jest.fn(
      async ({ address }) => chain.nativeBalance.get(address.toLowerCase()) ?? 0n,
    ),
    getTransactionCount: jest.fn(async () => chain.nonce),
    estimateFeesPerGas: jest.fn(async () => ({
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: 1n,
    })),
    getTransactionReceipt: jest.fn(async ({ hash }) => {
      const receipt = chain.receipts.get(hash);
      if (!receipt) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
      return receipt;
    }),
    getBlock: jest.fn(async ({ blockNumber }) => {
      const timestamp = chain.blockTimes.get(blockNumber);
      if (timestamp === undefined) throw new Error(`Block ${blockNumber} could not be found.`);
      return { timestamp };
    }),
  };
}

function freshChain(): Chain {
  return {
    tokenBalance: new Map([[PROVIDER.toLowerCase(), 200_000_000n]]),
    nativeBalance: new Map([[PROVIDER.toLowerCase(), 600_000_000_000_000n]]),
    nonce: 7,
    receipts: new Map(),
    blockTimes: new Map([[BLOCK, BLOCK_TIME]]),
  };
}

function builderOn(chain: Chain) {
  return new EvmStakeIntentBuilder(
    new Map([[TESTNET, client(chain)]]),
    new Map([[TESTNET, DEPLOYMENT]]),
  );
}

function request(overrides: Partial<StakeIntentRequest>): StakeIntentRequest {
  return {
    kind: StakeIntentKind.DEPOSIT,
    account: PROVIDER_ACCOUNT,
    amount: usdg(50_000_000n),
    ...overrides,
  };
}

function depositLog(provider: string, funder: string, amount: bigint, from = DEPLOYMENT.stake) {
  return {
    address: from,
    topics: encodeEventTopics({
      abi: STAKE_ABI,
      eventName: 'StakeDeposited',
      args: { provider: provider as `0x${string}`, funder: funder as `0x${string}` },
    }) as string[],
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint128' }], [amount, amount]),
  };
}

describe('EvmStakeIntentBuilder', () => {
  it('names the deployment asset as the stake asset — the one EvmStakeReader quotes in', async () => {
    await expect(builderOn(freshChain()).stakeAsset(TESTNET)).resolves.toEqual({
      asset: USDG,
      decimals: 6,
    });
  });

  it('says a provider has no stake account to open on this chain', () => {
    expect(builderOn(freshChain()).needsOpenStake(TESTNET)).toBe(false);
  });

  it('refuses to build an OPEN_STAKE: there is no instruction for it on eip155', async () => {
    await expectErrorCodeAsync(
      () =>
        builderOn(freshChain()).buildIntent(
          request({ kind: StakeIntentKind.OPEN_STAKE, amount: null }),
        ),
      ChainErrorCode.CHAIN_PAYLOAD_MALFORMED,
    );
  });

  describe('DEPOSIT', () => {
    it('is depositStake(amount) on the stake proxy, from the provider, with no value', async () => {
      const { transaction } = await builderOn(freshChain()).buildIntent(request({}));
      const tx = transaction as Eip155UnsignedTransaction;

      expect(tx).toMatchObject({
        namespace: 'eip155',
        chainId: TESTNET,
        kind: 'transaction',
        from: PROVIDER,
        to: DEPLOYMENT.stake,
        value: '0',
        nonce: '7',
        gasLimit: EVM_STAKE_GAS_CEILING.DEPOSIT.toString(),
        maxFeePerGas: MAX_FEE.toString(),
      });
      expect(decodeFunctionData({ abi: STAKE_ABI, data: tx.data as `0x${string}` })).toEqual({
        functionName: 'depositStake',
        args: [50_000_000n],
      });
    });

    it('quotes the approve and the deposit together as the gas ceiling, in wei', async () => {
      const { preflight } = await builderOn(freshChain()).buildIntent(request({}));

      expect(preflight.requiredStakeAsset).toEqual(usdg(50_000_000n));
      expect(preflight.stakeAssetBalance).toEqual(usdg(200_000_000n));
      expect(preflight.hasEnoughStakeAsset).toBe(true);
      expect(preflight.requiredGas.asset).toBe(`${TESTNET}/slip44:60`);
      expect(preflight.requiredGas.decimals).toBe(18);
      expect(BigInt(preflight.requiredGas.amount)).toBe(
        (EVM_STAKE_GAS_CEILING.APPROVE + EVM_STAKE_GAS_CEILING.DEPOSIT) * MAX_FEE,
      );
      expect(preflight.gasBalance.amount).toBe('600000000000000');
      expect(preflight.hasEnoughGas).toBe(true);
      expect(preflight.gasSponsored).toBe(false);
      expect(preflight.gasNotSponsoredReason).toBe(GAS_NOT_SPONSORED_REASON);
    });

    it('reports a real zero token balance as zero, never as "no account"', async () => {
      const chain = freshChain();
      chain.tokenBalance.clear();

      const preflight = await builderOn(chain).preflight(request({}));

      expect(preflight.stakeAssetBalance).toEqual(usdg(0n));
      expect(preflight.hasEnoughStakeAsset).toBe(false);
    });

    it('says the gas is short when the wallet holds no ETH', async () => {
      const chain = freshChain();
      chain.nativeBalance.clear();

      const preflight = await builderOn(chain).preflight(request({}));

      expect(preflight.hasEnoughGas).toBe(false);
    });

    it('with a funder, is depositStakeFor(provider, amount) sent and paid for by the funder', async () => {
      const chain = freshChain();
      chain.tokenBalance.set(TREASURY.toLowerCase(), 5_000_000n);

      const { transaction, preflight } = await builderOn(chain).buildIntent(
        request({ funder: toAccountId(TESTNET, TREASURY), amount: usdg(3_000_000n) }),
      );
      const tx = transaction as Eip155UnsignedTransaction;

      expect(tx.from).toBe(TREASURY);
      expect(decodeFunctionData({ abi: STAKE_ABI, data: tx.data as `0x${string}` })).toEqual({
        functionName: 'depositStakeFor',
        args: [PROVIDER, 3_000_000n],
      });
      expect(preflight.stakeAssetBalance).toEqual(usdg(5_000_000n));
    });

    it('refuses a missing amount rather than building a deposit of nothing', async () => {
      await expectErrorCodeAsync(
        () => builderOn(freshChain()).buildIntent(request({ amount: null })),
        ChainErrorCode.CHAIN_PROGRAM_NOT_CONFIGURED,
      );
    });

    it('refuses an amount in any asset but the stake asset', async () => {
      await expectErrorCodeAsync(
        () =>
          builderOn(freshChain()).buildIntent(
            request({ amount: MoneyUtil.of(1n, ASSET_IDS.USDC_SOLANA_DEVNET, 6) }),
          ),
        ChainErrorCode.CHAIN_ASSET_UNKNOWN,
      );
    });
  });

  it.each([
    [StakeIntentKind.UNSTAKE, 'requestUnstake'],
    [StakeIntentKind.WITHDRAW, 'withdrawStake'],
  ])('%s is %s(amount) and moves none of the stake asset in', async (kind, functionName) => {
    const { transaction, preflight } = await builderOn(freshChain()).buildIntent(
      request({ kind, amount: usdg(10_000_000n) }),
    );
    const tx = transaction as Eip155UnsignedTransaction;

    expect(tx.to).toBe(DEPLOYMENT.stake);
    expect(tx.gasLimit).toBe(EVM_STAKE_GAS_CEILING[kind as 'UNSTAKE' | 'WITHDRAW'].toString());
    expect(decodeFunctionData({ abi: STAKE_ABI, data: tx.data as `0x${string}` })).toEqual({
      functionName,
      args: [10_000_000n],
    });
    expect(preflight.requiredStakeAsset.amount).toBe('0');
  });

  it('refuses an account on a chain it has no deployment for', async () => {
    await expectErrorCodeAsync(
      () =>
        builderOn(freshChain()).buildIntent(
          request({ account: toAccountId(CHAIN_IDS.BASE_SEPOLIA, PROVIDER) }),
        ),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });

  describe('confirmedDeposit', () => {
    const HASH = `0x${'ab'.repeat(32)}`;

    it('sums the StakeDeposited events this transaction emitted for THIS provider', async () => {
      const chain = freshChain();
      chain.receipts.set(HASH, {
        status: 'success',
        blockNumber: BLOCK,
        logs: [
          depositLog(PROVIDER, TREASURY, 2_000_000n),
          depositLog(STRANGER, TREASURY, 9_000_000n),
          depositLog(PROVIDER, TREASURY, 1_000_000n),
        ],
      });

      await expect(
        builderOn(chain).confirmedDeposit(HASH, PROVIDER_ACCOUNT, EXPECTED),
      ).resolves.toEqual(usdg(3_000_000n));
    });

    it('ignores a StakeDeposited emitted by any contract but the stake proxy', async () => {
      const chain = freshChain();
      chain.receipts.set(HASH, {
        status: 'success',
        blockNumber: BLOCK,
        logs: [depositLog(PROVIDER, TREASURY, 2_000_000n, STRANGER)],
      });

      await expect(
        builderOn(chain).confirmedDeposit(HASH, PROVIDER_ACCOUNT, EXPECTED),
      ).resolves.toBeNull();
    });

    it('is null for a reverted transaction and for one the chain has never seen', async () => {
      const chain = freshChain();
      chain.receipts.set(HASH, {
        status: 'reverted',
        blockNumber: BLOCK,
        logs: [depositLog(PROVIDER, TREASURY, 2_000_000n)],
      });
      const builder = builderOn(chain);

      await expect(builder.confirmedDeposit(HASH, PROVIDER_ACCOUNT, EXPECTED)).resolves.toBeNull();
      await expect(
        builder.confirmedDeposit(`0x${'cd'.repeat(32)}`, PROVIDER_ACCOUNT, EXPECTED),
      ).resolves.toBeNull();
    });

    // Review M-3: the provider's own earlier stake deposit is not a compensation.
    it('ignores a deposit not funded by the treasury', async () => {
      const chain = freshChain();
      chain.receipts.set(HASH, {
        status: 'success',
        blockNumber: BLOCK,
        logs: [depositLog(PROVIDER, PROVIDER, 5_000_000n), depositLog(PROVIDER, TREASURY, 1n)],
      });

      await expect(
        builderOn(chain).confirmedDeposit(HASH, PROVIDER_ACCOUNT, EXPECTED),
      ).resolves.toEqual(usdg(1n));

      chain.receipts.set(HASH, {
        status: 'success',
        blockNumber: BLOCK,
        logs: [depositLog(PROVIDER, STRANGER, 5_000_000n)],
      });
      await expect(
        builderOn(chain).confirmedDeposit(HASH, PROVIDER_ACCOUNT, EXPECTED),
      ).resolves.toBeNull();
    });

    it('is null for a treasury deposit mined before the slash executed', async () => {
      const chain = freshChain();
      chain.receipts.set(HASH, {
        status: 'success',
        blockNumber: BLOCK,
        logs: [depositLog(PROVIDER, TREASURY, 5_000_000n)],
      });

      await expect(
        builderOn(chain).confirmedDeposit(HASH, PROVIDER_ACCOUNT, {
          funder: TREASURY_ACCOUNT,
          after: new Date(Number(BLOCK_TIME) * 1000),
        }),
      ).resolves.toBeNull();
    });
  });
});
