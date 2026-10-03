import {
  AccountLookupMeta,
  AccountMeta,
  Address,
  CompiledTransactionMessage,
  CompiledTransactionMessageWithLifetime,
  decompileTransactionMessageFetchingLookupTables,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  GetMultipleAccountsApi,
  Instruction,
  InstructionWithAccounts,
  InstructionWithData,
  ReadonlyUint8Array,
  Rpc,
} from '@solana/kit';

import { PaymentPayload } from '../../ports/x402.types';
import { X402InvalidReason, X402_INVALID_REASON } from '../facilitator.wire';
import { DecodedSvmPayload, ResolvedSvmInstruction } from './svm-instruction.types';

/**
 * The slice of the Solana JSON-RPC this decoder uses — declared structurally,
 * as `SolanaChainAdapter` does for `SolanaRpcClient`, so a test can supply a
 * fabricated `getMultipleAccounts` response instead of a live RPC connection.
 */
export interface FacilitatorSvmRpcClient {
  getMultipleAccounts(
    addresses: readonly Address[],
    config: { readonly encoding: 'jsonParsed' },
  ): {
    send(): Promise<{
      value: readonly ({ readonly data: { readonly parsed: { readonly info: unknown } } } | null)[];
    }>;
  };
}

/**
 * `status` is a string literal, not a boolean, on purpose: with this project's
 * `strictNullChecks: false` (`tsconfig.json`), TypeScript does not narrow a
 * discriminated union on a `true`/`false`-typed field — `if (!result.ok)`
 * type-checks but leaves `result` unnarrowed on both branches. A string
 * discriminant narrows correctly under the same config.
 */
export type DecodeSvmPayloadResult =
  | { readonly status: 'decoded'; readonly payload: DecodedSvmPayload }
  | { readonly status: 'rejected'; readonly invalidReason: X402InvalidReason };

/**
 * Turns the opaque `payload.payload.transaction` base64 blob into instructions
 * whose accounts are all real addresses — resolving any address lookup tables
 * along the way.
 *
 * This is the step the threat model calls out by name: "Address lookup tables
 * must be resolved before the check runs — otherwise an attacker hides the fee
 * payer behind a lookup index and the naive account scan passes."
 * `decompileTransactionMessageFetchingLookupTables` is what does the resolving;
 * every rule downstream only ever sees the result.
 *
 * Every failure here — undecodable base64, a corrupt message, an address
 * lookup table the RPC cannot find — collapses to the one `invalidReason` a
 * client can act on: build a fresh transaction, because this one cannot be
 * repaired. Where it went wrong is not information they can use.
 */
export async function decodeSvmPayload(
  payload: PaymentPayload,
  rpc: FacilitatorSvmRpcClient,
): Promise<DecodeSvmPayloadResult> {
  const encoded = payload.payload?.transaction;
  if (typeof encoded !== 'string') {
    return {
      status: 'rejected',
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION,
    };
  }

  try {
    const transactionBytes = getBase64Encoder().encode(encoded);
    const transaction = getTransactionDecoder().decode(transactionBytes);
    const compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    ) as CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;

    // `decompileTransactionMessageFetchingLookupTables` wants the full `Rpc<…>`
    // shape (it also exposes a `reactiveStore()` builder we never call); the
    // structural `FacilitatorSvmRpcClient` above is what keeps this function
    // unit-testable without a live RPC connection.
    const decompiled = await decompileTransactionMessageFetchingLookupTables(
      compiledMessage,
      rpc as unknown as Rpc<GetMultipleAccountsApi>,
    );

    // `decompiled.instructions` is typed as a union across legacy/v0/v1
    // transaction message shapes; every member carries the same `programAddress`
    // / `accounts` / `data` fields we read here, so one common shape is enough.
    const rawInstructions = decompiled.instructions as readonly (Instruction &
      Partial<InstructionWithAccounts<readonly (AccountLookupMeta | AccountMeta)[]>> &
      Partial<InstructionWithData<ReadonlyUint8Array>>)[];

    const instructions: ResolvedSvmInstruction[] = rawInstructions.map((instruction) => ({
      programAddress: instruction.programAddress,
      accounts: (instruction.accounts ?? []).map((account) => account.address),
      data: instruction.data ?? new Uint8Array(),
    }));

    const signatures = new Map<Address, ReadonlyUint8Array | null>(
      Object.entries(transaction.signatures) as unknown as [Address, ReadonlyUint8Array | null][],
    );

    return {
      status: 'decoded',
      payload: {
        feePayer: decompiled.feePayer.address,
        instructions,
        signatures,
        messageBytes: transaction.messageBytes,
        rawTransactionBase64: encoded,
      },
    };
  } catch {
    // Anything from here — malformed base64, a truncated message, a missing
    // lookup table — describes a transaction, just not a usable one.
    return {
      status: 'rejected',
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION,
    };
  }
}
