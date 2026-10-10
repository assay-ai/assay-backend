/**
 * UTC calendar boundaries for the hourly spend ceiling and the daily and monthly caps.
 *
 * Same rule as `BindingCeilingService`'s `utcDayKey` and
 * `PaymentIntentRepository`'s `CREATED_AT_UTC_DAY`: a cap that reset on the
 * process's local time zone would let two pods answer "has this agent hit its
 * daily cap" differently, and would roll the cap over at a different wall-clock
 * moment depending on where the request happened to land. `Date.UTC` and
 * `getUTCFullYear`/`getUTCMonth`/`getUTCDate`, never `getFullYear` or
 * `getMonth`.
 *
 * `payment_intents.created_at` is `timestamptz` (`abstract.entity.ts`'s own
 * doc comment) and these boundaries are plain absolute instants, so a
 * `created_at >= :boundary` predicate needs no `AT TIME ZONE` conversion —
 * that conversion is only for rendering a **label** ("which day"), not for
 * comparing to an instant, which is exactly the distinction that file draws
 * between `CREATED_AT` and `CREATED_AT_UTC_DAY`.
 */

/** The top of `now`'s UTC hour — the window `max_spend_per_hour` is measured in. */
export function utcHourStart(now: Date): Date {
  const hourMs = 60 * 60_000;
  return new Date(Math.floor(now.getTime() / hourMs) * hourMs);
}

/** Midnight UTC on `now`'s calendar day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Midnight UTC at the start of `now`'s calendar day, plus one day — when the daily cap resets. */
export function utcNextDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Midnight UTC on the 1st of `now`'s calendar month. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Midnight UTC on the 1st of the month after `now`'s — when the monthly cap resets. */
export function utcNextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
