import { ChainErrors } from '../errors/chains.errors';
import { AssetId, CHAIN_IDS, ChainId } from './caip.types';
import { AssetMetadata } from './money.types';

/**
 * Every asset the platform will hold, with the scale it is expected to have.
 *
 * The scale is recorded here rather than read from the chain because a mint
 * whose on-chain decimals differ from what we registered is either a
 * misconfiguration or a spoofed asset. Both should be loud.
 */
const USDC_SOLANA_MAINNET =
  `${CHAIN_IDS.SOLANA_MAINNET}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` as AssetId;

/**
 * Circle's devnet USDC mint, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, is
 * gated behind Circle's captcha faucet — there is no way to mint it
 * programmatically, which makes it useless for a reproducible devnet script
 * (`scripts/devnet/`) that has to fund a test wallet itself.
 *
 * `SOLANA_DEVNET_USDC_MINT` lets a devnet deployment point at a mint it
 * actually controls — typically a 6-decimal SPL mint the devnet script creates
 * and mints from, standing in for USDC. Read **once**, at module load, not per
 * call: an asset id that changed mid-process would silently split one asset
 * into two registry entries and make a balance held under the old id
 * unreachable under the new one.
 *
 * `SOLANA_DEVNET_USDC_MINT` is refused outright once `NODE_ENV=production` —
 * mainnet must never be overridable, and the only way to guarantee that is to
 * not read the variable at all in that environment rather than trust that
 * nobody sets it. A devnet-only knob that silently worked in production would
 * be a way to point the mainnet vault at an arbitrary mint.
 */
function resolveDevnetUsdcMint(): string {
  const override = process.env.SOLANA_DEVNET_USDC_MINT;
  if (!override) {
    return '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  }
  if (process.env.NODE_ENV === 'production') {
    throw ChainErrors.devnetOverrideForbidden({
      variable: 'SOLANA_DEVNET_USDC_MINT',
      reason: 'mainnet must never be overridable; unset it or unset NODE_ENV=production',
    });
  }
  return override;
}

const USDC_SOLANA_DEVNET = `${CHAIN_IDS.SOLANA_DEVNET}/token:${resolveDevnetUsdcMint()}` as AssetId;

/**
 * USDG on Robinhood Chain **testnet**, measured 2026-09-07 against the public
 * RPC with the pinned Foundry build (`docs/chain-facts.md` in assay-evm):
 * `symbol() == "USDG"`, `name() == "USDG"`, `decimals() == 6`, no EIP-2612
 * (`DOMAIN_SEPARATOR()` and `nonces()` both revert) and no EIP-3009
 * (`authorizationState()` reverts).
 *
 * **There is deliberately no mainnet row.** `cast code` at this same address on
 * 4663 returns `0x` — the empty-code answer, with an 11,306-byte reply from
 * testnet as the control proving the probe itself works — so the mainnet USDG
 * address is unresolved and must come from `docs.robinhood.com` or the
 * operator. Writing a guess here would be a number a later reader mistakes for
 * a measurement, and `assertChainMetadata` refusing `eip155:4663` at boot is
 * the correct behaviour until it is filled in. Do not copy this address across.
 */
const USDG_ROBINHOOD_TESTNET =
  `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec` as AssetId;

export const ASSET_IDS = {
  USDC_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  USDG_ROBINHOOD_TESTNET,
} as const;

const REGISTRY: Readonly<Record<string, AssetMetadata>> = {
  [USDC_SOLANA_MAINNET]: {
    assetId: USDC_SOLANA_MAINNET,
    symbol: 'USDC',
    decimals: 6,
    chainId: CHAIN_IDS.SOLANA_MAINNET,
    peg: 'USD-1:1',
  },
  [USDC_SOLANA_DEVNET]: {
    assetId: USDC_SOLANA_DEVNET,
    symbol: 'USDC',
    decimals: 6,
    chainId: CHAIN_IDS.SOLANA_DEVNET,
    peg: 'USD-1:1',
  },
  [USDG_ROBINHOOD_TESTNET]: {
    assetId: USDG_ROBINHOOD_TESTNET,
    symbol: 'USDG',
    decimals: 6,
    chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
    peg: 'USD-1:1',
  },
};

export function getAssetMetadata(asset: AssetId): AssetMetadata {
  const metadata = REGISTRY[asset];
  if (!metadata) {
    throw ChainErrors.assetUnknown({ asset });
  }
  return metadata;
}

export function isRegisteredAsset(asset: AssetId): boolean {
  return asset in REGISTRY;
}

/**
 * The settlement assets this platform custodies on one chain.
 *
 * **One derivation, two callers.** `ReconciliationJob` decides which assets to
 * reconcile and `PublicReservesApiModule` decides which chains to publish, and
 * a page that published a chain nobody reconciles — or a reconciler that
 * checked a chain nobody publishes — is the failure both would otherwise be one
 * forgotten edit away from. A separate env var for either would be a second
 * place to forget to add a chain.
 *
 * Exactly one asset per chain today, and `reconciliation-job.spec.ts` asserts
 * that rather than assuming it: the withdrawal freeze is keyed on the ASSET, so
 * a chain with two settlement assets would be a chain that can be half frozen.
 */
export function settlementAssetsOn(chainId: ChainId): AssetId[] {
  return Object.values(ASSET_IDS).filter((asset) => REGISTRY[asset]?.chainId === chainId);
}

export function registeredAssets(): readonly AssetMetadata[] {
  return Object.values(REGISTRY);
}
