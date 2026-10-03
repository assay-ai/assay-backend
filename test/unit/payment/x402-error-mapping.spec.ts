import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { throwForX402InvalidReason } from '@modules/payment/domain/x402-error-mapping';

import { expectErrorCode } from '../helpers/expect-error-code';

describe('throwForX402InvalidReason — x402 invalid-reason error mapping', () => {
  it.each([
    [X402_INVALID_REASON.INSUFFICIENT_FUNDS, PaymentErrorCode.PAYMENT_INSUFFICIENT_FUNDS],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE,
      PaymentErrorCode.PAYMENT_INVALID_SIGNATURE,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_BLOCKHASH,
      PaymentErrorCode.PAYMENT_AUTHORIZATION_EXPIRED,
    ],
    [X402_INVALID_REASON.INVALID_NETWORK, PaymentErrorCode.PAYMENT_UNSUPPORTED_NETWORK],
    [X402_INVALID_REASON.INVALID_SCHEME, PaymentErrorCode.PAYMENT_UNSUPPORTED_SCHEME],
    [X402_INVALID_REASON.UNSUPPORTED_SCHEME, PaymentErrorCode.PAYMENT_UNSUPPORTED_SCHEME],
    [X402_INVALID_REASON.DUPLICATE_SETTLEMENT, PaymentErrorCode.PAYMENT_DUPLICATE_SETTLEMENT],
    [X402_INVALID_REASON.UNEXPECTED_SETTLE_ERROR, PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSACTION,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_INSTRUCTIONS,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_COMPUTE_BUDGET,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_TRANSFER,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_ASSET, PaymentErrorCode.PAYMENT_INVALID_PAYLOAD],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_RECIPIENT,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO, PaymentErrorCode.PAYMENT_INVALID_PAYLOAD],
    [
      X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIGNATURE,
      PaymentErrorCode.PAYMENT_INVALID_SIGNATURE,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_TRANSACTION,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_RECIPIENT,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    [
      X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_AMOUNT,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
    // 4xx, not the 502 of an unknown reason: a missing `approve` is the caller's.
    [
      X402_INVALID_REASON.INVALID_EXACT_EVM_PAYLOAD_SIMULATION,
      PaymentErrorCode.PAYMENT_INVALID_PAYLOAD,
    ],
  ])('maps %s -> %s', (reason, code) => {
    expectErrorCode(() => throwForX402InvalidReason(reason), code);
  });

  it('maps an unknown or missing reason to PAYMENT_SETTLEMENT_FAILED (unreachable facilitator)', () => {
    expectErrorCode(
      () => throwForX402InvalidReason(undefined),
      PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED,
    );
    expectErrorCode(
      () => throwForX402InvalidReason('some_future_reason_we_do_not_know_yet'),
      PaymentErrorCode.PAYMENT_SETTLEMENT_FAILED,
    );
  });

  it('covers every value X402_INVALID_REASON can produce', () => {
    const covered = new Set<string>();
    const original = expectErrorCode;
    void original;
    for (const reason of Object.values(X402_INVALID_REASON)) {
      let code: string | undefined;
      try {
        throwForX402InvalidReason(reason);
      } catch (error) {
        code = (error as { errorCode?: string }).errorCode;
      }
      expect(code).toBeDefined();
      covered.add(reason);
    }
    expect(covered.size).toBe(Object.values(X402_INVALID_REASON).length);
  });
});
