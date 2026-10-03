import { checkComputeBudget } from '@modules/chains/facilitator/verification/rules/compute-budget.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import {
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
} from './helpers/svm-test-fixtures';

describe('checkComputeBudget', () => {
  it('accepts a price at exactly the cap', () => {
    expect(
      checkComputeBudget([setComputeUnitLimitIx(), setComputeUnitPriceIx(5n), transferCheckedIx()]),
    ).toBeNull();
  });

  it('accepts a price under the cap', () => {
    expect(
      checkComputeBudget([setComputeUnitLimitIx(), setComputeUnitPriceIx(0n), transferCheckedIx()]),
    ).toBeNull();
  });

  it('rejects a price one micro-lamport over the cap — the fee-payer-drain vector', () => {
    expect(
      checkComputeBudget([setComputeUnitLimitIx(), setComputeUnitPriceIx(6n), transferCheckedIx()]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET);
  });

  it('rejects a price wildly over the cap', () => {
    expect(
      checkComputeBudget([
        setComputeUnitLimitIx(),
        setComputeUnitPriceIx(50_000n),
        transferCheckedIx(),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET);
  });

  it('rejects a compute unit limit above the network hard ceiling', () => {
    expect(
      checkComputeBudget([
        setComputeUnitLimitIx(1_400_001),
        setComputeUnitPriceIx(1n),
        transferCheckedIx(),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET);
  });

  it('rejects a zero compute unit limit', () => {
    expect(
      checkComputeBudget([
        setComputeUnitLimitIx(0),
        setComputeUnitPriceIx(1n),
        transferCheckedIx(),
      ]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET);
  });

  it('rejects when the first two instructions are not decodable Compute Budget instructions', () => {
    expect(
      checkComputeBudget([transferCheckedIx(), transferCheckedIx(), transferCheckedIx()]),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET);
  });
});
