import { randomUUID } from 'node:crypto';

import { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';

import {
  DepositTestContext,
  USDC_ASSET,
  USDC_DECIMALS,
  createDepositTestContext,
} from '../helpers/deposit-test-context';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const AMOUNT = 1_000_000n;

/**
 * `uq_ledger_entries_deposit_pending` — the guard that closes HIGH-1, the
 * deposit-broadcast TOCTOU (migration 1762400000110).
 *
 * Its sibling `uq_ledger_entries_deposit_resolution` makes the *resolving*
 * entry single-use per signature but is partial on CONFIRM/REJECT only, so
 * nothing kept `DEPOSIT_PENDING` single-use. The buyer-broadcast path guarded a
 * re-used transaction with a read-then-write `findByChainTxRef`, and
 * `chain_tx_ref` stays NULL on an intent until SETTLED — so two intents could
 * both read "unclaimed", both settle one real transfer, and both write
 * `DEPOSIT_PENDING` for one signature. The phantom pending inflated liabilities
 * and let two SETTLED intents enter finality for a single transfer.
 *
 * Like its sibling this is an integration test because the thing under test is
 * a database constraint — an in-memory fake has no unique index and would pass
 * against the unfixed code.
 */
describe('Deposit pending uniqueness — one pending credit per signature (HIGH-1 regression)', () => {
  let ctx: DepositTestContext;

  beforeAll(async () => {
    ctx = await createDepositTestContext();
  });

  afterEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function seedSettledIntent(label: string): Promise<{ id: string; account: AccountId }> {
    const id = randomUUID();
    const account = ctx.account(label);
    await ctx.repository.insert({
      id,
      organizationId: ctx.organizationId,
      status: 'SETTLED',
      statusReason: 'settlement observed on-chain',
      agentId: randomUUID(),
      agentAccount: account,
      assetId: USDC_ASSET,
      decimals: USDC_DECIMALS,
      requestedAmount: AMOUNT.toString(),
      settledAmount: AMOUNT.toString(),
      chainId: SOLANA_DEVNET,
      chainTxRef: `Tx-${id}`,
      expiresAt: new Date(Date.now() + 90_000),
    });
    return { id, account };
  }

  it('refuses a second DEPOSIT_PENDING for one signature at the schema level', async () => {
    // Two intents on one account, the one real transfer. Before the fix both
    // pending writes succeeded; now the second is refused by the database.
    const first = await seedSettledIntent('agent-pending-uq');
    const second = await seedSettledIntent('agent-pending-uq');
    const signature = `Shared-${first.id}`;

    await ctx.ledger.appendNow({
      organizationId: ctx.organizationId,
      accountId: first.account,
      entryType: LedgerEntryType.DEPOSIT_PENDING,
      money: ctx.usdc(AMOUNT),
      intentId: first.id,
      chainTxRef: signature,
    });

    await expect(
      ctx.ledger.appendNow({
        organizationId: ctx.organizationId,
        accountId: second.account,
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        money: ctx.usdc(AMOUNT),
        intentId: second.id,
        chainTxRef: signature,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('still allows the DEPOSIT_CONFIRM that shares the pending signature', async () => {
    // The two indexes are disjoint by predicate: the normal lifecycle writes
    // one pending and then one confirm for the same signature, and both must
    // succeed — the fix must not refuse a deposit its own precursor named.
    const { id, account } = await seedSettledIntent('agent-pending-then-confirm');
    const signature = `Life-${id}`;

    await ctx.ledger.appendNow({
      organizationId: ctx.organizationId,
      accountId: account,
      entryType: LedgerEntryType.DEPOSIT_PENDING,
      money: ctx.usdc(AMOUNT),
      intentId: id,
      chainTxRef: signature,
    });

    // Resolves (does not throw): the confirm shares the signature but a
    // different partial index governs it.
    await ctx.ledger.appendNow({
      organizationId: ctx.organizationId,
      accountId: account,
      entryType: LedgerEntryType.DEPOSIT_CONFIRM,
      money: ctx.usdc(AMOUNT),
      intentId: id,
      chainTxRef: signature,
    });
  });
});
