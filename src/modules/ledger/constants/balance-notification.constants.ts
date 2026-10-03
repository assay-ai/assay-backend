/**
 * The `balance.low` threshold `LedgerJournalService.applyEntries` fires
 * against.
 *
 * The event is defined as *"Once per threshold crossing"*, with no number — the
 * figure is left to the implementation. 5 USDC is a documented placeholder, not a derived value: it
 * is roughly a day's spend for a light integration at the platform's own
 * example prices (`$0.001`–`$0.05`/call), late enough that "you are about to
 * run out" is still true when the notification lands, early enough that it is
 * not "you have already run out" (that is `balance.zero`, a separate event at
 * `0`).
 *
 * Expressed in the asset's own major units so it reads the same regardless of
 * which registered asset's decimals apply — `MoneyUtil.of` and
 * `getAssetMetadata` do the scaling at the point of use.
 */
export const BALANCE_LOW_THRESHOLD_MAJOR_UNITS = 5;

/** Overrides {@link BALANCE_LOW_THRESHOLD_MAJOR_UNITS} without a redeploy. */
export const BALANCE_LOW_THRESHOLD_MAJOR_UNITS_ENV = 'BALANCE_LOW_THRESHOLD_MAJOR_UNITS';
