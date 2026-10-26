/**
 * A duration in seconds as the words a terms table prints: `3600` → `1 hour`,
 * `259200` → `72 hours`, `950400` → `11 days`, `600` → `10 minutes`.
 *
 * Whole days only from four days up, so the slash delay keeps reading as
 * hours (`72 hours`) and the unbonding period as days. Anything that is not a
 * whole number of the unit falls through to the next smaller one.
 */
export function durationText(seconds: number): string {
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds >= 4 * 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}
