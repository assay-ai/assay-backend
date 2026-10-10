import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainsModule } from '@modules/chains/chains.module';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { EVM_RELAYER, EvmRelayerPort } from '@modules/chains/evm/ports/evm-relayer.port';
import { ESCROW_BALANCE_READER } from '@modules/ledger/ports/escrow-balance-reader.port';
import {
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  ONCHAIN_STAKE_READER,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import { ESCROW_INTENT_BUILDER } from '@modules/settlement/ports/escrow-intent-builder.port';
import { VERIFIER_REGISTRY } from '@modules/verification/signing/ports/verifier-registry.port';
import { AccountId, CHAIN_IDS, ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { ALERT_PORT } from '@shared/alerting';

const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const DEPLOYMENTS = JSON.stringify({
  [EVM]: {
    config: '0x1111111111111111111111111111111111111111',
    stake: '0x2222222222222222222222222222222222222222',
    escrow: '0x3333333333333333333333333333333333333333',
    asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
    // The two `assertVaultControl` compares the live chain against.
    escrowImplementation: '0x8888888888888888888888888888888888888888',
    admin: '0x9999999999999999999999999999999999999999',
  },
});
const RPC_URLS = JSON.stringify({ [EVM]: 'https://rpc.testnet.chain.robinhood.example' });

/** The two `@Global` providers `ChainsModule`'s graph reaches for. */
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
class GlobalsStubModule {}

/**
 * **Two chains, live** — the assertion is that the module boots.
 *
 * Without this wiring everything was inert: the EVM adapter is conformant, the
 * readers decode real structs, the redeemer batches, and none of them was
 * registered anywhere. Booting `ChainsModule` with both chains enabled is what
 * turns all of it on, and every case here composes the **real** module under a
 * real `ConfigModule` rather than a harness that re-declares the providers —
 * a harness would prove the classes and nothing about the wiring, which is
 * exactly what the fourteen tasks before this one already prove.
 *
 * No RPC is dialled: viem's client is lazy, `EvmRelayer` reads its key at boot
 * and nothing else, and every read here is of a token rather than of a chain.
 */
describe('two chains, enabled together', () => {
  const saved: Record<string, string | undefined> = {};

  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in saved)) saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(saved)) delete saved[key];
  });

  const bootWith = async (overrides: Record<string, string | undefined> = {}) => {
    set({
      ENABLED_CHAINS: `${SOLANA},${EVM}`,
      EVM_DEPLOYMENTS: DEPLOYMENTS,
      EVM_RPC_URLS: RPC_URLS,
      EVM_RELAYER_GAS_GRANT_MAX_WEI: '2000000000000000',
      EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI: '50000000000000000',
      EVM_RELAYER_FLOAT_LOW_WEI: '10000000000000000',
      // One relayer key, so `address()` has something to answer with. A throwaway
      // scalar: it signs nothing here and reaches no chain.
      EVM_RELAYER_KEYS: JSON.stringify([{ chainId: EVM, secretKey: `0x${'11'.repeat(32)}` }]),
      SOLANA_ENABLED_CHAINS: undefined,
      ...overrides,
    });

    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        GlobalsStubModule,
        ChainsModule,
      ],
    }).compile();
  };

  it('boots with two chains and resolves an adapter for each', async () => {
    const app = await bootWith();
    try {
      const registry = app.get(ChainAdapterRegistry);

      expect(registry.enabledChains()).toEqual([SOLANA, EVM]);
      expect(registry.resolve(SOLANA).namespace).toBe(ChainNamespace.SOLANA);
      expect(registry.resolve(EVM).namespace).toBe(ChainNamespace.EIP155);
    } finally {
      await app.close();
    }
  });

  it('binds every multiplexed port to a MULTIPLEXER, not to the Solana class', async () => {
    // The five ports that used to resolve to exactly one Solana class.
    // Asserted on the bound object, because a `useExisting` left pointing at the
    // Solana implementation answers an eip155 question with a Solana account
    // read — and, measured below, that read SUCCEEDS at reaching a wrong
    // account rather than refusing.
    const app = await bootWith();
    try {
      expect(app.get(ESCROW_BALANCE_READER).constructor.name).toBe('NamespaceEscrowBalanceReader');
      expect(app.get(ONCHAIN_STAKE_READER).constructor.name).toBe('NamespaceStakeReader');
      expect(app.get(VOUCHER_REDEEMER).constructor.name).toBe('NamespaceVoucherRedeemer');
      expect(app.get(ESCROW_INTENT_BUILDER).constructor.name).toBe('NamespaceEscrowIntentBuilder');
      expect(app.get(VERIFIER_REGISTRY).constructor.name).toBe('ChainVerifierRegistry');

      // And the redeemer's batch size is the MINIMUM across implementations —
      // Solana's `1` while Solana is enabled, so `VoucherRedemptionService`
      // keeps its per-row path and never hands Solana a batch of 64.
      expect(app.get<VoucherRedeemerPort>(VOUCHER_REDEEMER).maxBatchSize).toBe(1);

      // An empty batch is answered by the multiplexer itself, with no RPC.
      const stake = app.get<OnChainStakeReaderPort>(ONCHAIN_STAKE_READER);
      expect((await stake.bondedStakeOf([])).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('refuses to boot when an enabled eip155 chain has no deployment record', async () => {
    // The failure this replaces is a 500 on a buyer's balance screen.
    await expect(bootWith({ EVM_DEPLOYMENTS: '{}' })).rejects.toThrow(/EVM_DEPLOYMENTS/);
  });

  it('refuses to boot when an enabled eip155 chain has no RPC url', async () => {
    await expect(bootWith({ EVM_RPC_URLS: '{}' })).rejects.toThrow(/EVM_RPC_URLS/);
  });

  it('refuses to boot when a gas-grant cap is unset', async () => {
    // An unset cap is a boot failure, not an unlimited faucet.
    await expect(bootWith({ EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI: undefined })).rejects.toThrow(
      /EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI/,
    );
  });

  it('refuses eip155:4663 — the mainnet USDG address is unmeasured', async () => {
    // The deliverable, not the obstacle. `assertChainMetadata` refuses it
    // unconditionally, and adding an `EVM_DEPLOYMENTS` entry does not help:
    // there is no asset registry row and no chain-metadata row for 4663.
    await expect(
      bootWith({
        ENABLED_CHAINS: `${SOLANA},${CHAIN_IDS.ROBINHOOD_MAINNET}`,
        EVM_DEPLOYMENTS: JSON.stringify({
          [CHAIN_IDS.ROBINHOOD_MAINNET]: {
            config: '0x1111111111111111111111111111111111111111',
            stake: '0x2222222222222222222222222222222222222222',
            escrow: '0x3333333333333333333333333333333333333333',
            asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
          },
        }),
        EVM_RPC_URLS: JSON.stringify({
          [CHAIN_IDS.ROBINHOOD_MAINNET]: 'https://rpc.chain.robinhood.example',
        }),
      }),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_ENABLED_CHAINS_INVALID' });
  });

  it('turning Solana off leaves eip155 entirely unaffected', async () => {
    // N-RESOLVED, and `no-cross-chain-invariant.spec.ts` is the source lock for
    // the same rule: "If turning off Solana perturbs anything on 4663, the
    // independence is not real and that is a defect."
    const app = await bootWith({ ENABLED_CHAINS: EVM });
    try {
      expect(app.get(ChainAdapterRegistry).enabledChains()).toEqual([EVM]);
      await expect(app.get<EvmRelayerPort>(EVM_RELAYER).address(EVM)).resolves.toContain(EVM);
    } finally {
      await app.close();
    }
  });

  it('turning eip155 off leaves Solana entirely unaffected, and demands NO evm config', async () => {
    // The mirror, and the one that matters for every deployment running today:
    // a Solana-only process must boot with every EVM variable unset, including
    // the gas-grant caps that have no defaults.
    const app = await bootWith({
      ENABLED_CHAINS: SOLANA,
      EVM_DEPLOYMENTS: undefined,
      EVM_RPC_URLS: undefined,
      EVM_RELAYER_KEYS: undefined,
      EVM_RELAYER_GAS_GRANT_MAX_WEI: undefined,
      EVM_RELAYER_GAS_GRANT_DAILY_MAX_WEI: undefined,
      EVM_RELAYER_FLOAT_LOW_WEI: undefined,
    });
    try {
      expect(app.get<readonly ChainId[]>(ENABLED_CHAINS)).toEqual([SOLANA]);
      expect(app.get(ChainAdapterRegistry).enabledChains()).toEqual([SOLANA]);
      // And the EVM adapter is registered but declares no chains, so the
      // registry's own invariants — not a branch in the module — keep it
      // unreachable.
      expect(app.get(ChainAdapterRegistry).resolve(SOLANA).namespace).toBe(ChainNamespace.SOLANA);
    } finally {
      await app.close();
    }
  });

  it('a stake read for an eip155 provider reaches the EVM reader, not Solana', async () => {
    // The defect this wiring exists to fix, end to end through the real container,
    // and MEASURED in both directions rather than asserted as an absence.
    //
    // `OnChainProviderStakeSource` hands the UNION of stake authorities to
    // `ONCHAIN_STAKE_READER`, and before the multiplexer that single reader was
    // Solana's. Asking it about an `0x` address does **not** fail cleanly: the
    // 42-character hex string decodes as base58, a PDA is derived from it, and
    // the reader comes back with `CHAIN_ACCOUNT_LAYOUT_UNEXPECTED` — it read a
    // real account belonging to somebody else. Measured on this tree by
    // reverting the binding to `useExisting: SolanaSettlementStakeReader`:
    //
    //   CHAIN_ACCOUNT_LAYOUT_UNEXPECTED — On-chain account does not match the
    //   expected layout (AhugtuyU1rCk41iLFBDMR2vC1bWy345pPeNwMjm3Lggf)
    //
    // With the multiplexer bound, the same call reaches viem and fails at the
    // RPC instead, which is the EVM reader having actually tried.
    const app = await bootWith();
    try {
      const reader = app.get<OnChainStakeReaderPort>(ONCHAIN_STAKE_READER);
      const evmAccount = `${EVM}:0x5B38Da6a701c568545dCfcB03FcB875f56beddC4` as AccountId;

      const error = await reader
        .bondedStakeOf([evmAccount])
        .then(() => null)
        .catch((e: Error & { errorCode?: string }) => e);

      expect(error).not.toBeNull();
      expect(error?.errorCode).toBeUndefined();
      expect(error?.name).toBe('ContractFunctionExecutionError');
    } finally {
      await app.close();
    }
  });
});
