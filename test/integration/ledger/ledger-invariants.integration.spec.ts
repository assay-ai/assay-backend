import { foldJournal } from '@modules/ledger/domain/balance-fold';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  INTERNAL_ACCOUNTS,
  LedgerAccountId,
  LedgerEntryType,
} from '@modules/ledger/ports/ledger.types';
import { MoneyUtil } from '@shared/utils/money.util';
import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import {
  USDC_ASSET,
  LedgerTestContext,
  createLedgerTestContext,
} from '../helpers/ledger-test-context';

// This suite drives a few thousand real writes against Postgres per run.
jest.setTimeout(180_000);

const PLATFORM_FEES: LedgerAccountId = INTERNAL_ACCOUNTS.PLATFORM_FEES;

/**
 * A small linear-congruential PRNG so the "thousands of random operations"
 * run is reproducible across CI runs rather than flaking on a bad seed once
 * a decade. Good enough for test data; not for anything security-sensitive.
 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('ledger invariants — the real-database invariant run', () => {
  let context: LedgerTestContext;

  beforeAll(async () => {
    context = await createLedgerTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('several thousand random-but-valid operations leave the snapshot verified, the rebuild matching the stored balance for every account, and the fold of the journal matching both', async () => {
    const rng = makeRng(42);
    const agents = Array.from({ length: 5 }, (_, i) => context.account(`inv-agent-${i}`));
    const providers = Array.from({ length: 3 }, (_, i) => context.account(`inv-provider-${i}`));
    const touchedAccounts = new Set<LedgerAccountId>([...agents, ...providers, PLATFORM_FEES]);

    const SETTLEMENTS = 750; // ~4-5 ledger writes each: several thousand entries total.

    for (let i = 0; i < SETTLEMENTS; i++) {
      const agent = agents[Math.floor(rng() * agents.length)];
      const provider = providers[Math.floor(rng() * providers.length)];

      const depositAmt = BigInt(1 + Math.floor(rng() * 1000));
      await context.fund(agent, depositAmt);

      const hold = await context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: agent,
        money: context.usdc(depositAmt),
        intentId: context.intent(`inv-intent-${i}`),
      });

      if (rng() < 0.85) {
        await context.ledger.commitHold(context.organizationId, hold.id);

        const feeBps = Math.floor(rng() * 2000);
        const fee = (depositAmt * BigInt(feeBps)) / 10_000n;
        const providerAmt = depositAmt - fee;

        if (fee > 0n) {
          await context.ledger.appendNow({
            organizationId: context.organizationId,
            accountId: PLATFORM_FEES,
            entryType: LedgerEntryType.PLATFORM_FEE,
            money: context.usdc(fee),
          });
        }
        if (providerAmt > 0n) {
          await context.ledger.appendNow({
            organizationId: context.organizationId,
            accountId: provider,
            entryType: LedgerEntryType.PROVIDER_CREDIT,
            money: context.usdc(providerAmt),
          });

          if (rng() < 0.3) {
            const payout = 1n + BigInt(Math.floor(rng() * Number(providerAmt)));
            await context.ledger.appendNow({
              organizationId: context.organizationId,
              accountId: provider,
              entryType: LedgerEntryType.PAYOUT,
              money: context.usdc(payout),
            });
          }
        }
      } else {
        await context.ledger.releaseHold(context.organizationId, hold.id);
      }
    }

    const verification = await context.ledger.verifySnapshots(context.organizationId);
    expect(verification.ok).toBe(true);
    expect(verification.drifts).toHaveLength(0);
    expect(verification.checked).toBeGreaterThan(0);

    let sumFromRebuild = 0n;
    for (const accountId of touchedAccounts) {
      const rebuilt = await context.ledger.rebuildBalance(
        context.organizationId,
        accountId,
        USDC_ASSET,
      );
      const stored = await context.ledger.getBalance(context.organizationId, accountId, USDC_ASSET);
      expect(rebuilt).toEqual(stored);
      sumFromRebuild += MoneyUtil.toAtomic(rebuilt.total);
    }

    // Cross-check against the pure domain fold applied to the journal read
    // straight back from Postgres — the DB-backed rebuild and the in-memory
    // fold must agree on total value in the system.
    const journal = await context.ledger.readJournal(context.organizationId);
    const foldedFromJournal = foldJournal(journal);
    let sumFromJournal = 0n;
    for (const balance of foldedFromJournal.values()) {
      sumFromJournal += MoneyUtil.toAtomic(balance.total);
    }
    expect(sumFromRebuild).toBe(sumFromJournal);
  });

  it('the journal is append-only at the database level: a raw UPDATE and a raw DELETE are both rejected by Postgres', async () => {
    const agent = context.account('agent-append-only');
    await context.fund(agent, 10n);

    const [row] = await context.dataSource.query(
      'SELECT id, amount FROM ledger_entries WHERE organization_id = $1 ORDER BY seq DESC LIMIT 1',
      [context.organizationId],
    );
    expect(row).toBeDefined();

    // Neither statement should be able to reach the row — the guarantee is
    // enforced by Postgres (trigger / rule / REVOKE), not by application code
    // that could simply be bypassed by a raw connection like this one.
    await expect(
      context.dataSource.query('UPDATE ledger_entries SET amount = $1 WHERE id = $2', [
        String(BigInt(row.amount) + 1n),
        row.id,
      ]),
    ).rejects.toBeDefined();

    await expect(
      context.dataSource.query('DELETE FROM ledger_entries WHERE id = $1', [row.id]),
    ).rejects.toBeDefined();

    const [stillThere] = await context.dataSource.query(
      'SELECT id, amount FROM ledger_entries WHERE id = $1',
      [row.id],
    );
    expect(stillThere).toBeDefined();
    expect(stillThere.amount).toBe(row.amount);
  });

  describe('batch atomicity', () => {
    it('a batch that fails to flush applies none of its entries, and every snapshot still verifies', async () => {
      const agentA = context.account('agent-batch-a');
      const agentB = context.account('agent-batch-b');

      const journalBefore = await context.ledger.readJournal(context.organizationId);

      context.ledger.append({
        organizationId: context.organizationId,
        accountId: agentA,
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        money: context.usdc(100n),
      });
      context.ledger.append({
        organizationId: context.organizationId,
        accountId: agentB,
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        money: context.usdc(50n),
      });
      // A poisoned entry that survives `append` and fails at flush.
      //
      // Most malformed input is rejected synchronously by `append` — a decimals
      // scale disagreeing with the asset registry raises LEDGER_ASSET_MISMATCH
      // at the call site, by design, so that a bad entry fails its own caller
      // rather than four hundred innocent ones. `organizationId` is the
      // exception: it is opaque to the ledger and only Postgres knows it must
      // be a uuid, so it is the one value that can reach the INSERT and abort
      // the transaction there. That makes it the honest way to test batch
      // atomicity without a test-only seam in production code.
      context.ledger.append({
        organizationId: 'not-a-uuid',
        accountId: agentA,
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        money: context.usdc(10n),
      });

      await expectErrorCodeAsync(
        () => context.ledger.flush(),
        LedgerErrorCode.LEDGER_BATCH_FLUSH_FAILED,
      );

      const journalAfter = await context.ledger.readJournal(context.organizationId);
      expect(journalAfter).toHaveLength(journalBefore.length);

      const verification = await context.ledger.verifySnapshots(context.organizationId);
      expect(verification.ok).toBe(true);
      expect(verification.drifts).toHaveLength(0);
    });
  });
});
