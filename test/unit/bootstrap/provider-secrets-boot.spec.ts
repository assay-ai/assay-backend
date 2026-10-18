import { Global, Module, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getEntityManagerToken, getRepositoryToken } from '@nestjs/typeorm';

import { AppApiModule } from '@bootstrap/api/app.module';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { AppSchedulerModule } from '@bootstrap/scheduler/app.module';
import { DatabaseModule } from '@database/database.module';
import { PostgresModule, entities, repositories } from '@database/postgres/postgres.module';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { BINDING_INVOKER } from '@modules/tool/ports/binding-invoker.port';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

/**
 * Which process needs which provider-auth secret in production.
 *
 * `PROVIDER_REQUEST_SIGNING_KEYS` and `CREDENTIAL_VAULT_KEKS` are required, at
 * boot, by the processes that dial providers (api, mcp) — and by nothing else.
 * The scheduler reaches `ToolModule` (slash case briefs, toolset sweeps) but
 * never makes a provider call, so it must boot without either.
 *
 * Each app module is compiled for real — every constructor and factory runs,
 * which is where both secrets are read — with only Postgres and the Redis cache
 * stubbed. `compile()` runs no lifecycle hook, so nothing here queries anything.
 */

// `bull-board.module.ts` has a type error ts-jest reports and the build does not
// (a namespace import of `express-basic-auth` called as a function), so the
// operator console is replaced; it holds neither secret.
jest.mock('../../../src/bull-board/bull-board.module', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Module } = require('@nestjs/common');
  class BullBoardConfigModule {}
  Module({})(BullBoardConfigModule);
  return { BullBoardConfigModule };
});

/** Answers every property and call with itself; never a thenable. */
function inert(): unknown {
  const target = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => (key === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

const dataSourceTokens = [getDataSourceToken('postgres'), getEntityManagerToken('postgres')];
const repositoryTokens = entities.map((entity) => getRepositoryToken(entity, 'postgres'));

@Global()
@Module({
  providers: [
    ...[...repositories, ...dataSourceTokens, ...repositoryTokens].map((token) => ({
      provide: token,
      useFactory: inert,
    })),
  ],
  exports: [...repositories, ...dataSourceTokens, ...repositoryTokens],
})
class StubDatabaseModule {}

@Global()
@Module({
  providers: [
    { provide: REDIS_CACHE_CLIENT, useFactory: inert },
    { provide: CacheService, useFactory: inert },
  ],
  exports: [REDIS_CACHE_CLIENT, CacheService],
})
class StubRedisCacheModule {}

const SIGNING_KEYS = JSON.stringify([
  { keyId: 'boot-test', secretKey: '11'.repeat(16) + '22'.repeat(16) },
]);
const VAULT_KEKS = JSON.stringify([{ keyId: 'boot-test', key: '0123456789abcdef'.repeat(4) }]);

const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  TYPEORM_CACHE_TTL_MULTIPLIER: '1',
  TYPEORM_CACHE_ENABLED: 'false',
  // Never dialled: Postgres is stubbed and compile() opens no connection.
  DATABASE_HOST: 'db.invalid',
  DATABASE_PORT: '5432',
  DATABASE_USER: 'boot-test',
  DATABASE_PASSWORD: 'boot-test',
  DATABASE_NAME: 'boot-test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
  REDIS_URL: 'redis://127.0.0.1:1',
  WEB_APP_URL: 'https://app.example.test',
  MCP_SEARCH_CURSOR_SECRET: 'boot-test-'.repeat(4),
  JWT_SECRET: 'boot-test-jwt-'.repeat(4),
  VERIFIER_SIGNER_BACKEND: 'env',
  VERIFIER_SIGNING_KEYS: JSON.stringify([{ keyId: 'boot-verifier', secretKey: '33'.repeat(32) }]),
  ENABLED_CHAINS: CHAIN_IDS.SOLANA_DEVNET,
};

async function compile(appModule: Type<unknown>, serviceType: string): Promise<TestingModule> {
  process.env.SERVICE_TYPE = serviceType;
  return Test.createTestingModule({ imports: [appModule] })
    .overrideModule(DatabaseModule)
    .useModule(StubDatabaseModule)
    .overrideModule(PostgresModule)
    .useModule(StubDatabaseModule)
    .overrideModule(RedisCacheModule)
    .useModule(StubRedisCacheModule)
    .compile();
}

describe('provider-auth secrets per process (NODE_ENV=production)', () => {
  jest.setTimeout(60_000);
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, PRODUCTION_ENV);
    resetEnvSigningKeyCacheForTests();
  });
  afterEach(() => {
    process.env = saved;
    resetEnvSigningKeyCacheForTests();
  });

  function withSecrets(signing: boolean, vault: boolean): void {
    if (signing) process.env.PROVIDER_REQUEST_SIGNING_KEYS = SIGNING_KEYS;
    else delete process.env.PROVIDER_REQUEST_SIGNING_KEYS;
    if (vault) process.env.CREDENTIAL_VAULT_KEKS = VAULT_KEKS;
    else delete process.env.CREDENTIAL_VAULT_KEKS;
  }

  it('scheduler boots with neither secret', async () => {
    withSecrets(false, false);
    const app = await compile(AppSchedulerModule, 'scheduler');
    try {
      // It still reaches the router (quotes), but holds no invoker.
      expect(app.get(ProviderRouterService, { strict: false })).toBeDefined();
      expect(() => app.get(BINDING_INVOKER, { strict: false })).toThrow();
    } finally {
      await app.close();
    }
  });

  describe.each([
    ['api', AppApiModule],
    ['mcp', AppMcpModule],
  ] as const)('%s', (serviceType, appModule) => {
    it('boots with both secrets', async () => {
      withSecrets(true, true);
      const app = await compile(appModule, serviceType);
      try {
        expect(app.get(BINDING_INVOKER, { strict: false })).toBeInstanceOf(EgressBindingInvoker);
        // The router must hold that invoker, not just have it available: it is
        // @Optional(), so a wiring slip would only surface on the first call.
        const router = app.get(ProviderRouterService, { strict: false }) as unknown as {
          invoker: unknown;
        };
        expect(router.invoker).toBeInstanceOf(EgressBindingInvoker);
      } finally {
        await app.close();
      }
    });

    it('refuses to boot without PROVIDER_REQUEST_SIGNING_KEYS', async () => {
      withSecrets(false, true);
      await expect(compile(appModule, serviceType)).rejects.toThrow(
        'PROVIDER_REQUEST_SIGNING_KEYS is required in production',
      );
    });

    it('refuses to boot without CREDENTIAL_VAULT_KEKS', async () => {
      withSecrets(true, false);
      await expect(compile(appModule, serviceType)).rejects.toThrow(
        'CREDENTIAL_VAULT_KEKS must be set in production',
      );
    });
  });
});
