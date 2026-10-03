import {
  address,
  AccountRole,
  AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  Instruction,
  InstructionWithAccounts,
  InstructionWithData,
  pipe,
  ReadonlyUint8Array,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import {
  decodeSvmPayload,
  FacilitatorSvmRpcClient,
} from '@modules/chains/facilitator/verification/decode-svm-payload';
import { checkFeePayerIsolation } from '@modules/chains/facilitator/verification/rules/fee-payer-isolation.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { PaymentPayload } from '@modules/chains/ports/x402.types';
import { ResolvedSvmInstruction } from '@modules/chains/facilitator/verification/svm-instruction.types';
import {
  FEE_PAYER,
  memoIx,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
} from './helpers/svm-test-fixtures';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never;
const ALT_ADDRESS = address('1L2YUTNbFYP8GYAy8gziw7MvNGbRkcw8pydJuzH5cS4');

type KitInstruction = Instruction &
  InstructionWithAccounts<any> &
  InstructionWithData<ReadonlyUint8Array>;

function emptyRpc(): FacilitatorSvmRpcClient {
  return { getMultipleAccounts: () => ({ send: async () => ({ value: [] }) }) };
}

/** Encodes a `ResolvedSvmInstruction`-shaped fixture back into a kit `Instruction`. */
function toKitInstruction(ix: ResolvedSvmInstruction): KitInstruction {
  return {
    programAddress: ix.programAddress,
    accounts: ix.accounts.map((account) => ({ address: account, role: AccountRole.READONLY })),
    data: ix.data,
  } as KitInstruction;
}

function buildBase64Transaction(
  instructions: readonly KitInstruction[],
  alt?: AddressesByLookupTableAddress,
): string {
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 100n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  if (alt) {
    message = compressTransactionMessageUsingAddressLookupTables(message, alt) as typeof message;
  }
  return getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function payloadFor(base64: string): PaymentPayload {
  return {
    x402Version: 2,
    scheme: 'exact',
    network: SOLANA_DEVNET,
    payload: { transaction: base64 },
  };
}

describe('decodeSvmPayload', () => {
  it('decodes a plain static-path transaction into resolved instructions', async () => {
    const base64 = buildBase64Transaction([
      toKitInstruction(setComputeUnitLimitIx()),
      toKitInstruction(setComputeUnitPriceIx()),
      toKitInstruction(transferCheckedIx()),
    ]);

    const result = await decodeSvmPayload(payloadFor(base64), emptyRpc());

    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.payload.feePayer).toBe(FEE_PAYER);
    expect(result.payload.instructions).toHaveLength(3);
    expect(result.payload.rawTransactionBase64).toBe(base64);
  });

  it('rejects a payload whose transaction is not base64', async () => {
    const result = await decodeSvmPayload(
      {
        x402Version: 2,
        scheme: 'exact',
        network: SOLANA_DEVNET,
        payload: { transaction: '!!not-base64!!' },
      },
      emptyRpc(),
    );
    expect(result).toEqual({
      status: 'rejected',
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION,
    });
  });

  it('rejects a payload carrying no transaction field at all', async () => {
    const result = await decodeSvmPayload(
      { x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET, payload: {} },
      emptyRpc(),
    );
    expect(result).toEqual({
      status: 'rejected',
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION,
    });
  });

  it('resolves an address lookup table so a fee payer hidden behind it is still caught by rule 1', async () => {
    // The attack: the fee payer is never a *static* account, only reachable
    // through the lookup table — a scan of `staticAccounts` alone would see no
    // fee payer at all in the Memo instruction and wrongly pass it.
    const base64 = buildBase64Transaction(
      [
        toKitInstruction(setComputeUnitLimitIx()),
        toKitInstruction(setComputeUnitPriceIx()),
        toKitInstruction(transferCheckedIx()),
        {
          ...toKitInstruction(memoIx('bypass-attempt')),
          accounts: [{ address: FEE_PAYER, role: AccountRole.READONLY }],
        },
      ],
      { [ALT_ADDRESS]: [FEE_PAYER] },
    );

    const stubRpc: FacilitatorSvmRpcClient = {
      getMultipleAccounts: (addresses) => ({
        send: async () => ({
          value: addresses.map((requested) =>
            requested === ALT_ADDRESS
              ? { data: { parsed: { info: { addresses: [FEE_PAYER] } } } }
              : null,
          ),
        }),
      }),
    };

    const result = await decodeSvmPayload(payloadFor(base64), stubRpc);

    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;

    // The resolved instruction now carries the real address, not a lookup index.
    const memoInstruction = result.payload.instructions[3];
    expect(memoInstruction.accounts).toContain(FEE_PAYER);

    // And rule 1, given the resolved instructions, catches it.
    expect(checkFeePayerIsolation(result.payload.instructions, FEE_PAYER)).toBe(
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER,
    );
  });
});
