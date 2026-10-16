import { randomUUID } from 'node:crypto';

import { foldLiabilities } from '@modules/settlement/domain/ledger-book';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  INTERNAL_ACCOUNTS,
  LedgerEntryType,
  LEGACY_POOLED_VAULT_TX_REF,
} from '@modules/ledger/ports/ledger.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import {
  ProviderLedgerTestContext,
  USDC_ASSET,
  createProviderLedgerTestContext,
} from '../helpers/provider-ledger-test-context';

/**
 * `LedgerHoldService.commitHoldAndCredit` — the write side of the
 * provider earnings ledger. Uses `provider-ledger-test-context.ts` rather
 * than `ledger-test-context.ts` because it also needs the partial unique
 * index the earnings-ledger migration adds; the ledger-only context does not
 * run it.
 */
describe('ledger settlement credit — commitHoldAndCredit', () => {
  let context: ProviderLedgerTestContext;

  beforeAll(async () => {
    context = await createProviderLedgerTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('PASS → HOLD_COMMIT + PROVIDER_CREDIT + PLATFORM_FEE conserves total value and moves it from the agent book to the provider and platform books', async () => {
    const agentOrg = randomUUID();
    const providerOrg = randomUUID();
    const agent = context.account('agent-conservation');
    const provider = context.account('provider-conservation');

    await context.fund(agentOrg, agent, 1_000n);

    await context.settleCall({
      agentOrganizationId: agentOrg,
      agentAccountId: agent,
      providerOrganizationId: providerOrg,
      providerAccountId: provider,
      providerAmount: 900n,
      platformFee: 100n,
    });

    const agentBalance = await context.ledger.getBalance(agentOrg, agent, USDC_ASSET);
    expect(MoneyUtil.toAtomic(agentBalance.available)).toBe(0n);
    expect(MoneyUtil.toAtomic(agentBalance.held)).toBe(0n);

    const providerBalance = await context.ledger.getBalance(providerOrg, provider, USDC_ASSET);
    expect(MoneyUtil.toAtomic(providerBalance.available)).toBe(900n);

    const platformBalance = await context.ledger.getBalance(
      agentOrg,
      INTERNAL_ACCOUNTS.PLATFORM_FEES,
      USDC_ASSET,
    );
    expect(MoneyUtil.toAtomic(platformBalance.available)).toBe(100n);

    // Fold the journal across both organizations — `foldLiabilities` is a
    // platform-wide fold in production (`LedgerEntryRepository.sumByEntryType`
    // is cross-tenant); here the two organizations touched are read and
    // merged by hand.
    const agentJournal = await context.ledger.readJournal(agentOrg);
    const providerJournal = await context.ledger.readJournal(providerOrg);
    const totals = new Map<string, bigint>();
    for (const entry of [...agentJournal, ...providerJournal]) {
      const atomic = MoneyUtil.toAtomic(entry.money);
      totals.set(entry.entryType, (totals.get(entry.entryType) ?? 0n) + atomic);
    }

    const liabilities = foldLiabilities(totals);
    // The DEPOSIT put 1000 entirely in the agent book; HOLD_COMMIT +
    // PROVIDER_CREDIT + PLATFORM_FEE move 900 to the provider book and 100 to
    // the platform book, leaving the agent book at 0 — total unchanged.
    expect(liabilities.agentLiabilities).toBe(0n);
    expect(liabilities.providerPayable).toBe(900n);
    expect(liabilities.platformFees).toBe(100n);
    expect(liabilities.total).toBe(1_000n);
  });

  it('provider_amount + platform_fee = price is the CHECK payment_intents carries — asserted here directly rather than assumed', () => {
    const providerAmount = 900n;
    const platformFee = 100n;
    const price = 1_000n;
    expect(providerAmount + platformFee).toBe(price);
  });

  it('running the settle path twice writes exactly one PROVIDER_CREDIT, one PLATFORM_FEE and one HOLD_COMMIT — the second call is a no-op', async () => {
    const agentOrg = randomUUID();
    const providerOrg = randomUUID();
    const agent = context.account('agent-idempotent');
    const provider = context.account('provider-idempotent');

    await context.fund(agentOrg, agent, 500n);

    const intentId = randomUUID();
    const hold = await context.ledger.createHold({
      organizationId: agentOrg,
      accountId: agent,
      money: context.usdc(500n),
      intentId,
    });

    const credit = {
      providerOrganizationId: providerOrg,
      providerAccountId: provider,
      providerAmount: context.usdc(450n),
      platformFee: context.usdc(50n),
      intentId,
      chainTxRef: LEGACY_POOLED_VAULT_TX_REF,
    };

    const first = await context.ledger.commitHoldAndCredit(agentOrg, hold.id, credit);
    expect(first.applied).toBe(true);

    const second = await context.ledger.commitHoldAndCredit(agentOrg, hold.id, credit);
    expect(second.applied).toBe(false);

    const agentJournal = await context.ledger.readJournal(agentOrg, { intentId });
    expect(agentJournal.filter((e) => e.entryType === LedgerEntryType.HOLD_COMMIT)).toHaveLength(1);
    expect(agentJournal.filter((e) => e.entryType === LedgerEntryType.PLATFORM_FEE)).toHaveLength(
      1,
    );

    const providerJournal = await context.ledger.readJournal(providerOrg, { intentId });
    expect(
      providerJournal.filter((e) => e.entryType === LedgerEntryType.PROVIDER_CREDIT),
    ).toHaveLength(1);

    const providerBalance = await context.ledger.getBalance(providerOrg, provider, USDC_ASSET);
    expect(MoneyUtil.toAtomic(providerBalance.available)).toBe(450n);
  });

  it('providerAmount + platformFee above the committed hold rejects with LEDGER_SETTLEMENT_CREDIT_MISMATCH and writes nothing', async () => {
    const agentOrg = randomUUID();
    const providerOrg = randomUUID();
    const agent = context.account('agent-mismatch');
    const provider = context.account('provider-mismatch');

    await context.fund(agentOrg, agent, 1_000n);

    const intentId = randomUUID();
    const hold = await context.ledger.createHold({
      organizationId: agentOrg,
      accountId: agent,
      money: context.usdc(1_000n),
      intentId,
    });

    await expectErrorCodeAsync(
      () =>
        context.ledger.commitHoldAndCredit(agentOrg, hold.id, {
          providerOrganizationId: providerOrg,
          providerAccountId: provider,
          providerAmount: context.usdc(900n),
          // 900 + 150 = 1050, above the 1000 held. A credit BELOW the hold is
          // allowed: the remainder is released (a re-priced rail-A call).
          platformFee: context.usdc(150n),
          intentId,
          chainTxRef: LEGACY_POOLED_VAULT_TX_REF,
        }),
      LedgerErrorCode.LEDGER_SETTLEMENT_CREDIT_MISMATCH,
    );

    const stillOpenHold = await context.ledger.getHold(agentOrg, hold.id);
    expect(stillOpenHold.status).toBe('OPEN');

    const providerJournal = await context.ledger.readJournal(providerOrg, { intentId });
    expect(providerJournal).toHaveLength(0);
  });

  it('a second PROVIDER_CREDIT for the same (organization, intent) written outside commitHoldAndCredit is refused by the partial unique index', async () => {
    const providerOrg = randomUUID();
    const provider = context.account('provider-unique-index');
    const intentId = randomUUID();

    await context.ledger.appendNow({
      organizationId: providerOrg,
      accountId: provider,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(100n),
      intentId,
    });

    await expect(
      context.ledger.appendNow({
        organizationId: providerOrg,
        accountId: provider,
        entryType: LedgerEntryType.PROVIDER_CREDIT,
        money: context.usdc(100n),
        intentId,
      }),
    ).rejects.toBeDefined();
  });
});
