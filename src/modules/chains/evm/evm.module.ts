import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ALERT_PORT, AlertPort } from '@shared/alerting';
import { EgressHttpClient } from '@shared/network/egress';
import { NetworkModule } from '@shared/network/network.module';

import { ENABLED_CHAINS } from '../enabled-chains';
import { EnabledChainsModule } from '../enabled-chains.module';
import { ChainErrors } from '../errors/chains.errors';
import { ChainId, ChainNamespace, isChainId, namespaceOf } from '../ports/caip.types';
import { EvmChainAdapter } from './evm-chain.adapter';
import { EvmDepositRequirementsBuilder } from './evm-deposit-requirements-builder.service';
import { EvmEscrowBalanceReader } from './evm-escrow-balance-reader.service';
import { EvmEscrowOpener } from './evm-escrow-opener.service';
import { EvmEscrowIntentBuilder } from './evm-escrow-intent-builder.service';
import { EvmFacilitator } from './evm-facilitator.service';
import {
  EVM_GAS_GRANT_CAPS,
  EVM_GAS_GRANT_CONFIG,
  EVM_GAS_GRANT_DAILY_MAX_WEI_ENV,
  EVM_GAS_GRANT_MAX_WEI_ENV,
  EVM_RELAYER_FLOAT_LOW_WATER_ENV,
  EvmGasGrantService,
  parseGasGrantCaps,
} from './evm-gas-grant.service';
import { EvmRelayedEscrowIntentSubmitter } from './evm-relayed-escrow-intent.service';
import { EVM_REDEEMER_IDENTITY, EVM_RELAYER_IDENTITY, EvmRelayer } from './evm-relayer.service';
import { readEvmRelayerTiming } from './evm-relayer-timing';
import { EVM_REDEEMER, EVM_RELAYER } from './ports/evm-relayer.port';
import {
  EVM_REDEEMER_KEYS_ENV,
  EVM_REDEEMER_KEY_SOURCES,
  EVM_RELAYER_KEY_SOURCES,
  EvmRelayerKeySource,
  assertDistinctRedeemerKeys,
  keyAddressesByChain,
  takeEvmRelayerKeys,
} from './evm-relayer-key-source';
import { DEFAULT_EVM_PARAMS_TTL_MS, EvmStakeReader } from './evm-stake-reader.service';
import { EvmStakeIntentBuilder } from './evm-stake-intent-builder.service';
import { EvmVerifierRegistryService } from './evm-verifier-registry.service';
import { EvmVaultService } from './evm-vault.service';
import { EvmHeldPayments, parseHoldLiveChains } from './evm-held-payments.service';
import {
  EvmEscrowDepositLogs,
  parseDepositLookbackBlocks,
} from './evm-escrow-deposit-logs.service';
import { EvmVoucherRedeemer } from './evm-voucher-redeemer.service';
import { EvmMinimumStakeReader } from './evm-minimum-stake-reader.service';
import { EvmTightenDelayProbe } from './evm-tighten-delay.probe';
import { DEFAULT_EVM_SLASH_BATCH_SIZE, EvmSlashExecutor } from './evm-slash-executor.service';
import { ModuleRef } from '@nestjs/core';
import { VerifierSigningService } from '@modules/verification/signing/services/verifier-signing.service';
import {
  EVM_DEPLOYMENTS,
  EVM_RPC_CLIENTS,
  EvmDeployment,
  MULTICALL3_ADDRESS,
} from './evm.constants';
import { Chain } from 'viem';

import { createSanctionedEvmClient } from './sanctioned-evm-rpc';
import { EvmChainStateRepository } from '@database/postgres/repositories/evm-chain-state.repository';
import {
  DEFAULT_EVM_CHAIN_STATE_POLL_MS,
  EvmChainStateService,
} from './chain-state/evm-chain-state.service';

/** The two variables an eip155 chain cannot be served without. */
export const EVM_RPC_URLS_ENV = 'EVM_RPC_URLS';

/**
 * The minimal viem `Chain` for a CAIP-2 eip155 id.
 *
 * viem needs a chain object for two things only on this path: the numeric id it
 * asserts responses against, and `contracts.multicall3.address`, without which
 * every batched `readContract` is refused before it is sent. Nothing here is
 * network configuration — the RPC url comes from `EVM_RPC_URLS` and the
 * transport is still the sanctioned egress client.
 */
function evmChainOf(chainId: ChainId): Chain {
  const reference = Number(chainId.split(':')[1]);

  return {
    id: reference,
    name: chainId,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // Never used: the transport is `custom(...)`, so viem issues no request of
    // its own. Present because the type requires it.
    rpcUrls: { default: { http: [] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  };
}

export const EVM_DEPLOYMENTS_ENV = 'EVM_DEPLOYMENTS';

/**
 * Every `eip155` provider, wired.
 *
 * Without this module the EVM pieces are **inert**: the adapter is conformant,
 * the readers decode real structs, the relayer signs, the redeemer batches, and
 * nothing resolves any of them. The `extractSettledAmount` guard predates this
 * wiring precisely so that enabling the chain would not be the first time it
 * ran.
 *
 * ## Two boot rules, and why they are boot rules
 *
 * The Solana settlement program id is a **call-time** failure, deliberately: a
 * deployment that never touches the program is unaffected by it being unset.
 * That reasoning does not carry here. An enabled `eip155` chain with no escrow
 * address cannot answer a balance, a quote or a redemption, so the first symptom
 * would be a 500 on a buyer's screen rather than a line in a boot log. Both
 * `EVM_DEPLOYMENTS` and `EVM_RPC_URLS` must cover every enabled eip155 chain or
 * the process refuses to start.
 *
 * The mirror of that rule matters as much: **with no eip155 chain enabled this
 * module demands nothing.** `EVM_RPC_URLS` unset on a Solana-only deployment is
 * not an error, the maps are empty, `EvmChainAdapter.supportedChains` is empty,
 * and `ChainAdapterRegistry` never reaches it. Turning Solana off must leave
 * 46630 unaffected and turning EVM off must leave Solana unaffected;
 * `no-cross-chain-invariant.spec.ts` is the source lock for the same rule.
 *
 * ## `FeePayerSignerModule` is not imported here
 *
 * `EvmRelayer` resolves nothing through it. The relayer key is EVM's and the fee
 * payer's is Solana's, and a process that has business with one may have none
 * with the other — the API, worker and MCP bootstraps already differ on the fee
 * payer for exactly that reason.
 *
 * ## `eip155:4663` cannot be enabled from here or anywhere
 *
 * `assertChainMetadata` refuses it at boot because the mainnet USDG address is
 * unmeasured (`docs/chain-facts.md` in assay-evm), so it never reaches this module's
 * factories. Adding an `EVM_DEPLOYMENTS` entry for it does not help and is not a
 * workaround: the asset registry has a testnet row only.
 */
@Module({
  // `createSanctionedEvmClient` issues every JSON-RPC request through
  // `EgressHttpClient` — see `sanctioned-evm-rpc.ts` for why viem's own `http()`
  // transport cannot be used. `NetworkModule` is `@Global`, and is imported here
  // so this module's graph stands on its own.
  imports: [NetworkModule, EnabledChainsModule],
  providers: [
    {
      /**
       * One sanctioned client per enabled eip155 chain, or the boot fails.
       */
      provide: EVM_RPC_CLIENTS,
      useFactory: (
        config: ConfigService,
        enabled: readonly ChainId[],
        httpClient: EgressHttpClient,
      ) => {
        const urls = parseEvmChainMap(config.get<string>(EVM_RPC_URLS_ENV), EVM_RPC_URLS_ENV);
        assertCoversEnabled(urls, enabled, EVM_RPC_URLS_ENV);

        return new Map(
          [...urls].map(([chainId, url]) => [
            chainId,
            createSanctionedEvmClient(readRpcUrl(url, chainId), httpClient, evmChainOf(chainId)),
          ]),
        );
      },
      inject: [ConfigService, ENABLED_CHAINS, EgressHttpClient],
    },
    {
      /**
       * A deployment record per enabled eip155 chain, or the boot fails.
       */
      provide: EVM_DEPLOYMENTS,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]) => {
        const raw = parseEvmChainMap(config.get<string>(EVM_DEPLOYMENTS_ENV), EVM_DEPLOYMENTS_ENV);
        assertCoversEnabled(raw, enabled, EVM_DEPLOYMENTS_ENV);

        return new Map(
          [...raw].map(([chainId, value]) => [chainId, readDeployment(value, chainId)]),
        );
      },
      inject: [ConfigService, ENABLED_CHAINS],
    },

    {
      /**
       * The relayer's key(s), read once and **deleted from `process.env`**.
       *
       * Deliberately NOT asserted to cover the enabled chains. A read-only
       * deployment — the reconciler, an operator console — serves eip155
       * balances and quotes perfectly well with no relayer key at all, and
       * demanding one would put a private key in every process that has no
       * business holding one. `EvmRelayer.accountFor` fails loudly at the first
       * send instead, which is the same shape `FEE_PAYER_SIGNER` already has.
       */
      provide: EVM_RELAYER_KEY_SOURCES,
      useFactory: (): readonly EvmRelayerKeySource[] => takeEvmRelayerKeys(process.env),
    },
    {
      /**
       * The REDEEMER's key(s) — `Config.params().redeemer` — read once and
       * deleted from `process.env`, exactly like the relayer's, and likewise
       * not required to cover the enabled chains: a process that never redeems
       * holds no redeemer key, and `EvmVoucherRedeemer` fails loudly at its
       * first send instead.
       *
       * The boot DOES refuse one thing: a chain whose redeemer key is the
       * relayer key. The relayer carries buyer-signed requests and has no
       * on-chain role; the redeemer is the only sender `redeemVoucher[Batch]`
       * accepts. One key in both places makes a leak of either the leak of
       * both.
       */
      provide: EVM_REDEEMER_KEY_SOURCES,
      useFactory: (relayer: readonly EvmRelayerKeySource[]): readonly EvmRelayerKeySource[] => {
        const redeemer = takeEvmRelayerKeys(process.env, EVM_REDEEMER_KEYS_ENV);
        assertDistinctRedeemerKeys(relayer, redeemer);
        return redeemer;
      },
      inject: [EVM_RELAYER_KEY_SOURCES],
    },
    {
      provide: EvmRelayer,
      useFactory: (
        clients: ReadonlyMap<ChainId, never>,
        sources: readonly EvmRelayerKeySource[],
        alerts: AlertPort,
        config: ConfigService,
      ) =>
        new EvmRelayer(
          clients,
          sources,
          alerts,
          readOptionalWei(config.get<string>(EVM_RELAYER_FLOAT_LOW_WATER_ENV)),
          readEvmRelayerTiming((key) => config.get<string>(key)),
          EVM_RELAYER_IDENTITY,
        ),
      inject: [EVM_RPC_CLIENTS, EVM_RELAYER_KEY_SOURCES, ALERT_PORT, ConfigService],
    },
    // The token, for the consumers that hold the PORT rather than the class —
    // `EvmGasGrantService`, `EvmRelayedEscrowIntentSubmitter`, the slash
    // executor and the float monitor. None may reach a `sendRawTransaction`,
    // and the port is what says so.
    { provide: EVM_RELAYER, useExisting: EvmRelayer },
    {
      /**
       * A second `EvmRelayer`, holding the REDEEMER key. Only
       * `EvmVoucherRedeemer` (and the float monitor, read-only) receives it.
       */
      provide: EVM_REDEEMER,
      useFactory: (
        clients: ReadonlyMap<ChainId, never>,
        sources: readonly EvmRelayerKeySource[],
        alerts: AlertPort,
        config: ConfigService,
      ) =>
        new EvmRelayer(
          clients,
          sources,
          alerts,
          readOptionalWei(config.get<string>(EVM_RELAYER_FLOAT_LOW_WATER_ENV)),
          readEvmRelayerTiming((key) => config.get<string>(key)),
          EVM_REDEEMER_IDENTITY,
        ),
      inject: [EVM_RPC_CLIENTS, EVM_REDEEMER_KEY_SOURCES, ALERT_PORT, ConfigService],
    },

    {
      provide: EvmChainAdapter,
      useFactory: (
        clients: ReadonlyMap<ChainId, never>,
        deployments: ReadonlyMap<ChainId, EvmDeployment>,
        enabled: readonly ChainId[],
        config: ConfigService,
      ) =>
        // The INTERSECTION of what is configured with what is enabled, so a
        // Solana-only deployment produces an adapter declaring no chains and
        // `ChainAdapterRegistry` never reaches it.
        new EvmChainAdapter(
          clients,
          deployments,
          enabled.filter((chainId) => deployments.has(chainId)),
          depositConfirmationsFrom(config.get<string>('EVM_DEPOSIT_CONFIRMATIONS')),
        ),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, ENABLED_CHAINS, ConfigService],
    },

    {
      provide: EvmEscrowBalanceReader,
      useFactory: (clients: never, deployments: never) =>
        new EvmEscrowBalanceReader(clients, deployments),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
    {
      // The escrow opener, on a chain with nothing to open — see the class. It
      // takes the balance reader and nothing else: no client, no deployment map
      // and above all no relayer, so there is no send capability to hand out.
      provide: EvmEscrowOpener,
      useFactory: (escrows: EvmEscrowBalanceReader) => new EvmEscrowOpener(escrows),
      inject: [EvmEscrowBalanceReader],
    },
    // Pure — no RPC, no clock, no key. An EVM transaction's lifetime is the
    // wallet's nonce, so unlike the Solana builder there is nothing to fetch.
    EvmDepositRequirementsBuilder,
    {
      provide: EvmStakeReader,
      useFactory: (clients: never, deployments: never) =>
        new EvmStakeReader(clients, deployments, {
          now: () => Date.now(),
          paramsTtlMs: DEFAULT_EVM_PARAMS_TTL_MS,
        }),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
    {
      // A provider's stake doors, build-only: a read client and the deployment
      // map, and no relayer — there is nothing here to send with.
      provide: EvmStakeIntentBuilder,
      useFactory: (clients: never, deployments: never, gate: EvmChainStateService) =>
        new EvmStakeIntentBuilder(clients, deployments, gate),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, EvmChainStateService],
    },
    {
      provide: EvmEscrowIntentBuilder,
      useFactory: (clients: never, deployments: never, gate: EvmChainStateService) =>
        // The wall clock is the STALENESS detector only — it never reaches a
        // signed struct. See the builder's constructor.
        new EvmEscrowIntentBuilder(clients, deployments, { now: () => Date.now() }, gate),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, EvmChainStateService],
    },
    {
      /**
       * The relayed escrow intent submitter. Constructed with `@Inject`ed tokens rather than
       * a `useFactory` like its neighbours because it holds the RELAYER, and a
       * factory that reached for `EVM_RELAYER` by hand would be a third place
       * the send capability is handed out.
       */
      provide: EvmRelayedEscrowIntentSubmitter,
      useClass: EvmRelayedEscrowIntentSubmitter,
    },
    {
      // `params().minimumStake` per chain, for the operator economics panel.
      provide: EvmMinimumStakeReader,
      useFactory: (clients: never, deployments: never) =>
        new EvmMinimumStakeReader(clients, deployments),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
    {
      // Whether each chain's escrow has the tighten delay (D-21), by asking it.
      provide: EvmTightenDelayProbe,
      useFactory: (clients: never, deployments: never) =>
        new EvmTightenDelayProbe(clients, deployments, { now: () => Date.now() }),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
    {
      // "Redeem into hold" (G3.B1): collect and refund the escrow's held
      // payments with the REDEEMER key.
      provide: EvmHeldPayments,
      useFactory: (clients: never, deployments: never, redeemer: never, config: ConfigService) =>
        new EvmHeldPayments(
          clients,
          deployments,
          redeemer,
          parseHoldLiveChains(config.get<string>('EVM_HOLD_LIVE_CHAINS')),
        ),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, EVM_REDEEMER, ConfigService],
    },
    {
      // A2: the reconciler names a deposit no intent credited. Read-only.
      provide: EvmEscrowDepositLogs,
      useFactory: (clients: never, deployments: never, config: ConfigService) =>
        new EvmEscrowDepositLogs(
          clients,
          deployments,
          parseDepositLookbackBlocks(config.get<string>('RECONCILIATION_DEPOSIT_LOOKBACK_BLOCKS')),
        ),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, ConfigService],
    },
    {
      provide: EvmVoucherRedeemer,
      useFactory: (
        clients: never,
        deployments: never,
        redeemer: never,
        alerts: never,
        tightenDelay: EvmTightenDelayProbe,
      ) =>
        new EvmVoucherRedeemer(
          clients,
          deployments,
          redeemer,
          alerts,
          { now: () => Date.now() },
          tightenDelay,
        ),
      // The REDEEMER, not the relayer: `redeemVoucher[Batch]` accepts only
      // `Config.params().redeemer` as sender.
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, EVM_REDEEMER, ALERT_PORT, EvmTightenDelayProbe],
    },
    {
      /**
       * The eip155 half of `SLASH_EXECUTOR` (multiplexed in `ChainsModule`).
       * Signs through `VerifierSigningService`, resolved via `ModuleRef` at
       * call time exactly like `SolanaSlashExecutor`; sends through the relayer
       * EOA, which is never the authority — the attestation is.
       *
       * Batching through `Multicall3` is per chain and opt-in: a deployment
       * entry with `multicall3` set batches, one without sends one transaction
       * per judgement. `EVM_SLASH_BATCH_SIZE` bounds a batch (default 20).
       */
      provide: EvmSlashExecutor,
      useFactory: (
        clients: never,
        deployments: ReadonlyMap<ChainId, EvmDeployment>,
        relayer: never,
        moduleRef: ModuleRef,
        config: ConfigService,
        chainState: EvmChainStateService,
      ) =>
        new EvmSlashExecutor(clients, deployments, relayer, moduleRef, VerifierSigningService, {
          now: () => Date.now(),
          // The EIP-712 domain guard: no attestation while the Stake proxy
          // signs under another domain.
          domains: chainState,
          batchSize: readBatchSize(config.get<string>(EVM_SLASH_BATCH_SIZE_ENV)),
          multicall: new Map(
            [...deployments]
              .filter(([, deployment]) => deployment.multicall3)
              .map(([chainId, deployment]) => [chainId, deployment.multicall3 as `0x${string}`]),
          ),
        }),
      inject: [
        EVM_RPC_CLIENTS,
        EVM_DEPLOYMENTS,
        EVM_RELAYER,
        ModuleRef,
        ConfigService,
        EvmChainStateService,
      ],
    },
    {
      provide: EvmVerifierRegistryService,
      useFactory: (clients: never, deployments: never) =>
        new EvmVerifierRegistryService(clients, deployments),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
    {
      // The `eip155` half of `VAULT_PORT`. Provided unconditionally and
      // reachable only through `NamespaceVaultPort`, which drops it when no
      // eip155 chain is enabled: constructing it dials nothing, and a
      // `useFactory` that returned `null` on a Solana-only deployment would put
      // the enabled-chains decision in two places.
      //
      // It also gets the ADDRESSES of this process's redeemer and relayer keys,
      // so `assertVaultControl` can refuse a key split the chain does not
      // honour (`params().redeemer` must be the redeemer key, never the relayer).
      provide: EvmVaultService,
      useFactory: (
        clients: never,
        deployments: never,
        relayer: readonly EvmRelayerKeySource[],
        redeemer: readonly EvmRelayerKeySource[],
      ) =>
        new EvmVaultService(clients, deployments, {
          redeemer: keyAddressesByChain(redeemer),
          relayer: keyAddressesByChain(relayer),
        }),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS, EVM_RELAYER_KEY_SOURCES, EVM_REDEEMER_KEY_SOURCES],
    },

    {
      /**
       * The gas grant caps. **No defaults** — an unset cap is a boot failure, not an
       * unlimited faucet.
       *
       * Required exactly when an eip155 chain is enabled, and `null` otherwise.
       * `ChainsModule` imports this module unconditionally, so demanding the
       * caps on a Solana-only deployment would make an EVM variable a
       * precondition for a process that will never send an EVM transaction —
       * and an operator would set it to whatever silenced the boot, which is how
       * a cap stops meaning anything. `EvmGasGrantService` refuses on `null`;
       * that branch is unreachable in practice, because a deployment with no
       * eip155 chain also has no deployment record for the grant to resolve.
       */
      provide: EVM_GAS_GRANT_CAPS,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]) =>
        enabled.some((chainId) => namespaceOf(chainId) === ChainNamespace.EIP155)
          ? parseGasGrantCaps(
              config.get<string>(EVM_GAS_GRANT_MAX_WEI_ENV),
              config.get<string>(EVM_GAS_GRANT_DAILY_MAX_WEI_ENV),
              config.get<string>(EVM_RELAYER_FLOAT_LOW_WATER_ENV),
            )
          : null,
      inject: [ConfigService, ENABLED_CHAINS],
    },
    { provide: EVM_GAS_GRANT_CONFIG, useValue: { now: () => Date.now() } },
    EvmGasGrantService,
    // The pause/blocklist cache (D-19), in every process. The indexer that
    // fills it runs in the scheduler (`EvmSchedulerModule`).
    {
      provide: EvmChainStateService,
      useFactory: (
        repository: EvmChainStateRepository,
        clients: never,
        deployments: ReadonlyMap<ChainId, EvmDeployment>,
        config: ConfigService,
        alerts: AlertPort,
      ) =>
        new EvmChainStateService(
          repository,
          clients,
          deployments,
          {
            pollMs: readPositiveInt(
              config.get<string>(EVM_CHAIN_STATE_POLL_MS_ENV),
              DEFAULT_EVM_CHAIN_STATE_POLL_MS,
              EVM_CHAIN_STATE_POLL_MS_ENV,
            ),
          },
          alerts,
        ),
      inject: [
        EvmChainStateRepository,
        EVM_RPC_CLIENTS,
        EVM_DEPLOYMENTS,
        ConfigService,
        ALERT_PORT,
      ],
    },
    {
      // Holds no key — it broadcasts bytes the buyer signed — so it needs no
      // separate process the way the Solana fee-payer facilitator does.
      provide: EvmFacilitator,
      useFactory: (clients: never, deployments: never) => new EvmFacilitator(clients, deployments),
      inject: [EVM_RPC_CLIENTS, EVM_DEPLOYMENTS],
    },
  ],
  exports: [
    EvmChainStateService,
    EvmChainAdapter,
    EvmEscrowBalanceReader,
    EvmEscrowOpener,
    EvmDepositRequirementsBuilder,
    EvmStakeReader,
    EvmStakeIntentBuilder,
    EvmEscrowIntentBuilder,
    EvmRelayedEscrowIntentSubmitter,
    EvmVoucherRedeemer,
    EvmHeldPayments,
    EvmEscrowDepositLogs,
    EvmTightenDelayProbe,
    EvmMinimumStakeReader,
    EvmSlashExecutor,
    EvmVerifierRegistryService,
    EvmVaultService,
    EvmGasGrantService,
    EvmFacilitator,
    EvmRelayer,
    EVM_RELAYER,
    EVM_REDEEMER,
    EVM_DEPLOYMENTS,
    EVM_RPC_CLIENTS,
  ],
})
export class EvmModule {}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * `{"eip155:46630": <value>}` → a map keyed by a **validated** CAIP-2 chain id.
 *
 * Unset is an empty map, not a failure: a Solana-only deployment sets neither
 * variable, and {@link assertCoversEnabled} is what turns an omission into a
 * boot failure when — and only when — an eip155 chain is actually enabled.
 *
 * No error quotes the value it failed to parse. `JSON.parse`'s own message
 * contains the offending input, so it is caught and replaced; these two
 * variables carry addresses and URLs rather than keys, and the habit is the
 * point (`docs/architecture.md` §"Signing Keys" rule 6).
 */
function parseEvmChainMap(
  raw: string | undefined,
  variable: string,
): ReadonlyMap<ChainId, unknown> {
  if (raw === undefined || raw.trim() === '') return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a JSON object keyed by CAIP-2 chain id',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a JSON object keyed by CAIP-2 chain id',
    });
  }

  const map = new Map<ChainId, unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isChainId(key) || namespaceOf(key as ChainId) !== ChainNamespace.EIP155) {
      throw ChainErrors.configValueInvalid({
        variable,
        accepted: 'keys that are eip155 CAIP-2 chain ids, e.g. "eip155:46630"',
      });
    }
    map.set(key as ChainId, value);
  }
  return map;
}

/** Every enabled eip155 chain has an entry, or the boot fails naming the ones that do not. */
function assertCoversEnabled(
  configured: ReadonlyMap<ChainId, unknown>,
  enabled: readonly ChainId[],
  variable: string,
): void {
  const missing = enabled
    .filter((chainId) => namespaceOf(chainId) === ChainNamespace.EIP155)
    .filter((chainId) => !configured.has(chainId));

  if (missing.length > 0) {
    // NOT `enabledChainsInvalid`: the chain is perfectly well known — the entry
    // for it is missing — and "names an unknown network" would send an operator
    // to edit ENABLED_CHAINS, which is the one file that is already right.
    throw ChainErrors.configValueInvalid({
      variable,
      accepted:
        `an entry for every eip155 chain in ENABLED_CHAINS. Missing: ${missing.join(', ')}. ` +
        `Configured: ${[...configured.keys()].join(', ') || '(none)'}`,
    });
  }
}

function readRpcUrl(value: unknown, chainId: ChainId): string {
  // `https://` only, and it is not decoration: `installEgressLockdown` blocks
  // plaintext to a non-loopback host anyway, and WebSocket transports are not
  // offered, so every RPC call goes through the egress client.
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) {
    throw ChainErrors.configValueInvalid({
      variable: `${EVM_RPC_URLS_ENV}[${chainId}]`,
      accepted: 'an https URL per chain — WebSocket transports are not offered',
    });
  }
  return value;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The three proxies, the token, the escrow implementation, the admin and the
 * owner — all seven required and all seven address-shaped.
 *
 * `escrowImplementation`, `admin` and `owner` are in the record for
 * `EvmVaultService.assertVaultControl`, and they are **required rather than
 * optional** deliberately. An optional expectation is one a control check
 * cannot fail against: a deployment that omitted them would reconcile with
 * some of its control reads silently skipped, and would look exactly like one
 * that passed them all. All are public addresses in
 * `deployments/<chainId>.json` in assay-evm, so requiring them costs one line
 * of configuration each.
 */
function readDeployment(value: unknown, chainId: ChainId): EvmDeployment {
  const record = value as Record<string, unknown>;
  const fields = [
    'config',
    'stake',
    'escrow',
    'asset',
    'escrowImplementation',
    'admin',
    'owner',
  ] as const;

  for (const field of fields) {
    if (typeof record?.[field] !== 'string' || !ADDRESS.test(record[field] as string)) {
      throw ChainErrors.configValueInvalid({
        variable: `${EVM_DEPLOYMENTS_ENV}[${chainId}].${field}`,
        accepted:
          'a 20-byte 0x address for each of config, stake, escrow, asset, escrowImplementation, ' +
          'admin and owner. config/stake/escrow are the PROXY addresses, which are what an ' +
          'EIP-712 verifyingContract names and what does not move across an upgrade; ' +
          'escrowImplementation is the address behind the escrow proxy and DOES move on every ' +
          'upgrade; admin is AssayConfig.admin, the operational key; owner is ' +
          'AssayConfig.owner(), the upgrade authority of all three contracts',
      });
    }
  }

  // Optional: the Multicall3 the slash executor batches through on this chain.
  // Absent means one transaction per judgement.
  const multicall3 = record.multicall3;
  if (multicall3 !== undefined && (typeof multicall3 !== 'string' || !ADDRESS.test(multicall3))) {
    throw ChainErrors.configValueInvalid({
      variable: `${EVM_DEPLOYMENTS_ENV}[${chainId}].multicall3`,
      accepted: 'a 20-byte 0x address of Multicall3 on this chain, or absent to send singly',
    });
  }

  return {
    chainId,
    ...(multicall3 ? { multicall3: multicall3 as `0x${string}` } : {}),
    config: record.config as `0x${string}`,
    stake: record.stake as `0x${string}`,
    escrow: record.escrow as `0x${string}`,
    asset: record.asset as `0x${string}`,
    escrowImplementation: record.escrowImplementation as `0x${string}`,
    admin: record.admin as `0x${string}`,
    owner: record.owner as `0x${string}`,
  };
}

export const EVM_SLASH_BATCH_SIZE_ENV = 'EVM_SLASH_BATCH_SIZE';
export const EVM_CHAIN_STATE_POLL_MS_ENV = 'EVM_CHAIN_STATE_POLL_MS';

/** A positive whole number from the environment, or `fallback` when unset. */
export function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  variable: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw ChainErrors.configValueInvalid({ variable, accepted: 'a positive whole number' });
  }
  return value;
}

/** `EVM_SLASH_BATCH_SIZE`: 1–100, default {@link DEFAULT_EVM_SLASH_BATCH_SIZE}. */
function readBatchSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EVM_SLASH_BATCH_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw ChainErrors.configValueInvalid({
      variable: EVM_SLASH_BATCH_SIZE_ENV,
      accepted: 'a whole number of judgements per Multicall3 batch, 1 to 100',
    });
  }
  return value;
}

/** The relayer's own float floor. Optional — the relayer has its own default. */
function readOptionalWei(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw ChainErrors.configValueInvalid({
      variable: EVM_RELAYER_FLOAT_LOW_WATER_ENV,
      accepted: 'a whole number of wei, in decimal',
    });
  }
  return BigInt(raw);
}

/**
 * `EVM_DEPOSIT_CONFIRMATIONS`: blocks on top of a deposit before it is credited
 * (unset: 0, the sequencer's soft confirmation), or `finalized` for the chain's
 * finalized head. Anything else refuses to boot rather than guess.
 */
export function depositConfirmationsFrom(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (value === '') return 0;
  if (value === 'finalized') return null;
  if (!/^\d{1,6}$/.test(value)) {
    throw new Error(
      `EVM_DEPOSIT_CONFIRMATIONS must be a block count or "finalized", got "${value}"`,
    );
  }
  return Number(value);
}
