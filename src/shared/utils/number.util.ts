/**
 * Convert value to number safely
 * Handles string, number, or null/undefined values
 *
 * **Never use this for money.** It goes through `parseFloat`, which cannot
 * represent every 6-decimal USDC amount exactly and rounds silently instead of
 * failing. Amounts belong in `Money` and go through `MoneyUtil`
 * (`@shared/utils/money.util`), which is integer-only and range-checked.
 *
 * Currently unused — it is a starter-template leftover kept for non-monetary
 * coercion. If it is still unused when the domain lands, delete it.
 */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  return parseFloat(String(value)) || 0;
}
