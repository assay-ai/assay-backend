import { ChainErrors } from '../errors/chains.errors';
import { AssetId, CHAIN_IDS, ChainId, ChainNamespace, namespaceOf } from './caip.types';
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
 * The settlement token on Robinhood Chain **testnet**, from
 * `ROBINHOOD_TESTNET_USDG_ADDRESS` — typically a 6-decimal mock USD the
 * deployment controls. It must be the same address as the `asset` field of the
 * `eip155:46630` entry in `EVM_DEPLOYMENTS`.
 *
 * There is no default. Unset, the asset is simply not registered, and
 * `assertChainMetadata` refuses to boot a process that enables `eip155:46630`
 * and names this variable. Read **once**, at module load, for the same reason
 * as `SOLANA_DEVNET_USDC_MINT` above.
 */
export const ROBINHOOD_TESTNET_USDG_ENV = 'ROBINHOOD_TESTNET_USDG_ADDRESS';

function resolveRobinhoodTestnetUsdg(): AssetId | null {
  const value = process.env[ROBINHOOD_TESTNET_USDG_ENV]?.trim();
  if (!value) {
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw ChainErrors.configValueInvalid({
      variable: ROBINHOOD_TESTNET_USDG_ENV,
      accepted: 'a 0x-prefixed 20-byte ERC-20 address',
    });
  }
  return `${CHAIN_IDS.ROBINHOOD_TESTNET}/erc20:${value}` as AssetId;
}

const USDG_ROBINHOOD_TESTNET = resolveRobinhoodTestnetUsdg();

/**
 * USDG on Robinhood Chain mainnet. A constant, never env-driven: mainnet must
 * not be overridable. Keep the EIP-55 spelling exactly — asset ids are compared
 * as strings.
 */
const USDG_ROBINHOOD_MAINNET =
  `${CHAIN_IDS.ROBINHOOD_MAINNET}/erc20:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` as AssetId;

export const ASSET_IDS = {
  USDC_SOLANA_MAINNET,
  USDC_SOLANA_DEVNET,
  USDG_ROBINHOOD_TESTNET,
  USDG_ROBINHOOD_MAINNET,
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
  [USDG_ROBINHOOD_MAINNET]: {
    assetId: USDG_ROBINHOOD_MAINNET,
    symbol: 'USDG',
    decimals: 6,
    chainId: CHAIN_IDS.ROBINHOOD_MAINNET,
    peg: 'USD-1:1',
  },
  ...(USDG_ROBINHOOD_TESTNET && {
    [USDG_ROBINHOOD_TESTNET]: {
      assetId: USDG_ROBINHOOD_TESTNET,
      symbol: 'USDG',
      decimals: 6,
      chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
      peg: 'USD-1:1',
    },
  }),
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
 * The settlement assets this platform holds in a vault on one chain: the EVM
 * escrow contract's asset on an `eip155` chain, and nothing on Solana, whose
 * pooled Squads treasury is gone.
 *
 * **One derivation, two callers.** `ReconciliationJob` decides which assets to
 * reconcile and `PublicReservesApiModule` decides which chains to publish, and
 * a page that published a chain nobody reconciles — or a reconciler that
 * checked a chain nobody publishes — is the failure both would otherwise be one
 * forgotten edit away from. A separate env var for either would be a second
 * place to forget to add a chain.
 *
 * At most one asset per chain, and `reconciliation-job.spec.ts` asserts that
 * rather than assuming it: the withdrawal freeze is keyed on the ASSET, so a
 * chain with two settlement assets would be a chain that can be half frozen.
 */
export function settlementAssetsOn(chainId: ChainId): AssetId[] {
  if (namespaceOf(chainId) !== ChainNamespace.EIP155) return [];
  return Object.values(ASSET_IDS).filter(
    (asset): asset is AssetId => asset !== null && REGISTRY[asset]?.chainId === chainId,
  );
}

export function registeredAssets(): readonly AssetMetadata[] {
  return Object.values(REGISTRY);
}
