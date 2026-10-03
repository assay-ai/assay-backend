/**
 * Delays the execution of the subsequent code by the specified number of milliseconds.
 *
 * @param ms - The number of milliseconds to delay
 * @returns A Promise that resolves after the delay
 *
 * @example
 * // Delay for 1 second
 * await delay(1000);
 *
 * @example
 * // Use in a loop with delay between iterations
 * for (const item of items) {
 *   await processItem(item);
 *   await delay(500); // Wait 500ms between items
 * }
 */
export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
