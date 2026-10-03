import { address } from '@solana/kit';

import { checkInstructionLayout } from '@modules/chains/facilitator/verification/rules/instruction-layout.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import {
  memoIx,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
} from './helpers/svm-test-fixtures';

describe('checkInstructionLayout', () => {
  it('accepts the minimal 3-instruction static path', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx(),
      ]),
    ).toBeNull();
  });

  it('accepts up to 4 trailing Lighthouse/Memo instructions', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx(),
        memoIx('a'),
        memoIx('b'),
        memoIx('c'),
        memoIx('d'),
      ]),
    ).toBeNull();
  });

  it('rejects fewer than 3 instructions', () => {
    expect(checkInstructionLayout([setComputeUnitLimitIx(), setComputeUnitPriceIx()])).toBe(
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS,
    );
  });

  it('rejects more than 7 instructions', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx(),
        memoIx('a'),
        memoIx('b'),
        memoIx('c'),
        memoIx('d'),
        memoIx('e'),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS);
  });

  it('rejects when instruction 0 is not Compute Budget SetComputeUnitLimit', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitPriceIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx(),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS);
  });

  it('rejects when instruction 1 is not Compute Budget SetComputeUnitPrice', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitLimitIx(),
        transferCheckedIx(),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS);
  });

  it('rejects when instruction 2 is not a TransferChecked', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        memoIx('not a transfer'),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS);
  });

  it('rejects a trailing instruction from a program that is neither Lighthouse nor Memo', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx(),
        {
          programAddress: address('11111111111111111111111111111111'),
          accounts: [],
          data: new Uint8Array(),
        },
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS);
  });

  it('accepts Token-2022 TransferChecked as well as classic SPL Token', () => {
    expect(
      checkInstructionLayout([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(),
        transferCheckedIx({
          programAddress: address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
        }),
      ]),
    ).toBeNull();
  });
});
