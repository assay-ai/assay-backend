import { Injectable } from '@nestjs/common';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { MoneyUtil } from '@shared/utils/money.util';

import { deltaEquals, foldJournal, toAccountBalance, zeroBalance } from '../domain/balance-fold';
import { SnapshotDrift, SnapshotVerification } from '../ports/ledger.port';
import { AccountBalance, BalanceDelta, LedgerAccountId, balanceKeyOf } from '../ports/ledger.types';
import { LedgerJournalService } from './ledger-journal.service';

/**
 * Reading balances, and proving the fast path equals the slow one.
 *
 * Two implementations of the same question are kept on purpose. `getBalance`
 * reads the snapshot and is what production calls; `rebuildBalance` folds the
 * journal and is what decides who is right. A cache with no way to be falsified
 * is not a cache, it is a second source of truth.
 */
@Injectable()
export class LedgerBalanceService {
  constructor(
    private readonly balances: AccountBalanceRepository,
    private readonly journal: LedgerJournalService,
  ) {}

  /**
   * The snapshot. An account with no row has never received value, which is a
   * zero balance, not a missing one — a caller asking "can this account afford
   * X" deserves `no` rather than a 404.
   */
  async getBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance> {
    const row = await this.balances.findOneRow(organizationId, accountId, asset);
    const decimals = row?.decimals ?? getAssetMetadata(asset).decimals;

    if (!row) {
      return zeroBalance(organizationId, accountId, asset, decimals);
    }

    return toAccountBalance({ organizationId, accountId, asset }, decimals, {
      available: BigInt(row.available),
      held: BigInt(row.held),
      pending: BigInt(row.pending),
    });
  }

  /** The definition: the journal, folded. Never consults the snapshot. */
  async rebuildBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance> {
    const entries = await this.journal.readJournal(organizationId, {
      accountId,
      assetId: asset,
    });
    const folded = foldJournal(entries);
    const rebuilt = folded.get(balanceKeyOf({ organizationId, accountId, asset }));

    return (
      rebuilt ?? zeroBalance(organizationId, accountId, asset, getAssetMetadata(asset).decimals)
    );
  }

  /**
   * Folds the whole journal and compares it, row for row, against the snapshot
   * table.
   *
   * Both directions matter and both are checked: a snapshot that disagrees with
   * its fold, **and** a snapshot row that exists for an account the journal
   * never mentions. Checking only the first would miss a balance conjured
   * without a cause, which is the more dangerous of the two.
   */
  async verifySnapshots(organizationId: string): Promise<SnapshotVerification> {
    const entries = await this.journal.readJournal(organizationId);
    const rebuilt = foldJournal(entries);
    const stored = await this.balances.findAllRows(organizationId);

    const drifts: SnapshotDrift[] = [];
    const seen = new Set<string>();

    for (const row of stored) {
      const asset = row.assetId as AssetId;
      const key = balanceKeyOf({
        organizationId,
        accountId: row.accountId as LedgerAccountId,
        asset,
      });
      seen.add(key);

      const storedDelta: BalanceDelta = {
        available: BigInt(row.available),
        held: BigInt(row.held),
        pending: BigInt(row.pending),
      };
      const expected = rebuilt.get(key);
      const expectedDelta: BalanceDelta = expected
        ? {
            available: MoneyUtil.toAtomic(expected.available),
            held: MoneyUtil.toAtomic(expected.held),
            pending: MoneyUtil.toAtomic(expected.pending),
          }
        : { available: 0n, held: 0n, pending: 0n };

      if (!deltaEquals(storedDelta, expectedDelta)) {
        drifts.push(
          this.toDrift(organizationId, row.accountId as LedgerAccountId, asset, row.decimals, {
            stored: storedDelta,
            rebuilt: expectedDelta,
          }),
        );
      }
    }

    for (const [key, balance] of rebuilt) {
      if (seen.has(key)) {
        continue;
      }
      drifts.push({
        organizationId,
        accountId: balance.accountId,
        asset: balance.asset,
        stored: null,
        rebuilt: {
          available: balance.available,
          held: balance.held,
          pending: balance.pending,
        },
      });
    }

    return { ok: drifts.length === 0, checked: Math.max(stored.length, rebuilt.size), drifts };
  }

  /** Every snapshot row an organization holds, as balances. */
  async listBalances(organizationId: string): Promise<AccountBalance[]> {
    const rows = await this.balances.findAllRows(organizationId);
    return rows.map((row) =>
      toAccountBalance(
        {
          organizationId,
          accountId: row.accountId as LedgerAccountId,
          asset: row.assetId as AssetId,
        },
        row.decimals,
        {
          available: BigInt(row.available),
          held: BigInt(row.held),
          pending: BigInt(row.pending),
        },
      ),
    );
  }

  private toDrift(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
    decimals: number,
    deltas: { stored: BalanceDelta; rebuilt: BalanceDelta },
  ): SnapshotDrift {
    const money = (amount: bigint) => MoneyUtil.of(amount, asset, decimals);
    return {
      organizationId,
      accountId,
      asset,
      stored: {
        available: money(deltas.stored.available),
        held: money(deltas.stored.held),
        pending: money(deltas.stored.pending),
      },
      rebuilt: {
        available: money(deltas.rebuilt.available),
        held: money(deltas.rebuilt.held),
        pending: money(deltas.rebuilt.pending),
      },
    };
  }
}
