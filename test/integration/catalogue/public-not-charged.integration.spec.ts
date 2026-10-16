import { randomUUID } from 'node:crypto';

import { NotChargedWindow } from '@database/postgres/repositories/payment-intent.repository';
import { notChargedReason } from '@modules/catalogue/domain/not-charged-reason';
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
  async function call(toolId: string, outcome: 'REFUNDED' | 'VOIDED' | 'SETTLED'): Promise<string> {
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

  /**
   * Puts a SETTLED row into one of main's buyer-debt / forfeit states, the way
   * `VoucherRedemptionService` and `PaymentIntentService` leave it: the
   * columns only, since the feed reads nothing else. `releasedAt` is when the
   * hold was released (the outcome time); `now()` by default.
   */
  async function collection(
    intentId: string,
    state: 'FORFEITED' | 'OPEN_DEBT' | 'WRITTEN_OFF' | 'VOIDED_REFUND' | 'VOIDED_VOID',
    releasedAt: Date | null = null,
  ): Promise<void> {
    const lapsed = state !== 'FORFEITED';
    const released = state !== 'OPEN_DEBT';
    const cause = {
      FORFEITED: 'provider_forfeit:ProviderBelowMinimumStake',
      OPEN_DEBT: 'DelegateIsRevoked',
      WRITTEN_OFF: 'uncollected:DelegateIsRevoked',
      VOIDED_REFUND: 'voided:REFUND',
      VOIDED_VOID: 'voided:VOID',
    }[state];
    await context.dataSource.query(
      `UPDATE payment_intents
          SET redemption_last_error = $2,
              redemption_lapsed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
              hold_released_at = CASE WHEN $4::boolean THEN COALESCE($5::timestamptz, now())
                                      ELSE NULL END
        WHERE id = $1`,
      [intentId, cause, lapsed, released, releasedAt],
    );
  }

  /**
   * A rail-B SETTLED row whose voucher was redeemed: `commitRedeemedHold`
   * commits the hold and stamps `hold_released_at`. Until then the call is
   * awaiting redemption and could still lapse into debt.
   */
  async function collected(intentId: string, at: Date | null = null): Promise<string> {
    await context.dataSource.query(
      `UPDATE payment_intents SET hold_released_at = COALESCE($2::timestamptz, now()) WHERE id = $1`,
      [intentId, at],
    );
    return intentId;
  }

  /** A paid call by the current organization that was served and collected. */
  async function paidCall(toolId: string, at: Date | null = null): Promise<string> {
    return collected(await call(toolId, 'SETTLED'), at);
  }

  /** Wide on every side; see the first case. */
  function wideWindow(): NotChargedWindow {
    return {
      from: new Date(Date.now() - 10 * DAY_MS),
      to: new Date(Date.now() + 2 * DAY_MS),
      outcomeBefore: new Date(Date.now() + 2 * DAY_MS),
      buyerCreatedBefore: new Date(Date.now() - 7 * DAY_MS),
      buyerCollectedBefore: new Date(Date.now() + 2 * DAY_MS),
    };
  }

  const sum = (
    list: Awaited<ReturnType<WithheldTestContext['repository']['summarizeNotCharged']>>,
    key: 'calls' | 'notChargedCalls' | 'failedCheckCalls' | 'buyers',
  ) => list.reduce((total, row) => total + row[key], 0);

  async function rowsOf(window: NotChargedWindow, toolId: string) {
    return (await context.repository.findNotChargedCandidates(window, 500)).filter(
      (row) => row.toolId === toolId,
    );
  }

  it('reads only eligible buyers, selects no identifier, and totals the window', async () => {
    // Wide on both sides: this context's schema predates the `timestamptz`
    // migration, so `created_at` is a local wall-clock time and a tight window
    // would depend on the host's time zone. The 24 h delay and the complete-day
    // cut are the service's, tested in its unit spec.
    const window = wideWindow();
    const before = await context.repository.summarizeNotCharged(window);

    const TOOL = randomUUID();
    // Three eligible buyers: old enough, and each with a collected paid call.
    for (let i = 0; i < 3; i += 1) {
      await buyer(10);
      await paidCall(TOOL);
      await call(TOOL, 'REFUNDED');
    }
    // A sybil: brand new, though it has a collected call.
    await buyer(0);
    await paidCall(TOOL);
    await call(TOOL, 'REFUNDED');
    // An old organization that has never been charged.
    await buyer(30);
    await call(TOOL, 'VOIDED');

    const rows = await rowsOf(window, TOOL);

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
      'settledCause',
      'status',
      'toolId',
      'verificationVerdict',
    ]);
    expect(rows[0]).toMatchObject({
      status: 'REFUNDED',
      settledCause: null,
      priceAmount: 250_000n,
      providerId: PROVIDER,
    });

    const after = await context.repository.summarizeNotCharged(window);
    const amount = (list: typeof after) =>
      list.reduce((total, row) => total + row.notChargedAmount, 0n);

    // Every figure counts eligible buyers only, the population k is counted on
    // (audit P3-1): the sybil's and the never-charged organization's calls are
    // in none of them.
    expect(sum(after, 'calls') - sum(before, 'calls')).toBe(6);
    expect(sum(after, 'notChargedCalls') - sum(before, 'notChargedCalls')).toBe(3);
    expect(sum(after, 'failedCheckCalls') - sum(before, 'failedCheckCalls')).toBe(3);
    expect(amount(after) - amount(before)).toBe(3n * 250_000n);
    expect(sum(after, 'buyers') - sum(before, 'buyers')).toBe(3);
  });

  it('lists a forfeited or voided-debt call as not charged, never an owed one', async () => {
    const window = wideWindow();
    const before = await context.repository.summarizeNotCharged(window);

    const TOOL = randomUUID();
    // One eligible buyer (a collected call) with one call in every collection state.
    await buyer(10);
    await paidCall(TOOL);
    await collection(await call(TOOL, 'SETTLED'), 'FORFEITED');
    await collection(await call(TOOL, 'SETTLED'), 'VOIDED_REFUND');
    await collection(await call(TOOL, 'SETTLED'), 'VOIDED_VOID');
    await collection(await call(TOOL, 'SETTLED'), 'OPEN_DEBT');
    await collection(await call(TOOL, 'SETTLED'), 'WRITTEN_OFF');
    // Served, voucher not redeemed yet: not final, so not counted either.
    await call(TOOL, 'SETTLED');

    // An old organization whose only served calls became buyer debt: it never
    // paid, so it is not an eligible buyer and its refund is not read.
    await buyer(30);
    await collection(await call(TOOL, 'SETTLED'), 'OPEN_DEBT');
    await collection(await call(TOOL, 'SETTLED'), 'WRITTEN_OFF');
    await call(TOOL, 'REFUNDED');

    const rows = await rowsOf(window, TOOL);
    expect(rows.map((row) => `${row.status}:${row.settledCause}`).sort()).toEqual([
      'SETTLED:FORFEITED',
      'SETTLED:VOIDED_REFUND',
      'SETTLED:VOIDED_VOID',
    ]);

    const after = await context.repository.summarizeNotCharged(window);

    // Final calls of the eligible buyer: collected + forfeited + two voided
    // debts. The open debt, the written-off debt and the call awaiting
    // redemption can still change, so they are in no figure — debt state is
    // never readable from the totals.
    expect(sum(after, 'calls') - sum(before, 'calls')).toBe(4);
    expect(sum(after, 'notChargedCalls') - sum(before, 'notChargedCalls')).toBe(3);
    expect(sum(after, 'failedCheckCalls') - sum(before, 'failedCheckCalls')).toBe(1);
    expect(sum(after, 'buyers') - sum(before, 'buyers')).toBe(1);
  });

  /**
   * Audit P2-2: eligibility only ever goes forwards. A buyer counts on a
   * COLLECTED call, which nothing can reverse; a call still awaiting
   * redemption does not count, so its later lapse into debt cannot drop a
   * buyer and flip a tool or asset across k.
   */
  it('counts a buyer on a collected call only, so a later debt never drops it', async () => {
    const window = wideWindow();

    // A: its only paid call is awaiting redemption. Not eligible.
    const TOOL_A = randomUUID();
    await buyer(10);
    const awaiting = await call(TOOL_A, 'SETTLED');
    await call(TOOL_A, 'REFUNDED');
    expect(await rowsOf(window, TOOL_A)).toHaveLength(0);
    // ...and still not eligible after that call lapses into debt: no flip.
    await collection(awaiting, 'OPEN_DEBT');
    expect(await rowsOf(window, TOOL_A)).toHaveLength(0);

    // B: one collected call. Eligible, and stays eligible when a later call
    // lapses into debt and is then written off.
    const TOOL_B = randomUUID();
    await buyer(10);
    await paidCall(TOOL_B);
    await call(TOOL_B, 'REFUNDED');
    expect(await rowsOf(window, TOOL_B)).toHaveLength(1);
    const later = await call(TOOL_B, 'SETTLED');
    await collection(later, 'OPEN_DEBT');
    expect(await rowsOf(window, TOOL_B)).toHaveLength(1);
    await collection(later, 'WRITTEN_OFF');
    expect(await rowsOf(window, TOOL_B)).toHaveLength(1);

    // C: a collected call, but collected after the caller's cut-off.
    const TOOL_C = randomUUID();
    await buyer(10);
    await paidCall(TOOL_C, new Date(Date.now() + DAY_MS));
    await call(TOOL_C, 'REFUNDED');
    expect(await rowsOf({ ...window, buyerCollectedBefore: new Date() }, TOOL_C)).toHaveLength(0);
    expect(await rowsOf(window, TOOL_C)).toHaveLength(1);
  });

  /**
   * Audit P2-3: the window is on the OUTCOME as well as the call. A debt on an
   * old call voided "now" must not move today's totals or appear in the rows
   * until the outcome itself passes the cut-off.
   */
  it('counts an outcome only once it is older than the cut-off', async () => {
    const TOOL = randomUUID();
    await buyer(10);
    await paidCall(TOOL, new Date(Date.now() - 3 * DAY_MS));
    const old = await call(TOOL, 'SETTLED');
    await context.dataSource.query(
      `UPDATE payment_intents SET created_at = created_at - interval '5 days' WHERE id = $1`,
      [old],
    );

    // "Today" started an hour ago; rows must be resolved a day ago.
    const today = new Date(Date.now() - 60 * 60 * 1000);
    const totalsWindow: NotChargedWindow = {
      ...wideWindow(),
      outcomeBefore: today,
      buyerCollectedBefore: today,
    };
    const rowsWindow: NotChargedWindow = {
      ...wideWindow(),
      outcomeBefore: new Date(Date.now() - DAY_MS),
      buyerCollectedBefore: new Date(Date.now() - DAY_MS),
    };

    const before = await context.repository.summarizeNotCharged(totalsWindow);
    await collection(old, 'VOIDED_VOID'); // voided now
    const after = await context.repository.summarizeNotCharged(totalsWindow);

    expect(sum(after, 'calls')).toBe(sum(before, 'calls'));
    expect(sum(after, 'notChargedCalls')).toBe(sum(before, 'notChargedCalls'));
    expect(await rowsOf(rowsWindow, TOOL)).toHaveLength(0);

    // Once the outcome is older than both cut-offs, it is counted and listed.
    await collection(old, 'VOIDED_VOID', new Date(Date.now() - 2 * DAY_MS));
    const later = await context.repository.summarizeNotCharged(totalsWindow);
    expect(sum(later, 'calls') - sum(before, 'calls')).toBe(1);
    expect(sum(later, 'notChargedCalls') - sum(before, 'notChargedCalls')).toBe(1);
    expect(await rowsOf(rowsWindow, TOOL)).toHaveLength(1);
  });

  /**
   * The reason split is computed in SQL; it must give each call the same
   * reason the feed's rows get from `notChargedReason()`, never count a call
   * that failed the check, and add up to `notChargedCalls − failedCheckCalls`.
   */
  it('splits not-charged calls by the same reason the rows carry', async () => {
    const window = wideWindow();
    const reasonsBefore = await context.repository.summarizeNotChargedReasons(window);
    const totalsBefore = await context.repository.summarizeNotCharged(window);

    const TOOL = randomUUID();
    await buyer(10);
    await paidCall(TOOL);
    await call(TOOL, 'REFUNDED');
    await call(TOOL, 'VOIDED');
    await call(TOOL, 'VOIDED');
    await collection(await call(TOOL, 'SETTLED'), 'FORFEITED');
    await collection(await call(TOOL, 'SETTLED'), 'VOIDED_VOID');
    await collection(await call(TOOL, 'SETTLED'), 'VOIDED_REFUND');
    // Owed, never counted.
    await collection(await call(TOOL, 'SETTLED'), 'WRITTEN_OFF');

    const reasonsAfter = await context.repository.summarizeNotChargedReasons(window);
    const totalsAfter = await context.repository.summarizeNotCharged(window);

    const byReason = (list: typeof reasonsAfter) => {
      const map = new Map<string, number>();
      for (const r of list) map.set(r.reason, (map.get(r.reason) ?? 0) + r.calls);
      return map;
    };
    const before = byReason(reasonsBefore);
    const after = byReason(reasonsAfter);
    const delta = new Map(
      [...after].map(([reason, calls]) => [reason, calls - (before.get(reason) ?? 0)]),
    );
    const expected = new Map<string, number>();
    for (const row of await rowsOf(window, TOOL)) {
      const outcome = notChargedReason(row);
      if (!outcome || outcome.reason === 'FAILED_CHECK') continue;
      expected.set(outcome.reason, (expected.get(outcome.reason) ?? 0) + 1);
    }

    expect(expected).toEqual(
      new Map([
        ['NO_USABLE_RESULT', 2],
        ['NOT_COLLECTED', 2],
      ]),
    );
    for (const [reason, calls] of expected) expect(delta.get(reason)).toBe(calls);
    expect(delta.get('FAILED_CHECK')).toBeUndefined();
    expect([...delta.values()].reduce((a, b) => a + b, 0)).toBe(4);

    // Platform-wide, the cells add up to the totals' not-charged minus failed check.
    const cells = reasonsAfter.reduce((total, row) => total + row.calls, 0);
    expect(cells).toBe(sum(totalsAfter, 'notChargedCalls') - sum(totalsAfter, 'failedCheckCalls'));
    expect(sum(totalsAfter, 'notChargedCalls') - sum(totalsBefore, 'notChargedCalls')).toBe(6);
    // Buyers are counted per cell: one buyer here.
    const mine = reasonsAfter.filter((row) => row.reason === 'NOT_COLLECTED');
    const mineBefore = reasonsBefore.filter((row) => row.reason === 'NOT_COLLECTED');
    expect(
      mine.reduce((t, r) => t + r.buyers, 0) - mineBefore.reduce((t, r) => t + r.buyers, 0),
    ).toBe(1);
  });
  /**
   * Every reason the split can name, each driven through the columns the feed
   * reads, plus a legacy absorb: a SETTLED row with a `platform_absorbed:`
   * credit and a NULL `redemption_last_error`. That NULL once made the
   * failed-check test NULL, so the row fell out of the split and the cells
   * stopped adding up to the totals.
   */
  it('gives every reason, and a legacy absorb, the reason the rows carry', async () => {
    const window = wideWindow();
    const reasonsBefore = await context.repository.summarizeNotChargedReasons(window);
    const totalsBefore = await context.repository.summarizeNotCharged(window);

    const TOOL = randomUUID();
    await buyer(10);
    await paidCall(TOOL);

    const set = (id: string, columns: string) =>
      context.dataSource.query(`UPDATE payment_intents SET ${columns} WHERE id = $1`, [id]);
    await set(await call(TOOL, 'VOIDED'), `classification = 'SYSTEM_ERROR'`);
    await set(await call(TOOL, 'VOIDED'), `classification = 'REQUEST_ERROR'`);
    await set(
      await call(TOOL, 'VOIDED'),
      `classification = 'DATA_RESULT', verification_verdict = 'MISAPPLIED'`,
    );
    await call(TOOL, 'VOIDED');
    await set(await call(TOOL, 'VOIDED'), `status = 'EXPIRED', classification = NULL`);

    const absorbed = await collected(await call(TOOL, 'SETTLED'));
    await set(absorbed, `redemption_last_error = NULL`);
    await context.dataSource.query(
      `INSERT INTO ledger_entries
         (organization_id, account_id, entry_type, amount, asset_id, decimals, intent_id, chain_tx_ref)
       SELECT provider_id, $2, 'PROVIDER_CREDIT', price_amount, asset_id, decimals, id, $3
         FROM payment_intents WHERE id = $1`,
      [absorbed, context.account(`provider-${PROVIDER}`), `platform_absorbed:${randomUUID()}`],
    );

    const reasonsAfter = await context.repository.summarizeNotChargedReasons(window);
    const totalsAfter = await context.repository.summarizeNotCharged(window);

    const byReason = (list: typeof reasonsAfter) => {
      const map = new Map<string, number>();
      for (const r of list) map.set(r.reason, (map.get(r.reason) ?? 0) + r.calls);
      return map;
    };
    const before = byReason(reasonsBefore);
    const delta = new Map(
      [...byReason(reasonsAfter)]
        .map(([reason, calls]) => [reason, calls - (before.get(reason) ?? 0)] as const)
        .filter(([, calls]) => calls !== 0),
    );

    const rows = await rowsOf(window, TOOL);
    expect(rows.find((row) => row.status === 'SETTLED')?.settledCause).toBe('ABSORBED');
    const expected = new Map<string, number>();
    for (const row of rows) {
      const outcome = notChargedReason(row);
      if (!outcome || outcome.reason === 'FAILED_CHECK') continue;
      expected.set(outcome.reason, (expected.get(outcome.reason) ?? 0) + 1);
    }

    const one = (reason: string) => [reason, 1] as const;
    expect(expected).toEqual(
      new Map([
        one('PROVIDER_ERROR'),
        one('REQUEST_REJECTED'),
        one('OUT_OF_SCOPE'),
        one('NO_USABLE_RESULT'),
        one('EXPIRED'),
        one('NOT_COLLECTED'),
      ]),
    );
    expect(delta).toEqual(expected);

    // The absorb is not a failed check, and every cell still adds up.
    expect(sum(totalsAfter, 'notChargedCalls') - sum(totalsBefore, 'notChargedCalls')).toBe(6);
    expect(sum(totalsAfter, 'failedCheckCalls') - sum(totalsBefore, 'failedCheckCalls')).toBe(0);
    const cells = reasonsAfter.reduce((total, row) => total + row.calls, 0);
    expect(cells).toBe(sum(totalsAfter, 'notChargedCalls') - sum(totalsAfter, 'failedCheckCalls'));
  });
});
