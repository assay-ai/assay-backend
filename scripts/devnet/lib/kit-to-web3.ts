/**
 * Converts a `@solana/kit`-shaped `Instruction` (used everywhere in
 * `src/modules/chains/`) into the `@solana/web3.js` v1
 * `TransactionInstruction` shape `@sqds/multisig` expects.
 *
 * The two SDKs are deliberately kept apart in `src/` (one Solana SDK,
 * `@solana/kit`, ever) but this script needs both: the
 * deposit payload is built with `@solana/kit` to match exactly what a real
 * agent client would produce, while the Squads multisig setup needs
 * `@sqds/multisig`, which is built on web3.js v1. This converter is the one
 * seam between them, confined to `scripts/devnet/`.
 */
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { ReadonlyUint8Array } from '@solana/kit';

interface KitAccountMeta {
  readonly address: string;
  readonly role: number;
}

interface KitInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly KitAccountMeta[];
  readonly data?: ReadonlyUint8Array;
}

const ROLE_IS_SIGNER = new Set([2, 3]);
const ROLE_IS_WRITABLE = new Set([1, 3]);

export function kitInstructionToWeb3(instruction: KitInstruction): TransactionInstruction {
  const keys: AccountMeta[] = (instruction.accounts ?? []).map((account) => ({
    pubkey: new PublicKey(account.address),
    isSigner: ROLE_IS_SIGNER.has(account.role),
    isWritable: ROLE_IS_WRITABLE.has(account.role),
  }));

  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys,
    data: Buffer.from(instruction.data ?? new Uint8Array()),
  });
}
