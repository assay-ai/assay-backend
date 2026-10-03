import { ConsoleLogger } from '@nestjs/common';

/**
 * ConsoleLogger with a hook for suppressing known-noisy third-party warnings.
 *
 * Used by the api and websocket bootstraps. The list is currently empty — the
 * only entry used to be an `AmqpConnection` warning, which went away with
 * RabbitMQ. Add patterns here rather than lowering the global log level.
 *
 * `StructuredLogger` (`src/shared/observability/structured-logger.ts`)
 * preserves this hook rather than duplicating it: it calls
 * {@link isSuppressedWarning} with the same list, so a pattern added here
 * suppresses the noise under either logger.
 */
const SUPPRESSED_WARNING_PATTERNS: string[] = [];

/**
 * Whether `message` matches a suppressed pattern.
 *
 * `patterns` defaults to the module's own list but is overridable — purely so
 * a test can exercise the matching rule without mutating a list every other
 * test also reads.
 */
export function isSuppressedWarning(
  message: unknown,
  patterns: readonly string[] = SUPPRESSED_WARNING_PATTERNS,
): boolean {
  return typeof message === 'string' && patterns.some((pattern) => message.includes(pattern));
}

export class FilteredLogger extends ConsoleLogger {
  warn(message: any, context?: string) {
    if (isSuppressedWarning(message)) {
      return;
    }
    super.warn(message, context);
  }
}
