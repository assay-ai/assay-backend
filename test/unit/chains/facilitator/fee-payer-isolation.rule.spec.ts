import { address } from '@solana/kit';

import { checkFeePayerIsolation } from '@modules/chains/facilitator/verification/rules/fee-payer-isolation.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import {
  FEE_PAYER,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
} from './helpers/svm-test-fixtures';

describe('checkFeePayerIsolation', () => {
  it('accepts a transaction where the fee payer appears nowhere but message slot 0', () => {
    expect(
      checkFeePayerIsolation(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx()],
        FEE_PAYER,
      ),
    ).toBeNull();
  });

  it('rejects the fee payer used as the transfer source', () => {
    expect(
      checkFeePayerIsolation(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx({ source: FEE_PAYER }),
        ],
        FEE_PAYER,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER);
  });

  it('rejects the fee payer used as the transfer authority (owner/delegate)', () => {
    expect(
      checkFeePayerIsolation(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx({ authority: FEE_PAYER }),
        ],
        FEE_PAYER,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER);
  });

  it('rejects the fee payer appearing in an unrelated trailing instruction', () => {
    expect(
      checkFeePayerIsolation(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx(),
          {
            programAddress: address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
            accounts: [FEE_PAYER],
            data: new Uint8Array(),
          },
        ],
        FEE_PAYER,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER);
  });

  it('rejects the fee payer appearing in any account slot at all, regardless of its role', () => {
    expect(
      checkFeePayerIsolation(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx({ destination: FEE_PAYER }),
        ],
        FEE_PAYER,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER);
  });
});
