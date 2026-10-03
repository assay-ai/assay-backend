import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LEDGER_MAX_FLUSH_ATTEMPTS } from '@modules/ledger/constants/ledger.constants';
import { LedgerWriterService } from '@modules/ledger/services/ledger-writer.service';
import { expectErrorCodeAsync } from '../../unit/helpers/expect-error-code';
import {
  LedgerTestContext,
  USDC_ASSET,
  createLedgerTestContext,
} from '../helpers/ledger-test-context';

/**
 * The batch writer's failure behaviour.
 *
 * Batching is a throughput device, so its interesting cases are all about what
 * it does when it *cannot* write: a failed batch must apply nothing, must not
 * be lost, and — the case that only shows up in production — must not wedge the
 * buffer behind an entry that can never succeed.
 */
describe('ledger writer — batching under failure', () => {
  let context: LedgerTestContext;
  let writer: LedgerWriterService;

  beforeAll(async () => {
    context = await createLedgerTestContext();
    // The facade deliberately keeps the buffer's internals off its surface;
    // this suite is testing the writer itself, so it addresses the writer.
    writer = context.writer;
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('refuses to buffer an entry type that can reduce a balance, at the call site rather than at flush time', () => {
    const agent = context.account('writer-debit');

    for (const entryType of [
      LedgerEntryType.HOLD_CREATE,
      LedgerEntryType.HOLD_RELEASE,
      LedgerEntryType.HOLD_COMMIT,
      LedgerEntryType.PAYOUT,
      LedgerEntryType.WITHDRAWAL,
      LedgerEntryType.DEPOSIT_CONFIRM,
      LedgerEntryType.DEPOSIT_REJECT,
    ]) {
      expect(() =>
        context.ledger.append({
          organizationId: context.organizationId,
          accountId: agent,
          entryType,
          money: context.usdc(1n),
        }),
      ).toThrow();
      // Nothing reached the buffer, so no later flush inherits the problem.
      expect(writer.pending).toBe(0);
    }
  });

  it('re-queues a failed batch instead of dropping it, so a transient failure loses no credit', async () => {
    const agent = context.account('writer-requeue');

    context.ledger.append({
      organizationId: context.organizationId,
      accountId: agent,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(70n),
    });
    context.ledger.append({
      organizationId: 'not-a-uuid',
      accountId: agent,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(30n),
    });

    await expectErrorCodeAsync(
      () => context.ledger.flush(),
      LedgerErrorCode.LEDGER_BATCH_FLUSH_FAILED,
    );

    // Both entries came back — including the good one, which was never applied.
    expect(writer.pending).toBe(2);
    expect(
      (await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET)).available.amount,
    ).toBe('0');
  });

  it('quarantines a batch that can never be written, so the healthy entries behind it still drain', async () => {
    const agent = context.account('writer-poison');

    context.ledger.append({
      organizationId: 'not-a-uuid',
      accountId: agent,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(5n),
    });

    // Retrying is right — nothing was applied, so a retry cannot double-apply.
    // Retrying forever is not: this entry sits at the head of the buffer and
    // takes every healthy entry behind it down on every attempt.
    for (let attempt = 0; attempt < LEDGER_MAX_FLUSH_ATTEMPTS; attempt += 1) {
      await expectErrorCodeAsync(
        () => context.ledger.flush(),
        LedgerErrorCode.LEDGER_BATCH_FLUSH_FAILED,
      );
    }

    expect(writer.pending).toBe(0);
    expect(writer.quarantinedCount).toBe(1);

    // The buffer is usable again, and a good entry written after the poison
    // lands normally.
    context.ledger.append({
      organizationId: context.organizationId,
      accountId: agent,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(11n),
    });
    expect(await context.ledger.flush()).toBe(1);

    const balance = await context.ledger.getBalance(context.organizationId, agent, USDC_ASSET);
    expect(balance.available.amount).toBe('11');
    expect((await context.ledger.verifySnapshots(context.organizationId)).ok).toBe(true);

    // A quarantined batch is un-written credit, not lost money: it is handed
    // back whole so the reconciler can re-derive it.
    expect(writer.drainQuarantine()).toHaveLength(1);
    expect(writer.quarantinedCount).toBe(0);
  });

  it('writes a multi-account batch as one unit, moving every snapshot it names', async () => {
    const provider = context.account('writer-provider');
    const other = context.account('writer-other');

    context.ledger.append({
      organizationId: context.organizationId,
      accountId: provider,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(900n),
    });
    context.ledger.append({
      organizationId: context.organizationId,
      accountId: provider,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(100n),
    });
    context.ledger.append({
      organizationId: context.organizationId,
      accountId: other,
      entryType: LedgerEntryType.PLATFORM_FEE,
      money: context.usdc(42n),
    });

    expect(await context.ledger.flush()).toBe(3);

    // Two entries for one account collapse into one balance update, and the
    // balance must equal their sum — not the last one written.
    expect(
      (await context.ledger.getBalance(context.organizationId, provider, USDC_ASSET)).available
        .amount,
    ).toBe('1000');
    expect(
      (await context.ledger.getBalance(context.organizationId, other, USDC_ASSET)).available.amount,
    ).toBe('42');
    expect((await context.ledger.verifySnapshots(context.organizationId)).ok).toBe(true);
  });
});
