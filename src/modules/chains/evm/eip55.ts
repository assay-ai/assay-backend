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

/** Exactly `0x` and 40 hex digits: anything else is not an EVM address here. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** `eip155:{ref}:{address}` with the address checksummed; anything else unchanged. */
export function checksummedAccount<T extends string>(id: T): T {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAccountId(id)) return id;
  const { chainId, address } = parseAccountId(id);
  if (!EVM_ADDRESS_RE.test(address) || !isAddress(address, { strict: false })) return id;
  return toAccountId(chainId, getAddress(address)) as string as T;
}

/** `eip155:{ref}/erc20:{address}` with the address checksummed; anything else unchanged. */
export function checksummedAsset<T extends string>(id: T): T {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAssetId(id)) return id;
  const { chainId, assetNamespace, assetReference } = parseAssetId(id);
  if (
    assetNamespace !== 'erc20' ||
    !EVM_ADDRESS_RE.test(assetReference) ||
    !isAddress(assetReference, { strict: false })
  ) {
    return id;
  }
  return toAssetId(chainId, assetNamespace, getAddress(assetReference)) as string as T;
}

/**
 * The 20 bytes an eip155 CAIP-10 id names, as lower-case hex, with its chain;
 * `null` for anything else (another namespace, a short or long address,
 * non-hex digits, a `0X` prefix, a malformed id).
 */
function evmAccountBytes(id: string): { chainId: string; bytes: string } | null {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAccountId(id)) return null;
  const { chainId, address } = parseAccountId(id);
  if (!EVM_ADDRESS_RE.test(address)) return null;
  return { chainId, bytes: address.slice(2).toLowerCase() };
}

/** The same for an eip155 `erc20` CAIP-19 id. */
function evmAssetBytes(id: string): { chainId: string; bytes: string } | null {
  if (typeof id !== 'string' || !id.startsWith('eip155:') || !isAssetId(id)) return null;
  const { chainId, assetNamespace, assetReference } = parseAssetId(id);
  if (assetNamespace !== 'erc20' || !EVM_ADDRESS_RE.test(assetReference)) return null;
  return { chainId, bytes: assetReference.slice(2).toLowerCase() };
}

/**
 * Whether two CAIP-10 ids name the same account: equal strings, or two
 * well-formed eip155 addresses on the same chain with the same 20 bytes.
 * Everything else (Solana, whose base58 is case-sensitive, and any malformed
 * value) must be equal exactly.
 */
export function sameAccountSpelling(a: AccountId | string, b: AccountId | string): boolean {
  if (a === b) return true;
  const left = evmAccountBytes(a);
  const right = evmAccountBytes(b);
  return (
    left !== null && right !== null && left.chainId === right.chainId && left.bytes === right.bytes
  );
}

/** {@link sameAccountSpelling} for a CAIP-19 asset: an eip155 `erc20` address by its bytes. */
export function sameAssetSpelling(a: AssetId | string, b: AssetId | string): boolean {
  if (a === b) return true;
  const left = evmAssetBytes(a);
  const right = evmAssetBytes(b);
  return (
    left !== null && right !== null && left.chainId === right.chainId && left.bytes === right.bytes
  );
}
