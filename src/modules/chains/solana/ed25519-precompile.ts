import { Address, address, Instruction } from '@solana/kit';
import { Ed25519Program, TransactionInstruction } from '@solana/web3.js';

/**
 * Solana's ed25519 signature-verification precompile.
 *
 * Its address is fixed by the runtime, not by any program's IDL, which is why
 * it is written out here rather than imported from a generated client.
 */
export const ED25519_PROGRAM_ADDRESS: Address = address(
  'Ed25519SigVerify111111111111111111111111111',
);

/**
 * The ed25519 precompile instruction that carries a signature into the
 * transaction, so the program can check it with `load_instruction_at_checked`.
 *
 * Built with `@solana/web3.js`'s `Ed25519Program`, exactly as
 * `scripts/settlement/exercise-all.ts`'s own `ed25519VerifyInstruction` does,
 * and for the reason its comment gives: the precompile is not this program and
 * has no IDL, so there is no generated builder for it, but "no generated client
 * exists" is not a licence to hand-pack the one encoding this program's whole
 * security argument rests on. `@solana/web3.js` was a `devDependencies`-only
 * package before this was written — it is a production dependency now, because
 * this is a production import rather than only an operator script's.
 *
 * ## Shared rather than duplicated, and the reason is arithmetic
 *
 * One `redeem_voucher` plus its precompile was measured at 1,187 of a
 * transaction's 1,232 bytes. A second, subtly different encoder of the same
 * 351-byte instruction would fit or not fit by accident, and the failure would
 * be a transaction the RPC refuses after the call has already been served.
 * `SettlementSlashExecutorService` and `SolanaVoucherRedeemer` both call this
 * one.
 */
export function ed25519VerifyInstruction(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Instruction {
  return web3ToKit(
    Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature }),
  );
}

/** Kit account roles: 0 readonly, 1 writable, 2 readonly signer, 3 writable signer. */
export function web3ToKit(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((key) => ({
      address: address(key.pubkey.toBase58()),
      role: (key.isWritable ? 1 : 0) | (key.isSigner ? 2 : 0),
    })),
    data: new Uint8Array(instruction.data),
  } as Instruction;
}
