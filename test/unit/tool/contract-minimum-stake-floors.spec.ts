import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ChainParams, ChainParamsPort } from '@modules/chains/ports/chain-params.port';
import { Money } from '@modules/chains/ports/money.types';
import { liveMinimumStakeParameters } from '@modules/provider/services/provider-stake.service';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { ContractMinimumStakeFloors } from '@modules/tool/services/contract-minimum-stake-floors.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The routing floor follows the settlement contract's minimum stake (the
 * on-chain params cache) in both directions once it was read, and is the
 * configured floor only for a chain never read.
 */
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC0000000000000000000000000000000000aA` as AssetId;
const usd = (dollars: number) => MoneyUtil.of(String(dollars * 1_000_000), ASSET, 6);
const CONFIGURED: MinimumStakeParameters = { floor: usd(50), priceMultiple: 1000 };

function reading(minimumStake: Money | null, source: 'chain' | 'config' = 'chain'): ChainParams {
  return {
    chainId: CHAIN,
    source,
    readAt: source === 'chain' ? new Date() : null,
    contracts: { config: '0x1', stake: '0x2', escrow: '0x3', asset: '0x4' } as never,
    minimumStake,
    penaltyAmount: null,
    verifierDailyCap: null,
    takeRateBps: 1000,
    slashAgentBps: 6000,
    slashPlatformBps: 3000,
    slashCapBps: 1000,
    unbondingPeriodSeconds: 950_400,
    slashDelaySeconds: 259_200,
    policySlashDelaySeconds: 259_200,
    collectHoldSeconds: 3600,
    paused: false,
    arbiter: null,
  };
}

/** A params port whose `refresh()` moves to the next answer. */
function port(...answers: ChainParams[]) {
  let index = 0;
  const listeners = new Set<(params: ChainParams) => void>();
  const fake = {
    current: jest.fn(() => answers[index]),
    all: jest.fn(() => [answers[index]]),
    refresh: jest.fn(async () => {
      index = Math.min(index + 1, answers.length - 1);
      for (const listener of listeners) listener(answers[index]);
    }),
    subscribe: jest.fn((listener: (params: ChainParams) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return fake satisfies ChainParamsPort;
}

function floors(params: ChainParamsPort | null) {
  return new ContractMinimumStakeFloors(new Map([[CHAIN, CONFIGURED]]), params);
}

describe('ContractMinimumStakeFloors — routing follows the contract minimum', () => {
  it('takes the contract minimum before routing starts', () => {
    const subject = floors(port(reading(usd(100))));
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)).toEqual({ floor: usd(100), priceMultiple: 1000 });
  });

  it('follows a contract minimum BELOW the configured floor too', () => {
    const subject = floors(port(reading(usd(10))));
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(10));
  });

  it('uses the configured floor while the chain was never read', () => {
    const subject = floors(port(reading(usd(50), 'config')));
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
  });

  it('uses the configured floor when there is no params cache at all', () => {
    const subject = floors(null);
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
  });

  it('follows every change the cache announces, without a refresh of its own', async () => {
    const params = port(reading(usd(100)), reading(usd(75)));
    const subject = floors(params);
    subject.onModuleInit();
    await params.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(75));
    subject.onModuleDestroy();
    await params.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(75));
  });

  it('ignores a reading in another asset, and a chain without a configured floor', () => {
    const other = MoneyUtil.of(
      '100000000',
      `${CHAIN}/erc20:0x1111111111111111111111111111111111111111` as never,
      6,
    );
    const subject = floors(port(reading(other)));
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
    expect(subject.byChain.has(CHAIN_IDS.SOLANA_DEVNET as ChainId)).toBe(false);
  });

  it('matches the asset whatever the address case, keeping the floor’s own tag', () => {
    const lower = MoneyUtil.of('100000000', ASSET.toLowerCase() as AssetId, 6);
    const subject = floors(port(reading(lower)));
    subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(100));
  });

  it('keeps one map for its whole life, so the router sees every refresh', async () => {
    const subject = floors(port(reading(usd(50), 'config'), reading(usd(100))));
    const before = subject.byChain;
    await subject.refresh();
    expect(subject.byChain).toBe(before);
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(100));
  });
});

describe('liveMinimumStakeParameters — the Capital screen and stake monitor floor (review M-8)', () => {
  it('follows the effective routing floor, at every read', async () => {
    const subject = floors(port(reading(usd(50), 'config'), reading(usd(100))));
    const parameters = liveMinimumStakeParameters(CONFIGURED, subject.byChain);
    expect(parameters.floor).toEqual(usd(50));
    await subject.refresh();
    expect(parameters.floor).toEqual(usd(100));
    expect(parameters.priceMultiple).toBe(1000);
  });

  it('shows a routing floor below the configured one (the chain wins)', () => {
    const parameters = liveMinimumStakeParameters(
      CONFIGURED,
      new Map([[CHAIN, { floor: usd(10), priceMultiple: 1000 }]]),
    );
    expect(parameters.floor).toEqual(usd(10));
  });

  it('shows the configured floor when the chain has no entry', () => {
    expect(liveMinimumStakeParameters(CONFIGURED, new Map()).floor).toEqual(usd(50));
  });
});
