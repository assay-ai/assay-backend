/**
 * A deadline for one Redis call on a request path.
 *
 * The shared cache client sets no `commandTimeout` (BullMQ and other users
 * depend on that), so a Redis that accepts the connection but stops answering
 * leaves an `await` waiting until TCP gives up. A call wrapped here rejects
 * with {@link RedisTimeoutError} after `ms` instead, and the caller applies
 * its "Redis unreachable" rule: fail closed, fail open, or skip.
 *
 * The command itself is not cancelled: it may still run on Redis after the
 * deadline. Callers must treat a timeout as "outcome unknown", the same as a
 * dropped connection.
 */
export const REDIS_REQUEST_TIMEOUT_MS = 500;

export class RedisTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Redis did not answer within ${timeoutMs} ms`);
    this.name = 'RedisTimeoutError';
  }
}

export function withRedisTimeout<T>(
  op: () => Promise<T>,
  ms: number = REDIS_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(op());
  } catch (error) {
    return Promise.reject(error);
  }
  // A late rejection, after the deadline won, must not become unhandled.
  pending.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RedisTimeoutError(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}
