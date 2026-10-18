import { Logger } from '@nestjs/common';

import { ParameterlessQueryLogger } from '@database/postgres/parameterless-query.logger';

/**
 * R-OA-27 (review M5): with `DATABASE_LOGGING=true` the queries are logged,
 * never their bound parameters (token and code hashes, credential ids).
 */
describe('ParameterlessQueryLogger', () => {
  const HASH = 'f'.repeat(64);
  const TOKEN = 'assay_rt_' + 'T'.repeat(43);

  function captured(run: (logger: ParameterlessQueryLogger) => void): string {
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    try {
      run(new ParameterlessQueryLogger());
      return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }

  it('logs the query text and the parameter count, never the parameters', () => {
    const text = captured((logger) => {
      logger.logQuery('SELECT * FROM "oauth_tokens" WHERE "token_hash" = $1', [HASH]);
      logger.logQuerySlow(900, 'UPDATE "x" SET "a" = $1', [TOKEN]);
      logger.logQueryError(new Error('boom'), 'INSERT INTO "y" VALUES ($1, $2)', [HASH, TOKEN]);
    });
    expect(text).toContain('oauth_tokens');
    expect(text).toContain('INSERT INTO');
    expect(text).not.toContain(HASH);
    expect(text).not.toContain(TOKEN);
  });

  it('logs a query error by its message, not the driver detail', () => {
    const error = Object.assign(new Error('duplicate key'), {
      detail: `Key (token_hash)=(${HASH}) already exists.`,
      parameters: [HASH],
    });
    const text = captured((logger) => logger.logQueryError(error, 'INSERT', [HASH]));
    expect(text).toContain('duplicate key');
    expect(text).not.toContain(HASH);
  });
});
