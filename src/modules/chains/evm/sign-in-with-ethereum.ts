import { getAddress, isAddress, verifyMessage } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';

/**
 * EIP-4361 (Sign-In with Ethereum), for the operator console's wallet sign-in.
 *
 * Here because it is viem, and viem stays in `src/modules/chains/`. Pure: no
 * RPC, so the signature check is an EOA (`personal_sign`) recovery only —
 * ERC-1271 / ERC-6492 smart-contract wallets would need a chain read per
 * sign-in and are not supported.
 */
export interface SignInMessageFields {
  readonly address: string;
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly statement: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
}

export function isEvmAddress(value: string): boolean {
  return isAddress(value, { strict: false });
}

export function newSignInNonce(): string {
  return generateSiweNonce();
}

/** The message, with the address in its EIP-55 checksum form as EIP-4361 requires. */
export function buildSignInMessage(fields: SignInMessageFields): string {
  return createSiweMessage({
    address: getAddress(fields.address),
    chainId: fields.chainId,
    domain: fields.domain,
    uri: fields.uri,
    version: '1',
    statement: fields.statement,
    nonce: fields.nonce,
    issuedAt: fields.issuedAt,
    expirationTime: fields.expirationTime,
  });
}

/** Whatever fields parse out of `message`; any may be missing. */
export function parseSignInMessage(message: string): Partial<SignInMessageFields> & {
  readonly version?: string;
} {
  return parseSiweMessage(message);
}

/** `true` only when `signature` is `address`'s `personal_sign` of `message`. */
export async function verifySignInSignature(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || !isEvmAddress(address)) return false;
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
