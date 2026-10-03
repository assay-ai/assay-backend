import { address, Address } from '@solana/kit';
import { getTransferCheckedInstructionDataEncoder } from '@solana-program/token';

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
} from '@modules/chains/facilitator/verification/facilitator-policy.constants';
import { ResolvedSvmInstruction } from '@modules/chains/facilitator/verification/svm-instruction.types';

/**
 * Builders for the exact instruction shapes the six rules police, so every
 * rule spec constructs fixtures the same way a real static-path wallet would,
 * rather than each spec inventing its own byte layout.
 */

export const FEE_PAYER = address('FKJGnectZbXwfY437Nzf31rJUqH1Le8jAU8ytgge8wsH');
export const PAYER = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
export const USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const VAULT_ATA = address('C4PRXFV6Gf5mytVZb6RoeLsG8CjcFWzR2EJ3dvwPTUJH');
export const OTHER_MINT = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');

export function setComputeUnitLimitIx(units = 200_000): ResolvedSvmInstruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}

export function setComputeUnitPriceIx(microLamports = 1n): ResolvedSvmInstruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}

export function transferCheckedIx(options?: {
  source?: Address;
  mint?: Address;
  destination?: Address;
  authority?: Address;
  amount?: bigint;
  decimals?: number;
  programAddress?: Address;
}): ResolvedSvmInstruction {
  const data = getTransferCheckedInstructionDataEncoder().encode({
    amount: options?.amount ?? 10_000n,
    decimals: options?.decimals ?? 6,
  });
  return {
    programAddress:
      options?.programAddress ?? address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    accounts: [
      options?.source ?? PAYER,
      options?.mint ?? USDC_MINT,
      options?.destination ?? VAULT_ATA,
      options?.authority ?? PAYER,
    ],
    data,
  };
}

export function memoIx(memo: string): ResolvedSvmInstruction {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(memo),
  };
}
