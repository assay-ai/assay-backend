/**
 * `created_at`, cast to a UTC calendar day — shared by every provider report
 * that buckets `payment_intents` by day (`traffic`, `sla-windows`).
 *
 * Mirrors `PaymentIntentRepository`'s private `CREATED_AT_UTC_DAY` /
 * `DAY_EXPR` constants exactly, including the `AT TIME ZONE 'UTC'`
 * requirement — see that file's comment for why the conversion is not
 * optional: `to_char` on a `timestamptz` renders in the *session* time zone
 * without it, so which day a row lands in would depend on where the process
 * runs. Duplicated rather than imported because those constants are private
 * to a repository this module may not edit.
 */
export function dayExpr(alias: string): string {
  return `to_char((${alias}.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
}
