/**
 * The one piece of arithmetic behind `first_response_due_at`.
 *
 * Pure, and deliberately small. The queue's promise is "a two-working-day first
 * response", and the migration's docstring is explicit that the due date is
 * computed once, at insert, rather than re-derived at read time: a promise
 * with a date on it, not a rendering detail. This is that computation, kept
 * apart from the service so it can be tested without a database.
 *
 * ## What this deliberately does not do
 *
 * No holiday calendar. Weekend rollover is the whole of it. A
 * calendar is a table that goes stale the moment nobody maintains it for next
 * year, and a stale one is worse than the honest, slightly-pessimistic-around
 * -holidays answer this function gives instead.
 *
 * ## Why day-of-week is read in UTC
 *
 * `AbstractEntity`'s own docstring (`abstract.entity.ts`) records a defect
 * class this codebase has already paid for once: a value read back through the
 * host's local offset instead of UTC. `getDay()` on a `Date` answers in the
 * *host's* time zone; on a UTC host that happens to agree with `getUTCDay()`,
 * and on any other host it can disagree right at a day boundary — the exact
 * shape of bug `Date.getDay()` would reintroduce here. `getUTCDay()` gives the
 * same answer everywhere the process runs.
 */

/** Sunday and Saturday, as `Date#getUTCDay()` returns them. */
const WEEKEND_DAYS: ReadonlySet<number> = new Set([0, 6]);

/** The commitment the queue's copy states: "a two-working-day first response". */
export const FIRST_RESPONSE_WORKING_DAYS = 2;

/**
 * Adds `workingDays` weekdays to `from`, skipping Saturday and Sunday.
 *
 * Walks one calendar day at a time rather than computing an offset, because a
 * closed-form formula for "skip weekends" is exactly the kind of arithmetic
 * that is easy to get off-by-one on at the boundaries (a `from` that already
 * sits on a Friday or a Sunday) and cheap to get right by simulation instead.
 * Two working days is a small, fixed loop bound — this is not a hot path.
 *
 * The time-of-day on `from` is preserved: filing a ticket at 14:00 on a Monday
 * produces a due date at 14:00, not midnight.
 */
export function addWorkingDays(from: Date, workingDays: number): Date {
  if (!Number.isInteger(workingDays) || workingDays < 0) {
    throw new RangeError(`workingDays must be a non-negative integer, got ${workingDays}`);
  }

  let result = new Date(from.getTime());
  let remaining = workingDays;

  while (remaining > 0) {
    result = new Date(result.getTime() + 24 * 60 * 60 * 1000);
    if (!WEEKEND_DAYS.has(result.getUTCDay())) {
      remaining -= 1;
    }
  }

  return result;
}

/** `first_response_due_at`, from the moment a request is filed. */
export function computeFirstResponseDueAt(filedAt: Date): Date {
  return addWorkingDays(filedAt, FIRST_RESPONSE_WORKING_DAYS);
}
