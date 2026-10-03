import { randomUUID } from 'node:crypto';

import { INTERNAL_ACCOUNTS } from '@modules/ledger/ports/ledger.types';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  PaymentIntent,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { BaseError } from '@shared/errors/base.error';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  PaymentTestContext,
  USDC_ASSET,
  createPaymentTestContext,
} from '../helpers/payment-test-context';

/**
 * A rail-A intent may not reach a paying state without naming **where**
 * the money goes, and the database is what says so.
 *
 * ## Why this file is integration and not unit
 *
 * `chk_payment_intents_settled_names_payee` is a Postgres CHECK. The payment
 * unit harnesses are in-memory `Map`s where a CHECK constraint does not exist,
 * so a unit test asserting "the row cannot be written" would be asserting
 * something about a fake. Every claim below is a claim about the real schema.
 *
 * It is also the harness that could not have caught the original defect: it
 * used to omit `RoutedPaymentIntents1755600000000`, so
 * `provider_id` and `provider_account` were still `NOT NULL` here. An intent
 * with no payee could not be inserted at all, and the guard in
 * `PaymentIntentService.resolve()` was unreachable from this file.
 */
describe('rail-A payment intents must name a payee', () => {
  let context: PaymentTestContext;

  beforeAll(async () => {
    context = await createPaymentTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  /** A rail-A intent as `McpToolCallService` creates one: no provider, no binding. */
  async function unroutedIntent(label: string): Promise<PaymentIntent> {
    return context.createIntent(label, {
      rail: PaymentRail.RAIL_A_PER_CALL,
      // Rail A's replay guard is on-chain; a nonce here would be refused by
      // `chk_payment_intents_voucher_nonce_rail`.
      voucherNonce: null,
      providerId: null,
      providerAccount: null,
      callId: randomUUID(),
    });
  }

  async function executing(label: string): Promise<PaymentIntent> {
    const intent = await unroutedIntent(label);
    await context.fund(intent.agentAccount, 5_000_000n);
    await context.intents.secureFunds(context.organizationId, intent.id);
    return context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
    );
  }

  it('creates and executes with no payee at all — that window is legitimate', async () => {
    const intent = await executing('rail-a-window');

    // The router has not run. The whole argument for dropping the two
    // `NOT NULL`s: there is genuinely nobody to name yet, and inventing one
    // would write a false statement about who is owed money.
    expect(intent.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
    expect(intent.providerId).toBeNull();
    expect(intent.providerAccount).toBeNull();
    expect(await context.held(intent.agentAccount)).toBe(1_000_000n);
  });

  it('REFUSES the move to VERIFYING when the transition names no payout account', async () => {
    const intent = await executing('rail-a-no-account');

    // This is the exact shape of the defect: `resolveDataResult` wrote
    // `providerId` and `bindingId` and no `providerAccount`, and nothing
    // anywhere objected. Postgres objects now.
    let thrown: unknown;
    try {
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        { providerId: context.id('rail-a-no-account:provider') },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    // `23514` — check_violation — naming the constraint, so a failure in
    // production says which rule was broken rather than "insert failed".
    expect((thrown as { code?: string }).code).toBe('23514');
    expect((thrown as { constraint?: string }).constraint).toBe(
      'chk_payment_intents_settled_names_payee',
    );

    // And the row did not move. A refused transition must not half-apply.
    const fresh = await context.intents.findById(context.organizationId, intent.id);
    expect(fresh.status).toBe(PaymentIntentStatus.PROVIDER_EXECUTING);
  });

  it('refuses a VERIFYING row that names an account but no provider, from the sibling CHECK', async () => {
    const intent = await executing('rail-a-half-payee');

    let thrown: unknown;
    try {
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        { providerAccount: context.account('rail-a-half-payee-provider') },
      );
    } catch (error) {
      thrown = error;
    }

    // Two constraints, two halves, and either one refusing is enough. Which
    // one fires is Postgres's choice; both are named here so the assertion does
    // not pin an evaluation order.
    expect((thrown as { code?: string }).code).toBe('23514');
    expect([
      'chk_payment_intents_paying_states_name_payee',
      'chk_payment_intents_payee_is_whole',
    ]).toContain((thrown as { constraint?: string }).constraint);
  });

  /**
   * **A provider is actually paid** — the ledger half, and only that half.
   *
   * What this proves: given a transition that names a payout account, the money
   * genuinely moves, against real Postgres and the real `commitHoldAndCredit`.
   * The agent's held balance goes to zero, the named account receives the
   * provider's share, and platform fees receive the remainder. That is a
   * stronger claim than "a field was set".
   *
   * What it does **not** prove, and must not be read as proving: that
   * `providers.payout_account_id` reaches that transition. `PaymentTestContext`
   * wires no `McpToolCallService` and no `ProviderRouterService` — the `payee`
   * below is a literal this test invented and handed to `intents.transition()`
   * directly. The threading half is proved in
   * `test/unit/mcp/mcp-tool-call.spec.ts`, against router fixtures.
   *
   * Two tests, two halves, neither end to end. The split follows the harness
   * boundary, but it is a real gap and worth naming rather than papering over:
   * nothing in this suite executes registry → router → intent → ledger in one
   * pass. Only a devnet run does.
   */
  it('settles a routed rail-A intent by crediting the account the transition named', async () => {
    const intent = await executing('rail-a-settles');
    // Unique per run. `reset()` rotates the AGENT's organization only, and the
    // ledger is append-only — a payee derived from a fixed label would carry
    // every earlier run's credits and the figure below would grow by 900,000
    // each time the file is executed.
    const run = randomUUID();
    const payee = context.account(`rail-a-settles-payee-${run}`);
    const providerOrg = context.id(`rail-a-settles:provider:${run}`);

    await context.intents.transition(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
      { providerId: providerOrg, providerAccount: payee },
    );

    const settled = await context.intents.resolve(
      context.organizationId,
      intent.id,
      PaymentIntentStatus.VERIFYING,
      PaymentIntentStatus.SETTLED,
    );

    expect(settled.status).toBe(PaymentIntentStatus.SETTLED);
    expect(settled.holdReleasedAt).not.toBeNull();

    // The agent paid: nothing held, and the price is gone from `available`.
    expect(await context.held(intent.agentAccount)).toBe(0n);
    expect(await context.available(intent.agentAccount)).toBe(4_000_000n);

    // The provider was paid — 1.000000 USDC less the 0.100000 platform fee that
    // `createIntent` splits out. Before the payee fix this figure was 0 for every rail-A
    // call on the platform.
    //
    // Read under the PROVIDER's organization, which is what
    // `commitHoldAndCredit` writes the credit against: `providerId` is the
    // provider organization (`providerId == organizationId`, the equivalence
    // the provider surface rests on), and reading it under the agent's org
    // would find nothing and look like a missing payment.
    const paid = await context.ledger.getBalance(providerOrg, payee, USDC_ASSET);
    expect(MoneyUtil.toAtomic(paid.available)).toBe(900_000n);

    // And the platform took its cut, on the same transaction.
    const fees = await context.ledger.getBalance(
      context.organizationId,
      INTERNAL_ACCOUNTS.PLATFORM_FEES,
      USDC_ASSET,
    );
    expect(MoneyUtil.toAtomic(fees.available)).toBe(100_000n);
  });

  it('is installed NOT VALID, so it binds new rows without asserting anything about old ones', async () => {
    const [row] = await context.dataSource.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'chk_payment_intents_settled_names_payee'`,
    );

    // The 4,879 stranded devnet rows are deliberately left alone: back-filling
    // `provider_account` would make them *assert* a payee that was never paid,
    // which is worse than an honest hole. `convalidated = false` is the record
    // of that decision, and running `VALIDATE CONSTRAINT` would fail on them.
    expect(row).toBeDefined();
    expect(row.convalidated).toBe(false);
  });

  it('still lets the guard in resolve() speak, for a row that predates the CHECK', async () => {
    // A `NOT VALID` constraint does not police rows written before it, so the
    // service-level guard is not redundant — it is what a legacy row hits.
    // Reproduced here by writing the state the constraint would refuse, with
    // the constraint temporarily out of the way.
    const intent = await executing('rail-a-legacy');

    await context.dataSource.query(
      `ALTER TABLE payment_intents DROP CONSTRAINT chk_payment_intents_settled_names_payee`,
    );

    let thrown: unknown;
    try {
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
        { providerId: context.id('rail-a-legacy:provider') },
      );

      await context.intents.resolve(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
      );
    } catch (error) {
      thrown = error;
    } finally {
      await context.dataSource.query(
        `ALTER TABLE payment_intents ADD CONSTRAINT chk_payment_intents_settled_names_payee ` +
          `CHECK (status NOT IN ('VERIFYING','SETTLED') OR provider_account IS NOT NULL) NOT VALID`,
      );
    }

    expect(thrown).toBeInstanceOf(BaseError);
    expect((thrown as BaseError).errorCode).toBe(PaymentErrorCode.PAYMENT_PROVIDER_NOT_ASSIGNED);
    // Nobody was credited, and the agent's money is still held — the honest,
    // findable hole rather than a payment to a made-up payee.
    expect(await context.held(intent.agentAccount)).toBe(1_000_000n);
  });
});
