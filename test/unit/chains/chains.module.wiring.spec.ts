import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainsModule } from '@modules/chains/chains.module';
import { ENABLED_CHAINS, ENABLED_CHAINS_ENV } from '@modules/chains/enabled-chains';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { SolanaChainAdapter } from '@modules/chains/solana/solana-chain.adapter';
import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { ALERT_PORT } from '@shared/alerting';

/** What a consuming module sees — `public-reserves-api.module.ts` in miniature. */
const CONSUMED_ENABLED_CHAINS = 'TEST_CONSUMED_ENABLED_CHAINS';

/**
 * Stands in for `PublicReservesApiModule`: imports `ChainsModule` and injects
 * `ENABLED_CHAINS` into a `useFactory`, which is exactly how the real consumer
 * reaches it. If the token is provided but not **exported**, Nest cannot
 * resolve this factory and `compile()` throws — which is the question
 * "is it exported?" actually being asked, rather than asked of `ChainsModule`'s
 * own container, where a provider resolves whether or not it is exported.
 */
@Module({
  imports: [ChainsModule],
  providers: [
    {
      provide: CONSUMED_ENABLED_CHAINS,
      useFactory: (enabled: readonly ChainId[]) => enabled,
      inject: [ENABLED_CHAINS],
    },
  ],
})
class EnabledChainsConsumerModule {}

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
  ],
  exports: [ALERT_PORT, EvmGasGrantRepository],
})
class EvmGlobalsStubModule {}

/**
 * The boot gate for `ENABLED_CHAINS`.
 *
 * Every other test of this gate asserts against a directly-constructed object,
 * which proves the parser, the adapter and the registry and proves *nothing*
 * about the wiring between them: with the `ENABLED_CHAINS` provider deleted
 * from `ChainsModule`, all of them stay green and only a real boot fails. The
 * one gate that would have caught it lives in the integration tree, which
 * `yarn test` does not run.
 *
 * So this composes the real `ChainsModule` under a real `ConfigModule` and
 * asserts the token resolves, reaches both of its in-module consumers, and
 * crosses the module boundary. It is deliberately the *whole* module rather
 * than a hand-built harness — a harness that re-declares the provider would be
 * asserting its own setup.
 */
describe('ChainsModule wiring — ENABLED_CHAINS is provided, exported and injected', () => {
  jest.setTimeout(30_000);

  const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
  const previousEnabled = process.env[ENABLED_CHAINS_ENV];
  const previousLegacy = process.env.SOLANA_ENABLED_CHAINS;

  let moduleRef: TestingModule;

  beforeAll(async () => {
    // Set on `process.env` rather than through `ConfigModule`'s `load`, because
    // `ConfigService.get` reads `process.env` first — and because the variable
    // an operator sets is the thing under test.
    process.env[ENABLED_CHAINS_ENV] = DEVNET;
    delete process.env.SOLANA_ENABLED_CHAINS;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EvmGlobalsStubModule,
        EnabledChainsConsumerModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
    if (previousEnabled === undefined) delete process.env[ENABLED_CHAINS_ENV];
    else process.env[ENABLED_CHAINS_ENV] = previousEnabled;
    if (previousLegacy === undefined) delete process.env.SOLANA_ENABLED_CHAINS;
    else process.env.SOLANA_ENABLED_CHAINS = previousLegacy;
  });

  it('resolves the token to the parsed list', () => {
    expect(moduleRef.get<readonly ChainId[]>(ENABLED_CHAINS)).toEqual([DEVNET]);
  });

  it('reaches the adapter, which narrows to its own namespace', () => {
    expect(moduleRef.get(SolanaChainAdapter).supportedChains).toEqual([DEVNET]);
  });

  it('reaches the registry, which advertises exactly the enabled list', () => {
    expect(moduleRef.get(ChainAdapterRegistry).enabledChains()).toEqual([DEVNET]);
  });

  it('crosses the module boundary into a consumer that imports ChainsModule', () => {
    expect(moduleRef.get<readonly ChainId[]>(CONSUMED_ENABLED_CHAINS)).toEqual([DEVNET]);
  });
});
