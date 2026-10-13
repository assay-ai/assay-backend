import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ChainsApiModule } from '@modules/chains/chains-api.module';
import { ChainsController } from '@modules/chains/controllers/chains.controller';
import { ENABLED_CHAINS_ENV } from '@modules/chains/enabled-chains';
import { CHAIN_IDS, toChainId } from '@modules/chains/ports/caip.types';
import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { ALERT_PORT } from '@shared/alerting';

/**
 * Stands in for `AppApiModule`: imports `ChainsApiModule` and nothing else, so
 * whatever resolves here resolves in the API bootstrap for the same reason.
 */
@Module({ imports: [ChainsApiModule] })
class ApiBootstrapStandIn {}

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;

/** Set `ENABLED_CHAINS` for one `compile()` and put the environment back. */
async function compileWith<T>(value: string, use: (moduleRef: TestingModule) => T): Promise<T> {
  const previousEnabled = process.env[ENABLED_CHAINS_ENV];
  const previousLegacy = process.env.SOLANA_ENABLED_CHAINS;
  process.env[ENABLED_CHAINS_ENV] = value;
  delete process.env.SOLANA_ENABLED_CHAINS;

  let moduleRef: TestingModule | undefined;
  try {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EvmGlobalsStubModule,
        ApiBootstrapStandIn,
      ],
    }).compile();
    return use(moduleRef);
  } finally {
    await moduleRef?.close();
    if (previousEnabled === undefined) delete process.env[ENABLED_CHAINS_ENV];
    else process.env[ENABLED_CHAINS_ENV] = previousEnabled;
    if (previousLegacy === undefined) delete process.env.SOLANA_ENABLED_CHAINS;
    else process.env.SOLANA_ENABLED_CHAINS = previousLegacy;
  }
}

/**
 * The two globals `EvmModule` now reaches for.
 *
 * `ChainsModule` imports `EvmModule`, whose `EvmVoucherRedeemer` alerts on an
 * unnamed revert and whose `EvmGasGrantService` writes a grant ledger. Both are
 * `@Global` in every bootstrap — `AlertingModule` and `PostgresModule` — and are
 * supplied here the same way `tool-module-wiring.spec.ts` already supplies its
 * repositories: the claim this file makes is **the tokens resolve**, and
 * whether Postgres is reachable is a different test and not a unit one.
 */
@Global()
@Module({
  providers: [
    { provide: ALERT_PORT, useValue: { emit: async () => undefined } },
    {
      provide: EvmGasGrantRepository,
      useValue: { hasGranted: async () => false, grantedWeiSince: async () => 0n },
    },
    {
      provide: EvmChainStateRepository,
      useValue: { findAllStates: async () => [], findBlocked: async () => [] },
    },
  ],
  exports: [ALERT_PORT, EvmGasGrantRepository, EvmChainStateRepository],
})
class EvmGlobalsStubModule {}

/**
 * The wiring of `GET /api/v1/chains`.
 *
 * `chains.controller.spec.ts` constructs `ChainDirectoryService` by hand with a
 * list it chose. That proves the mapping and proves *nothing* about where the
 * list comes from in a running process: with `ENABLED_CHAINS` deleted from
 * `ChainsApiModule`'s reach, or with `ChainsController` dropped from its
 * `controllers`, every test in that file stays green and only a real boot
 * fails. This is the same argument `chains.module.wiring.spec.ts` makes for the
 * token itself, one module further out.
 *
 * So: compose the real `ChainsApiModule` under a real `ConfigModule`, from the
 * real environment variable, and ask the controller — not the service — for the
 * answer.
 */
describe('ChainsApiModule wiring — the controller serves ENABLED_CHAINS', () => {
  jest.setTimeout(30_000);

  it('registers the controller and answers from the environment, not from a literal', async () => {
    // `get(ChainsController)` rather than `get(ChainDirectoryService)`: the
    // controller is the thing HTTP reaches, and asking it is what proves the
    // module declares it AND that its one dependency is injectable here.
    const chains = await compileWith(DEVNET, (m) => m.get(ChainsController).list().chains);

    expect(chains.map((chain) => chain.chainId)).toEqual([DEVNET]);
    expect(chains[0].displayName).toBe('Solana devnet');
    expect(chains[0].decimals).toBe(6);
  });

  it('follows the operator through a real container, in the operator’s order', async () => {
    // The service-level order tests build the list by hand. This one comes from
    // a string an operator typed, through `parseEnabledChains`, the metadata
    // assertion and DI — and it is deliberately the order that is NEITHER
    // alphabetical NOR the registry's, so a canonicalisation anywhere along
    // that path shows up here.
    const chains = await compileWith(
      `${DEVNET},${CHAIN_IDS.SOLANA_MAINNET}`,
      (m) => m.get(ChainsController).list().chains,
    );

    expect(chains.map((chain) => chain.chainId)).toEqual([DEVNET, CHAIN_IDS.SOLANA_MAINNET]);
    expect(chains.map((chain) => chain.displayName)).toEqual(['Solana devnet', 'Solana mainnet']);
  });

  it('is mounted at `chains`, which the API bootstrap prefixes to /api/v1/chains', () => {
    // The prefix and the version come from `src/bootstrap/api/main.ts`
    // (`setGlobalPrefix('api')` + URI versioning, default `1`) and are not this
    // module's to declare. What IS this module's is the last segment, and the
    // frontend hard-codes the full path, so pin it.
    expect(Reflect.getMetadata('path', ChainsController)).toBe('chains');
  });
});

/**
 * The metadata gate, at the only place it counts: a boot.
 *
 * `chain-metadata.spec.ts` calls `assertChainMetadata` directly, which proves
 * the function and proves nothing about whether anything calls it — delete the
 * call from `chains.module.ts`'s `ENABLED_CHAINS` factory and every test in
 * that file stays green while the process it was written for starts happily.
 */
describe('ChainsApiModule refuses to boot on a chain it cannot describe', () => {
  jest.setTimeout(30_000);

  it('fails compile() rather than serving a 400 on the first request', async () => {
    await expect(
      compileWith(toChainId('eip155', '4663'), (m) => m.get(ChainsController).list()),
    ).rejects.toThrow(/chain-metadata\.ts/);
  });
});
