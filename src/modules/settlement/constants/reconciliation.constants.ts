/**
 * Reconciler bounds.
 *
 * The cadence is fixed at five minutes for both proof of reserves and
 * reconciliation; the thresholds below are this file's own decisions and each
 * says why.
 */

/**
 * Every five minutes, on the minute.
 *
 * Written out rather than `CronExpression.EVERY_5_MINUTES` so the cadence the
 * docs promise is greppable as a literal, and so changing it is a change to
 * this line rather than to an import.
 */
export const RECONCILIATION_CRON = '0 */5 * * * *';

/**
 * How short the vault may be before it is a breach: **not at all**.
 *
 * There is no tolerance on this side and there must not be. A shortfall of one
 * atomic unit is still value the ledger says someone owns and the chain says
 * is not there, and the only two causes are an accounting bug or funds leaving
 * without an entry. Both are stop-everything conditions, and a threshold here
 * would be a decision about how much of someone else's money may be missing
 * before anyone is told.
 */
export const RECONCILIATION_SHORTFALL_TOLERANCE_ATOMIC = 0n;

/**
 * How much unexplained surplus is tolerated before warning, in **whole units**
 * of the asset (so `1` is $1.00 of USDC, whatever its decimals).
 *
 * Surplus is not symmetric with shortfall. The vault holding more than the
 * ledger accounts for means value arrived without being credited — a deposit
 * whose ledger write failed, or a stranger transferring straight to the vault
 * ATA, which anyone can do and nobody can prevent. The first strands an
 * agent's money and must be investigated; the second is noise. Both warn
 * rather than page: nobody's money is missing, and paging on a figure a
 * stranger controls hands them a way to wake on-call at will.
 */
export const RECONCILIATION_SURPLUS_TOLERANCE_UNITS = 1n;

/**
 * How many consecutive runs may fail before the failure itself is a page.
 *
 * One failed chain read is an RPC blip. Three in a row is fifteen minutes in
 * which nothing was checking the money, and a reconciler that is not running
 * is indistinguishable — from the outside — from a reconciler that keeps
 * finding nothing. This is the check that makes the silence meaningful.
 */
export const RECONCILIATION_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a WARN-severity finding holds its silence once it has paged, in
 * seconds — a day, against the one-hour default in `SuppressingAlertSink`.
 *
 * The severities mean different things about time. A `CRITICAL` finding is
 * money that is wrong now and someone is expected to be acting on it, so the
 * hourly repeat is the reminder it is meant to be. A `WARN` means "a human
 * should look during working hours" — an unexplained surplus, or a chain read that failed but not
 * yet often enough to be blind. Repeating those every hour through the night
 * says nothing new and costs the channel the attention a `CRITICAL` needs.
 *
 * `CRITICAL` deliberately has no constant here: it stays on the sink's default
 * so that the escalation from WARN to CRITICAL is also an escalation in how
 * often it speaks.
 */
export const RECONCILIATION_WARN_ALERT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * How many buyer escrows one page of the reconciler's mirror walk carries.
 *
 * The walk is keyset-paginated through `BuyerEscrowRepository.listAll`, and this
 * is the Postgres page size — not the RPC batch size, which is bounded
 * separately by `getMultipleAccounts`'s own 100-account limit and is what keeps
 * the RPC cost flat as buyers grow. Two numbers because
 * each escrow costs **two** accounts to read (the `BuyerEscrow` PDA and its
 * ATA), so one page of 100 escrows is two RPC calls, not one.
 */
export const RECONCILIATION_ESCROW_PAGE = 100;

/** Alert names. Stable strings: routing rules and runbooks key off them. */
export const RECONCILIATION_ALERTS = {
  RESERVES_BREACH: 'reserves_breach',
  UNEXPLAINED_SURPLUS: 'reserves_unexplained_surplus',
  SNAPSHOT_DRIFT: 'ledger_snapshot_drift',
  NEGATIVE_BOOK: 'ledger_negative_book',
  RECONCILIATION_FAILED: 'reconciliation_failed',
  RECONCILIATION_BLIND: 'reconciliation_blind',
  ESCROW_SHORTFALL: 'escrow_shortfall',
  ESCROW_MIRROR_DRIFT: 'escrow_mirror_drift',
  HELD_ORPHAN: 'held_orphan',
  ESCROW_UNCREDITED_DEPOSIT: 'escrow_uncredited_deposit',
  ESCROW_SEQ_REALIGNED: 'escrow_seq_realigned',
  RECONCILIATION_SCAN_TIMEOUT: 'reconciliation_scan_timeout',
} as const;

/**
 * Most `held(payer, seq)` reads one pass spends naming orphan holds (A2), and
 * only while the escrow holds more than the mirror. The highest seqs with no
 * intent are read first.
 */
export const RECONCILIATION_HELD_ORPHAN_SCAN_MAX = 256;

/** Of those, at most this many for one escrow, so one escrow cannot spend the whole pass. */
export const RECONCILIATION_HELD_ORPHAN_SCAN_PER_ACCOUNT = 64;

/** `held(payer, seq)` reads in flight at once: the RPC quota is shared with redemptions. */
export const RECONCILIATION_HELD_READ_CONCURRENCY = 8;

/**
 * The A2 scans' overall time budget per pass. They run after the run row is
 * written and never delay it; what does not finish waits for the next pass.
 */
export const RECONCILIATION_NAMED_SCAN_BUDGET_MS = 30_000;

/** Most escrows one pass scans for uncredited deposits (A2); the rest wait a pass. */
export const RECONCILIATION_DEPOSIT_SCAN_MAX_ACCOUNTS = 20;
