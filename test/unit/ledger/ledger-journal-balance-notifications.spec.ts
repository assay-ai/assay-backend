import { QueryRunner } from 'typeorm';

import {
  AccountBalanceRepository,
  rowKeyOf,
} from '@database/postgres/repositories/account-balance.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { AccountId } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { NotificationEvent, NotificationPort } from '@modules/notification/ports/notification.port';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * `LedgerJournalService.applyEntries`'s `balance.low` / `balance.zero`
 * producer.
 *
 * The notification is fired-and-forgotten, not awaited by `applyEntries` (see
 * that method's own comment on why). For a write with exactly one crossing
 * whose effect is `balance.low` alone — not also `balance.zero` — the single
 * `notify()` call happens synchronously as part of invoking the fire-and-forget
 * async function, before `applyEntries` itself returns; that is what lets this
 * suite assert on the mock immediately after `await`ing `applyEntries`, with no
 * extra microtask flush. A scenario that crosses `balance.zero` too would need
 * one, since that path calls `notify()` a second time in the same pass.
 */

const ORG = 'org-1';
const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const ACCOUNT = `${ASSET.split('/')[0]}:H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp` as AccountId;
const DECIMALS = 6;

function usdc(amount: string) {
  return MoneyUtil.of(amount, ASSET, DECIMALS);
}

function build(initialAvailable: string) {
  const balanceRow = {
    accountId: ACCOUNT,
    assetId: ASSET,
    decimals: DECIMALS,
    available: initialAvailable,
    held: '0',
    pending: '0',
  };

  const balances = {
    ensureRows: jest.fn().mockResolvedValue(undefined),
    lockRows: jest
      .fn()
      .mockImplementation(async () => new Map([[rowKeyOf(ACCOUNT, ASSET), balanceRow]])),
    applyDeltas: jest.fn().mockImplementation(async (_org: string, deltas: unknown[]) => {
      // Mutate the row so a second `applyEntries` call in the same test sees
      // the updated balance, same as a real read-your-writes flow would.
      const delta = (deltas as { available: bigint }[])[0];
      balanceRow.available = (BigInt(balanceRow.available) + delta.available).toString();
      return deltas.length;
    }),
  };

  const entries = { appendMany: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };

  const journal = new LedgerJournalService(
    entries as unknown as LedgerEntryRepository,
    balances as unknown as AccountBalanceRepository,
    {} as never, // DataSource — unused by applyEntries directly
    notifications as unknown as NotificationPort,
  );

  return { journal, notifications, balanceRow };
}

describe('LedgerJournalService — balance.low / balance.zero', () => {
  it('fires balance.low on the write that crosses the threshold downward', async () => {
    // 10 USDC available, default threshold is 5 USDC — a 6 USDC debit crosses it.
    const { journal, notifications } = build('10000000');

    await journal.applyEntries({} as QueryRunner, ORG, [
      journal.prepare({
        organizationId: ORG,
        accountId: ACCOUNT,
        entryType: LedgerEntryType.WITHDRAWAL,
        money: usdc('6000000'),
      }),
    ]);

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [request] = notifications.notify.mock.calls[0];
    expect(request.event).toBe(NotificationEvent.BALANCE_LOW);
    expect(request.organizationId).toBe(ORG);
  });

  it('does not fire again on a subsequent write that stays below the threshold', async () => {
    const { journal, notifications } = build('10000000');

    // First write: 10 -> 4 USDC, crosses the threshold.
    await journal.applyEntries({} as QueryRunner, ORG, [
      journal.prepare({
        organizationId: ORG,
        accountId: ACCOUNT,
        entryType: LedgerEntryType.WITHDRAWAL,
        money: usdc('6000000'),
      }),
    ]);
    expect(notifications.notify).toHaveBeenCalledTimes(1);

    // Second write: 4 -> 3.5 USDC. Still below the threshold, but this write
    // did not cross it — the balance was already under 5 USDC beforehand.
    await journal.applyEntries({} as QueryRunner, ORG, [
      journal.prepare({
        organizationId: ORG,
        accountId: ACCOUNT,
        entryType: LedgerEntryType.WITHDRAWAL,
        money: usdc('500000'),
      }),
    ]);

    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the balance never crosses the threshold', async () => {
    const { journal, notifications } = build('10000000');

    await journal.applyEntries({} as QueryRunner, ORG, [
      journal.prepare({
        organizationId: ORG,
        accountId: ACCOUNT,
        entryType: LedgerEntryType.WITHDRAWAL,
        money: usdc('1000000'),
      }),
    ]);

    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
