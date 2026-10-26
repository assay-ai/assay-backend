import { ChainErrors } from '../errors/chains.errors';

/**
 * CAIP identifiers — the only way a chain, an account or an asset is named
 * anywhere outside `src/modules/chains/`.
 *
 * x402 v2 already uses CAIP-2 for networks; we extend the same convention to
 * accounts (CAIP-10) and assets (CAIP-19) so that one string is always
 * sufficient to identify anything on any chain. A `PublicKey`, an `0x` literal
 * or a bare mint address never crosses the boundary.
 *
 * The types are branded: a raw `string` will not type-check where a `ChainId`
 * is expected, so parsing and validation happen exactly once, here, and every
 * consumer downstream can assume well-formedness.
 */

/** CAIP-2 — `{namespace}:{reference}`, e.g. `eip155:8453`. */
export type ChainId = string & { readonly __brand: 'ChainId' };

/** CAIP-10 — `{chainId}:{address}`. */
export type AccountId = string & { readonly __brand: 'AccountId' };

/** CAIP-19 — `{chainId}/{assetNamespace}:{assetReference}`. */
export type AssetId = string & { readonly __brand: 'AssetId' };

export enum ChainNamespace {
  SOLANA = 'solana',
  EIP155 = 'eip155',
}

// The grammars are copied from CAIP-2, CAIP-10 and CAIP-19 rather than
// loosened to "anything with a colon in it". A permissive parser here would
// let a malformed identifier travel all the way to an RPC call, where the
// failure is a 500 with a chain SDK stack trace instead of a 400.
/**
 * The character bounds each part of a CAIP identifier may occupy.
 *
 * Exported, and the regexes below are built from it rather than repeating the
 * numbers, because these bounds decide how wide a column that stores a CAIP
 * identifier has to be. The schema guard test derives its maximal fixture from
 * {@link CAIP_MAX_LENGTHS}; hand-copying `170` into a test would let the
 * grammar widen without the columns following, which is the drift that guard
 * exists to remove.
 */
export const CAIP_BOUNDS = {
  namespace: { min: 3, max: 8 },
  reference: { min: 1, max: 32 },
  address: { min: 1, max: 128 },
  assetNamespace: { min: 3, max: 8 },
  assetReference: { min: 1, max: 128 },
} as const;

const bounded = (chars: string, of: { min: number; max: number }): string =>
  `${chars}{${of.min},${of.max}}`;

const NAMESPACE = bounded('[-a-z0-9]', CAIP_BOUNDS.namespace);
const REFERENCE = bounded('[-_a-zA-Z0-9]', CAIP_BOUNDS.reference);
const ADDRESS = bounded('[-.%a-zA-Z0-9]', CAIP_BOUNDS.address);
const ASSET_NAMESPACE = bounded('[-a-z0-9]', CAIP_BOUNDS.assetNamespace);
const ASSET_REFERENCE = bounded('[-.%a-zA-Z0-9]', CAIP_BOUNDS.assetReference);

/**
 * The longest string each `is*Id` predicate can accept, counting the
 * separators. `accountId` is **170** — 8 + ':' + 32 + ':' + 128 — which is why
 * `varchar(160)` on `agents.primary_account_id` rejected an account id this
 * codebase itself considers legal, on Solana, before EVM entered the picture.
 */
export const CAIP_MAX_LENGTHS = {
  chainId: CAIP_BOUNDS.namespace.max + 1 + CAIP_BOUNDS.reference.max,
  accountId:
    CAIP_BOUNDS.namespace.max + 1 + CAIP_BOUNDS.reference.max + 1 + CAIP_BOUNDS.address.max,
  assetId:
    CAIP_BOUNDS.namespace.max +
    1 +
    CAIP_BOUNDS.reference.max +
    1 +
    CAIP_BOUNDS.assetNamespace.max +
    1 +
    CAIP_BOUNDS.assetReference.max,
} as const;

/**
 * CAIP-2, as one regex.
 *
 * Exported for the one caller that cannot use {@link isChainId}: a
 * `class-validator` `@Matches` decorator takes a `RegExp`, not a predicate.
 * Sharing this object rather than re-typing the grammar in a DTO is the same
 * rule {@link CAIP_BOUNDS} exists for — a second copy is a copy free to widen
 * while the column, the CHECK and the parser stay where they are. It carries no
 * `g` flag, so it holds no `lastIndex` and is safe to share.
 */
export const CHAIN_ID_RE = new RegExp(`^(${NAMESPACE}):(${REFERENCE})$`);
const ACCOUNT_ID_RE = new RegExp(`^((${NAMESPACE}):(${REFERENCE})):(${ADDRESS})$`);
const ASSET_ID_RE = new RegExp(
  `^((${NAMESPACE}):(${REFERENCE}))/(${ASSET_NAMESPACE}):(${ASSET_REFERENCE})$`,
);

export interface ParsedChainId {
  readonly namespace: string;
  readonly reference: string;
}

export interface ParsedAccountId {
  readonly chainId: ChainId;
  readonly address: string;
}

export interface ParsedAssetId {
  readonly chainId: ChainId;
  readonly assetNamespace: string;
  readonly assetReference: string;
}

export function parseChainId(value: string): ParsedChainId {
  const match = typeof value === 'string' ? CHAIN_ID_RE.exec(value) : null;
  if (!match) {
    throw ChainErrors.invalidChainId({ value });
  }
  return { namespace: match[1], reference: match[2] };
}

export function parseAccountId(value: string): ParsedAccountId {
  const match = typeof value === 'string' ? ACCOUNT_ID_RE.exec(value) : null;
  if (!match) {
    throw ChainErrors.invalidAccountId({ value });
  }
  return { chainId: match[1] as ChainId, address: match[4] };
}

export function parseAssetId(value: string): ParsedAssetId {
  const match = typeof value === 'string' ? ASSET_ID_RE.exec(value) : null;
  if (!match) {
    throw ChainErrors.invalidAssetId({ value });
  }
  return { chainId: match[1] as ChainId, assetNamespace: match[4], assetReference: match[5] };
}

export function isChainId(value: string): value is ChainId {
  return typeof value === 'string' && CHAIN_ID_RE.test(value);
}

export function isAccountId(value: string): value is AccountId {
  return typeof value === 'string' && ACCOUNT_ID_RE.test(value);
}

export function isAssetId(value: string): value is AssetId {
  return typeof value === 'string' && ASSET_ID_RE.test(value);
}

export function toChainId(namespace: ChainNamespace | string, reference: string): ChainId {
  const value = `${namespace}:${reference}`;
  parseChainId(value);
  return value as ChainId;
}

export function toAccountId(chainId: ChainId, address: string): AccountId {
  parseChainId(chainId);
  const value = `${chainId}:${address}`;
  if (!isAccountId(value)) {
    throw ChainErrors.invalidAccountId({ value });
  }
  return value as AccountId;
}

export function toAssetId(
  chainId: ChainId,
  assetNamespace: string,
  assetReference: string,
): AssetId {
  parseChainId(chainId);
  const value = `${chainId}/${assetNamespace}:${assetReference}`;
  if (!isAssetId(value)) {
    throw ChainErrors.invalidAssetId({ value });
  }
  return value as AssetId;
}

/** The CAIP-2 namespace of any CAIP identifier, without a full parse. */
export function namespaceOf(id: ChainId | AccountId | AssetId): string {
  return parseChainId(chainIdOf(id)).namespace;
}

/** The chain a CAIP-10 account or CAIP-19 asset lives on. */
export function chainIdOf(id: ChainId | AccountId | AssetId): ChainId {
  if (isChainId(id)) {
    return id;
  }
  if (isAssetId(id)) {
    return parseAssetId(id).chainId;
  }
  return parseAccountId(id).chainId;
}

export const CHAIN_IDS = {
  SOLANA_MAINNET: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as ChainId,
  SOLANA_DEVNET: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId,
  BASE_MAINNET: 'eip155:8453' as ChainId,
  BASE_SEPOLIA: 'eip155:84532' as ChainId,
  /**
   * Robinhood Chain mainnet. Described in `chain-metadata.ts` and settles in
   * mainnet USDG (`asset-registry.ts`); live wherever `ENABLED_CHAINS` names it.
   */
  ROBINHOOD_MAINNET: 'eip155:4663' as ChainId,
  /** Robinhood Chain testnet. */
  ROBINHOOD_TESTNET: 'eip155:46630' as ChainId,
} as const;
