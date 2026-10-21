import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  MinimumStakeReaderPort,
  MinimumStakeReading,
} from '@modules/chains/ports/minimum-stake-reader.port';
import { liveMinimumStakeParameters } from '@modules/provider/services/provider-stake.service';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import {
  CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS,
  ContractMinimumStakeFloors,
} from '@modules/tool/services/contract-minimum-stake-floors.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The routing floor follows the settlement contract's minimum stake: read
 * with the economics panel's 2 s budget, cached in memory, never lower than
 * the configured floor, and the configured floor when the chain cannot be read.
 */
const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC0000000000000000000000000000000000aA` as AssetId;
const usd = (dollars: number) => MoneyUtil.of(String(dollars * 1_000_000), ASSET, 6);
const CONFIGURED: MinimumStakeParameters = { floor: usd(50), priceMultiple: 1000 };

function reader(...answers: Array<readonly MinimumStakeReading[] | Error>) {
  let call = 0;
  const readMinimumStakes = jest.fn(async (_options: { timeoutMs: number }) => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { readMinimumStakes } satisfies MinimumStakeReaderPort;
}

const read = (dollars: number): MinimumStakeReading => ({
  chainId: CHAIN,
  minimumStake: usd(dollars),
  failure: null,
});
const failed: MinimumStakeReading = { chainId: CHAIN, minimumStake: null, failure: 'TIMEOUT' };

function floors(port: MinimumStakeReaderPort | null) {
  return new ContractMinimumStakeFloors(new Map([[CHAIN, CONFIGURED]]), port);
}

describe('ContractMinimumStakeFloors — routing follows the contract minimum', () => {
  it('raises the routing floor to a stricter contract minimum before routing starts', async () => {
    const port = reader([read(100)]);
    const subject = floors(port);

    await subject.onModuleInit();
    subject.onModuleDestroy();

    expect(subject.byChain.get(CHAIN)).toEqual({ floor: usd(100), priceMultiple: 1000 });
    expect(port.readMinimumStakes).toHaveBeenCalledWith({
      timeoutMs: CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS,
    });
    expect(CONTRACT_MINIMUM_STAKE_READ_TIMEOUT_MS).toBe(2_000);
  });

  it('uses the configured floor when the chain cannot be read', async () => {
    const subject = floors(reader([failed]));
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
  });

  it('uses the configured floor when there is no reader at all', async () => {
    const subject = floors(null);
    await subject.onModuleInit();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
  });

  it('keeps the last contract reading when a later read fails or throws', async () => {
    const subject = floors(reader([read(100)], [failed], new Error('rpc down')));
    await subject.refresh();
    await subject.refresh();
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(100));
  });

  it('never drops below the configured floor (a lower contract minimum is ignored)', async () => {
    const subject = floors(reader([read(10)]));
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
  });

  it('follows a contract minimum that changes, down to the configured floor', async () => {
    const subject = floors(reader([read(100)], [read(75)]));
    await subject.refresh();
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(75));
  });

  it('ignores a reading in another asset, and a chain without a configured floor', async () => {
    const other = MoneyUtil.of(
      '100000000',
      `${CHAIN}/erc20:0x1111111111111111111111111111111111111111` as never,
      6,
    );
    const subject = floors(
      reader([
        { chainId: CHAIN, minimumStake: other, failure: null },
        { chainId: CHAIN_IDS.SOLANA_DEVNET as ChainId, minimumStake: usd(500), failure: null },
      ]),
    );
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(50));
    expect(subject.byChain.has(CHAIN_IDS.SOLANA_DEVNET as ChainId)).toBe(false);
  });

  it('matches the asset whatever the address case, keeping the floor’s own tag', async () => {
    const lower = MoneyUtil.of('100000000', ASSET.toLowerCase() as AssetId, 6);
    const subject = floors(reader([{ chainId: CHAIN, minimumStake: lower, failure: null }]));
    await subject.refresh();
    expect(subject.byChain.get(CHAIN)?.floor).toEqual(usd(100));
  });

  it('keeps one map for its whole life, so the router sees every refresh', async () => {
    const subject = floors(reader([read(100)]));
    const before = subject.byChain;
    await subject.refresh();
    expect(subject.byChain).toBe(before);
  });

  it('runs one read at a time', async () => {
    let release: (value: readonly MinimumStakeReading[]) => void = () => undefined;
    const readMinimumStakes = jest.fn(
      () => new Promise<readonly MinimumStakeReading[]>((resolve) => (release = resolve)),
    );
    const subject = floors({ readMinimumStakes });
    const first = subject.refresh();
    const second = subject.refresh();
    release([read(100)]);
    await Promise.all([first, second]);
    expect(readMinimumStakes).toHaveBeenCalledTimes(1);
  });
});

describe('liveMinimumStakeParameters — the Capital screen and stake monitor floor (review M-8)', () => {
  it('follows the effective routing floor when it is stricter, at every read', async () => {
    const subject = floors(reader([read(100)]));
    const parameters = liveMinimumStakeParameters(CONFIGURED, subject.byChain);
    expect(parameters.floor).toEqual(usd(50));
    await subject.refresh();
    expect(parameters.floor).toEqual(usd(100));
    expect(parameters.priceMultiple).toBe(1000);
  });

  it('never shows less than the configured floor', () => {
    const parameters = liveMinimumStakeParameters(
      CONFIGURED,
      new Map([[CHAIN, { floor: usd(10), priceMultiple: 1000 }]]),
    );
    expect(parameters.floor).toEqual(usd(50));
  });

  it('shows the configured floor when the chain has no entry', () => {
    expect(liveMinimumStakeParameters(CONFIGURED, new Map()).floor).toEqual(usd(50));
  });
});
