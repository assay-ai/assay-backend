import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { EscrowWithdrawalEventRepository } from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId } from '@modules/chains/ports/caip.types';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * Every minute, fifteen seconds after the withdrawal index
 * (`EVM_ESCROW_WITHDRAWAL_INDEX_CRON`), so a claim it stored is booked before
 * the next reconciliation pass reads the books.
 */
export const CLAIMED_WITHDRAWAL_BOOKING_CRON = '45 * * * * *';
/** Most claims one pass books; a backlog is caught up over later passes. */
export const CLAIMED_WITHDRAWAL_BOOKING_BATCH = 100;

/**
 * Books each claimed `EscrowWithdrawn` as a `WITHDRAWAL` debit of the buyer's
 * `available`, once.
 *
 * The claim already left the escrow, which IS the vault, so until the ledger
 * says so the reconciler compares a vault that paid out against books that
 * still owe the money: a `RESERVES_BREACH` that freezes every withdrawal, and
 * an `ESCROW_MIRROR_DRIFT` for the buyer. This is the one write that closes it.
 *
 * **Idempotent by the claim's log.** The entry's `chain_tx_ref` is
 * `<transaction hash>:<log index>` and `uq_ledger_entries_withdrawal` makes it
 * single-use, so a retried pass or a race loses quietly. The claims are read
 * from `escrow_withdrawal_events`, not from this pass's logs: a claim indexed
 * before this class existed, or one whose booking failed, is booked by the
 * next pass like any other.
 *
 * **Never more than `available`.** The contract pays `min(requested,
 * balance)` out of the escrow, which can hold money the books do not have as
 * available: an uncredited deposit, a deposit still pending, or an open hold.
 * The journal cannot go negative, so the debit is what `available` has and
 * the rest is logged; an entry of zero still books the claim, so it is not
 * read again. A held remainder is an `ESCROW_SHORTFALL` the reconciler
 * already reports.
 */
@Injectable()
export class ClaimedWithdrawalBooker {
  private readonly logger = new Logger(ClaimedWithdrawalBooker.name);

  constructor(
    private readonly events: EscrowWithdrawalEventRepository,
    private readonly ledger: LedgerService,
  ) {}

  @Cron(CLAIMED_WITHDRAWAL_BOOKING_CRON)
  async handleTick(): Promise<void> {
    try {
      await this.book();
    } catch (error) {
      this.logger.error(`claimed withdrawal booking threw: ${describe(error)}`);
    }
  }

  /** One pass; how many claims it booked. A claim that fails is left for the next pass. */
  async book(): Promise<number> {
    const claims = await this.events.listUnbookedClaims(CLAIMED_WITHDRAWAL_BOOKING_BATCH);
    let booked = 0;
    for (const claim of claims) {
      const asset = claim.assetId as AssetId;
      const account = claim.accountId as LedgerAccountId;
      try {
        const balance = await this.ledger.getBalance(claim.organizationId, account, asset);
        const available = BigInt(balance.available.amount);
        const debit = claim.amount < available ? claim.amount : available;
        if (debit < claim.amount) {
          this.logger.warn(
            `claim ${claim.ref} of ${account}: paid ${claim.amount}, the books have ` +
              `${available} available; ${claim.amount - debit} was not on them as available`,
          );
        }
        await this.ledger.appendNow({
          organizationId: claim.organizationId,
          accountId: account,
          entryType: LedgerEntryType.WITHDRAWAL,
          money: MoneyUtil.of(debit, asset, getAssetMetadata(asset).decimals),
          chainTxRef: claim.ref,
        });
        booked += 1;
      } catch (error) {
        // Booked by a pass that got there first: the retry path working.
        if (isDuplicate(error)) continue;
        this.logger.error(`claim ${claim.ref} of ${account} not booked: ${describe(error)}`);
      }
    }
    return booked;
  }
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
