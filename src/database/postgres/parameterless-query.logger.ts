import { Logger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';

/**
 * The TypeORM logger used when `DATABASE_LOGGING=true`.
 *
 * TypeORM's built-in loggers print every query with its bound parameters,
 * straight to the console. Those parameters are token and code hashes,
 * credential ids and other values R-OA-27 keeps out of logs. This one logs
 * the query text and how many parameters it had, never the values, and goes
 * through Nest's `Logger`, so the line is structured and redacted like every
 * other one. A failed query is logged by its error message only: the driver's
 * `detail` quotes the offending value.
 */
export class ParameterlessQueryLogger implements TypeOrmLogger {
  private readonly logger = new Logger('TypeORM');

  logQuery(query: string, parameters?: unknown[]): void {
    this.logger.debug(`query: ${query}${countOf(parameters)}`);
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
    const message = typeof error === 'string' ? error : error.message;
    this.logger.error(`query failed: ${message} -- ${query}${countOf(parameters)}`);
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
    this.logger.warn(`slow query (${time} ms): ${query}${countOf(parameters)}`);
  }

  logSchemaBuild(message: string): void {
    this.logger.log(message);
  }

  logMigration(message: string): void {
    this.logger.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    const text = typeof message === 'string' ? message : String(message);
    if (level === 'warn') this.logger.warn(text);
    else this.logger.log(text);
  }
}

function countOf(parameters?: unknown[]): string {
  return parameters && parameters.length > 0 ? ` -- ${parameters.length} parameter(s)` : '';
}
