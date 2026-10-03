import { address } from '@solana/kit';

import { checkTransferCorrectness } from '@modules/chains/facilitator/verification/rules/transfer-correctness.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import {
  memoIx,
  OTHER_MINT,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
  USDC_MINT,
  VAULT_ATA,
} from './helpers/svm-test-fixtures';

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
  amount: '10000',
  asset: USDC_MINT,
  payTo: VAULT_ATA,
  resource: 'https://api.platform.io/tools/search_web',
  maxTimeoutSeconds: 60,
};

describe('checkTransferCorrectness', () => {
  it('accepts a transfer that pays exactly the required amount to the vault ATA', () => {
    expect(
      checkTransferCorrectness(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx()],
        requirements,
      ),
    ).toBeNull();
  });

  it('accepts overpayment — SVM tolerates at-least', () => {
    expect(
      checkTransferCorrectness(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx({ amount: 10_001n })],
        requirements,
      ),
    ).toBeNull();
  });

  it('rejects underpayment', () => {
    expect(
      checkTransferCorrectness(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx({ amount: 9_999n })],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT);
  });

  it('rejects a transfer to any account other than the vault ATA', () => {
    expect(
      checkTransferCorrectness(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx({ destination: address('11111111111111111111111111111111') }),
        ],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_RECIPIENT);
  });

  it('rejects a transfer in the wrong mint', () => {
    expect(
      checkTransferCorrectness(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx({ mint: OTHER_MINT })],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_ASSET);
  });

  it('rejects when there is no TransferChecked instruction at all', () => {
    expect(
      checkTransferCorrectness(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), memoIx('no transfer here')],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSFER);
  });

  it('rejects a second, unaccounted-for transfer even when the first one is correct', () => {
    expect(
      checkTransferCorrectness(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx(),
          transferCheckedIx({ destination: address('11111111111111111111111111111111') }),
        ],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSFER);
  });
});
