import { RETRYABLE_ERROR_CODES } from '@database/postgres/repositories/abstract.repository';

export async function executeWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isDeadlock =
        error.code === RETRYABLE_ERROR_CODES[0] || error.message?.includes('deadlock');

      if (!isDeadlock || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 5000) + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
