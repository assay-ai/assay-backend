import { randomUUID } from 'node:crypto';

import { ReceiptsSummaryGroupBy } from '@database/postgres/repositories/payment-intent.repository';
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
      | 'VOIDED_VOID',
  ): Promise<void> {
    const cause = {
      COLLECTED: null,
      FORFEITED: 'provider_forfeit:ProviderBelowMinimumStake',
      OPEN_DEBT: 'DelegateIsRevoked',
      WRITTEN_OFF: 'uncollected:DelegateIsRevoked',
      VOIDED_REFUND: 'voided:REFUND',
      VOIDED_VOID: 'voided:VOID',
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
    expect(totals.calls).toBe(10);
    expect(totals.notChargedCalls).toBe(7);
    expect(totals.notChargedTotal).toBe(7n * PRICE);
    expect(totals.owedCalls).toBe(2);

    const withheldCalls = withheld.reduce((total, row) => total + row.calls, 0);
    const withheldAmount = withheld.reduce((total, row) => total + row.amount, 0n);
    expect(withheldCalls).toBe(totals.notChargedCalls);
    expect(withheldAmount).toBe(totals.notChargedTotal);

    const byStatus = new Map(withheld.map((row) => [row.status, row]));
    expect(byStatus.get('REFUNDED')).toMatchObject({ calls: 1, notCollected: false });
    expect(byStatus.get('VOIDED')).toMatchObject({ calls: 2, notCollected: false });
    expect(byStatus.get('SETTLED')).toMatchObject({ calls: 4, notCollected: true });
  });
});
