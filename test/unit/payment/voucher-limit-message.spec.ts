import { PaymentErrors } from '@modules/payment/errors/payment.errors';

// UX note R3-journey 28: "(maxPerWindow: 14353)" is 0.014353 USDG, printed as a
// bare number with no unit.
describe('voucher limit refusals name the unit of the amount they print', () => {
  it('labels a delegate cap as smallest units of the payment asset', () => {
    const error = PaymentErrors.voucherDelegateLimitExceeded({
      limit: 'maxPerWindow',
      allowed: '14353',
    });
    expect(error.message).toBe(
      'This voucher exceeds what the payer authorised its delegate to spend ' +
        "(maxPerWindow: 14353 left, in the payment asset's smallest units); nothing was charged",
    );
  });

  it('does the same for the escrow limit, and leaves a non-amount untouched', () => {
    expect(
      PaymentErrors.voucherEscrowLimitExceeded({ limit: 'maxVoucherAmount', allowed: '40000' })
        .message,
    ).toBe(
      "This voucher exceeds the payer's own escrow limit " +
        "(maxVoucherAmount: 40000, in the payment asset's smallest units); nothing was charged",
    );
    expect(
      PaymentErrors.voucherDelegateLimitExceeded({ limit: 'validUntil', allowed: 'a voucher x' })
        .message,
    ).toBe(
      'This voucher exceeds what the payer authorised its delegate to spend ' +
        '(validUntil: a voucher x); nothing was charged',
    );
  });
});
