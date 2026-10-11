import { randomUUID } from 'node:crypto';

import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

/**
 * Agent payment delegation, against Postgres: the delegate's vouchers that hold
 * money and have not reached the chain yet are what the delegate's on-chain
 * window cannot see, and `VoucherService` adds them before serving a
 * delegate-signed call. The sum must count exactly those — by payer, by
 * delegate, with an open hold — and nothing else.
 */
describe('payment_intents.voucher_delegate — the delegate’s in-flight vouchers', () => {
  let context: PaymentTestContext;

  beforeAll(async () => {
    context = await createPaymentTestContext();
  }, 300_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('sums the open holds a delegate signed for a payer, and only those', async () => {
    // Unique per run: the sum is deliberately ACROSS organizations (the window
    // is the payer account's on chain), so a rotated organization id does not
    // isolate one run's rows from the last one's.
    const run = randomUUID().slice(0, 8);
    const payer = context.account(`payer-${run}`);
    const otherPayer = context.account(`other-payer-${run}`);
    const delegate = context.account(`delegate-${run}`);
    const otherDelegate = context.account(`other-delegate-${run}`);
    const asset = context.usdc(0n).asset;
    await context.fund(payer, 10_000_000n);
    await context.fund(otherPayer, 10_000_000n);

    const secured = async (
      label: string,
      agentAccount: typeof payer,
      voucherDelegate: string | null,
    ) => {
      const intent = await context.createIntent(label, { agentAccount, voucherDelegate });
      return context.intents.secureFunds(context.organizationId, intent.id);
    };

    const a = await secured('a', payer, delegate);
    await secured('b', payer, delegate);
    await secured('c', payer, otherDelegate); // another delegate of the same payer
    await secured('d', payer, null); // the payer's own voucher
    await secured('e', otherPayer, delegate); // the same key, another payer
    await context.createIntent('f', { agentAccount: payer, voucherDelegate: delegate }); // no hold yet

    expect(a.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
    expect(a.voucherDelegate).toBe(delegate);
    expect(await context.intents.sumOpenDelegateVouchers(payer, delegate, asset)).toBe(2_000_000n);

    // Redeemed on chain: the redemption job closes the hold, and from then on
    // the chain's own window carries the amount.
    await context.dataSource.query(
      `UPDATE "payment_intents" SET "hold_released_at" = now() WHERE "id" = $1`,
      [a.id],
    );
    expect(await context.intents.sumOpenDelegateVouchers(payer, delegate, asset)).toBe(1_000_000n);
    expect(await context.intents.sumOpenDelegateVouchers(payer, otherDelegate, asset)).toBe(
      1_000_000n,
    );
    expect(await context.intents.sumOpenDelegateVouchers(otherPayer, delegate, asset)).toBe(
      1_000_000n,
    );
  });

  it('reads back the delegate it stored, and null for a payer-signed voucher', async () => {
    const delegate = context.account('delegate');
    const withDelegate = await context.createIntent('g', { voucherDelegate: delegate });
    const withoutDelegate = await context.createIntent('h');
    expect(
      (await context.intents.findById(context.organizationId, withDelegate.id)).voucherDelegate,
    ).toBe(delegate);
    expect(
      (await context.intents.findById(context.organizationId, withoutDelegate.id)).voucherDelegate,
    ).toBeNull();
  });
});
