const SECONDS_PER_DAY = 86400;

/**
 * Normalize timestamp to 10-digit Unix timestamp (seconds)
 * Handles both seconds (10 digits) and milliseconds (13 digits) timestamps
 *
 * @param timestamp - Unix timestamp in seconds or milliseconds
 * @returns Unix timestamp in seconds (10 digits)
 *
 * @example
 * normalizeToSeconds(1734403200) // 1734403200 (already in seconds)
 * normalizeToSeconds(1734403200000) // 1734403200 (converted from milliseconds)
 */
export function normalizeToSeconds(timestamp: number): number {
  // If timestamp is greater than 9999999999 (year 2286), it's in milliseconds (13 digits)
  // Convert to seconds by dividing by 1000
  if (timestamp > 9999999999) {
    return Math.floor(timestamp / 1000);
  }
  // Already in seconds (10 digits)
  return timestamp;
}

/**
 * Convert Date object to Unix timestamp in seconds (10 digits)
 *
 * @param date - Date object or date string
 * @returns Unix timestamp in seconds (10 digits)
 *
 * @example
 * dateToSeconds(new Date('2024-12-17')) // 1734403200
 * dateToSeconds('2024-12-17') // 1734403200
 */
export function dateToSeconds(date: Date | string): number {
  const dateObj = date instanceof Date ? date : new Date(date);
  return Math.floor(dateObj.getTime() / 1000);
}

/**
 * Convert Unix timestamp in seconds to Date object
 *
 * @param timestamp - Unix timestamp in seconds (10 digits)
 * @returns Date object
 *
 * @example
 * secondsToDate(1734403200) // Date object for 2024-12-17
 */
export function secondsToDate(timestamp: number): Date {
  return new Date(timestamp * 1000);
}

// Helper methods
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function secondsToDays(seconds: number): number {
  return seconds / SECONDS_PER_DAY;
}
