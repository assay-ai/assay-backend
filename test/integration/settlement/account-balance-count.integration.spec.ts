import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { INTERNAL_ACCOUNTS, LedgerEntryType } from '@modules/ledger/ports/ledger.types';

import {
  SettlementTestContext,
  USDC_ASSET,
  createSettlementTestContext,
} from '../helpers/settlement-test-context';

/**
 * The `Accounts` tile of the proof-of-reserves page, against real rows.
 *
 * An **integration** test on purpose. This is a question about what a `WHERE`
 * clause selects out of `account_balances`, and the unit harness is an
 * in-memory `Map` that would answer whichever way the fake happened to be
 * written — a gate that answers a different question than the one it claims.
 */
describe('countFundedCustomerAccounts', () => {
  let context: SettlementTestContext;
  let balances: AccountBalanceRepository;

  beforeAll(async () => {
    context = await createSettlementTestContext();
    balances = new AccountBalanceRepository(context.dataSource);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('counts only customer accounts holding something', async () => {
    const funded = context.account('Funded11111111111111111111111111111111111');
    const drained = context.account('Drained1111111111111111111111111111111111');

    await context.fund(funded, 7_000_000n);

    // A real zero: funded, then withdrawn to nothing. The row still exists —
    // the journal refuses DELETE — so it is exactly the row the `> 0` clause
    // has to reject.
    await context.fund(drained, 3_000_000n);
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: drained,
      entryType: LedgerEntryType.WITHDRAWAL,
      money: context.usdc(3_000_000n),
    });

    // The case that matters. `platform:fees` is written under the *paying*
    // organization's id by `LedgerHoldService.commitHoldAndCredit`, so every
    // org that ever paid for a call has one. Counting it publishes a number of
    // "accounts" larger than the number of customers — the same defect class
    // as an earlier defect on this table.
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: INTERNAL_ACCOUNTS.PLATFORM_FEES,
      entryType: LedgerEntryType.PLATFORM_FEE,
      money: context.usdc(500_000n),
    });

    await expect(balances.countFundedCustomerAccounts(USDC_ASSET)).resolves.toBe(1);
  });

  it('counts the same account id once per organization that holds it', async () => {
    const shared = context.account('Shared11111111111111111111111111111111111');

    await context.fund(shared, 1_000_000n);
    const firstOrg = context.organizationId;
    context.organizationId = '11111111-2222-4333-8444-555555555555';
    await context.fund(shared, 2_000_000n);

    expect(context.organizationId).not.toBe(firstOrg);

    // `account_balances` is keyed `(organizationId, accountId, assetId)`, so
    // this is two rows and the tile says 2. `COUNT(DISTINCT account_id)` is one
    // word away and would say 1; the docstring on the method is what pins which
    // of the two numbers gets published.
    await expect(balances.countFundedCustomerAccounts(USDC_ASSET)).resolves.toBe(2);
  });

  it('is zero, not null, when the platform holds nothing in the asset', async () => {
    await expect(balances.countFundedCustomerAccounts(USDC_ASSET)).resolves.toBe(0);
  });
});
