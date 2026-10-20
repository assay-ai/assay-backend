import { randomUUID } from 'node:crypto';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { PaymentKeyDailySummaryService } from '@modules/account/services/payment-key-daily-summary.service';
import {
  NotificationEvent,
  NotificationPort,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import { PaymentIntent } from '@modules/payment/ports/payment.types';
import { PaymentKeyFirstSpendService } from '@modules/payment/services/payment-key-first-spend.service';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

/**
 * The payment-key notices (spec §7.10 item 6) against Postgres: "first" and
 * "spent" are questions the payment_intents table answers, so they are tested
 * on it — which rows count as a spend, in which window, per key.
 */
describe('payment-key notices — first spend and the daily summary', () => {
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

  const recordingPort = () => {
    const sent: NotificationRequest[] = [];
    const port: NotificationPort = {
      notify: async (request) => {
        sent.push(request);
        return { deliveredNow: true };
      },
    };
    // The port fake writes no row: a recorded send stands for one.
    const notices = {
      existsWithPayload: async () => sent.length > 0,
    } as unknown as NotificationRepository;
    return { sent, port, notices };
  };

  const noName = { findOne: async () => null };

  const firstSpend = (port: NotificationPort, notices: NotificationRepository) =>
    new PaymentKeyFirstSpendService(
      context.repository,
      port,
      noName as unknown as AgentCredentialRepository,
      noName as unknown as AgentRepository,
      noName as unknown as ToolRepository,
      notices,
    );

  /** A voucher of `delegate` (null: the payer's own key) whose funds are secured. */
  const spend = async (
    label: string,
    delegate: string | null,
    extra: { credentialId?: string; price?: bigint } = {},
  ): Promise<PaymentIntent> => {
    const payer = context.account(`payer-${label}`);
    await context.fund(payer, 100_000_000n);
    const intent = await context.createIntent(label, {
      agentAccount: payer,
      voucherDelegate: delegate,
      credentialId: extra.credentialId ?? null,
      ...(extra.price !== undefined
        ? { price: context.usdc(extra.price), platformFee: context.usdc(0n) }
        : {}),
    });
    return context.intents.secureFunds(context.organizationId, intent.id);
  };

  describe('payment_key.first_spend', () => {
    it('first delegate-signed redemption → one notification; second → none', async () => {
      const { sent, port, notices } = recordingPort();
      const service = firstSpend(port, notices);
      const delegate = context.account(`delegate-${randomUUID().slice(0, 8)}`);

      const first = await spend('first', delegate);
      expect(await service.notifyIfFirst(first)).toBe(true);
      const second = await spend('second', delegate);
      expect(await service.notifyIfFirst(second)).toBe(false);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        organizationId: context.organizationId,
        event: NotificationEvent.PAYMENT_KEY_FIRST_SPEND,
      });
    });

    it('payer-signed voucher → none', async () => {
      const { sent, port, notices } = recordingPort();
      const own = await spend('own', null);
      expect(await firstSpend(port, notices).notifyIfFirst(own)).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('an earlier voucher that never held money is not a spend', async () => {
      const { sent, port, notices } = recordingPort();
      const delegate = context.account(`delegate-${randomUUID().slice(0, 8)}`);
      // Admitted, then refused for funds: no hold, nothing spent.
      const unfunded = await context.createIntent('unfunded', { voucherDelegate: delegate });
      await context.intents.abandonUnsecuredVoucher(context.organizationId, unfunded.id);

      const first = await spend('after-unfunded', delegate);
      expect(await firstSpend(port, notices).notifyIfFirst(first)).toBe(true);
      expect(sent).toHaveLength(1);
    });
  });

  describe('payment_key.daily_summary', () => {
    const window = () => ({
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    });

    it('summary lists amount and count per key; no key with zero spend', async () => {
      const run = randomUUID().slice(0, 8);
      const key1 = context.account(`key1-${run}`);
      const key2 = context.account(`key2-${run}`);
      const quiet = context.account(`quiet-${run}`);
      const credential1 = randomUUID();
      const credential2 = randomUUID();

      await spend('a', key1, { credentialId: credential1, price: 1_000_000n });
      await spend('b', key1, { credentialId: credential1, price: 2_500_001n });
      await spend('c', key2, { credentialId: credential2, price: 7n });
      await spend('own', null, { price: 9_000_000n }); // the payer's key: not a payment key
      // The quiet key's only voucher was refunded: nothing spent.
      const refunded = await spend('d', quiet, { price: 5_000_000n });
      await context.dataSource.query(
        `UPDATE "payment_intents" SET "status" = 'REFUNDED' WHERE "id" = $1`,
        [refunded.id],
      );
      // Outside the window.
      const old = await spend('e', key1, { credentialId: credential1, price: 4_000_000n });
      await context.dataSource.query(
        `UPDATE "payment_intents" SET "created_at" = now() - interval '2 days' WHERE "id" = $1`,
        [old.id],
      );

      const { from, to } = window();
      const rows = (await context.repository.sumDelegateSpendByKey(from, to)).filter(
        (row) => row.organizationId === context.organizationId,
      );

      expect(
        rows.map((row) => ({
          credentialId: row.credentialId,
          delegate: row.delegate,
          calls: row.calls,
          amount: row.amount,
        })),
      ).toEqual(
        [
          { credentialId: credential1, delegate: key1, calls: 2, amount: 3_500_001n },
          { credentialId: credential2, delegate: key2, calls: 1, amount: 7n },
        ].sort((x, y) => x.delegate.localeCompare(y.delegate)),
      );
    });

    it('sends one notice per organization for the previous UTC day', async () => {
      const run = randomUUID().slice(0, 8);
      const key = context.account(`key-${run}`);
      await spend('f', key, { price: 1_500_000n });
      await spend('g', key, { price: 1_500_000n });

      const { sent, port } = recordingPort();
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const service = new PaymentKeyDailySummaryService(
        context.repository,
        port,
        { now: () => tomorrow.getTime() },
        noName as unknown as AgentCredentialRepository,
        noName as unknown as AgentRepository,
        { set: async () => 'OK' } as never,
      );

      const result = await service.run();
      expect(result).toMatchObject({ skipped: false, day: new Date().toISOString().slice(0, 10) });
      const mine = sent.filter((request) => request.organizationId === context.organizationId);
      expect(mine).toHaveLength(1);
      expect(mine[0].body).toContain('2 paid calls, 3.000000 USDC');
      expect(mine[0].payload).toMatchObject({
        keys: [{ calls: 2, spend: [{ amount: '3000000' }] }],
      });
    });
  });
});
