import { checkMemo } from '@modules/chains/facilitator/verification/rules/memo.rule';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import {
  memoIx,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
} from './helpers/svm-test-fixtures';

const baseRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never,
  amount: '10000',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  payTo: 'C4PRXFV6Gf5mytVZb6RoeLsG8CjcFWzR2EJ3dvwPTUJH',
  resource: 'https://api.platform.io/tools/search_web',
  maxTimeoutSeconds: 60,
};

describe('checkMemo', () => {
  it('passes when no memo is required and none is present', () => {
    expect(
      checkMemo(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx()],
        baseRequirements,
      ),
    ).toBeNull();
  });

  it('accepts a memo that matches extra.memo exactly', () => {
    const requirements = { ...baseRequirements, extra: { memo: 'pi_01J8XZQ4M0000000000000' } };
    expect(
      checkMemo(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx(),
          memoIx('pi_01J8XZQ4M0000000000000'),
        ],
        requirements,
      ),
    ).toBeNull();
  });

  it('rejects a missing memo when one is required', () => {
    const requirements = { ...baseRequirements, extra: { memo: 'pi_expected' } };
    expect(
      checkMemo(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx()],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO);
  });

  it('rejects a memo that does not match exactly', () => {
    const requirements = { ...baseRequirements, extra: { memo: 'pi_expected' } };
    expect(
      checkMemo(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx(), memoIx('pi_wrong')],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO);
  });

  it('rejects two memo instructions even if one matches — ambiguous binding is not a pass', () => {
    const requirements = { ...baseRequirements, extra: { memo: 'pi_expected' } };
    expect(
      checkMemo(
        [
          setComputeUnitLimitIx(),
          setComputeUnitPriceIx(),
          transferCheckedIx(),
          memoIx('pi_expected'),
          memoIx('pi_other'),
        ],
        requirements,
      ),
    ).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO);
  });

  it('ignores a memo present when none was required', () => {
    expect(
      checkMemo(
        [setComputeUnitLimitIx(), setComputeUnitPriceIx(), transferCheckedIx(), memoIx('anything')],
        baseRequirements,
      ),
    ).toBeNull();
  });
});
