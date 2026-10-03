import { Injectable } from '@nestjs/common';

import { AssetId } from '@modules/chains/ports/caip.types';

import { LedgerPort, SnapshotVerification } from '../ports/ledger.port';
import {
  AccountBalance,
  AppendEntryInput,
  CreateHoldInput,
  HoldResolution,
  JournalEntry,
  LedgerAccountId,
  LedgerHold,
  SettlementCredit,
} from '../ports/ledger.types';
import { LedgerBalanceService } from './ledger-balance.service';
import { LedgerHoldService } from './ledger-hold.service';
import { LedgerJournalService } from './ledger-journal.service';
import { LedgerWriterService } from './ledger-writer.service';

/**
 * `LedgerPort`, assembled.
 *
 * The four services behind it are split by *what can go wrong*, not by noun:
 * the journal owns atomicity, the writer owns throughput, holds own the state
 * machine, and balances own the cache being provably redundant. This class
 * exists so no caller has to know which of those it is talking to.
 *
 * **`withheld` is deliberately not here**, even though it is a ledger
 * number. `LedgerWithheldService` computes it by joining the journal against
 * `payment_intents` — a *different domain's* table — and putting that behind
 * this facade would mean every consumer of `LedgerPort`, which is the contract
 * the whole platform talks to for money movement, transitively depended on the
 * payment domain to ask what a balance is. It would also give this class a
 * `reconcile()` that means something entirely different from the reconciler's
 * `ReconciliationService.reconcile()`. Callers that want the figure inject
 * `LedgerWithheldService`, which `LedgerModule` exports for exactly that.
 */
@Injectable()
export class LedgerService implements LedgerPort {
  constructor(
    private readonly journal: LedgerJournalService,
    private readonly writer: LedgerWriterService,
    private readonly balances: LedgerBalanceService,
    private readonly holds: LedgerHoldService,
  ) {}

  // ── Journal ──────────────────────────────────────────────────────────────

  appendNow(input: AppendEntryInput): Promise<JournalEntry> {
    return this.journal.appendNow(input);
  }

  append(input: AppendEntryInput): void {
    this.writer.append(input);
  }

  flush(): Promise<number> {
    return this.writer.flush();
  }

  /** Entries still in memory, not yet durable. */
  get buffered(): number {
    return this.writer.pending;
  }

  readJournal(
    organizationId: string,
    filter: { accountId?: LedgerAccountId; asset?: AssetId; intentId?: string } = {},
  ): Promise<JournalEntry[]> {
    return this.journal.readJournal(organizationId, {
      accountId: filter.accountId,
      assetId: filter.asset,
      intentId: filter.intentId,
    });
  }

  // ── Balances ─────────────────────────────────────────────────────────────

  getBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance> {
    return this.balances.getBalance(organizationId, accountId, asset);
  }

  rebuildBalance(
    organizationId: string,
    accountId: LedgerAccountId,
    asset: AssetId,
  ): Promise<AccountBalance> {
    return this.balances.rebuildBalance(organizationId, accountId, asset);
  }

  verifySnapshots(organizationId: string): Promise<SnapshotVerification> {
    return this.balances.verifySnapshots(organizationId);
  }

  listBalances(organizationId: string): Promise<AccountBalance[]> {
    return this.balances.listBalances(organizationId);
  }

  // ── Holds ────────────────────────────────────────────────────────────────

  createHold(input: CreateHoldInput): Promise<LedgerHold> {
    return this.holds.createHold(input);
  }

  releaseHold(organizationId: string, holdId: string): Promise<HoldResolution> {
    return this.holds.releaseHold(organizationId, holdId);
  }

  commitHold(organizationId: string, holdId: string): Promise<HoldResolution> {
    return this.holds.commitHold(organizationId, holdId);
  }

  commitHoldAndCredit(
    organizationId: string,
    holdId: string,
    credit: SettlementCredit,
  ): Promise<HoldResolution> {
    return this.holds.commitHoldAndCredit(organizationId, holdId, credit);
  }

  getHold(organizationId: string, holdId: string): Promise<LedgerHold> {
    return this.holds.getHold(organizationId, holdId);
  }
}
