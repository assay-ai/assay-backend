import { ConfigService } from '@nestjs/config';

import { chainMetadata } from './chain-metadata';
import { ENABLED_CHAINS_ENV, parseEnabledChains } from './enabled-chains';
import { ASSET_IDS } from './ports/asset-registry';
import { AssetId, ChainId } from './ports/caip.types';

/** The variable that names the platform's one asset explicitly. */
export const PLATFORM_STAKE_ASSET_ID_ENV = 'PLATFORM_STAKE_ASSET_ID';

/**
 * The one asset this deployment prices, stakes and settles in.
 *
 * `PLATFORM_STAKE_ASSET_ID` when it is set (an empty value counts as unset —
 * that is how a `.env` copied from `.env.example` arrives); otherwise the
 * declared settlement asset of the FIRST chain in `ENABLED_CHAINS`; devnet USDC
 * only when no chain is named at all, which is the unit-test and script case.
 *
 * It used to be devnet USDC unconditionally, at four call sites that each wrote
 * the default out for themselves. On an eip155-only deployment that made a
 * Solana asset the floor, the binding currency and the operator's payout asset
 * at once. One derivation, so they cannot disagree again.
 *
 * An unparseable `ENABLED_CHAINS` is not this helper's to refuse — `ChainsModule`
 * fails the boot on it, with the value named — so it falls back rather than
 * throwing a second, less specific error from wherever this was called.
 */
export function platformAssetFrom(config: ConfigService): AssetId {
  const configured = config.get<string>(PLATFORM_STAKE_ASSET_ID_ENV)?.trim();
  if (configured) {
    return configured as AssetId;
  }

  let first: ChainId | undefined;
  try {
    const raw = config.get<string>(ENABLED_CHAINS_ENV);
    first = raw ? parseEnabledChains(raw)[0] : undefined;
  } catch {
    first = undefined;
  }
  return first ? chainMetadata(first).settlementAsset : ASSET_IDS.USDC_SOLANA_DEVNET;
}
