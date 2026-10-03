import { RequestContext, StructuredLogger } from '@shared/observability';
import { isSuppressedWarning } from '@shared/utils';

/**
 * Observability — what actually reaches the process's own streams.
 *
 * Same technique as `logging-alert.sink.spec.ts`: capture what the process
 * would really write and assert on that, not on an internal call.
 * `ConsoleLogger`'s JSON path (`console-logger.service.js`'s `printAsJson`)
 * routes `error`/`fatal` to `process.stderr.write` and everything else to
 * `process.stdout.write` — both are captured here into one ordered line list,
 * because `StructuredLogger` extends `ConsoleLogger` in `json` mode rather
 * than reimplementing formatting (see the class docstring for why).
 */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const capture = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
  const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  return {
    lines,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

function lastLogged(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe('StructuredLogger', () => {
  it('emits one parseable JSON line per call, carrying the standard fields', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('MyService').log('hello');
    } finally {
      restore();
    }

    const line = lastLogged(lines);
    expect(line.level).toBe('log');
    expect(line.message).toBe('hello');
    expect(line.context).toBe('MyService');
    expect(typeof line.timestamp).toBe('number');
    expect(typeof line.pid).toBe('number');
  });

  it('carries requestId: null and organizationId: null outside any RequestContext.run()', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('X').log('no context active');
    } finally {
      restore();
    }

    const line = lastLogged(lines);
    expect(line.requestId).toBeNull();
    expect(line.organizationId).toBeNull();
  });

  it('carries the ambient requestId and organizationId when logged from inside RequestContext.run()', () => {
    const { lines, restore } = captureStdout();
    try {
      RequestContext.run({ requestId: 'req-42', organizationId: 'org-7' }, () => {
        new StructuredLogger('Verification').log('judged intent pi_1');
      });
    } finally {
      restore();
    }

    const line = lastLogged(lines);
    expect(line.requestId).toBe('req-42');
    expect(line.organizationId).toBe('org-7');
  });

  it('reads a fresh RequestContext on every call — the instance itself carries no request state', () => {
    const logger = new StructuredLogger('Shared');
    const { lines, restore } = captureStdout();
    try {
      RequestContext.run({ requestId: 'first', organizationId: null }, () => logger.log('a'));
      RequestContext.run({ requestId: 'second', organizationId: null }, () => logger.log('b'));
    } finally {
      restore();
    }

    expect(lines.map((line) => JSON.parse(line).requestId)).toEqual(['first', 'second']);
  });

  it('redacts a forbidden key inside a structured message object', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('Account').log({
        agentId: 'agent_1',
        token: 'x402_live_secret_value',
      });
    } finally {
      restore();
    }

    const line = lastLogged(lines);
    const message = line.message as Record<string, unknown>;
    expect(message.agentId).toBe('agent_1');
    expect(message.token).toBe('[REDACTED]');
  });

  it('redacts an env-var-shaped secret nested under the message', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('Boot').log({
        config: { DATABASE_PASSWORD: 'hunter2', VERIFIER_SIGNING_KEYS: 'k1,k2' },
      });
    } finally {
      restore();
    }

    const message = lastLogged(lines).message as { config: Record<string, unknown> };
    expect(message.config.DATABASE_PASSWORD).toBe('[REDACTED]');
    expect(message.config.VERIFIER_SIGNING_KEYS).toBe('[REDACTED]');
  });

  it('writes an error-level line with the stack trace attached', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('X').error('settlement failed', new Error('boom').stack);
    } finally {
      restore();
    }

    const line = lastLogged(lines);
    expect(line.level).toBe('error');
    expect(line.message).toBe('settlement failed');
    expect(typeof line.stack).toBe('string');
  });

  it('preserves FilteredLogger’s suppression hook rather than dropping it — currently a no-op because the pattern list is empty', () => {
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('X').warn('anything, since SUPPRESSED_WARNING_PATTERNS is empty today');
    } finally {
      restore();
    }

    // Documents the current, honest state: nothing is suppressed yet. The
    // predicate both loggers now share is exercised directly below.
    expect(lines).toHaveLength(1);
  });

  it('shares its suppression predicate with FilteredLogger, and that predicate matches by substring', () => {
    expect(isSuppressedWarning('a noisy AmqpConnection warning', ['AmqpConnection'])).toBe(true);
    expect(isSuppressedWarning('an unrelated warning', ['AmqpConnection'])).toBe(false);
    expect(isSuppressedWarning({ not: 'a string' }, ['AmqpConnection'])).toBe(false);
  });

  it('disables debug and verbose when constructed under NODE_ENV=production — "off in production" per the doc', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { lines, restore } = captureStdout();
    try {
      const logger = new StructuredLogger('X');
      logger.debug('should not appear');
      logger.verbose('should not appear either');
      logger.log('should still appear');
    } finally {
      restore();
      process.env.NODE_ENV = original;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe('should still appear');
  });

  it('keeps debug enabled outside production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const { lines, restore } = captureStdout();
    try {
      new StructuredLogger('X').debug('visible outside production');
    } finally {
      restore();
      process.env.NODE_ENV = original;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('debug');
  });
});
