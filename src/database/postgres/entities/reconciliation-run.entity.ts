import { Column, Entity, Index } from 'typeorm';
import { AbstractEntityWithoutSoftDelete } from './abstract.entity';

/**
 * One pass of the 5-minute reconciler, recorded whether or not it found
 * anything.
 *
 * **Every run is written, including the quiet ones.** A table that only holds
 * breaches cannot answer the question that matters most during an incident —
 * *when was the last time this was right?* — and cannot distinguish "no
 * breaches" from "the reconciler stopped running three days ago". The silent
 * rows are the baseline the loud ones are read against.
 *
 * Not organization-scoped, and this is one of the few tables where that is
 * correct rather than an oversight: the vault is a single account custodying
 * every organization's funds, so the figure being checked is platform-wide and
 * there is no tenant to scope it to. Same reasoning as
 * `AccountBalanceRepository.sumLiabilities`. It therefore extends
 * `AbstractEntityWithoutSoftDelete` rather than the organization-scoped base —
 * and never soft-deletes, because a deleted reconciliation record is a hole in
 * exactly the history it exists to preserve.
 */
@Entity('reconciliation_runs')
@Index('idx_reconciliation_runs_asset_started_at', ['assetId', 'startedAt'])
@Index('idx_reconciliation_runs_severity', ['severity', 'startedAt'])
export class ReconciliationRunEntity extends AbstractEntityWithoutSoftDelete {
  /** CAIP-19. One run reconciles one asset; the vault holds only USDC in the MVP. */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** The vault token account the balance was read from, so the row is auditable on chain. */
  @Column({ name: 'vault_account', type: 'varchar', length: 256, nullable: true })
  vaultAccount: string | null;

  /** What the chain says the vault holds. `null` when the chain read itself failed. */
  @Column({ name: 'vault_balance', type: 'numeric', precision: 78, scale: 0, nullable: true })
  vaultBalance: string | null;

  /**
   * The slot `vaultBalance` was true at, as the RPC reported it.
   *
   * The proof-of-reserves page prints this beside the balance so a reader can
   * check the vault themselves at the same slot — the difference between
   * publishing a number and publishing something checkable. `null` for every
   * row written before the column existed, and for any run whose chain read
   * failed; the page renders those as an em dash rather than inventing one.
   */
  @Column({ name: 'vault_slot', type: 'bigint', nullable: true })
  vaultSlot: string | null;

  // ── The three figures, from the journal ──────────────────────────────────

  /** `Σ` agent-owned value: available + held + pending, across every organization. */
  @Column({ name: 'agent_liabilities', type: 'numeric', precision: 78, scale: 0, nullable: true })
  agentLiabilities: string | null;

  /** The reserved slice of `agent_liabilities`. Reported separately, not added again. */
  @Column({ name: 'open_holds', type: 'numeric', precision: 78, scale: 0, nullable: true })
  openHolds: string | null;

  /** `Σ PROVIDER_CREDIT − Σ PAYOUT` — earnings accrued and not yet paid out. */
  @Column({ name: 'provider_payable', type: 'numeric', precision: 78, scale: 0, nullable: true })
  providerPayable: string | null;

  /** `Σ PLATFORM_FEE` not yet swept. A liability like any other until it leaves. */
  @Column({ name: 'platform_fees', type: 'numeric', precision: 78, scale: 0, nullable: true })
  platformFees: string | null;

  /** The sum of the three. What the vault must cover. */
  @Column({ name: 'total_liabilities', type: 'numeric', precision: 78, scale: 0, nullable: true })
  totalLiabilities: string | null;

  /**
   * The same total as the *snapshot* table sees it (`account_balances`).
   *
   * Kept beside `total_liabilities` — which is folded from the journal — so a
   * derivation bug in the snapshot is visible as a difference between two
   * columns of one row, rather than requiring a second query at 3am.
   */
  @Column({
    name: 'snapshot_liabilities',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
  })
  snapshotLiabilities: string | null;

  /**
   * `vault_balance − total_liabilities`. **Signed**, unlike every other amount
   * column in the schema: a negative surplus is the single most important
   * number the platform produces, and storing its magnitude with the sign
   * carried by a status column elsewhere would make the one query that matters
   * — `WHERE difference < 0` — impossible to write.
   */
  @Column({ name: 'difference', type: 'numeric', precision: 78, scale: 0, nullable: true })
  difference: string | null;

  // ── The escrow figures ──────────────────────────────────────
  //
  // All nullable, and every one of them stays null on a run that predates the
  // escrow cutover or that could not read the chain. The per-buyer escrow check
  // fills them; without it a run writes the pooled-vault figures alone.

  /** `Σ` over every buyer's escrow ATA balance read this run. */
  @Column({ name: 'escrow_total', type: 'numeric', precision: 78, scale: 0, nullable: true })
  escrowTotal: string | null;

  /**
   * How many escrows were read. Kept beside the total because a total of zero
   * and a total over zero accounts are different failures, and the sum alone
   * cannot tell them apart.
   */
  @Column({ name: 'escrow_accounts', type: 'int', nullable: true })
  escrowAccounts: number | null;

  /**
   * How many escrows hold less than the open holds against them.
   *
   * This is the per-buyer analogue of `difference < 0`, and it is a **count**
   * rather than a sum on purpose: one buyer $500 short and five hundred buyers
   * $1 short are the same number of dollars and completely different
   * incidents.
   */
  @Column({ name: 'escrow_shortfall_accounts', type: 'int', nullable: true })
  escrowShortfallAccounts: number | null;

  /** One of `ReconciliationSeverity`; the CHECK constraint holds the enum. */
  @Column({ name: 'severity', type: 'varchar', length: 16 })
  severity: string;

  /**
   * Every rule that fired, as `[{ code, summary, details }]`. Empty on a clean
   * run.
   */
  @Column({ name: 'findings', type: 'jsonb', default: () => `'[]'::jsonb` })
  findings: unknown;

  /** Whether an alert was actually emitted for this run. */
  @Column({ name: 'alerted', type: 'boolean', default: false })
  alerted: boolean;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz' })
  finishedAt: Date;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;
}
