/**
 * The per-call export reconciles against `ProviderEarningsService`, per call
 * id.
 *
 * This is the test that makes the export's whole reason for existing
 * checkable rather than eyeballed: its promise is that a provider's
 * finance team can explain the gap between "10,000 requests served" and
 * "9,600 credited", and that promise only holds if the export's own totals
 * agree with the aggregate report the platform already publishes. Both are
 * computed independently — `ProviderEarningsService` sums in SQL,
 * `ProviderCallsExportService` streams rows this test sums in JS — so an
 * agreement between them is a real check, not two views of one query.
 */
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
} from '@modules/payment/ports/payment.types';
import { CallReconciliationClass } from '@modules/provider/domain/call-reconciliation';
import { GetProviderCallsExportQueryDto } from '@modules/provider/dto/get-provider-calls-export.dto';
import {
  GetProviderEarningsResponseDto,
  ProviderEarningsGroupBy,
} from '@modules/provider/dto/get-provider-earnings.dto';
import { ProviderCallsExportService } from '@modules/provider/services/provider-calls-export.service';
import { ProviderEarningsService } from '@modules/provider/services/provider-earnings.service';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

describe('per-call export ↔ ProviderEarningsService reconciliation', () => {
  let context: PaymentTestContext;
  let earningsService: ProviderEarningsService;
  let exportService: ProviderCallsExportService;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    earningsService = new ProviderEarningsService(context.repository);
    exportService = new ProviderCallsExportService(context.repository);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  async function driveToVerifying(intent: PaymentIntent) {
    await context.intents.secureFunds(context.organizationId, intent.id);
    await context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    return context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
    );
  }

  it('every call id is unique, and PAID_CREDITED / withheld sums match the earnings report exactly', async () => {
    const PROVIDER_ID = context.id('reconcile:provider');
    const PROVIDER_ACCOUNT = context.account('reconcile-provider');
    const AGENT_ACCOUNT = context.account('reconcile-agent');

    await context.fund(AGENT_ACCOUNT, 100_000_000n);

    // Every intent's `created_at` is written by Postgres's own `now()`, which
    // is not assumed to agree with this process's wall clock (it does not,
    // on this host — the test database container's clock differs from the
    // one Node reads `Date.now()` from). So the export window is built from
    // the timestamps the rows actually carry, not from `Date.now()`.
    const createdAt: Date[] = [];
    const track = <T extends { createdAt: Date }>(intent: T): T => {
      createdAt.push(intent.createdAt);
      return intent;
    };

    // Two credited calls.
    for (const label of ['settled-1', 'settled-2']) {
      const intent = track(
        await context.createIntent(label, {
          agentAccount: AGENT_ACCOUNT,
          providerId: PROVIDER_ID,
          providerAccount: PROVIDER_ACCOUNT,
        }),
      );
      const verifying = await driveToVerifying(intent);
      await context.intents.resolve(
        context.organizationId,
        verifying.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );
      // Rail B: credited once `redeem_voucher` lands, which is when the export
      // and the earnings report both count it.
      await context.intents.commitRedeemedHold(
        context.organizationId,
        verifying.id,
        `redeem-${verifying.id}`,
      );
    }

    // One uncredited (verification FAIL → REFUNDED).
    {
      const intent = track(
        await context.createIntent('refunded-1', {
          agentAccount: AGENT_ACCOUNT,
          providerId: PROVIDER_ID,
          providerAccount: PROVIDER_ACCOUNT,
        }),
      );
      const verifying = await driveToVerifying(intent);
      await context.intents.resolve(
        context.organizationId,
        verifying.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.REFUNDED,
        { reason: 'verification FAIL', verificationVerdict: 'FAIL' },
      );
    }

    // Two voided calls — one SYSTEM_ERROR, one REQUEST_ERROR.
    {
      const intent = track(
        await context.createIntent('voided-system-error', {
          agentAccount: AGENT_ACCOUNT,
          providerId: PROVIDER_ID,
          providerAccount: PROVIDER_ACCOUNT,
        }),
      );
      await context.intents.secureFunds(context.organizationId, intent.id);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );
      await context.intents.resolve(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        { reason: 'upstream 503', classification: 'SYSTEM_ERROR' },
      );
    }
    {
      const intent = track(
        await context.createIntent('voided-request-error', {
          agentAccount: AGENT_ACCOUNT,
          providerId: PROVIDER_ID,
          providerAccount: PROVIDER_ACCOUNT,
        }),
      );
      await context.intents.secureFunds(context.organizationId, intent.id);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );
      await context.intents.resolve(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        { reason: 'agent sent a bad argument', classification: 'REQUEST_ERROR' },
      );
    }

    // A FREE call. Priced the same as the others on purpose (there is no
    // real zero-price `FREE` producer today) — the point of this row is that
    // `classifyForReconciliation`
    // excludes it from `PAID_CREDITED`/withheld on `callClass` alone, never
    // on the amount. It is `SETTLED`, so `ProviderEarningsService` — which
    // predates `call_class` and sums every `SETTLED` row regardless of it —
    // *does* fold this row into `earned`. That is a real, pre-existing
    // divergence between the two reports, not a bug this test papers over:
    // the assertions below add this row's contribution back in explicitly,
    // by name, rather than silently expecting an equality that does not
    // actually hold.
    const freeIntent = track(
      await context.createIntent('free-settled', {
        agentAccount: AGENT_ACCOUNT,
        providerId: PROVIDER_ID,
        providerAccount: PROVIDER_ACCOUNT,
        callClass: PaymentIntentCallClass.FREE,
      }),
    );
    {
      const verifying = await driveToVerifying(freeIntent);
      await context.intents.resolve(
        context.organizationId,
        verifying.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );
      // Rail B: credited once `redeem_voucher` lands, which is when the export
      // and the earnings report both count it.
      await context.intents.commitRedeemedHold(
        context.organizationId,
        verifying.id,
        `redeem-${verifying.id}`,
      );
    }

    // One still in flight — no terminal outcome yet.
    const pendingIntent = track(
      await context.createIntent('pending-1', {
        agentAccount: AGENT_ACCOUNT,
        providerId: PROVIDER_ID,
        providerAccount: PROVIDER_ACCOUNT,
      }),
    );
    await driveToVerifying(pendingIntent);

    const from = new Date(Math.min(...createdAt.map((d) => d.getTime())) - 1_000).toISOString();
    const to = new Date(Math.max(...createdAt.map((d) => d.getTime())) + 1_000).toISOString();

    const earnings: GetProviderEarningsResponseDto = await earningsService.getEarnings(
      PROVIDER_ID,
      { from, to, groupBy: ProviderEarningsGroupBy.DAY },
    );

    const query: GetProviderCallsExportQueryDto = { from, to };
    const result = await exportService.prepare(PROVIDER_ID, query);

    expect(result.meta.truncated).toBe(false);
    expect(result.meta.totalMatching).toBe(7);
    expect(result.meta.rowCount).toBe(7);

    const rows: Array<ReadonlyArray<string | number | null>> = [];
    for await (const row of result.rows) {
      rows.push(row);
    }
    expect(rows).toHaveLength(7);

    // (a) every call id is unique and appears exactly once.
    const callIds = rows.map((row) => row[0]);
    expect(new Set(callIds).size).toBe(callIds.length);

    // Column indices, matching `CSV_HEADER` in `provider-calls-export.service.ts`:
    // 0 call_id · 5 classification · 8 provider_amount · 9 platform_fee
    const classificationOf = (row: ReadonlyArray<string | number | null>) => row[5];
    const providerAmountOf = (row: ReadonlyArray<string | number | null>) =>
      BigInt(row[8] as string);
    const platformFeeOf = (row: ReadonlyArray<string | number | null>) => BigInt(row[9] as string);

    const sumWhere = (predicate: (c: unknown) => boolean, pick: typeof providerAmountOf) =>
      rows
        .filter((row) => predicate(classificationOf(row)))
        .reduce((sum, row) => sum + pick(row), 0n);

    // (b) Σ PAID_CREDITED + the one FREE/SETTLED row == earnings.totals.earned,
    // exactly — see the comment on the FREE row above for why the FREE
    // contribution has to be named rather than assumed to be zero.
    const creditedProviderAmount = sumWhere(
      (c) => c === CallReconciliationClass.PAID_CREDITED,
      providerAmountOf,
    );
    const creditedPlatformFee = sumWhere(
      (c) => c === CallReconciliationClass.PAID_CREDITED,
      platformFeeOf,
    );
    const freeSettledProviderAmount = BigInt(freeIntent.providerAmount.amount);
    const freeSettledPlatformFee = BigInt(freeIntent.platformFee.amount);
    expect((creditedProviderAmount + freeSettledProviderAmount).toString()).toBe(
      earnings.totals.earned?.amount,
    );
    expect((creditedPlatformFee + freeSettledPlatformFee).toString()).toBe(
      earnings.totals.platformFee?.amount,
    );

    // And the withheld/uncredited bucket: PAID_UNCREDITED + SYSTEM_ERROR + REQUEST_ERROR.
    const withheldProviderAmount = sumWhere(
      (c) =>
        c === CallReconciliationClass.PAID_UNCREDITED ||
        c === CallReconciliationClass.SYSTEM_ERROR ||
        c === CallReconciliationClass.REQUEST_ERROR,
      providerAmountOf,
    );
    expect(withheldProviderAmount.toString()).toBe(earnings.totals.withheld?.amount);

    // The exact classification mix this scenario produces.
    const classCounts = new Map<string, number>();
    for (const row of rows) {
      const key = String(classificationOf(row));
      classCounts.set(key, (classCounts.get(key) ?? 0) + 1);
    }
    expect(classCounts.get(CallReconciliationClass.PAID_CREDITED)).toBe(2);
    expect(classCounts.get(CallReconciliationClass.PAID_UNCREDITED)).toBe(1);
    expect(classCounts.get(CallReconciliationClass.SYSTEM_ERROR)).toBe(1);
    expect(classCounts.get(CallReconciliationClass.REQUEST_ERROR)).toBe(1);
    expect(classCounts.get(CallReconciliationClass.FREE)).toBe(1);
    expect(classCounts.get(CallReconciliationClass.PENDING)).toBe(1);

    // No row is unclassified — every one of the seven has a real member.
    expect(
      rows.every((row) => typeof classificationOf(row) === 'string' && classificationOf(row)),
    ).toBe(true);
  });

  it('a settled call nobody was credited for is PENDING, not PAID_CREDITED', async () => {
    const PROVIDER_ID = context.id('uncredited:provider');
    // SETTLED with no hold at all — the shape a bulk seed writes, and what a
    // failed commit leaves behind. The earnings report credits nothing for it.
    const intent = await context.createIntent('uncredited-1', {
      providerId: PROVIDER_ID,
      providerAccount: context.account('uncredited-provider'),
    });
    await context.dataSource.query(`UPDATE payment_intents SET status = 'SETTLED' WHERE id = $1`, [
      intent.id,
    ]);

    const from = new Date(intent.createdAt.getTime() - 1_000).toISOString();
    const to = new Date(intent.createdAt.getTime() + 1_000).toISOString();
    const result = await exportService.prepare(PROVIDER_ID, { from, to });
    const rows: Array<ReadonlyArray<string | number | null>> = [];
    for await (const row of result.rows) rows.push(row);

    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe(CallReconciliationClass.PENDING);
    expect(rows[0][6]).toBe('settled, no credit recorded');

    const earnings = await earningsService.getEarnings(PROVIDER_ID, {
      from,
      to,
      groupBy: ProviderEarningsGroupBy.DAY,
    });
    expect(earnings.totals.earned?.amount ?? '0').toBe('0');
  });

  it('not credited counts the same calls as the export, held or not (D17)', async () => {
    const PROVIDER_ID = context.id('not-credited:provider');
    const parties = {
      agentAccount: context.account('not-credited-agent'),
      providerId: PROVIDER_ID,
      providerAccount: context.account('not-credited-provider'),
    };
    await context.fund(parties.agentAccount, 100_000_000n);

    // A failed check whose hold was never recorded (a test-injected row).
    const unheld = await context.createIntent('not-credited-unheld', parties);
    await context.dataSource.query(
      `UPDATE payment_intents SET status = 'REFUNDED', hold_id = NULL WHERE id = $1`,
      [unheld.id],
    );
    // A buyer debt voided by a late rejecting verdict.
    const voided = await context.createIntent('not-credited-voided', parties);
    await context.dataSource.query(
      `UPDATE payment_intents SET status = 'SETTLED', redemption_last_error = 'voided:FAIL' WHERE id = $1`,
      [voided.id],
    );
    // A held endpoint error.
    const errored = await context.createIntent('not-credited-error', parties);
    await context.intents.secureFunds(context.organizationId, errored.id);
    await context.intents.transition(
      context.organizationId,
      errored.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
    await context.intents.resolve(
      context.organizationId,
      errored.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      { reason: 'upstream 503', classification: 'SYSTEM_ERROR' },
    );

    const times = [unheld, voided, errored].map((intent) => intent.createdAt.getTime());
    const from = new Date(Math.min(...times) - 1_000).toISOString();
    const to = new Date(Math.max(...times) + 1_000).toISOString();

    const result = await exportService.prepare(PROVIDER_ID, { from, to });
    const exported = new Map<string, number>();
    const exportedAmount = new Map<string, bigint>();
    for await (const row of result.rows) {
      if (row[1] === voided.id) {
        // Wave-1 audit M1: the forgone share, but no fee was taken on it.
        expect({ providerAmount: row[8], platformFee: row[9] }).toEqual({
          providerAmount: voided.providerAmount.amount,
          platformFee: '0',
        });
      }
      const cls = String(row[5]);
      exported.set(cls, (exported.get(cls) ?? 0) + 1);
      exportedAmount.set(cls, (exportedAmount.get(cls) ?? 0n) + BigInt(row[8] as string));
    }

    // Both groupings: the day key (`to_char`) and the tool key join the same way.
    for (const groupBy of [ProviderEarningsGroupBy.TOOL, ProviderEarningsGroupBy.DAY]) {
      const earnings = await earningsService.getEarnings(PROVIDER_ID, { from, to, groupBy });

      expect(earnings.totals.withheldCalls).toBe(3);
      for (const reason of earnings.totals.withheldByClass) {
        // Calls AND amounts: the CSV's provider_amount per class is the reason's worth.
        expect(reason.calls).toBe(exported.get(reason.class) ?? 0);
        expect(reason.amount?.amount).toBe((exportedAmount.get(reason.class) ?? 0n).toString());
      }
      const groupCalls = earnings.groups.reduce((sum, group) => sum + group.withheldCalls, 0);
      expect(groupCalls).toBe(3);
    }
    const earnings = await earningsService.getEarnings(PROVIDER_ID, {
      from,
      to,
      groupBy: ProviderEarningsGroupBy.TOOL,
    });
    expect(exported.get(CallReconciliationClass.PAID_UNCREDITED)).toBe(2);
    // The summary is its reasons' sum; each call counts at its provider share.
    const share = BigInt(unheld.providerAmount.amount);
    expect(earnings.totals.withheld?.amount).toBe((share * 3n).toString());
  });
});
