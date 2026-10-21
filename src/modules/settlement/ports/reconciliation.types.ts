import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * How bad one reconciliation pass was.
 *
 * Three levels rather than a boolean because the three have different
 * consequences: `CRITICAL` pages on-call and freezes withdrawals, `WARN` is
 * read during working hours, `OK` is the baseline the other two are counted
 * against.
 */
export enum ReconciliationSeverity {
  OK = 'OK',
  WARN = 'WARN',
  CRITICAL = 'CRITICAL',
}

/** Why a run was not `OK`. One per rule that fired. */
export enum ReconciliationFindingCode {
  /** `vault_balance < Σ liabilities`. The unconditional page. */
  RESERVES_BREACH = 'RESERVES_BREACH',
  /** The vault holds materially more than the ledger accounts for. */
  UNEXPLAINED_SURPLUS = 'UNEXPLAINED_SURPLUS',
  /** The balance snapshot disagrees with the journal it is derived from. */
  SNAPSHOT_DRIFT = 'SNAPSHOT_DRIFT',
  /** A book folded to a negative total — more paid out than was ever credited. */
  NEGATIVE_BOOK = 'NEGATIVE_BOOK',
  /**
   * One buyer's escrow holds less than the platform has reserved against it
   * CRITICAL: money someone owns is not there.
   */
  ESCROW_SHORTFALL = 'ESCROW_SHORTFALL',
  /**
   * One buyer's escrow and the mirror disagree, in either direction.
   * WARN, and **expected and transient** by construction — a redemption lands
   * before its `HOLD_COMMIT` is written, so drift is ordinary operation for as
   * long as that gap lasts. The chain is the tiebreak.
   */
  ESCROW_MIRROR_DRIFT = 'ESCROW_MIRROR_DRIFT',
  /**
   * The escrow's `totalHeld()` (G3.B1, "redeem into hold") and the calls the
   * platform mirrors as held disagree. WARN and transient for a pass while a
   * redemption, collect or refund is being booked; persistent is a missed
   * `PaymentHeld` / `HeldCollected` / `HeldRefunded`.
   */
  HELD_MIRROR_DRIFT = 'HELD_MIRROR_DRIFT',
  /**
   * One hold the escrow has (`held(payer, seq)` is HELD) for a seq no payment
   * intent of that payer carries: what a persistent `HELD_MIRROR_DRIFT` is made
   * of, by name (A2). WARN: read and report only.
   */
  HELD_ORPHAN = 'HELD_ORPHAN',
  /**
   * One `Deposited` event into a buyer's escrow that no deposit intent credited
   * (A2, BUG-BUY-MONEY-02): money on chain agents cannot spend. WARN.
   */
  ESCROW_UNCREDITED_DEPOSIT = 'ESCROW_UNCREDITED_DEPOSIT',
  /**
   * `realignSeq` moved a buyer's `next_seq` past the chain's `seq_high`: some
   * other signer or redeemer used this escrow (a copy of this database, a
   * restored backup). WARN.
   */
  ESCROW_SEQ_REALIGNED = 'ESCROW_SEQ_REALIGNED',
  /** The pass could not complete; the figures are unknown, not healthy. */
  RECONCILIATION_FAILED = 'RECONCILIATION_FAILED',
  /** Enough consecutive failures that nobody has checked the money in a while. */
  RECONCILIATION_BLIND = 'RECONCILIATION_BLIND',
}

export interface ReconciliationFinding {
  readonly code: ReconciliationFindingCode;
  readonly severity: ReconciliationSeverity;
  /** One line, with the numbers in it. Goes straight into the alert. */
  readonly summary: string;
  /** The figures behind the summary, for the alert and the stored row. */
  readonly details: Readonly<Record<string, string | number>>;
}

/**
 * The result of one pass.
 *
 * A breach is a **field** here, not a throw: the reconciler's job is to
 * observe, record and alert — throwing would abort the run before the row that
 * records the breach is written, which is the one artefact an incident
 * actually needs.
 */
export interface ReconciliationReport {
  readonly id: string;
  readonly asset: AssetId;
  /** The scale every `*Atomic` figure below is quoted in. */
  readonly decimals: number;
  readonly severity: ReconciliationSeverity;
  readonly findings: readonly ReconciliationFinding[];
  /** `true` when an alert was emitted — i.e. this run was not silent. */
  readonly alerted: boolean;

  /** `null` when the chain could not be read; the run is recorded regardless. */
  readonly vault: AccountId | null;
  /**
   * What the chain says. `Money` rather than a raw bigint because a token
   * account balance genuinely cannot be negative — the chain will not
   * represent one.
   */
  readonly vaultBalance: Money | null;

  /**
   * The slot the chain reported `vaultBalance` at. `null` when the read failed
   * — never a zero, which would be a claim about slot 0.
   */
  readonly vaultSlot: bigint | null;

  /**
   * The three figures, plus the reserved slice and the total they sum to —
   * as **signed atomic units, not `Money`**.
   *
   * `Money` is defined as a non-negative count and `MoneyUtil` refuses
   * anything below zero, which is right for an amount someone is being charged
   * and wrong for a folded total. A book *can* fold negative, and when it does
   * that is precisely the finding worth reporting: more left the book than
   * ever entered it. Typing these as `Money` would make the reconciler throw
   * while constructing the report that describes the corruption — the one
   * failure mode this whole item exists to prevent.
   */
  readonly agentLiabilitiesAtomic: bigint | null;
  readonly openHoldsAtomic: bigint | null;
  readonly providerPayableAtomic: bigint | null;
  readonly platformFeesAtomic: bigint | null;
  readonly totalLiabilitiesAtomic: bigint | null;
  /** The same total as the `account_balances` snapshot sees it. */
  readonly snapshotLiabilitiesAtomic: bigint | null;

  /** `vaultBalance − totalLiabilities`, **signed**. Negative is a breach. */
  readonly differenceAtomic: bigint | null;

  /** How many journal rows were folded. An audit figure. */
  readonly journalEntries: number;

  // ── The escrow figures ──────────────────────────────────────
  //
  // `null` on a run that could not read the chain, and on every run recorded
  // before the escrow cutover. Same reason every column behind them is
  // nullable: an unknown figure and a zero figure are different answers.

  /** `Σ` over every buyer escrow ATA read this pass. */
  readonly escrowTotalAtomic: bigint | null;
  /** How many escrows were read. A total of zero over zero accounts is not a clean pass. */
  readonly escrowAccounts: number | null;
  /**
   * How many escrows hold less than the open holds against them — a **count**,
   * not a sum: one buyer $500 short and five hundred buyers $1 short are the
   * same money and completely different incidents.
   */
  readonly escrowShortfallAccounts: number | null;

  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}
