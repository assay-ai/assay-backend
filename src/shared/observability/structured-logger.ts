import { ConsoleLogger, LogLevel } from '@nestjs/common';

import { isSuppressedWarning } from '@shared/utils';

import { redact } from './redact';
import { RequestContext } from './request-context';

/**
 * The structured, correlated, redacted replacement for `FilteredLogger`:
 * structured, correlated by request id, with a strict rule on contents.
 *
 * ## Why this extends `ConsoleLogger` rather than writing a formatter
 *
 * `ConsoleLogger` already has a `json: true` mode (`getJsonLogObject` →
 * `printAsJson`) that Nest 11 ships built in. Extending it means every
 * existing call site in this codebase — `new Logger('SomeService')`, which
 * `Nest`'s own `Logger` class forwards to whatever instance was registered
 * via `app.useLogger()` (`Logger.overrideLogger`, `logger.service.js`) —
 * gets structured JSON and redaction for free, with no call site touched.
 * That forwarding is also how this reaches the BullMQ worker path:
 * `QueueProcessorBase`'s `this.logger = new Logger(this.constructor.name)`
 * (`src/shared/queue/queue-processor.base.ts`) is the same `Logger` class and
 * proxies to the same registered instance.
 *
 * ## What it adds over the base JSON mode
 *
 * - `requestId` / `organizationId` from {@link RequestContext}, read fresh
 *   on every call — never cached on the instance, because one instance is
 *   shared across every request and every job.
 * - {@link redact} applied to the whole emitted object, not just the message
 *   — a caller that logs `{ intentId, headers }` gets the `authorization`
 *   header blanked without knowing this logger exists.
 * - {@link isSuppressedWarning}, imported from `FilteredLogger` rather than
 *   re-implemented, so the two loggers can never drift on which warnings are
 *   noise.
 *
 * ## What it does not do
 *
 * It does not itself enter a `RequestContext` — that is `LoggingInterceptor`
 * for HTTP and `QueueProcessorBase` (`src/shared/queue/queue-processor.base.ts`)
 * for the BullMQ worker path. A log line emitted outside either carries
 * `requestId: null, organizationId: null`, same as one emitted at boot; it is
 * not lost, only uncorrelated.
 */
export class StructuredLogger extends ConsoleLogger {
  constructor(context?: string) {
    super(context, {
      json: true,
      colors: false,
      /**
       * `debug` is off in production. Read
       * at construction time (matching `isEgressLockdownEnabled`'s
       * call-it-inline convention elsewhere in `shared/`), not cached at
       * module load, so a test that flips `NODE_ENV` sees the change.
       */
      logLevels:
        process.env.NODE_ENV === 'production' ? ['log', 'warn', 'error', 'fatal'] : undefined,
    });
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    if (isSuppressedWarning(message)) {
      return;
    }
    super.warn(message, ...(optionalParams as []));
  }

  protected override getJsonLogObject(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: 'stdout' | 'stderr';
      errorStack?: unknown;
    },
  ): {
    level: LogLevel;
    pid: number;
    timestamp: number;
    message: unknown;
    context?: string;
    stack?: unknown;
  } {
    const base = super.getJsonLogObject(message, options);
    const store = RequestContext.get();

    // `redact` is generic over `unknown`; the cast back to `typeof base`
    // is safe because redaction only ever replaces individual values with
    // `REDACTED`/`[CIRCULAR]`/`[TRUNCATED]` strings — it never removes or
    // renames a key — so the shape here is unchanged.
    //
    // The caller's part is redacted *before* the correlation fields are
    // added: `requestId` is a forbidden key when a caller logs it (that name
    // is the OAuth consent request id, R-OA-27), while the one added here is
    // the trace id this logger exists to carry.
    const enriched = {
      ...(redact(base) as typeof base),
      requestId: store?.requestId ?? null,
      organizationId: store?.organizationId ?? null,
      // Present on HTTP requests only; joins a log line to an override entry.
      ...(store?.serverRequestId ? { serverRequestId: store.serverRequestId } : {}),
    };
    return enriched;
  }
}
