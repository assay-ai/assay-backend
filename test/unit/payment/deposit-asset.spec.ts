import { chainMetadata, describedChains } from '@modules/chains/chain-metadata';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import {
  assertDepositAssetIsSettlementAsset,
  depositAssetFor,
} from '@modules/payment/domain/deposit-asset';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { BaseError } from '@shared/errors/base.error';

import { expectErrorCode } from '../helpers/expect-error-code';

/**
 * Which asset a deposit may name, per chain.
 *
 * ## Every fixture here names two chains with two DIFFERENT answers
 *
 * The defect this file was written for was a `Partial<Record<ChainId, AssetId>>`
 * with two Solana rows and no `eip155` row, so `POST /deposits` on
 * `eip155:46630` was refused before anything else happened. It survived because
 * every fixture that touched deposits used one chain — and on one chain, "the
 * right answer", "the first answer" and "any answer" are the same string.
 *
 * So no case below asserts a single value. Each one asserts a *pair* whose
 * members differ, and the pair spans the two namespaces this deployment serves:
 * `solana:…` settles in USDC, `eip155:46630` settles in **USDG**, a different
 * token with a different symbol at a different address. Two degenerate
 * implementations are named in the report and were run against this file:
 * "accept any asset on any chain" and "always return the first registered
 * asset". The first dies on {@link CROSS_CHAIN} below, the second on
 * {@link PER_CHAIN}.
 */

/** The chain ↔ its declared settlement asset. Four chains, four distinct assets. */
const PER_CHAIN: readonly { chainId: ChainId; asset: AssetId; symbol: string }[] = [
  { chainId: CHAIN_IDS.SOLANA_MAINNET, asset: ASSET_IDS.USDC_SOLANA_MAINNET, symbol: 'USDC' },
  { chainId: CHAIN_IDS.SOLANA_DEVNET, asset: ASSET_IDS.USDC_SOLANA_DEVNET, symbol: 'USDC' },
  { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET, symbol: 'USDG' },
  { chainId: CHAIN_IDS.ROBINHOOD_MAINNET, asset: ASSET_IDS.USDG_ROBINHOOD_MAINNET, symbol: 'USDG' },
];

/**
 * Each chain paired with an asset that is registered, real, and **not** its
 * settlement asset. Runs in both directions: an EVM asset offered to Solana and
 * a Solana asset offered to EVM. A guard that only refuses "unregistered" or
 * only refuses "not an SPL mint" passes one direction and fails the other.
 */
const CROSS_CHAIN: readonly { chainId: ChainId; wrong: AssetId }[] = [
  { chainId: CHAIN_IDS.SOLANA_DEVNET, wrong: ASSET_IDS.USDG_ROBINHOOD_TESTNET },
  { chainId: CHAIN_IDS.SOLANA_DEVNET, wrong: ASSET_IDS.USDC_SOLANA_MAINNET },
  { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, wrong: ASSET_IDS.USDC_SOLANA_DEVNET },
  { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, wrong: ASSET_IDS.USDC_SOLANA_MAINNET },
  // Same symbol, same scale, different chain: testnet USDG is not mainnet USDG.
  { chainId: CHAIN_IDS.ROBINHOOD_MAINNET, wrong: ASSET_IDS.USDG_ROBINHOOD_TESTNET },
  { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, wrong: ASSET_IDS.USDG_ROBINHOOD_MAINNET },
];

/** Chains this deployment names but cannot describe — there is no row to read. */
const UNDESCRIBED: readonly ChainId[] = [CHAIN_IDS.BASE_MAINNET, CHAIN_IDS.BASE_SEPOLIA];

describe('depositAssetFor', () => {
  it.each(PER_CHAIN)('answers $asset on $chainId', ({ chainId, asset }) => {
    expect(depositAssetFor(chainId)).toBe(asset);
  });

  it('answers a DIFFERENT asset on each chain, and none of them is USDC-only', () => {
    const answers = PER_CHAIN.map((row) => depositAssetFor(row.chainId));

    // Three chains, three distinct answers: an implementation that returns one
    // constant, or the registry's first entry, collapses this set.
    expect(new Set(answers).size).toBe(PER_CHAIN.length);

    // And the symbols are not all the same string. `eip155:46630` settles in
    // USDG — the error this path used to throw was literally named
    // `..._NOT_USDC`, which is false here.
    expect(answers.map((asset) => getAssetMetadata(asset).symbol)).toEqual([
      'USDC',
      'USDC',
      'USDG',
      'USDG',
    ]);
  });

  it.each(PER_CHAIN)('answers an asset that LIVES on $chainId', ({ chainId }) => {
    expect(chainIdOf(depositAssetFor(chainId))).toBe(chainId);
  });

  it('answers exactly what the chain declares it settles in, for every described chain', () => {
    // Not a second table of expectations — the point is that there is now ONE
    // declaration. A chain added to `chain-metadata.ts` is covered by this the
    // day it lands, which is the property the old lookup table did not have.
    for (const chainId of describedChains()) {
      expect(depositAssetFor(chainId)).toBe(chainMetadata(chainId).settlementAsset);
    }
  });

  it.each(UNDESCRIBED)('refuses %s, which this deployment cannot describe', (chainId) => {
    // Not "the first registered asset", not a default: no answer at all. The
    // honest error is the chain one — the caller supplied no asset to be wrong
    // about.
    expectErrorCode(() => depositAssetFor(chainId), ChainErrorCode.CHAIN_UNSUPPORTED);
  });
});

describe('assertDepositAssetIsSettlementAsset', () => {
  it.each(PER_CHAIN)('accepts $asset on $chainId', ({ chainId, asset }) => {
    expect(() => assertDepositAssetIsSettlementAsset(chainId, asset)).not.toThrow();
  });

  it.each(CROSS_CHAIN)('refuses $wrong on $chainId', ({ chainId, wrong }) => {
    expectErrorCode(
      () => assertDepositAssetIsSettlementAsset(chainId, wrong),
      PaymentErrorCode.PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET,
    );
  });

  it('refuses a registered asset whose SYMBOL matches, on the wrong chain', () => {
    // The property the deleted lookup table's comment was protecting, kept: the
    // decision is never "the registry says symbol === 'USDC'". Mainnet USDC and
    // devnet USDC share a symbol and a scale and are both registered; only one
    // of them is devnet's settlement asset.
    expect(getAssetMetadata(ASSET_IDS.USDC_SOLANA_MAINNET).symbol).toBe(
      getAssetMetadata(ASSET_IDS.USDC_SOLANA_DEVNET).symbol,
    );

    expectErrorCode(
      () =>
        assertDepositAssetIsSettlementAsset(CHAIN_IDS.SOLANA_DEVNET, ASSET_IDS.USDC_SOLANA_MAINNET),
      PaymentErrorCode.PAYMENT_DEPOSIT_ASSET_NOT_SETTLEMENT_ASSET,
    );
  });

  it('names the asset it wanted, per chain, so the message cannot be generic', () => {
    // A buyer on `eip155:46630` told "accept only the registered USDC of the
    // chain" concludes they used the wrong token when they used the right one.
    // The refusal must name THIS chain's asset, and the two must differ.
    const messages = [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.ROBINHOOD_TESTNET].map((chainId) => {
      try {
        assertDepositAssetIsSettlementAsset(chainId, 'solana:nope/token:nope' as AssetId);
        throw new Error(`expected a refusal on ${chainId}`);
      } catch (error) {
        expect(error).toBeInstanceOf(BaseError);
        return (error as BaseError).message;
      }
    });

    expect(messages[0]).toContain(ASSET_IDS.USDC_SOLANA_DEVNET);
    expect(messages[1]).toContain(ASSET_IDS.USDG_ROBINHOOD_TESTNET);
    expect(messages[0]).not.toBe(messages[1]);
    // Says nothing about USDC on the chain that does not settle in it.
    expect(messages[1]).not.toContain('USDC');
  });

  it.each(UNDESCRIBED)('refuses every asset on %s, which has no settlement asset', (chainId) => {
    expectErrorCode(
      () => assertDepositAssetIsSettlementAsset(chainId, ASSET_IDS.USDC_SOLANA_MAINNET),
      ChainErrorCode.CHAIN_UNSUPPORTED,
    );
  });
});
