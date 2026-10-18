import { randomUUID } from 'node:crypto';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { ReceiptsSummaryGroupBy } from '@database/postgres/repositories/payment-intent.repository';
import { WithheldBucket } from '@modules/ledger/domain/withheld';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { WithheldTestContext, createWithheldTestContext } from '../helpers/withheld-test-context';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE = 100_000n;

/**
 * UX review 2026-10-18 P0-3: `GET /withheld` and `GET /receipts/summary` are
 * two routes to one buyer figure, "not charged", and they disagreed. The
 * summary counted a served call that was never collected and is not owed
 * (forfeited, debt voided, legacy absorb) as not charged; `withheld` did not,
 * so the seeded buyer saw $0.60 / 14 calls on one screen and $1.10 / 19 on the
 * next. Both are computed in SQL, so the agreement is checked against Postgres.
 */
describe('PaymentIntentRepository — withheld equals the summary’s not charged', () => {
  let context: WithheldTestContext;
  const PROVIDER = randomUUID();

  beforeAll(async () => {
    context = await createWithheldTestContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  /** One paid call by the current organization, driven to `outcome`. */
  async function call(toolId: string, outcome: 'REFUNDED' | 'VOIDED' | 'SETTLED'): Promise<string> {
    const { organizationId } = context;
    const account = context.account(`buyer-${randomUUID()}`);
    await context.fund(account, 10_000_000n);

    const intent = await context.createIntent({
      agentAccount: account,
      toolId,
      priceAtomic: PRICE,
    });
    await context.intents.secureFunds(organizationId, intent.id);
    await context.intents.transition(
      organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      { reason: 'forwarded' },
    );

    if (outcome === 'VOIDED') {
      await context.intents.resolve(
        organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        { reason: 'provider error', providerId: PROVIDER },
      );
      return intent.id;
    }

    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
      {
        reason: 'data result',
        providerId: PROVIDER,
        providerAccount: context.account(`provider-${PROVIDER}`),
      },
    );
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      outcome === 'SETTLED' ? PaymentIntentStatus.SETTLED : PaymentIntentStatus.REFUNDED,
      {
        reason: outcome === 'SETTLED' ? 'verification passed' : 'verification failed',
        verificationVerdict: outcome === 'SETTLED' ? 'PASS' : 'FAIL',
      },
    );
    return intent.id;
  }

  /** The columns `VoucherRedemptionService` leaves on a SETTLED row in each state. */
  async function settledAs(
    intentId: string,
    state:
      | 'COLLECTED'
      | 'FORFEITED'
      | 'OPEN_DEBT'
      | 'WRITTEN_OFF'
      | 'VOIDED_REFUND'
      | 'VOIDED_VOID'
      | 'DISPUTE_UPHELD',
  ): Promise<void> {
    const cause = {
      COLLECTED: null,
      FORFEITED: 'provider_forfeit:ProviderBelowMinimumStake',
      OPEN_DEBT: 'DelegateIsRevoked',
      WRITTEN_OFF: 'uncollected:DelegateIsRevoked',
      VOIDED_REFUND: 'voided:REFUND',
      VOIDED_VOID: 'voided:VOID',
      DISPUTE_UPHELD: 'voided:DISPUTE_UPHELD',
    }[state];
    const lapsed = state !== 'COLLECTED' && state !== 'FORFEITED';
    const released = state !== 'OPEN_DEBT';
    await context.dataSource.query(
      `UPDATE payment_intents
          SET redemption_last_error = $2,
              redemption_lapsed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
              hold_released_at = CASE WHEN $4::boolean THEN now() ELSE NULL END
        WHERE id = $1`,
      [intentId, cause, lapsed, released],
    );
  }

  /** A legacy absorb: collected columns, plus a `platform_absorbed:` provider credit. */
  async function absorbed(intentId: string): Promise<void> {
    await settledAs(intentId, 'COLLECTED');
    await context.dataSource.query(
      `INSERT INTO ledger_entries
         (organization_id, account_id, entry_type, amount, asset_id, decimals, intent_id, chain_tx_ref)
       SELECT provider_id, $2, 'PROVIDER_CREDIT', price_amount, asset_id, decimals, id, $3
         FROM payment_intents WHERE id = $1`,
      [intentId, context.account(`provider-${PROVIDER}`), 'platform_absorbed:DelegateIsRevoked'],
    );
  }

  /**
   * A terminal call that never reserved money: an unfunded keyed call is moved
   * `CREATED → EXPIRED` with no hold (`mcp-tool-call.service.ts`). Written with
   * SQL, since only the status and the missing hold matter here.
   */
  async function neverReserved(toolId: string, status: 'EXPIRED' | 'REFUNDED'): Promise<void> {
    const intent = await context.createIntent({
      agentAccount: context.account(`buyer-${randomUUID()}`),
      toolId,
      priceAtomic: PRICE,
    });
    await context.dataSource.query(
      `UPDATE payment_intents SET status = $2, provider_id = $3 WHERE id = $1 AND hold_id IS NULL`,
      [intent.id, status, PROVIDER],
    );
  }

  it('counts forfeited, voided-debt and absorbed calls in both, and owed calls in neither', async () => {
    await context.reset();
    const TOOL = randomUUID();

    await settledAs(await call(TOOL, 'SETTLED'), 'COLLECTED'); // charged
    await call(TOOL, 'REFUNDED');
    await call(TOOL, 'VOIDED');
    await call(TOOL, 'VOIDED');
    await settledAs(await call(TOOL, 'SETTLED'), 'FORFEITED');
    await settledAs(await call(TOOL, 'SETTLED'), 'VOIDED_REFUND');
    await settledAs(await call(TOOL, 'SETTLED'), 'VOIDED_VOID');
    await absorbed(await call(TOOL, 'SETTLED'));
    await settledAs(await call(TOOL, 'SETTLED'), 'OPEN_DEBT'); // owed
    await settledAs(await call(TOOL, 'SETTLED'), 'WRITTEN_OFF'); // still owed
    await settledAs(await call(TOOL, 'SETTLED'), 'DISPUTE_UPHELD'); // refunded by a report
    // Never reserved: in neither figure, and not even in listed (B1 review I1).
    await neverReserved(TOOL, 'EXPIRED');
    await neverReserved(TOOL, 'REFUNDED');

    const window = {
      from: new Date(Date.now() - 2 * DAY_MS),
      to: new Date(Date.now() + 2 * DAY_MS),
    };
    const summary = await context.repository.summarizeReceipts(
      context.organizationId,
      ReceiptsSummaryGroupBy.TOOL,
      window,
    );
    const withheld = await context.repository.sumWithheldByAssetAndStatus(
      context.organizationId,
      window,
    );

    expect(summary).toHaveLength(1);
    const totals = summary[0];
    expect(totals.calls).toBe(11);
    expect(totals.listedTotal).toBe(11n * PRICE);
    expect(totals.notChargedCalls).toBe(8);
    expect(totals.notChargedTotal).toBe(8n * PRICE);
    expect(totals.owedCalls).toBe(2);

    const withheldCalls = withheld.reduce((total, row) => total + row.calls, 0);
    const withheldAmount = withheld.reduce((total, row) => total + row.amount, 0n);
    expect(withheldCalls).toBe(totals.notChargedCalls);
    expect(withheldAmount).toBe(totals.notChargedTotal);

    const byStatus = new Map(withheld.map((row) => [row.status, row]));
    expect(byStatus.get('REFUNDED')).toMatchObject({ calls: 1, notCollected: false });
    expect(byStatus.get('VOIDED')).toMatchObject({ calls: 2, notCollected: false });
    expect(byStatus.get('SETTLED')).toMatchObject({ calls: 5, notCollected: true });
  });

  /**
   * Wave-1 audit M4: the summary drops every hold-less REFUNDED / VOIDED /
   * EXPIRED intent. No call that ran is among them: a hold must reserve a
   * non-zero amount, so a zero-price intent never secures funds and never runs
   * (it can only go CREATED → EXPIRED), and every edge into REFUNDED or VOIDED
   * starts after FUNDS_SECURED, which writes the hold. Free-tier calls are
   * `tool_call_records`, not intents. A zero-price row that did settle still
   * counts in `calls` and `freeCalls`.
   */
  it('drops no zero-price call that ran: a zero-price intent cannot secure funds', async () => {
    await context.reset();
    const TOOL = randomUUID();
    const account = context.account(`buyer-${randomUUID()}`);
    await context.fund(account, 10_000_000n);

    const free = await context.createIntent({
      agentAccount: account,
      toolId: TOOL,
      priceAtomic: 0n,
    });
    await expect(context.intents.secureFunds(context.organizationId, free.id)).rejects.toThrow();
    const [row] = (await context.dataSource.query(
      `SELECT status, hold_id FROM payment_intents WHERE id = $1`,
      [free.id],
    )) as { status: string; hold_id: string | null }[];
    expect(row).toEqual({ status: 'CREATED', hold_id: null });

    // A zero-price row settled without a hold (as a free intent is recorded).
    const settled = await context.createIntent({
      agentAccount: account,
      toolId: TOOL,
      priceAtomic: 0n,
    });
    await context.dataSource.query(
      `UPDATE payment_intents SET status = 'SETTLED', provider_id = $2, provider_account = $3
        WHERE id = $1`,
      [settled.id, PROVIDER, context.account(`provider-${PROVIDER}`)],
    );

    const [totals] = await context.repository.summarizeReceipts(
      context.organizationId,
      ReceiptsSummaryGroupBy.TOOL,
      { from: new Date(Date.now() - DAY_MS), to: new Date(Date.now() + DAY_MS) },
    );
    // The CREATED one is in progress, the settled one free: both counted.
    expect(totals).toMatchObject({ calls: 2, freeCalls: 2, inProgressCalls: 1 });
  });

  /**
   * The same calls with their holds really released, the way the services do
   * it, so `ok` is proven against the journal rather than a mock: a forfeit and
   * a voided debt release the buyer's hold, and the release must be explained.
   */
  it('reconciles against real HOLD_RELEASE entries for forfeited and voided-debt calls', async () => {
    await context.reset();
    const TOOL = randomUUID();
    const { organizationId } = context;

    await call(TOOL, 'REFUNDED');
    await call(TOOL, 'VOIDED');
    await call(TOOL, 'SETTLED'); // rail B, awaiting redemption: hold still open

    const forfeited = await call(TOOL, 'SETTLED');
    const forfeitedIntent = await context.intents.findById(organizationId, forfeited);
    await context.intents.releaseHold({
      organizationId,
      id: forfeited,
      holdId: forfeitedIntent.holdId as string,
    });
    await context.dataSource.query(
      `UPDATE payment_intents SET redemption_last_error = 'provider_forfeit:ProviderBelowMinimumStake' WHERE id = $1`,
      [forfeited],
    );

    const upheld = await call(TOOL, 'SETTLED');
    await context.dataSource.query(
      `UPDATE payment_intents SET redemption_lapsed_at = now() WHERE id = $1`,
      [upheld],
    );
    expect(await context.intents.voidDebt(organizationId, upheld, 'DISPUTE_UPHELD')).toBe(true);

    const service = new LedgerWithheldService(
      new LedgerEntryRepository(context.dataSource),
      context.repository,
    );
    const zero = context.usdc(0n);
    const reconciliation = await service.reconcile(organizationId, zero.asset, zero.decimals);

    expect(reconciliation.holdReleaseTotal.amount).toBe((4n * PRICE).toString());
    expect(reconciliation.withheld.calls).toBe(4);
    const notCollected = reconciliation.withheld.buckets.find(
      (bucket) => bucket.bucket === WithheldBucket.NOT_COLLECTED,
    );
    expect(notCollected).toMatchObject({ calls: 2, amount: { amount: (2n * PRICE).toString() } });
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.difference).toBe('0');
  });
});
