import { join } from 'path';

import { DataSource } from 'typeorm';
import { config } from 'dotenv';

import { ParameterlessQueryLogger } from './parameterless-query.logger';

// Load environment variables
config();

/**
 * TypeORM DataSource for PostgreSQL (CLI - migrations)
 * This is separate from the runtime database module
 */
const isLogging = process.env.DATABASE_LOGGING === 'true';

export const PostgresDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  username: process.env.DATABASE_USER || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'starter_db',

  /**
   * Entity and migration globs are anchored on `__dirname`, not on the process
   * working directory, and they cover both extensions.
   *
   * This file is loaded from two different places:
   *
   *  - `src/database/postgres/postgres.data-source.ts` under ts-node, for
   *    `yarn migration:generate` (which needs the `.ts` entities to diff against);
   *  - `dist/database/postgres/postgres.data-source.js` inside the production
   *    image, for `migration:run:prod` — and that image contains only `dist`,
   *    because the Dockerfile's runtime stage never copies `src`.
   *
   * The relative layout is identical in both trees, so one `__dirname`-anchored
   * expression serves both.
   *
   * The previous globs were cwd-relative AND TypeScript-only
   * (`src/database/postgres/migrations/*.ts`). In an image that has no `src/`
   * they matched nothing — and matching nothing is not an error. TypeORM loads
   * zero migrations, finds zero of them pending, prints "No migrations are
   * pending" and exits 0. So `start:prod` (`migration:run:prod && node dist/main`,
   * the image's CMD) reported a successful migration at every container start
   * and then booted the app against a database that had never been migrated.
   * A silent no-op, not a failure — which is why it went unnoticed.
   *
   * `.d.ts` files sitting next to the compiled `.js` are excluded by TypeORM
   * itself (`util/DirectoryExportedClassesLoader.js`), so `{ts,js}` is safe here.
   */
  entities: [join(__dirname, 'entities', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],

  synchronize: false,
  logging: isLogging,
  // As the app does: queries, never their bound parameters (R-OA-27).
  ...(isLogging && { logger: new ParameterlessQueryLogger() }),
  migrationsTransactionMode: 'each',
});
