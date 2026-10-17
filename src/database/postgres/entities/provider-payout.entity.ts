import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One hourly payout run's payment to one provider, in one asset.
 *
 * ## FROZEN — read, never written
 *
 * The hourly batch that wrote these rows is **deleted**. A provider now signs
 * `request_earnings_withdraw` and `withdraw_earnings` against their own
 * `ProviderEarnings` account, so the platform no longer decides when or how much
 * of somebody else's money moves, and there is no run to reserve a period for.
 *
 * The table and its rows are kept deliberately: `GET /providers/me/payouts`
 * still renders what was already paid, and dropping the table to tidy up after a
 * deleted service would erase a provider's payment history. Nothing inserts,
 * updates or deletes here any more.
 *
 * **Where the money-moved record lives now.** The `PAYOUT` ledger entry, which
 * the reconciler writes from the observed delta in
 * `ProviderEarnings.total_withdrawn` — with `batch_id` and
 * `chain_tx_ref` both null, because the reconciler observes a *balance* and not
 * a transaction, and saying so honestly is better than inventing a signature.
 * Everything below this line describes how the deleted batch used these columns,
 * and is kept so an old row can still be read correctly.
 *
 * ## Why this table exists at all, given `ledger_entries.PAYOUT` already debits
 *
 * A `PAYOUT` journal entry proves money left the provider's book; it cannot by
 * itself answer "did we already pay out this hour" (the table is append-only
 * and carries no period), "which calls did this payout cover" (a payout that
 * cannot be decomposed into calls is not a statement), or "did we submit on
 * chain but crash before recording it" (the ledger write happens only *after*
 * on-chain confirmation, so there is a real window in which a payout was sent
 * and nothing durable says so yet). This row is the durable record all three
 * questions are answered from.
 *
 * ## The two guards against paying twice
 *
 * 1. **`uq_provider_payouts_org_asset_period`** — `UNIQUE (organization_id,
 *    asset_id, period_start)`. A re-run of the same hourly period is refused
 *    by Postgres before any on-chain action is even considered, which is a
 *    stronger guarantee than "check then insert": two scheduler instances
 *    racing the same period both attempt the insert and exactly one wins.
 * 2. **`status`** distinguishes three points in a run that can each be the last
 *    thing that happened before a crash: `PENDING` (the period is reserved and
 *    the amount is snapshotted, nothing sent on chain yet), `SUBMITTED` (the
 *    inert on-chain instruction was built and its deterministic proposal id
 *    recorded in `chain_tx_ref` — and "submitted" never meant "confirmed": the
 *    vault is Squads-gated, and nothing in this codebase could execute a vault
 *    transaction without a human multisig approval, which is why the batch
 *    shipped defaulted off and why provider-signed withdrawals replaced it
 *    rather than finishing it), and `RECORDED` (the `PAYOUT` ledger entry
 *    exists — `ledger_entry_id` is set — and the amount has actually left the
 *    provider's available balance). A resumed run reads this column to decide
 *    whether to build the proposal again (never, once `chain_tx_ref` is set —
 *    that would be a second reference for one payment) or only to (re)write the
 *    ledger entry.
 *
 * ## Decomposability
 *
 * `ledger_entries` is append-only, so a `PROVIDER_CREDIT` row can never be
 * stamped with the id of the payout that later swept it — there is no UPDATE
 * this schema permits. `from_seq` / `to_seq` name the window instead: every
 * `PROVIDER_CREDIT` entry for this provider and asset with
 * `from_seq < seq <= to_seq` is exactly the set this payout paid, because
 * payouts always sweep the *entire* payable balance and are computed under a
 * lock on the account's balance row (see the service), so consecutive payouts
 * for one `(organization_id, asset_id)` tile the journal without gap or
 * overlap. `call_count` is the same window's row count, stored so a caller does
 * not have to run the join just to show "N calls" in a list. Whoever builds a
 * per-call export joins on this window
 * (`ledger_entries.seq BETWEEN provider_payouts.from_seq + 1 AND provider_payouts.to_seq`,
 * filtered to `entry_type = 'PROVIDER_CREDIT'`), not on
 * `ledger_entries.batch_id` — repurposing that column for
 * `PROVIDER_CREDIT` would give it a second meaning. `batch_id` on *this* table means something else again — see
 * below — which is exactly the ambiguity the seq window avoids.
 *
 * ## `batch_id` here is the run, not the flush
 *
 * One value, generated once per scheduler invocation and shared by every
 * provider paid in that run (however many separate on-chain instructions it
 * took). The same value is
 * written to the `PAYOUT` ledger entry's own `batch_id` column, which is what
 * lets `ProviderPayoutsService` (`GET /providers/me/payouts`) group a
 * provider's rows by run without joining this table at all.
 */
@Entity('provider_payouts')
@Index('idx_provider_payouts_batch_id', ['organizationId', 'batchId'])
@Index('idx_provider_payouts_status', ['status'])
export class ProviderPayoutEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** CAIP-19. */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** The hourly bucket this payout covers — the period half of the unique key. */
  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd: Date;

  /** Atomic units. Always the full payable balance at the moment of the snapshot. */
  @Column({ name: 'amount', type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  /** Exclusive lower bound — the previous payout's `to_seq` for this org+asset, or `0`. */
  @Column({ name: 'from_seq', type: 'bigint', default: 0 })
  fromSeq: string;

  /** Inclusive upper bound — the `PROVIDER_CREDIT` journal high-water mark at snapshot time. */
  @Column({ name: 'to_seq', type: 'bigint' })
  toSeq: string;

  /** `COUNT(*)` of the `PROVIDER_CREDIT` rows in `(from_seq, to_seq]` — one call, one row. */
  @Column({ name: 'call_count', type: 'int' })
  callCount: number;

  /** `PENDING` | `SUBMITTED` | `RECORDED` — see the class comment. */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'PENDING' })
  status: string;

  /** Shared by every provider paid in the same scheduler run. See the class comment. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  /**
   * The ledger account the `PAYOUT` entry debits — the same `accountId`
   * `PROVIDER_CREDIT` entries actually landed under
   * (`payment_intents.provider_account`), **not** necessarily
   * `payout_account_id` below. A provider whose credits are split across more
   * than one account in one asset is unsupported by this pass and is skipped
   * rather than guessed at. That skip belonged to the deleted batch; the
   * identity question it names outlived it, and now bites at withdrawal time
   * instead — see `ProviderEarningsIntentService`.
   */
  @Column({ name: 'source_account_id', type: 'varchar', length: 256 })
  sourceAccountId: string;

  /**
   * Snapshot of the provider's payout address at computation time — the
   * on-chain destination.
   *
   * **Not `providers.payout_account_id`.** That column was dropped by
   * `1759300000002` for multichain support; the address is now one row per
   * chain in `provider_chain_enrolments`, so whoever turns the payout batch on
   * has to decide *which chain a batch is for* before it can name a payee, and
   * read the enrolment for that chain. A batch that picked a provider's first
   * enrolment would pay a Solana address for earnings settled on `eip155:4663`.
   */
  @Column({ name: 'payout_account_id', type: 'varchar', length: 256 })
  payoutAccountId: string;

  /** The built proposal's deterministic id. Set once, on the `PENDING → SUBMITTED` move. */
  @Column({ name: 'chain_tx_ref', type: 'varchar', length: 256, nullable: true })
  chainTxRef: string | null;

  /** The `PAYOUT` journal row. Set once, on the `SUBMITTED → RECORDED` move. */
  @Column({ name: 'ledger_entry_id', type: 'uuid', nullable: true })
  ledgerEntryId: string | null;
}
