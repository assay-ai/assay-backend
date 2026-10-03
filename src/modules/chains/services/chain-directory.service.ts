import { Inject, Injectable } from '@nestjs/common';

import { ChainAdapterRegistry } from '../chain-adapter.registry';
import { chainMetadata } from '../chain-metadata';
import { ChainDto, GetChainsResponseDto } from '../dto/get-chains.dto';
import { ENABLED_CHAINS } from '../enabled-chains';
import { getAssetMetadata } from '../ports/asset-registry';
import { ChainId, parseChainId } from '../ports/caip.types';
import { PUBLIC_RPC_URLS } from '../public-rpc-urls';

/**
 * The enabled set, as the frontend reads it.
 *
 * Built from the `ENABLED_CHAINS` token and nothing else. Reading
 * `registry.enabledChains()` here would be subtly wrong in a way no other test
 * would catch: that method returns every chain every registered adapter
 * supports, which is a superset the moment an adapter is constructed with a
 * wider list than the deployment offers.
 *
 * The registry is still injected, and it is what makes the second guarantee
 * true: a chain in `ENABLED_CHAINS` that NO adapter serves fails here rather
 * than being advertised to a client that would then get `CHAIN_UNSUPPORTED` on
 * its first deposit. `resolve()` throwing is the check.
 *
 * Every lookup below is total on a process that booted — `chain-metadata.ts`'s
 * `assertChainMetadata` runs in the `ENABLED_CHAINS` factory and refuses an
 * enabled chain that any of these three tables cannot answer for. This class
 * therefore has no fallback, no default row and no "first asset on the chain":
 * it maps, and the disagreements were settled before it was constructed.
 */
@Injectable()
export class ChainDirectoryService {
  constructor(
    @Inject(ENABLED_CHAINS) private readonly enabled: readonly ChainId[],
    private readonly registry: ChainAdapterRegistry,
    /**
     * `PUBLIC_RPC_URLS`, and a SEPARATE variable from the ones this backend
     * reaches a chain through. `SOLANA_RPC_URL` may carry a Helius
     * api-key inline and an EVM node may sit inside a VPC; this field is
     * served to anyone who asks for the chain list, so only an endpoint that
     * is already public may appear in it. A chain with none is served without
     * the field, and the browser refuses that chain by name.
     */
    @Inject(PUBLIC_RPC_URLS) private readonly publicRpcUrls: ReadonlyMap<string, string>,
  ) {}

  listChains(): GetChainsResponseDto {
    return { chains: this.enabled.map((chainId) => this.describe(chainId)) };
  }

  private describe(chainId: ChainId): ChainDto {
    // "Every enabled chain has an adapter" is enforced at BOOT by
    // ChainAdapterRegistry's constructor. This resolve() is belt-and-braces: it cannot fail on a
    // process that booted, and it documents that the list served here is a
    // subset of what the registry serves.
    this.registry.resolve(chainId);

    const metadata = chainMetadata(chainId);
    // The DECLARED settlement asset, not the first one registered on this
    // chain — see `chain-metadata.ts` for the money bug that distinction
    // closes. `getAssetMetadata` is where `decimals` comes from, so the scale a
    // client multiplies by is the registry's, never this table's.
    const asset = getAssetMetadata(metadata.settlementAsset);

    return {
      chainId,
      namespace: parseChainId(chainId).namespace,
      displayName: metadata.displayName,
      explorerBaseUrl: metadata.explorerBaseUrl,
      settlementAsset: asset.assetId,
      // Both off the SAME registry entry as the asset id above, and off the
      // entry for THIS chain's declared settlement asset — never
      // `registeredAssets()[0]`, which is USDC for every chain including the
      // one that settles in USDG.
      settlementAssetSymbol: asset.symbol,
      decimals: asset.decimals,
      // Absent rather than empty when this deployment names no public endpoint
      // for the chain: the browser's refusal reads "this build has no network
      // endpoint for this chain", which is true, instead of dialling "".
      ...(this.publicRpcUrls.get(chainId) ? { publicRpcUrl: this.publicRpcUrls.get(chainId) } : {}),
    };
  }
}
