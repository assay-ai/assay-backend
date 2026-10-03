import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import {
  ConfigProviderStakeSource,
  ProviderStakeSnapshot,
} from '@modules/provider/services/config-provider-stake.source';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * `ConfigProviderStakeSource` — the seeded stake source, and **the default
 * production one**.
 *
 * ## Why this file exists
 *
 * `PROVIDER_STAKE_SOURCE_MODE` defaults to `config`, so on an unset environment
 * — which is every environment on the day on-chain stake shipped and most of them still
 * — this class *is* the platform's answer to "how much has this provider
 * staked". It had no spec at all until stake became per-chain, and the gap was not
 * theoretical: review's degenerate added a cross-chain fallback here
 * (`snapshot[key] ?? any key starting with ${providerId}|`) and the entire
 * 3,665-test unit suite stayed green, because every other fixture that reaches
 * this class seeds the exact pair it then asks for.
 *
 * That fallback is precisely the substitution per-chain stake exists to forbid, on the
 * default path. So the cases below are deliberately about the two things a
 * lookup can get wrong — **answering a pair it should not** and **failing to
 * answer one it should** — rather than about the arithmetic, of which there is
 * none.
 *
 * ## Two Solana chain ids and no EVM
 *
 * The class never learns what a chain is; it looks up a string key. Two devnet/
 * mainnet ids state the property exactly as well as an EVM id would, and
 * without an adapter.
 */

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

const DEVNET_USDC = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;
const MAINNET_USDC = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;

const PROVIDER = 'org-11111111-1111-4111-8111-111111111111';
const OTHER = 'org-22222222-2222-4222-8222-222222222222';

function money(atomic: string, asset: AssetId): Money {
  return MoneyUtil.of(atomic, asset, 6);
}

function source(snapshot: ProviderStakeSnapshot): ConfigProviderStakeSource {
  return new ConfigProviderStakeSource(snapshot);
}

describe('ConfigProviderStakeSource — keyed on the PAIR, never on the provider', () => {
  it('answers the seeded chain and is ABSENT on the one it was not seeded for', async () => {
    // The degenerate this kills, and it is the sharpest one in the diff: a
    // fallback from `${providerId}|${chainId}` to any key for that provider.
    // Such a source answers a 4663 call with Solana collateral no contract on
    // 4663 can take, on the DEFAULT production path, and every routing fixture
    // in this tree seeds the exact pair so none of them would notice.
    const found = await source({
      [stakeKey(PROVIDER, DEVNET)]: money('1000000000', DEVNET_USDC),
    }).stakeOn([
      { providerId: PROVIDER, chainId: DEVNET },
      { providerId: PROVIDER, chainId: MAINNET },
    ]);

    expect(found.get(stakeKey(PROVIDER, DEVNET))?.staked.amount).toBe('1000000000');
    expect(found.has(stakeKey(PROVIDER, MAINNET))).toBe(false);
  });

  it('does not answer one provider from another provider’s entry', async () => {
    // The other half of the same key, and the collision that a chain-only key
    // would produce: the router asks about many providers at once, so a source
    // keyed on the chain alone would let one provider's seed answer for every
    // other provider on that chain.
    const found = await source({
      [stakeKey(OTHER, DEVNET)]: money('1000000000', DEVNET_USDC),
    }).stakeOn([{ providerId: PROVIDER, chainId: DEVNET }]);

    expect(found.size).toBe(0);
  });

  it('carries the chain on the reading, matching the key it was asked for', async () => {
    // `evaluateStakeGate` cross-checks `reading.chainId` against the chain it
    // was asked about, so a source that filed the wrong one would be refused
    // rather than believed. Pinned here as well as at the gate, because this is
    // the source that writes it.
    const found = await source({
      [stakeKey(PROVIDER, MAINNET)]: money('500000000', MAINNET_USDC),
    }).stakeOn([{ providerId: PROVIDER, chainId: MAINNET }]);

    expect(found.get(stakeKey(PROVIDER, MAINNET))).toMatchObject({
      providerId: PROVIDER,
      chainId: MAINNET,
    });
  });

  it('answers two chains independently for one provider', async () => {
    // The invariant in one call: bonded on both, and the two figures do not
    // stand in for each other.
    const found = await source({
      [stakeKey(PROVIDER, DEVNET)]: money('1000000000', DEVNET_USDC),
      [stakeKey(PROVIDER, MAINNET)]: money('7000000', MAINNET_USDC),
    }).stakeOn([
      { providerId: PROVIDER, chainId: DEVNET },
      { providerId: PROVIDER, chainId: MAINNET },
    ]);

    expect(found.get(stakeKey(PROVIDER, DEVNET))?.staked.amount).toBe('1000000000');
    expect(found.get(stakeKey(PROVIDER, MAINNET))?.staked.amount).toBe('7000000');
  });

  it('leaves an unseeded pair absent, never zero', async () => {
    // Absent is not zero — the port is emphatic, and the gate refuses both
    // while a receipt can still tell them apart. A source that returned a zero
    // `Money` here would make "the operator never seeded this provider" and
    // "this provider has bonded nothing" the same fact.
    const found = await source({}).stakeOn([{ providerId: PROVIDER, chainId: DEVNET }]);

    expect(found.size).toBe(0);
    expect(found.get(stakeKey(PROVIDER, DEVNET))).toBeUndefined();
  });

  it('asks nothing and answers nothing for an empty key set', async () => {
    expect((await source({}).stakeOn([])).size).toBe(0);
  });
});
