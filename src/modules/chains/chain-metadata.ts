import { ChainErrors } from './errors/chains.errors';
import {
  ASSET_IDS,
  getAssetMetadata,
  isRegisteredAsset,
  registeredAssets,
  ROBINHOOD_TESTNET_USDG_ENV,
} from './ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId, chainIdOf } from './ports/caip.types';
import { ENABLED_CHAINS_ENV } from './enabled-chains';

/**
 * What a chain looks like to a human, and what it settles in.
 *
 * Static per chain — this table is a property of the *chain*, never of the
 * deployment. Which of these rows is live is `ENABLED_CHAINS`'s answer and
 * nobody else's, so the enabled list deliberately does not appear here.
 *
 * ## Why `settlementAsset` is declared rather than looked up
 *
 * It used to be `registeredAssets().find((a) => a.chainId === chainId)` — the
 * first asset registered on the chain. That is correct only while every chain
 * has exactly one asset, and it fails *silently* the moment one has two:
 * `Object.values` is insertion order, so registering a second asset **above**
 * the current one in `asset-registry.ts` changes both the advertised
 * `settlementAsset` and its `decimals`, with nothing to notice. `decimals` is
 * what a client multiplies a displayed amount by to get minor units, so that is
 * a money bug arriving through the ordering of an unrelated literal.
 *
 * Declaring it here makes "the one asset this chain settles in" — which the DTO
 * already promises every client — a statement someone wrote down, and
 * {@link assertChainMetadata} makes it one the process refuses to boot without.
 * Registering a second asset on a chain is then a normal thing to do: it simply
 * is not the settlement asset unless this table says so.
 */
/**
 * A settlement rail this deployment can offer on a chain.
 *
 * `'A'` is the on-chain-settled rail; `'B'` is the escrow/voucher rail. Which
 * of the two a chain offers is a property of what was built for that chain, not
 * of the chain itself — hence a field here rather than a global constant.
 */
export type PaymentRailName = 'A' | 'B';

export interface ChainMetadata {
  readonly displayName: string;
  readonly explorerBaseUrl: string;
  /**
   * CAIP-19. Must be registered in `asset-registry.ts`, live on this chain,
   * pegged 1:1 and 6 dp — all four checked by {@link assertChainMetadata}.
   */
  readonly settlementAsset: AssetId;
  /**
   * Supported rails are per-chain: Solana keeps A and B, 4663 ships B only.
   * The 402 response on 4663 never advertises a rail A scheme, and the router
   * never selects one.
   *
   * Declared here because it describes the deployment's offer on that chain,
   * and read in `tool/` — a table nothing reads is a comment with a type
   * annotation. {@link assertChainMetadata} refuses an empty list, which is the
   * shape a half-finished config edit produces.
   */
  readonly rails: readonly PaymentRailName[];
}

const CHAIN_METADATA: Readonly<Record<string, ChainMetadata>> = {
  [CHAIN_IDS.SOLANA_MAINNET]: {
    displayName: 'Solana mainnet',
    explorerBaseUrl: 'https://explorer.solana.com',
    settlementAsset: ASSET_IDS.USDC_SOLANA_MAINNET,
    rails: ['A', 'B'],
  },
  [CHAIN_IDS.SOLANA_DEVNET]: {
    displayName: 'Solana devnet',
    explorerBaseUrl: 'https://explorer.solana.com/?cluster=devnet',
    settlementAsset: ASSET_IDS.USDC_SOLANA_DEVNET,
    rails: ['A', 'B'],
  },
  // `eip155:4663` — Robinhood Chain MAINNET — is absent on purpose, and the
  // absence is load-bearing: the mainnet token address is unknown, so no
  // settlement asset can honestly be named for it and `assertChainMetadata`
  // refuses the chain at boot.
  //
  // The testnet row exists only once `ROBINHOOD_TESTNET_USDG_ADDRESS` names its
  // settlement token (asset-registry.ts); `assertChainMetadata` names that
  // variable when the chain is enabled without it.
  ...(ASSET_IDS.USDG_ROBINHOOD_TESTNET && {
    [CHAIN_IDS.ROBINHOOD_TESTNET]: {
      displayName: 'Robinhood Chain testnet',
      explorerBaseUrl: 'https://explorer.testnet.chain.robinhood.com',
      settlementAsset: ASSET_IDS.USDG_ROBINHOOD_TESTNET,
      rails: ['B'] as const,
    },
  }),
};

/** The chains this table can describe. Not the enabled list — see the file comment. */
export function describedChains(): readonly ChainId[] {
  return Object.keys(CHAIN_METADATA) as ChainId[];
}

/**
 * Read one row. Throws `CHAIN_UNSUPPORTED` for a chain with none.
 *
 * On a process that booted, this cannot throw: {@link assertChainMetadata} has
 * already refused every enabled chain without a row. It stays a throw rather
 * than a `?? DEFAULT` because a placeholder display name for an unknown network
 * is how a mainnet gets labelled as something else.
 */
export function chainMetadata(chainId: ChainId): ChainMetadata {
  const metadata = CHAIN_METADATA[chainId];
  if (!metadata) {
    throw ChainErrors.unsupportedChain({ chainId });
  }
  return metadata;
}

/**
 * Every enabled chain is describable and settles in a registered asset — at
 * BOOT, in every process.
 *
 * ## Why this is not left to the request
 *
 * `ChainAdapterRegistry`'s constructor already asserts that `ENABLED_CHAINS` and
 * the registered adapters agree, because *"an operator who enables
 * `eip155:46630` on a Solana-only build learns it from a 500 on `GET /chains`,
 * or on a deposit"*. `CHAIN_METADATA` and the asset registry are two more tables
 * that have to agree with `ENABLED_CHAINS`, and until this function existed they
 * were the only two left out of that rule — the same fail-open, one table over.
 *
 * Observed before this assertion existed:
 *
 * - **Today**, `ENABLED_CHAINS=eip155:4663` fails at boot — but from the
 *   *registry*, because no adapter serves it (`CHAIN_ENABLED_CHAINS_INVALID`,
 *   500). The metadata gap is masked by the adapter gap and is not reachable.
 * - **Once an EVM adapter exists** the mask is gone. The registry accepts the
 *   chain (`enabledChains() === ['eip155:4663']`) and the first `GET /chains`
 *   throws `CHAIN_UNSUPPORTED` — **HTTP 400**, reading *"No chain adapter is
 *   enabled for eip155:4663"*. Three things wrong in one response: an adapter
 *   *is* enabled, so the message sends the operator to the wrong file; 4xx
 *   blames a caller who sent no input for a server misconfiguration; and 4xx is
 *   the class 5xx alerting does not watch, so a deployment can be broken with
 *   nobody paged.
 *
 * Asserting here deletes that state rather than improving its error message. The
 * error is `CHAIN_ENABLED_CHAINS_INVALID` — 500, and already this module's
 * boot-failure vocabulary — and it names every missing chain at once plus what
 * *is* available, because an operator fixing a deployment config wants the whole list,
 * not the first entry that failed.
 */
export function assertChainMetadata(enabled: readonly ChainId[]): void {
  if (enabled.includes(CHAIN_IDS.ROBINHOOD_TESTNET) && !ASSET_IDS.USDG_ROBINHOOD_TESTNET) {
    throw ChainErrors.configValueInvalid({
      variable: ROBINHOOD_TESTNET_USDG_ENV,
      accepted: `the settlement token address, required while ${CHAIN_IDS.ROBINHOOD_TESTNET} is enabled`,
    });
  }

  const undescribed = enabled.filter((chainId) => !CHAIN_METADATA[chainId]);
  if (undescribed.length > 0) {
    throw ChainErrors.enabledChainsInvalid({
      variable: ENABLED_CHAINS_ENV,
      value: undescribed.join(','),
      accepted:
        'a chain with a row in src/modules/chains/chain-metadata.ts — currently: ' +
        describedChains().join(', '),
    });
  }

  // Checked separately from the row above so the message says which of the two
  // tables is short. A chain that is describable but settles in an asset nobody
  // registered would otherwise report as "no metadata", and the operator would
  // edit the file that is already correct.
  const unsettleable = enabled.filter((chainId) => {
    const asset = CHAIN_METADATA[chainId].settlementAsset;
    return !isRegisteredAsset(asset) || chainIdOf(asset) !== chainId;
  });
  if (unsettleable.length > 0) {
    throw ChainErrors.enabledChainsInvalid({
      variable: ENABLED_CHAINS_ENV,
      value: unsettleable.join(','),
      accepted:
        'a chain whose declared settlementAsset is registered in asset-registry.ts and ' +
        'lives on that chain — currently registered: ' +
        registeredAssets()
          .map((entry) => entry.assetId)
          .join(', '),
    });
  }

  // The settlement asset must be 1:1 with the platform's unit of account
  // and 6 dp, or `price_amount` (USD minor units, scale 6) needs an oracle to
  // become a chain `Money`, and an oracle is a new trusted input on the paying
  // path. A boot failure here is the whole reason `peg` exists: the alternative
  // is a silent mispricing that looks like arithmetic.
  //
  // Runs after the registration check above, so `getAssetMetadata` cannot throw
  // and the message names the right table.
  const unpegged = enabled.filter((chainId) => {
    const metadata = getAssetMetadata(CHAIN_METADATA[chainId].settlementAsset);
    return metadata.peg !== 'USD-1:1' || metadata.decimals !== 6;
  });
  if (unpegged.length > 0) {
    throw ChainErrors.enabledChainsInvalid({
      variable: ENABLED_CHAINS_ENV,
      value: unpegged.join(','),
      accepted:
        "a chain whose settlementAsset has peg 'USD-1:1' and decimals 6 in " +
        'asset-registry.ts — anything else needs a price oracle, which this ' +
        'platform does not have',
    });
  }

  // A chain that offers no rail is a chain nothing can be paid on. Cheap, and
  // it is the shape a half-finished edit to `rails` produces.
  const railless = enabled.filter((chainId) => CHAIN_METADATA[chainId].rails.length === 0);
  if (railless.length > 0) {
    throw ChainErrors.enabledChainsInvalid({
      variable: ENABLED_CHAINS_ENV,
      value: railless.join(','),
      accepted: 'a chain with at least one entry in its chain-metadata.ts `rails` list',
    });
  }
}

/**
 * The rail this chain is being asked to settle on is one it offers.
 *
 * Supported rails are per-chain: Solana keeps A and B, 4663 ships B only. The
 * 402 response on 4663 never advertises a rail A scheme, and the router never
 * selects one. `ChainMetadata.rails` declares that, and this function is where
 * the declaration becomes binding, and it is called at the site that *decides* a rail for an intent
 * rather than at the site that records one.
 *
 * Takes a name rather than `PaymentRail` so that nothing under `chains/` has to
 * know what a payment rail is; `railName` in `payment/ports/payment.types.ts`
 * is the translation, and it is an exhaustive switch for the same reason.
 *
 * Throws `CHAIN_UNSUPPORTED` for a chain with no row at all, by way of
 * {@link chainMetadata} — which is the honest answer for `eip155:4663`, whose
 * absence from the table is deliberate and load-bearing. A rail check that
 * answered "yes" for an undescribed chain would make that refusal reachable
 * only at boot.
 */
export function assertRailOffered(chainId: ChainId, rail: PaymentRailName): void {
  const { rails } = chainMetadata(chainId);
  if (!rails.includes(rail)) {
    throw ChainErrors.railNotOffered({ chainId, rail, offered: [...rails] });
  }
}
