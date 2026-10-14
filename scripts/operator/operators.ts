/**
 * `yarn operator:add | operator:list | operator:remove` — bootstrap and
 * maintain the operator directory from the database. See
 * `lib/operator-cli.ts` for the flags, and `docs/runbooks/operator-access.md`.
 */
import { INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OperatorSessionStore } from '@modules/operator/auth/operator-session.store';
import { RedisCacheProvider } from '@shared/cache/redis-cache/redis-cache.provider';

import { OperatorCliError, runOperatorCli } from './lib/operator-cli';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
  ],
  // Redis, for one thing: `remove` revokes the operator's live sessions.
  providers: [RedisCacheProvider, OperatorSessionStore],
})
class OperatorCliModule {}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  let app: INestApplicationContext | null = null;
  let failed = false;
  try {
    app = await NestFactory.createApplicationContext(OperatorCliModule, {
      logger: ['error', 'warn'],
      abortOnError: false,
    });
    await runOperatorCli(
      app.get(OperatorRepository),
      app.get(OperatorSessionStore),
      command,
      argv,
      (line) => console.log(line),
    );
  } catch (error) {
    failed = true;
    console.error(error instanceof OperatorCliError ? error.message : error);
  } finally {
    await app?.close().catch(() => undefined);
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(failed ? 1 : 0);
  }
}

void main();
