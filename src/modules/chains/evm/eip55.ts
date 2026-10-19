import { getAddress, isAddress } from 'viem';

import {
  AccountId,
  AssetId,
  isAccountId,
  isAssetId,
  parseAccountId,
  parseAssetId,
  toAccountId,
  toAssetId,
} from '../ports/caip.types';

/**
 * EIP-55 spellings of eip155 identifiers.
 *
 * An EVM address has one identity and many spellings: all lower case, all
 * upper case, or the EIP-55 mixed-case checksum. What an agent signs on
 * eip155 is the 20 bytes, so every spelling pays the same account. But
 * `assay-mcp`'s signer accepts the checksummed spelling only (spec §7.8 G2/G4),
 * so what this server hands an agent to sign is always checksummed, and what
 * it compares an agent's voucher against is compared on the checksummed
 * spelling of both sides.
 *
 * Anything that is not an eip155 address (a Solana account, a malformed
 * value) is returned unchanged: these functions spell, they never validate.
 */

/** `eip155:{ref}:{address}` with the address checksummed; anything else unchanged. */
export function checksummedAccount<T extends string>(id: T): T {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAccountId(id)) return id;
  const { chainId, address } = parseAccountId(id);
  if (!isAddress(address, { strict: false })) return id;
  return toAccountId(chainId, getAddress(address)) as string as T;
}

/** `eip155:{ref}/erc20:{address}` with the address checksummed; anything else unchanged. */
export function checksummedAsset<T extends string>(id: T): T {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAssetId(id)) return id;
  const { chainId, assetNamespace, assetReference } = parseAssetId(id);
  if (assetNamespace !== 'erc20' || !isAddress(assetReference, { strict: false })) return id;
  return toAssetId(chainId, assetNamespace, getAddress(assetReference)) as string as T;
}

/** Whether two CAIP-10 ids name the same account: equal, or equal once checksummed on eip155. */
export function sameAccountSpelling(a: AccountId | string, b: AccountId | string): boolean {
  return a === b || checksummedAccount(a) === checksummedAccount(b);
}

/** Whether two CAIP-19 ids name the same asset: equal, or equal once checksummed on eip155. */
export function sameAssetSpelling(a: AssetId | string, b: AssetId | string): boolean {
  return a === b || checksummedAsset(a) === checksummedAsset(b);
}
