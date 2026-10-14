/**
 * The seam between the provider earnings ledger and the per-call export, which
 * neither can test alone.
 *
 * The earnings ledger is `PROVIDER_CREDIT` entries under the provider's own
 * organization. The export's whole promise is that a provider's finance team
 * can take the export, join it
 * to their own access log on `X-Assay-Call-Id`, and have every row explained.
 * That promise is only worth anything if the export agrees with **the ledger we
 * actually pay out of** — not merely with `payment_intents`, which is what
 * `calls-export-reconciliation.integration.spec.ts` already checks.
 *
 * The distinction matters because the two can drift. `payment_intents` is the
 * accounting *record*; `ledger_entries` is the accounting *fact*, and
 * `ProviderPayoutBatchService` pays from the latter. An export that reconciled
 * against the record while the ledger said something else would tell a provider
 * their statement was correct right up until the money arrived and was a
 * different number.
 *
 * So this test drives the **production** path end to end — `PaymentIntentService`
 * creates and resolves, which is what calls `commitHoldAndCredit` — and then
 * asserts the join **programmatically, per call id**. Nothing here is compared
 * by eye and nothing is asserted against a hand-written expected total: the
 * expectation is built from the ledger rows themselves, so a bug that moved
 * both sides in the same direction still fails.
 */
import { randomUUID } from 'node:crypto';

import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { CallReconciliationClass } from '@modules/provider/domain/call-reconciliation';
import { ProviderCallsExportService } from '@modules/provider/services/provider-calls-export.service';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

/** One seeded call and the outcome it was driven to. */
interface SeededCall {
  readonly label: string;
  readonly callId: string;
  readonly intentId: string;
  readonly settled: boolean;
}

describe('per-call export reconciles against the provider earnings ledger', () => {
  let context: PaymentTestContext;
  let exportService: ProviderCallsExportService;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    exportService = new ProviderCallsExportService(context.repository);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('every PAID_CREDITED row has a PROVIDER_CREDIT of exactly its amount, and every other row has none', async () => {
    const agent = context.account('recon-agent');
    await context.fund(agent, 100_000_000n);

    // One provider, addressed the way the whole module addresses providers:
    // `providerId === organizationId` (see `ProviderProfileService`). This is
    // the id the credit lands under, and the id the export is scoped by.
    // A fresh provider id per run. `ledger_entries` refuses DELETE by design
    // and this database is never truncated, so a deterministic id would join
    // this run's export to the previous run's rows.
    const providerOrg = randomUUID();
    const providerAccount = context.account(`recon-provider-payout-${providerOrg}`);

    const from = new Date(Date.now() - 60_000);

    // A deliberately mixed window: two calls that settle, one that is refunded
    // after verification failed, one voided by a provider system error, and one
    // still in flight. Only the first two may carry earnings.
    const plan: readonly { label: string; settle: boolean; refund?: boolean; void?: boolean }[] = [
      { label: 'call-settles-1', settle: true },
      { label: 'call-settles-2', settle: true },
      { label: 'call-refunded', settle: false, refund: true },
      { label: 'call-voided', settle: false, void: true },
      { label: 'call-in-flight', settle: false },
    ];

    const seeded: SeededCall[] = [];

    for (const step of plan) {
      const callId = randomUUID();
      // No provider at creation — a CHECK refuses one, because on the MCP path
      // the router picks the provider after the intent exists. It is written on
      // the edge leaving `PROVIDER_EXECUTING`, exactly as production does it.
      const intent = await context.createIntent(step.label, {
        agentAccount: agent,
        callId,
        price: context.usdc(1_000_000n),
        platformFee: context.usdc(200_000n),
      });

      await context.intents.secureFunds(context.organizationId, intent.id);
      await context.intents.resolve(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        { reason: 'forwarded to the provider' },
      );

      if (step.void) {
        await context.intents.resolve(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.PROVIDER_EXECUTING,
          PaymentIntentStatus.VOIDED,
          { reason: 'provider system error', providerId: providerOrg, providerAccount },
        );
      } else {
        await context.intents.resolve(
          context.organizationId,
          intent.id,
          PaymentIntentStatus.PROVIDER_EXECUTING,
          PaymentIntentStatus.VERIFYING,
          { reason: 'data result', providerId: providerOrg, providerAccount },
        );

        if (step.settle) {
          await context.intents.resolve(
            context.organizationId,
            intent.id,
            PaymentIntentStatus.VERIFYING,
            PaymentIntentStatus.SETTLED,
            { reason: 'verification passed' },
          );
          // Rail B: `resolve()` leaves the hold open on SETTLED and the provider is credited only
          // once `redeem_voucher` lands, so the earnings ledger is read after the redemption.
          await context.intents.commitRedeemedHold(
            context.organizationId,
            intent.id,
            `redeem-${intent.id}`,
          );
        } else if (step.refund) {
          await context.intents.resolve(
            context.organizationId,
            intent.id,
            PaymentIntentStatus.VERIFYING,
            PaymentIntentStatus.REFUNDED,
            { reason: 'verification failed' },
          );
        }
      }

      seeded.push({
        label: step.label,
        callId,
        intentId: intent.id,
        settled: step.settle,
      });
    }

    const to = new Date(Date.now() + 60_000);

    // ── The export, as the provider downloads it ─────────────────────────────
    const prepared = await exportService.prepare(providerOrg, {
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const rows: Array<ReadonlyArray<string | number | null>> = [];
    for await (const row of prepared.rows) rows.push(row);

    // Column indices, matching `CSV_HEADER` in `provider-calls-export.service.ts`:
    // 0 call_id · 1 intent_id · 5 classification · 8 provider_amount
    const callIdOf = (row: ReadonlyArray<string | number | null>) => String(row[0]);
    const classOf = (row: ReadonlyArray<string | number | null>) => row[5];
    const providerAmountOf = (row: ReadonlyArray<string | number | null>) => String(row[8]);

    expect(rows).toHaveLength(seeded.length);

    // ── The earnings ledger, as the payout batch reads it ────────────────────
    const credits = await context.dataSource.getRepository(LedgerEntryEntity).find({
      where: { organizationId: providerOrg, entryType: LedgerEntryType.PROVIDER_CREDIT },
    });

    // Keyed by intent, because that is the only key the two sides share: the
    // journal deliberately carries no call id (a ledger entry is a movement of
    // value, not a record of an HTTP request), and the export carries both.
    const creditByIntent = new Map(credits.map((entry) => [entry.intentId as string, entry]));
    const rowByCallId = new Map(rows.map((row) => [callIdOf(row), row]));

    // Every call id appears exactly once — otherwise a provider joining their
    // log to ours would double-count.
    expect(rowByCallId.size).toBe(rows.length);

    let creditedFromExport = 0n;
    let creditedFromLedger = 0n;

    for (const call of seeded) {
      const row = rowByCallId.get(call.callId);
      expect(row).toBeDefined();
      if (!row) continue;

      const credit = creditByIntent.get(call.intentId);

      if (call.settled) {
        // Classified as credited, and the ledger agrees to the atomic unit.
        expect(classOf(row)).toBe(CallReconciliationClass.PAID_CREDITED);
        expect(credit).toBeDefined();
        expect(credit?.amount).toBe(providerAmountOf(row));

        creditedFromExport += BigInt(providerAmountOf(row));
        creditedFromLedger += BigInt(credit?.amount ?? '0');
      } else {
        // The load-bearing half. A call the export did not classify as credited
        // must have moved no money to the provider — this is the assertion that
        // would catch an export that under-reports earnings, which is the
        // failure a provider would never notice from their side.
        expect(classOf(row)).not.toBe(CallReconciliationClass.PAID_CREDITED);
        expect(credit).toBeUndefined();
      }
    }

    // No credit exists for a call outside the export — i.e. the ledger holds
    // nothing this provider was paid for that their statement does not show.
    for (const intentId of creditByIntent.keys()) {
      expect(seeded.some((call) => call.intentId === intentId && call.settled)).toBe(true);
    }

    expect(creditedFromExport).toBe(creditedFromLedger);
    expect(creditedFromExport).toBe(2n * 800_000n); // price 1.00 − fee 0.20, twice

    console.log(
      'Export ↔ earnings-ledger reconciliation, joined per call id:\n' +
        `  rows exported            : ${rows.length}\n` +
        `  PROVIDER_CREDIT entries  : ${credits.length}\n` +
        `  Σ export PAID_CREDITED   : ${creditedFromExport}\n` +
        `  Σ ledger PROVIDER_CREDIT : ${creditedFromLedger}\n` +
        `  difference               : ${creditedFromExport - creditedFromLedger}`,
    );
  });
});
