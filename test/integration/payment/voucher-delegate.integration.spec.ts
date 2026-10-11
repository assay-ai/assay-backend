import { randomUUID } from 'node:crypto';

import {
  OpenVoucherTotals,
  ReceiptsSummaryGroupBy,
} from '@database/postgres/repositories/payment-intent.repository';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

/**
 * Agent payment delegation, against Postgres: the vouchers that have not
 * reached the chain yet are what the escrow's and the delegate's on-chain
 * windows cannot see, and `VoucherService` adds them before serving a call.
 * The admission read must count exactly those — by payer, by delegate — and
 * nothing else.
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

  it('counts, per payer and per delegate, every voucher the chain has not counted yet', async () => {
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

    /** What an admission for (payer, delegate) reads, with nothing written. */
    const open = async (
      who: typeof payer,
      signer: string | null,
      since: Date = new Date(),
    ): Promise<OpenVoucherTotals> => {
      let seen: OpenVoucherTotals | undefined;
      await expect(
        context.repository.insertAdmittedVoucherIntent(
          { organizationId: context.organizationId },
          {
            payer: who,
            assetId: asset,
            delegate: signer,
            escrowSince: since,
            delegateSince: since,
          },
          (totals) => {
            seen = totals;
            throw new Error('probe only');
          },
        ),
      ).rejects.toThrow('probe only');
      return seen as OpenVoucherTotals;
    };

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
    // In flight: admitted, funds not secured yet. It holds its place.
    const f = await context.createIntent('f', { agentAccount: payer, voucherDelegate: delegate });

    expect(a.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
    expect(a.voucherDelegate).toBe(delegate);
    expect(await open(payer, delegate)).toEqual({ escrow: 5_000_000n, delegate: 3_000_000n });
    expect(await open(payer, otherDelegate)).toEqual({ escrow: 5_000_000n, delegate: 1_000_000n });
    expect(await open(payer, null)).toEqual({ escrow: 5_000_000n, delegate: 0n });
    expect(await open(otherPayer, delegate)).toEqual({ escrow: 1_000_000n, delegate: 1_000_000n });

    // A CREATED intent whose funds could not be secured gives its place back.
    await context.intents.abandonUnsecuredVoucher(context.organizationId, f.id);
    expect(await open(payer, delegate)).toEqual({ escrow: 4_000_000n, delegate: 2_000_000n });

    // Redeemed on chain: the redemption job closes the hold of a SETTLED
    // intent. A chain read taken BEFORE that cannot contain it, so it still
    // counts; a read after it does, so it no longer does.
    const before = new Date(Date.now() - 60_000);
    await context.dataSource.query(
      `UPDATE "payment_intents" SET "status" = 'SETTLED', "hold_released_at" = now() WHERE "id" = $1`,
      [a.id],
    );
    expect(await open(payer, delegate, before)).toEqual({
      escrow: 4_000_000n,
      delegate: 2_000_000n,
    });
    expect(await open(payer, delegate, new Date(Date.now() + 1_000))).toEqual({
      escrow: 3_000_000n,
      delegate: 1_000_000n,
    });
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

  it('groups a delegate-signed call under the agent whose credential made it (GET /receipts/summary groupBy=agent)', async () => {
    const agentId = context.id('agent-with-delegate');
    const otherAgentId = context.id('agent-without-delegate');
    const delegate = context.account('delegate');
    await context.createIntent('i', { agentId, voucherDelegate: delegate });
    await context.createIntent('j', { agentId, voucherDelegate: delegate });
    await context.createIntent('k', { agentId }); // the payer's own voucher, same agent
    await context.createIntent('l', { agentId: otherAgentId });

    const now = Date.now();
    const rows = await context.repository.summarizeReceipts(
      context.organizationId,
      ReceiptsSummaryGroupBy.AGENT,
      { from: new Date(now - 3_600_000), to: new Date(now + 3_600_000) },
    );

    const calls = Object.fromEntries(rows.map((row) => [row.key, row.calls]));
    expect(calls).toEqual({ [agentId]: 3, [otherAgentId]: 1 });
  });

  /**
   * U02: two credentials of ONE agent hold two delegate keys (two machines,
   * two grants) and were one group under `groupBy=agent`. `groupBy=credential`
   * splits them; a row written before `credential_id` existed falls back to
   * its agent.
   */
  it('splits one agent’s spend by the credential that made each call (groupBy=credential)', async () => {
    const agentId = context.id('agent-with-two-credentials');
    const first = randomUUID();
    const second = randomUUID();
    await context.createIntent('m', { agentId, credentialId: first });
    await context.createIntent('n', { agentId, credentialId: first });
    await context.createIntent('o', { agentId, credentialId: second });
    await context.createIntent('p', { agentId }); // before the column: no credential

    const now = Date.now();
    const period = { from: new Date(now - 3_600_000), to: new Date(now + 3_600_000) };
    const byCredential = Object.fromEntries(
      (
        await context.repository.summarizeReceipts(
          context.organizationId,
          ReceiptsSummaryGroupBy.CREDENTIAL,
          period,
        )
      ).map((row) => [row.key, row.calls]),
    );
    expect(byCredential).toEqual({ [first]: 2, [second]: 1, [`agent:${agentId}`]: 1 });

    const byAgent = await context.repository.summarizeReceipts(
      context.organizationId,
      ReceiptsSummaryGroupBy.AGENT,
      period,
    );
    expect(byAgent.map((row) => [row.key, row.calls])).toEqual([[agentId, 4]]);
  });
});
