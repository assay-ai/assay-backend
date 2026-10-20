import { getAddress } from 'viem';

import { ChainErrors } from '../errors/chains.errors';
import { ChainId, toAccountId } from '../ports/caip.types';
import {
  VoucherAuthorityAnswer,
  VoucherAuthorityKind,
  VoucherAuthorityRefusal,
} from '../ports/voucher-authority.types';
import { EVM_CONSTANTS } from './evm.constants';
import { ASSAY_ESCROW_ABI } from './abi/assay.abi';
import { decayWindow } from './evm-voucher-prevalidation';
import { recoverEvmSigner } from './secp256k1-recover';

/** `r || s || v`. The platform stores and redeems 65-byte signatures only. */
const SECP256K1_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export interface EvmVoucherAuthorityClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

interface DelegationRead {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: bigint;
  readonly validUntil: bigint;
  readonly revoked: boolean;
}

/**
 * `AssayEscrow._voucherAuthority`, off chain, for one chain's escrow.
 *
 * It answers exactly the question the contract will answer at redemption, in
 * the contract's order — the payer's own key, then a delegate the payer
 * authorised — from CHAIN STATE: the delegation is `delegationOf(payer,
 * signer)` on the escrow, never anything this backend remembers. That is the
 * x402 facilitator rule: what is verified off chain is what the chain will
 * verify. There is no third branch: the contract has no EIP-1271 path (D-18),
 * so a contract-wallet payer authorises a delegate and lets the delegate sign.
 *
 * The delegation is read FRESH for every decision, never cached: its window
 * counter moves with every redemption, and a cached counter beside a pending
 * sum that no longer holds the redeemed voucher under-counts the window (review
 * S3-6); a cached revocation is a served call nobody pays for. Reads **fail
 * closed**: an RPC that cannot answer is a `CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE`
 * refusal, never an acceptance. The backend assumes the upgraded escrow, so
 * `delegationOf` failing in any way is that refusal too.
 *
 * The delegate's CAPS are returned, not applied: the per-call and window
 * checks also need the delegate's in-flight vouchers, which only the payment
 * domain knows.
 *
 * Deliberately not here: ERC-6492 (the contract does not accept it either), and
 * signatures that are not 65 bytes (the platform stores and redeems only
 * those).
 */
export class EvmVoucherAuthority {
  constructor(
    private readonly chainId: ChainId,
    private readonly client: EvmVoucherAuthorityClient,
    private readonly escrow: `0x${string}`,
  ) {}

  async authorize(
    payer: `0x${string}`,
    digest: `0x${string}`,
    signature: string,
    nowSeconds: number,
  ): Promise<VoucherAuthorityAnswer> {
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
      if (delegation.validUntil !== 0n) {
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

    return {
      kind: 'REFUSED',
      reason: refusal,
      signer: signer === null ? null : toAccountId(this.chainId, signer),
    };
  }

  private async delegation(payer: `0x${string}`, delegate: `0x${string}`): Promise<DelegationRead> {
    try {
      return (await this.client.readContract({
        address: this.escrow,
        abi: ASSAY_ESCROW_ABI,
        functionName: 'delegationOf',
        args: [payer, delegate],
      })) as DelegationRead;
    } catch {
      throw ChainErrors.voucherAuthorityUnavailable({
        what: `delegationOf(${payer}, ${delegate})`,
      });
    }
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
