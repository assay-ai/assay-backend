import { randomUUID } from 'node:crypto';

import { NotChargedWindow } from '@database/postgres/repositories/payment-intent.repository';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { WithheldTestContext, createWithheldTestContext } from '../helpers/withheld-test-context';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The public "not charged" queries against real Postgres: the SQL that feeds
 * an unauthenticated route, so the projection and the buyer-eligibility rule
 * are checked where they are computed, not only against a mock.
 *
 * The test database is shared with other suites and keeps its rows, so every
 * row assertion is scoped to tool ids minted here, and the platform-wide
 * totals are compared as a before/after delta.
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

  /** A fresh buyer organization, registered `ageDays` ago. */
  async function buyer(ageDays: number): Promise<string> {
    await context.reset();
    await context.dataSource.query(
      `INSERT INTO organizations (id, name, created_at) VALUES ($1, 'buyer', $2)`,
      [context.organizationId, new Date(Date.now() - ageDays * DAY_MS)],
    );
    return context.organizationId;
  }

  /** One paid call by the CURRENT organization, driven to `outcome`. */
  async function call(toolId: string, outcome: 'REFUNDED' | 'VOIDED' | 'SETTLED'): Promise<void> {
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

  it('reads only eligible buyers, selects no identifier, and totals the window', async () => {
    // Wide on both sides: this context's schema predates the `timestamptz`
    // migration, so `created_at` is a local wall-clock time and a tight window
    // would depend on the host's time zone. The 24 h delay and the complete-day
    // cut are the service's, tested in its unit spec.
    const window: NotChargedWindow = {
      from: new Date(Date.now() - 2 * DAY_MS),
      to: new Date(Date.now() + 2 * DAY_MS),
      buyerCreatedBefore: new Date(Date.now() - 7 * DAY_MS),
    };
    const before = await context.repository.summarizeNotCharged(window);

    const TOOL = randomUUID();
    // Three eligible buyers: old enough, and each with a charged paid call.
    for (let i = 0; i < 3; i += 1) {
      await buyer(10);
      await call(TOOL, 'SETTLED');
      await call(TOOL, 'REFUNDED');
    }
    // A sybil: brand new, though it has a charged call.
    await buyer(0);
    await call(TOOL, 'SETTLED');
    await call(TOOL, 'REFUNDED');
    // An old organization that has never been charged.
    await buyer(30);
    await call(TOOL, 'VOIDED');

    const rows = (await context.repository.findNotChargedCandidates(window, 500)).filter(
      (row) => row.toolId === TOOL,
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.buyer)).size).toBe(3);
    expect(rows.every((row) => /^[0-9a-f]{32}$/.test(row.buyer))).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'asset',
      'buyer',
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

    const after = await context.repository.summarizeNotCharged(window);
    const sum = (
      list: typeof after,
      key: 'calls' | 'notChargedCalls' | 'failedCheckCalls' | 'buyers',
    ) => list.reduce((total, row) => total + row[key], 0);
    const amount = (list: typeof after) =>
      list.reduce((total, row) => total + row.notChargedAmount, 0n);

    // Totals count every paid call; only the buyer count is eligibility-gated.
    expect(sum(after, 'calls') - sum(before, 'calls')).toBe(9);
    expect(sum(after, 'notChargedCalls') - sum(before, 'notChargedCalls')).toBe(5);
    expect(sum(after, 'failedCheckCalls') - sum(before, 'failedCheckCalls')).toBe(4);
    expect(amount(after) - amount(before)).toBe(5n * 250_000n);
    expect(sum(after, 'buyers') - sum(before, 'buyers')).toBe(3);
  });
});
