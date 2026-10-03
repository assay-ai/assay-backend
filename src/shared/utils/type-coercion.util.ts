/**
 * Safe type coercion utilities for handling JSON-serialized data (e.g., TypeORM cache)
 *
 * Problem: TypeORM cache serializes Date objects to strings. When deserialized,
 * dates remain as strings, causing `.getTime()` to fail.
 */

/**
 * Safely convert any value to Date object
 * Handles: Date, string (ISO format), number (timestamp), null/undefined
 *
 * @example
 * toDate(new Date()) // Date object
 * toDate("2024-01-26T10:30:00.000Z") // Date object (from cache)
 * toDate(1706266200000) // Date object (from timestamp)
 * toDate(null) // null
 */
export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Safely get timestamp in milliseconds (replacement for .getTime())
 *
 * @example
 * toTimestamp(new Date()) // 1706266200000
 * toTimestamp("2024-01-26T10:30:00.000Z") // 1706266200000
 * toTimestamp(null) // 0
 * toTimestamp(null, -1) // -1 (custom default)
 */
export function toTimestamp(
  value: Date | string | number | null | undefined,
  defaultValue: number = 0,
): number {
  const date = toDate(value);
  return date ? date.getTime() : defaultValue;
}

/**
 * Safely convert any value to number for arithmetic operations
 * Handles: number, string, null/undefined
 *
 * @example
 * toSafeNumber("123.45") // 123.45
 * toSafeNumber(123) // 123
 * toSafeNumber(null) // 0
 * toSafeNumber(undefined, -1) // -1
 */
export function toSafeNumber(
  value: string | number | null | undefined,
  defaultValue: number = 0,
): number {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'number') {
    return isNaN(value) ? defaultValue : value;
  }
  const parsed = parseFloat(String(value));
  return isNaN(parsed) ? defaultValue : parsed;
}
