import { getAddress } from 'viem';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, toAccountId } from '../ports/caip.types';
import {
  VoucherAuthorityAnswer,
  VoucherAuthorityKind,
  VoucherAuthorityOptions,
  VoucherAuthorityRefusal,
} from '../ports/voucher-authority.types';
import { EVM_CONSTANTS } from './evm.constants';
import { ERC1271_ABI, X402_ESCROW_ABI } from './abi/x402.abi';
import { decayWindow } from './evm-voucher-prevalidation';
import { recoverEvmSigner } from './secp256k1-recover';

/** EIP-1271's magic value: the `isValidSignature(bytes32,bytes)` selector. */
export const ERC1271_MAGIC_VALUE = '0x1626ba7e';

/**
 * How many payers' "has code" answers are kept. Bounded so a stream of vouchers
 * for random payers cannot grow memory without limit; the oldest entry goes
 * first.
 */
export const EVM_PAYER_CODE_CACHE_MAX_ENTRIES = 10_000;

/**
 * How long "does the payer have code" is trusted. Code changes only by a
 * deployment (or an EIP-7702 delegation), and the answer only CHOOSES which
 * branches are tried — a wrong answer refuses, it never accepts.
 */
export const EVM_PAYER_CODE_CACHE_TTL_MS = 60_000;

/** `r || s || v`. The platform stores and redeems 65-byte signatures only. */
const SECP256K1_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export interface EvmVoucherAuthorityClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  getCode?(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
}

interface DelegationRead {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: bigint;
  readonly validUntil: bigint;
  readonly revoked: boolean;
}

interface Cached<T> {
  readonly value: T;
  readonly until: number;
}

/**
 * `X402Escrow._voucherAuthority`, off chain, for one chain's escrow.
 *
 * It answers exactly the question the contract will answer at redemption, in
 * the contract's order — the payer's own key, then a delegate the payer
 * authorised, then the payer's EIP-1271 wallet — from CHAIN STATE: the
 * delegation is `delegationOf(payer, signer)` on the escrow, never anything
 * this backend remembers. That is the x402 facilitator rule: what is verified
 * off chain is what the chain will verify.
 *
 * The delegation is read FRESH for every decision, never cached: its window
 * counter moves with every redemption, and a cached counter beside a pending
 * sum that no longer holds the redeemed voucher under-counts the window (review
 * S3-6); a cached revocation is a served call nobody pays for. Only "does the
 * payer have code" is cached, in a bounded map. Reads **fail closed**: an RPC that cannot answer is a `CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE`
 * refusal, never an acceptance. A call that REVERTS is an answer, not an
 * outage — `delegationOf` reverting (an escrow not yet upgraded) reads as "no
 * delegate", and `isValidSignature` reverting reads as "not valid", exactly as
 * OpenZeppelin's `SignatureChecker` treats it on chain.
 *
 * The delegate's CAPS are returned, not applied: the per-call and window
 * checks also need the delegate's in-flight vouchers, which only the payment
 * domain knows.
 *
 * Deliberately not here: ERC-6492 (the contract does not accept it either), and
 * signatures that are not 65 bytes (the platform stores and redeems only
 * those; a longer EIP-1271 signature is a recorded follow-up).
 */
export class EvmVoucherAuthority {
  private readonly codeCache = new Map<string, Cached<boolean>>();

  constructor(
    private readonly chainId: ChainId,
    private readonly client: EvmVoucherAuthorityClient,
    private readonly escrow: `0x${string}`,
    private readonly clock: { readonly nowMs: () => number } = { nowMs: () => Date.now() },
  ) {}

  async authorize(
    payer: `0x${string}`,
    digest: `0x${string}`,
    signature: string,
    nowSeconds: number,
    options: VoucherAuthorityOptions = {},
  ): Promise<VoucherAuthorityAnswer> {
    const allowErc1271 = options.allowErc1271 ?? true;
    const payerAddress = getAddress(payer);
    if (typeof signature !== 'string' || !SECP256K1_SIGNATURE_RE.test(signature)) {
      return { kind: 'REFUSED', reason: VoucherAuthorityRefusal.NOT_PAYER, signer: null };
    }

    // (a) the payer's own key. Strict and lenient recovery agree on every
    // signature that recovers at all; the off-chain answer for one that does
    // not is "refuse", which is what either on-chain form yields.
    const recovered = recoverEvmSigner(digest, signature);
    const signer = recovered === null ? null : getAddress(recovered);
    if (signer === payerAddress) return { kind: VoucherAuthorityKind.PAYER };

    // (b) a delegate the payer authorised on chain.
    let refusal = VoucherAuthorityRefusal.NOT_PAYER;
    if (signer !== null) {
      const delegation = await this.delegation(payerAddress, signer);
      if (delegation !== null && delegation.validUntil !== 0n) {
        if (delegation.revoked) {
          refusal = VoucherAuthorityRefusal.DELEGATE_REVOKED;
        } else if (BigInt(nowSeconds) > delegation.validUntil) {
          refusal = VoucherAuthorityRefusal.DELEGATE_EXPIRED;
        } else {
          return {
            kind: VoucherAuthorityKind.DELEGATE,
            delegate: toAccountId(this.chainId, signer),
            terms: {
              maxVoucherAmount: delegation.maxVoucherAmount,
              maxPerWindow: delegation.maxPerWindow,
              carriedInWindow: decayWindow({
                spentInWindow: delegation.spentInWindow,
                windowStartedAt: Number(delegation.windowStartedAt),
                nowSeconds,
              }),
              validUntil: Number(delegation.validUntil),
              redeemGraceSeconds: EVM_CONSTANTS.REDEEM_GRACE_SECONDS,
            },
          };
        }
      }
    }

    // (c) the payer's own EIP-1271 wallet, only when the payer has code.
    if (await this.hasCode(payerAddress)) {
      if (!allowErc1271) {
        // Not asked at all: the caller will not rely on the answer, so it costs
        // no `isValidSignature` call.
        return {
          kind: 'REFUSED',
          reason:
            refusal === VoucherAuthorityRefusal.NOT_PAYER
              ? VoucherAuthorityRefusal.ERC1271_NOT_ACCEPTED
              : refusal,
          signer: signer === null ? null : toAccountId(this.chainId, signer),
        };
      }
      if (await this.isValid1271(payerAddress, digest, signature)) {
        return { kind: VoucherAuthorityKind.ERC1271 };
      }
    }

    return {
      kind: 'REFUSED',
      reason: refusal,
      signer: signer === null ? null : toAccountId(this.chainId, signer),
    };
  }

  private async hasCode(address: `0x${string}`): Promise<boolean> {
    const cached = this.fresh(this.codeCache, address);
    if (cached !== undefined) return cached;
    if (typeof this.client.getCode !== 'function') {
      throw ChainErrors.voucherAuthorityUnavailable({ what: 'no getCode on the RPC client' });
    }
    let code: `0x${string}` | undefined;
    try {
      code = await this.client.getCode({ address });
    } catch {
      throw ChainErrors.voucherAuthorityUnavailable({ what: `eth_getCode(${address})` });
    }
    const value = typeof code === 'string' && code !== '0x' && code.length > 2;
    if (this.codeCache.size >= EVM_PAYER_CODE_CACHE_MAX_ENTRIES) {
      // A Map iterates in insertion order: the first key is the oldest.
      const oldest = this.codeCache.keys().next().value;
      if (oldest !== undefined) this.codeCache.delete(oldest);
    }
    this.codeCache.set(address, { value, until: this.clock.nowMs() + EVM_PAYER_CODE_CACHE_TTL_MS });
    return value;
  }

  private async delegation(
    payer: `0x${string}`,
    delegate: `0x${string}`,
  ): Promise<DelegationRead | null> {
    try {
      return (await this.client.readContract({
        address: this.escrow,
        abi: X402_ESCROW_ABI,
        functionName: 'delegationOf',
        args: [payer, delegate],
      })) as DelegationRead;
    } catch (error) {
      if (!isRevert(error)) {
        throw ChainErrors.voucherAuthorityUnavailable({
          what: `delegationOf(${payer}, ${delegate})`,
        });
      }
      // An escrow without the delegation surface has no delegates.
      return null;
    }
  }

  /** Never cached: the wallet's answer can change from one block to the next. */
  private async isValid1271(
    wallet: `0x${string}`,
    digest: `0x${string}`,
    signature: string,
  ): Promise<boolean> {
    try {
      const answer = await this.client.readContract({
        address: wallet,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [digest, signature],
      });
      return typeof answer === 'string' && answer.toLowerCase() === ERC1271_MAGIC_VALUE;
    } catch (error) {
      if (isRevert(error)) return false;
      throw ChainErrors.voucherAuthorityUnavailable({ what: `isValidSignature on ${wallet}` });
    }
  }

  private fresh<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    if (hit.until <= this.clock.nowMs()) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  }
}

/**
 * Did the CONTRACT answer (a revert, no return data, undecodable return data)
 * rather than the RPC fail? viem names those errors; walk the cause chain.
 * Anything else — a timeout, a refused connection — is an outage.
 */
export function isRevert(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (
      typeof name === 'string' &&
      /ContractFunctionRevertedError|ContractFunctionZeroDataError|AbiDecodingZeroDataError|AbiDecodingDataSizeTooSmallError|ExecutionRevertedError/.test(
        name,
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
