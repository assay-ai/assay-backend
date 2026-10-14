import { domainSeparator } from 'viem';

import { ChainId } from '../../ports/caip.types';
import { X402_ESCROW_ABI, X402_STAKE_ABI } from '../abi/x402.abi';
import { EvmDeployment } from '../evm.constants';
import { evmDomain } from './domain';

export interface EvmDomainReadClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

/** One proxy whose live `DOMAIN_SEPARATOR()` is not the one this backend signs under. */
export interface EvmDomainMismatch {
  readonly contract: 'X402Escrow' | 'X402Stake';
  readonly address: `0x${string}`;
  readonly expected: `0x${string}`;
  readonly live: `0x${string}`;
}

/**
 * The EIP-712 domain guard (reviews evm-escrow R1, evm-stake-slash R-3).
 *
 * The backend builds every voucher, `…BySig` intent and slash attestation
 * domain from {@link evmDomain}, and checks vouchers off chain against it. The
 * contracts recompute the digest under THEIR domain. If the two disagree — a
 * proxy upgraded to a new `EIP712` name or version before the backend, or the
 * other way round — every voucher the backend accepts reverts `SignerIsNotPayer`
 * at redemption (a provider served and never paid), and every attestation
 * reverts `VerifierNotRegistered`. Comparing the domain separators turns that
 * silent loss into a loud refusal.
 *
 * Reads `DOMAIN_SEPARATOR()` of both proxies and returns the ones that differ;
 * `[]` when both match. A failed read throws: the caller keeps its last answer.
 */
export async function readDomainMismatches(
  client: EvmDomainReadClient,
  chainId: ChainId,
  deployment: Pick<EvmDeployment, 'escrow' | 'stake'>,
): Promise<EvmDomainMismatch[]> {
  const proxies = [
    { contract: 'X402Escrow' as const, address: deployment.escrow, abi: X402_ESCROW_ABI },
    { contract: 'X402Stake' as const, address: deployment.stake, abi: X402_STAKE_ABI },
  ];
  const mismatches: EvmDomainMismatch[] = [];
  for (const proxy of proxies) {
    const live = (
      (await client.readContract({
        address: proxy.address,
        abi: proxy.abi,
        functionName: 'DOMAIN_SEPARATOR',
        args: [],
      })) as `0x${string}`
    ).toLowerCase() as `0x${string}`;
    const expected = domainSeparator({
      domain: evmDomain(chainId, proxy.address),
    }).toLowerCase() as `0x${string}`;
    if (live !== expected) {
      mismatches.push({ contract: proxy.contract, address: proxy.address, expected, live });
    }
  }
  return mismatches;
}
