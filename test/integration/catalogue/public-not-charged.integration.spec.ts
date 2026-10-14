import { randomUUID } from 'node:crypto';

import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { WithheldTestContext, createWithheldTestContext } from '../helpers/withheld-test-context';

/**
 * The public "not charged" queries against real Postgres: the SQL that feeds
 * an unauthenticated route, so the projection and the k-anonymity counts are
 * checked where they are computed, not only against a mock.
 *
 * The test database is shared with other suites and keeps its rows, so every
 * assertion is scoped to tool ids minted here, and the platform-wide totals
 * are compared as a before/after delta.
 */
describe('PaymentIntentRepository — the public not-charged feed', () => {
  let context: WithheldTestContext;
  const PROVIDER = randomUUID();

  beforeAll(async () => {
    context = await createWithheldTestContext();
  });

  afterAll(async () => {
    await context?.close();
  });

  /** One paid call by a fresh buyer organization, driven to `outcome`. */
  async function call(toolId: string, outcome: 'REFUNDED' | 'VOIDED' | 'SETTLED'): Promise<void> {
    await context.reset();
    const { organizationId } = context;
    const account = context.account(`buyer-${randomUUID()}`);
    await context.fund(account, 10_000_000n);

    const intent = await context.createIntent({
      agentAccount: account,
      toolId,
      priceAtomic: 250_000n,
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
      return;
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
  }

  it('counts buyers per tool, lists only the tools asked for, and selects no identifier', async () => {
    // A day back, not a minute: this context's schema predates the
    // `timestamptz` migration, so `created_at` is a local wall-clock time and
    // a tight window would depend on the host's time zone.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const before = await context.repository.summarizeNotCharged(since);

    const BUSY = randomUUID();
    const RARE = randomUUID();
    for (let i = 0; i < 5; i += 1) await call(BUSY, 'REFUNDED');
    await call(BUSY, 'SETTLED');
    await call(RARE, 'VOIDED');

    const buyers = await context.repository.countNotChargedBuyersByTool(since);
    expect(buyers.find((row) => row.toolId === BUSY)).toEqual({ toolId: BUSY, buyers: 5 });
    expect(buyers.find((row) => row.toolId === RARE)).toEqual({ toolId: RARE, buyers: 1 });

    const rows = await context.repository.findRecentNotCharged(since, 50, [BUSY]);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.toolId === BUSY)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'asset',
      'classification',
      'createdAt',
      'decimals',
      'priceAmount',
      'providerId',
      'status',
      'toolId',
      'verificationVerdict',
    ]);
    expect(rows[0]).toMatchObject({
      status: 'REFUNDED',
      priceAmount: 250_000n,
      providerId: PROVIDER,
    });
    expect(await context.repository.findRecentNotCharged(since, 50, [])).toEqual([]);

    const after = await context.repository.summarizeNotCharged(since);
    const delta = (key: 'calls' | 'notChargedCalls' | 'failedCheckCalls') =>
      after.reduce((sum, row) => sum + row[key], 0) -
      before.reduce((sum, row) => sum + row[key], 0);
    const amount = (rows: typeof after) =>
      rows.reduce((sum, row) => sum + row.notChargedAmount, 0n);

    expect(delta('calls')).toBe(7);
    expect(delta('notChargedCalls')).toBe(6);
    expect(delta('failedCheckCalls')).toBe(5);
    expect(amount(after) - amount(before)).toBe(6n * 250_000n);
  });
});
