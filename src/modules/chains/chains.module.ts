import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  createSanctionedSolanaRpc,
  createSanctionedSolanaRpcSubscriptions,
  solanaSubscriptionsUrl,
} from './solana/sanctioned-rpc';

import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import {
  DEPOSIT_REQUIREMENTS_BUILDER,
  DepositRequirementsBuilderPort,
} from '@modules/payment/ports/deposit-requirements.port';
import {
  ONCHAIN_STAKE_READER,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import {
  STAKE_INTENT_BUILDER,
  StakeIntentBuilderPort,
} from '@modules/provider/ports/stake-intent-builder.port';
import { ESCROW_OPENER, EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';
import {
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  ESCROW_DELEGATION,
  EscrowDelegationPort,
} from '@modules/settlement/ports/escrow-delegation.port';
import {
  ESCROW_INTENT_BUILDER,
  EscrowIntentBuilderPort,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  RELAYED_ESCROW_INTENT,
  RelayedEscrowIntentPort,
} from '@modules/settlement/ports/relayed-escrow-intent.port';
import { TIGHTEN_DELAY } from '@modules/settlement/ports/tighten-delay.port';
import {
  WITHDRAW_GAS_GRANT,
  WithdrawGasGrantPort,
} from '@modules/settlement/ports/withdraw-gas-grant.port';
import { SLASH_EXECUTOR, SlashExecutorPort } from '@modules/slash/ports/slash-executor.port';
import { SLASH_CAPS_READER } from '@modules/slash/ports/slash-caps-reader.port';
import { EvmSlashExecutor } from './evm/evm-slash-executor.service';
import { EvmChainStateService } from './evm/chain-state/evm-chain-state.service';
import { CHAIN_STATE_GATE } from './ports/chain-state-gate.port';
import { SLASH_DISPUTE_INTENTS } from '@modules/slash/ports/slash-dispute-intent.port';
import {
  NamespaceSlashCapsReader,
  NamespaceSlashExecutor,
} from './multiplex/namespace-slash-executor';
import {
  VERIFIER_REGISTRY,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';

import { NetworkModule } from '@shared/network/network.module';
import { ChainAdapterRegistry } from './chain-adapter.registry';
import {
  DEFAULT_FACILITATOR_TIMEOUT_MS,
  FACILITATOR_BASE_URL,
  FACILITATOR_TIMEOUT_MS,
} from './facilitator/facilitator.constants';
import { HttpFacilitatorAdapter } from './facilitator/http-facilitator.adapter';
import { CHAIN_ADAPTERS } from './ports/chain-adapter.port';
import { FACILITATOR_PORT, FacilitatorPort } from './ports/facilitator.port';
import { VAULT_PORT } from './ports/vault.port';
import { BLOCKHASH_PROVIDERS } from './solana/blockhash.service';
import { SolanaDepositRequirementsBuilder } from './solana/deposit-requirements-builder.service';
import { EvmDepositRequirementsBuilder } from './evm/evm-deposit-requirements-builder.service';
import { EvmEscrowOpener } from './evm/evm-escrow-opener.service';
import { NamespaceDepositRequirementsBuilder } from './multiplex/namespace-deposit-requirements-builder';
import { NamespaceEscrowOpener } from './multiplex/namespace-escrow-opener';
import { NamespaceFacilitator } from './multiplex/namespace-facilitator';
import { EvmFacilitator } from './evm/evm-facilitator.service';
import { ENABLED_CHAINS } from './enabled-chains';
import { EnabledChainsModule } from './enabled-chains.module';
import { ChainId, ChainNamespace, namespaceOf } from './ports/caip.types';
import { ChainVerifierRegistry } from './multiplex/chain-verifier-registry';
import { NamespaceEscrowBalanceReader } from './multiplex/namespace-escrow-balance-reader';
import { NamespaceEscrowIntentBuilder } from './multiplex/namespace-escrow-intent-builder';
import { NamespaceEscrowDelegation } from './multiplex/namespace-escrow-delegation';
import { NamespaceRelayedEscrowIntent } from './multiplex/namespace-relayed-escrow-intent';
import { NamespaceStakeReader } from './multiplex/namespace-stake-reader';
import { NamespaceStakeIntentBuilder } from './multiplex/namespace-stake-intent-builder';
import {
  NamespaceWithdrawGasGrant,
  NoWithdrawGasGrant,
} from './multiplex/namespace-withdraw-gas-grant';
import { buildNamespaceVaultPort } from './multiplex/namespace-vault.port';
import { NamespaceVoucherRedeemer } from './multiplex/namespace-voucher-redeemer';
import { EvmModule } from './evm/evm.module';
import { EvmMinimumStakeReader } from './evm/evm-minimum-stake-reader.service';
import { MINIMUM_STAKE_READER } from './ports/minimum-stake-reader.port';
import { EvmChainAdapter } from './evm/evm-chain.adapter';
import { EvmEscrowBalanceReader } from './evm/evm-escrow-balance-reader.service';
import { EvmEscrowIntentBuilder } from './evm/evm-escrow-intent-builder.service';
import { EvmTightenDelayProbe } from './evm/evm-tighten-delay.probe';
import { EvmGasGrantService } from './evm/evm-gas-grant.service';
import { EvmRelayedEscrowIntentSubmitter } from './evm/evm-relayed-escrow-intent.service';
import { EvmStakeReader } from './evm/evm-stake-reader.service';
import { EvmStakeIntentBuilder } from './evm/evm-stake-intent-builder.service';
import { EvmVaultService } from './evm/evm-vault.service';
import { EvmVerifierRegistryService } from './evm/evm-verifier-registry.service';
import { EvmHeldPayments } from './evm/evm-held-payments.service';
import { EvmVoucherRedeemer } from './evm/evm-voucher-redeemer.service';
import { NamespaceHeldPayments } from './multiplex/namespace-held-payments';
import { HELD_PAYMENTS } from '@modules/payment/ports/held-payments.port';
import { SolanaChainAdapter } from './solana/solana-chain.adapter';
import { SOLANA_CHAIN_ID, SOLANA_RPC, SOLANA_RPC_SUBSCRIPTIONS } from './solana/solana.constants';
import { ACCOUNT_WATCH_PORT } from './ports/account-watch.port';
import { SolanaAccountWatcher } from './solana/solana-account-watcher.service';
import {
  SETTLEMENT_PROGRAM_ID,
  SETTLEMENT_PROGRAM_ID_ENV,
} from './solana/settlement-program.constants';
import {
  DEFAULT_ESCROW_BALANCE_READER_CONFIG,
  ESCROW_BALANCE_READER_CONFIG,
  SolanaEscrowBalanceReader,
} from './solana/escrow-balance-reader.service';
import {
  ESCROW_INTENT_BUILDER_CONFIG,
  SolanaEscrowIntentBuilder,
} from './solana/escrow-intent-builder.service';
import { SolanaEscrowOpener } from './solana/escrow-opener.service';
import { SolanaSettlementStakeReader } from './solana/settlement-stake-reader.service';
import { SolanaSlashExecutor } from './solana/settlement-slash-executor.service';
import { SolanaStakeIntentBuilder } from './solana/stake-intent-builder.service';
import { SolanaVoucherRedeemer } from './solana/voucher-redeemer.service';
import { SolanaVerifierRegistryService } from './solana/verifier-registry.service';

/**
 * The chain boundary.
 *
 * Everything chain-specific lives under this module and is reached only through
 * `ChainAdapterRegistry`. A new chain is added by adding one adapter to
 * `CHAIN_ADAPTERS`, and nothing under `src/modules/` outside
 * `chains/` changes.
 *
 * `FACILITATOR_PORT` is per namespace. On Solana it is the HTTP client
 * pointed by `FACILITATOR_URL` at our self-hosted Kora wrapper — a separate
 * process, `SERVICE_TYPE=facilitator`, so its fee-payer key is not in the
 * API's address space. On eip155 it
 * is `EvmFacilitator`, in process, because it holds no key to isolate: it
 * broadcasts a transaction the buyer already signed.
 */
@Module({
  // `HttpFacilitatorAdapter` calls out over HTTP, and there is exactly one
  // client that may do that. `NetworkModule` is `@Global`, but importing it
  // where it is used keeps this module's graph readable and testable on its own.
  imports: [NetworkModule, EnabledChainsModule, EvmModule],
  providers: [
    {
      provide: SOLANA_RPC,
      useFactory: (config: ConfigService) =>
        createSanctionedSolanaRpc(
          config.get<string>('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com',
        ),
      inject: [ConfigService],
    },
    {
      /**
       * `undefined` when no `wss://` URL can be formed — see
       * `solanaSubscriptionsUrl`. `SolanaAccountWatcher` is only provided when
       * this resolves, so the absence propagates as "no watcher" rather than as
       * a socket dialled at a guessed address.
       */
      provide: SOLANA_RPC_SUBSCRIPTIONS,
      useFactory: (config: ConfigService) => {
        const url = solanaSubscriptionsUrl(
          config.get<string>('SOLANA_RPC_WS_URL'),
          config.get<string>('SOLANA_RPC_URL'),
        );

        return url ? createSanctionedSolanaRpcSubscriptions(url) : undefined;
      },
      inject: [ConfigService],
    },
    {
      provide: ACCOUNT_WATCH_PORT,
      useFactory: (client: unknown) =>
        client ? new SolanaAccountWatcher(client as never) : undefined,
      inject: [SOLANA_RPC_SUBSCRIPTIONS],
    },
    {
      // See `SOLANA_CHAIN_ID`. Depends on `ENABLED_CHAINS` rather than re-reading
      // the variable, so there is one parser and one `assertChainMetadata`.
      provide: SOLANA_CHAIN_ID,
      useFactory: (enabled: readonly ChainId[]): ChainId | null => {
        const solana = enabled.filter((chainId) => namespaceOf(chainId) === ChainNamespace.SOLANA);
        // `null` rather than a throw when the answer is not unique, and the
        // same shape as `SETTLEMENT_PROGRAM_ID` two providers down: the
        // absence propagates to a call-time failure that says what is missing,
        // instead of stopping the boot of every process — including the five
        // that never sign anything. Enabling both Solana clusters against one
        // `SOLANA_RPC_URL` is a configuration this deployment has always
        // accepted, and adding EVM support does not take it away.
        return solana.length === 1 ? solana[0] : null;
      },
      inject: [ENABLED_CHAINS],
    },
    SolanaChainAdapter,
    {
      /**
       * Both adapters, always, and in `ENABLED_CHAINS`' own order for the two
       * halves of `chooseSettlementChain` rule 3 to agree.
       *
       * `EvmChainAdapter.supportedChains` is the intersection of its configured
       * deployments with `ENABLED_CHAINS`, so a Solana-only deployment registers
       * an adapter that declares no chains — and `ChainAdapterRegistry`'s three
       * constructor invariants (every enabled chain served, nothing but an
       * enabled chain served, an adapter's chains inside its own namespace) then
       * do exactly the work they were written for, with no branch here.
       */
      provide: CHAIN_ADAPTERS,
      useFactory: (solana: SolanaChainAdapter, evm: EvmChainAdapter) => [solana, evm],
      inject: [SolanaChainAdapter, EvmChainAdapter],
    },
    ChainAdapterRegistry,

    {
      provide: FACILITATOR_BASE_URL,
      useFactory: (config: ConfigService) =>
        config.get<string>('FACILITATOR_URL') ?? 'http://127.0.0.1:3100',
      inject: [ConfigService],
    },
    {
      provide: FACILITATOR_TIMEOUT_MS,
      useFactory: (config: ConfigService) =>
        Number(config.get<string>('FACILITATOR_TIMEOUT_MS') ?? DEFAULT_FACILITATOR_TIMEOUT_MS),
      inject: [ConfigService],
    },
    HttpFacilitatorAdapter,
    {
      /**
       * Per namespace. Solana keeps the HTTP client to the separate fee-payer
       * service; eip155 gets `EvmFacilitator`, in process, because it holds no
       * key. Until this, eip155 deposits reached the Solana-only HTTP service
       * and were refused `invalid_network` after passing their binding check.
       */
      provide: FACILITATOR_PORT,
      useFactory: (solana: HttpFacilitatorAdapter, evm: EvmFacilitator) =>
        new NamespaceFacilitator(
          new Map<string, FacilitatorPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [HttpFacilitatorAdapter, EvmFacilitator],
    },

    {
      /**
       * The escrow contract's balance, on each enabled eip155 chain — the
       * left side of proof of reserves. Solana has no vault: the pooled
       * Squads treasury is gone, so a Solana asset is `CHAIN_UNSUPPORTED`.
       */
      provide: VAULT_PORT,
      useFactory: (evm: EvmVaultService, enabled: readonly ChainId[]) =>
        buildNamespaceVaultPort({ enabled, evm }),
      inject: [EvmVaultService, ENABLED_CHAINS],
    },

    // The on-chain verifier allowlist, read-only. `null` when the
    // settlement program is not deployed for this environment; see
    // `settlement-program.constants.ts` for why that is a call-time failure and
    // not a boot-time one.
    {
      provide: SETTLEMENT_PROGRAM_ID,
      useFactory: (config: ConfigService) => config.get<string>(SETTLEMENT_PROGRAM_ID_ENV) ?? null,
      inject: [ConfigService],
    },
    SolanaVerifierRegistryService,
    {
      /**
       * A namespace multiplexer rather than one implementation.
       *
       * `VERIFIER_REGISTRY` was `useExisting: SolanaVerifierRegistryService`,
       * which is correct exactly while one namespace exists and silently wrong
       * afterwards: an `eip155` lookup would have been answered by a Solana PDA
       * read, and it would have looked like a successful read. The multiplexer
       * makes the dispatch explicit, so a chain nobody wired up throws
       * `CHAIN_UNSUPPORTED` instead of being answered by whoever was bound.
       *
       * `EvmVerifierRegistryService` needs `EVM_DEPLOYMENTS` and
       * `EVM_RPC_CLIENTS`, which `evm.module.ts` provides. The dispatch itself
       * is the property that matters, and the one
       * `test/unit/chains/chain-verifier-registry.spec.ts` pins.
       */
      provide: VERIFIER_REGISTRY,
      useFactory: (solana: SolanaVerifierRegistryService, evm: EvmVerifierRegistryService) =>
        new ChainVerifierRegistry(
          new Map<string, VerifierRegistryPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaVerifierRegistryService, EvmVerifierRegistryService],
    },

    // `ProviderStake.bonded`, read off the same settlement program.
    // The port is declared by `provider/`, because that is the module that
    // needs the fact; the implementation is here, because it is the only place
    // allowed to import `@assay/settlement-client`. Exactly the arrangement
    // `VERIFIER_REGISTRY` above already has, and for the same ESLint rule.
    SolanaSettlementStakeReader,
    {
      // The multiplexer, and the one that had to SPLIT A BATCH.
      // `OnChainProviderStakeSource.stakeOn` resolves the authority per
      // `(provider, chain)` and then handed the UNION to this single reader;
      // with two chains that asks a Solana RPC about an `0x` address, gets "no
      // account", and fails the routing gate CLOSED for every EVM provider.
      provide: ONCHAIN_STAKE_READER,
      useFactory: (solana: SolanaSettlementStakeReader, evm: EvmStakeReader) =>
        new NamespaceStakeReader(
          new Map<string, OnChainStakeReaderPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaSettlementStakeReader, EvmStakeReader],
    },

    // `escrow_ata.amount`, read off the same settlement program and
    // cached the same shape `OnChainProviderStakeSource` already argues for
    // (10s fresh, 60s fail-closed ceiling). `now` is `Date.now` in
    // production and overridden by tests that need to age a reading without
    // waiting for it.
    {
      provide: ESCROW_BALANCE_READER_CONFIG,
      useValue: { ...DEFAULT_ESCROW_BALANCE_READER_CONFIG, now: () => Date.now() },
    },
    SolanaEscrowBalanceReader,
    {
      provide: ESCROW_BALANCE_READER,
      useFactory: (solana: SolanaEscrowBalanceReader, evm: EvmEscrowBalanceReader) =>
        new NamespaceEscrowBalanceReader(
          new Map<string, EscrowBalanceReaderPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaEscrowBalanceReader, EvmEscrowBalanceReader],
    },

    // The third thing that touches `ProviderStake`, and the
    // only one of the three that neither reads a balance nor writes to the
    // chain: it COMPILES a transaction and hands it back unsigned, for the
    // provider's own wallet to sign. Note what it is not given: no signer, no
    // `sendTransaction` on its RPC interface, no submit path anywhere. The
    // backend must never sign a provider's stake instruction — `withdraw_stake`
    // itself says *"the admin key cannot, and neither can the exposure
    // authority"* — and this wiring is where that becomes structural rather
    // than a rule someone has to remember.
    SolanaStakeIntentBuilder,
    {
      // Dispatched per namespace. The EVM member has no account to open and builds
      // the provider's `depositStake` / `requestUnstake` / `withdrawStake`; it
      // is given no relayer, for the reason above.
      provide: STAKE_INTENT_BUILDER,
      useFactory: (solana: SolanaStakeIntentBuilder, evm: EvmStakeIntentBuilder) =>
        new NamespaceStakeIntentBuilder(
          new Map<string, StakeIntentBuilderPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaStakeIntentBuilder, EvmStakeIntentBuilder],
    },

    // A recent blockhash, for the one path that has to hand a
    // transaction lifetime to a browser (`POST /deposits`). Spread from
    // `./solana/blockhash.service` rather than written out here, and NOT
    // exported: nothing outside `chains/solana/` may name that token,
    // and a `provide:` entry in this file would be this file naming it.
    // `SolanaDepositRequirementsBuilder` is the only injector.
    ...BLOCKHASH_PROVIDERS,

    // The chain-neutral seam `POST /deposits` speaks to. The controller injects
    // this and imports nothing from `chains/solana/` or `chains/evm/`.
    //
    // It was `useExisting: SolanaDepositRequirementsBuilder` for every chain,
    // which is what made a `eip155:46630` deposit describe an SPL transfer —
    // see `NamespaceDepositRequirementsBuilder`. The two members answer
    // genuinely different shapes (one has a blockhash and a fee payer, the
    // other has a contract and a method), which is exactly what the
    // discriminant was declared for.
    SolanaDepositRequirementsBuilder,
    {
      provide: DEPOSIT_REQUIREMENTS_BUILDER,
      useFactory: (solana: SolanaDepositRequirementsBuilder, evm: EvmDepositRequirementsBuilder) =>
        new NamespaceDepositRequirementsBuilder(
          new Map<string, DepositRequirementsBuilderPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaDepositRequirementsBuilder, EvmDepositRequirementsBuilder],
    },

    // The only path allowed to submit the slash
    // lifecycle. No signer is bound here: the verifier signing key is not a
    // provider of this module at all, and `SolanaSlashExecutor` reaches it
    // through `ModuleRef` at call time rather than through the constructor —
    // see its class comment for why importing `VerifierSigningModule` here
    // would be a circular module import that nothing in this codebase's ESLint
    // config or module graph is set up to carry (`grep -r forwardRef src/` is
    // empty). The failure mode where that lookup finds nothing is loud, at the
    // first call, in whichever process has no business signing.
    SolanaSlashExecutor,
    // Chain-dispatched, not a global override: each request carries its
    // `chainId` and reaches the executor of that namespace. eip155 is
    // `EvmSlashExecutor` (AssayStake, batched through Multicall3 where
    // configured); solana is unchanged.
    {
      provide: SLASH_EXECUTOR,
      useFactory: (solana: SolanaSlashExecutor, evm: EvmSlashExecutor) =>
        new NamespaceSlashExecutor(
          new Map<string, SlashExecutorPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaSlashExecutor, EvmSlashExecutor],
    },
    // The live caps a pro-rata plan is scaled to. eip155 only: the per-agent
    // split is an EVM path, and a Solana request is refused CHAIN_UNSUPPORTED.
    {
      provide: SLASH_CAPS_READER,
      useFactory: (evm: EvmSlashExecutor) =>
        new NamespaceSlashCapsReader(new Map([[ChainNamespace.EIP155, evm]])),
      inject: [EvmSlashExecutor],
    },

    // The pause/blocklist gate (D-19): refuse early what the chain would refuse.
    { provide: CHAIN_STATE_GATE, useExisting: EvmChainStateService },
    // The dispute upgrade's unsigned intents — eip155 only.
    { provide: SLASH_DISPUTE_INTENTS, useExisting: EvmSlashExecutor },

    // The buyer's own escrow doors, compiled but never signed.
    // `now` is `Date.now` in production; tests fix it to avoid a real clock.
    {
      provide: ESCROW_INTENT_BUILDER_CONFIG,
      useValue: { now: () => Date.now() },
    },
    SolanaEscrowIntentBuilder,
    {
      provide: ESCROW_INTENT_BUILDER,
      useFactory: (solana: SolanaEscrowIntentBuilder, evm: EvmEscrowIntentBuilder) =>
        new NamespaceEscrowIntentBuilder(
          new Map<string, EscrowIntentBuilderPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaEscrowIntentBuilder, EvmEscrowIntentBuilder],
    },

    {
      /**
       * Agent payment delegation — `eip155` only. The EVM intent builder is the
       * implementation: it already holds the escrow read, the chain clock and
       * the deadline freshness rule the delegation messages share with
       * `SetLimits`.
       */
      provide: ESCROW_DELEGATION,
      useFactory: (evm: EvmEscrowIntentBuilder) =>
        new NamespaceEscrowDelegation(
          new Map<string, EscrowDelegationPort>([[ChainNamespace.EIP155, evm]]),
        ),
      inject: [EvmEscrowIntentBuilder],
    },

    {
      /**
       * Whether a payer's escrow makes a tightening wait (assay-evm D-21). Only
       * an EVM escrow can; the probe answers `false` for any chain it has no
       * escrow on (Solana included), which keeps the strand guard there.
       */
      provide: TIGHTEN_DELAY,
      useExisting: EvmTightenDelayProbe,
    },
    // Read-only: the minimum stake each EVM settlement contract enforces, for
    // the operator economics panel. EVM only today; a Solana build has none.
    {
      provide: MINIMUM_STAKE_READER,
      useExisting: EvmMinimumStakeReader,
    },

    {
      /**
       * The submit half of the relayed escrow intents.
       *
       * The mirror image of the entry below: `EvmRelayedEscrowIntentSubmitter`
       * is the only implementation and `eip155` is the only key, so a Solana
       * account is refused `CHAIN_UNSUPPORTED` by the multiplexer rather than
       * by a stub that agreed the operation made sense. See
       * `namespace-relayed-escrow-intent.ts` for why there is no Solana member
       * here when `WITHDRAW_GAS_GRANT` has one.
       */
      provide: RELAYED_ESCROW_INTENT,
      useFactory: (evm: EvmRelayedEscrowIntentSubmitter) =>
        new NamespaceRelayedEscrowIntent(
          new Map<string, RelayedEscrowIntentPort>([[ChainNamespace.EIP155, evm]]),
        ),
      inject: [EvmRelayedEscrowIntentSubmitter],
    },

    {
      /**
       * The EVM withdraw gas grant. It exists so that a buyer holding USDG and
       * no ETH on `eip155:46630` still has an exit. `WithdrawalService` is the
       * caller; this is the seam it reaches the grant through, because
       * `settlement/` may not import from `chains/evm/`.
       *
       * Provided unconditionally, exactly like `EvmVaultService` above: the
       * multiplexer dispatches on the account, so on a Solana-only deployment
       * `NoWithdrawGasGrant` answers every call and `EvmGasGrantService` is
       * constructed and never reached. Constructing it dials nothing.
       */
      provide: WITHDRAW_GAS_GRANT,
      useFactory: (evm: EvmGasGrantService) =>
        new NamespaceWithdrawGasGrant(
          new Map<string, WithdrawGasGrantPort>([
            [ChainNamespace.SOLANA, new NoWithdrawGasGrant()],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [EvmGasGrantService],
    },

    // The only path allowed to submit `redeem_voucher`. Like the
    // slash executor above it takes no signer as a constructor dependency: the
    // fee payer lives in `FeePayerSignerModule`, which the API, worker and MCP
    // bootstraps deliberately do not import (`src/bootstrap/mcp/app.module.ts`
    // states the rule), and this module is imported by all three. The redeemer
    // resolves `FEE_PAYER_SIGNER` through `ModuleRef` at call time instead, so
    // a process with no business paying for a redemption fails loudly at the
    // first call rather than being handed a key at boot.
    SolanaVoucherRedeemer,
    {
      // `maxBatchSize` becomes the MINIMUM across implementations — `1` while
      // Solana is enabled — so `VoucherRedemptionService` keeps its per-row path
      // and never hands Solana a batch it cannot send. The cost is that EVM
      // batching is inert on a two-chain deployment; see
      // `NamespaceVoucherRedeemer`'s header.
      provide: VOUCHER_REDEEMER,
      useFactory: (solana: SolanaVoucherRedeemer, evm: EvmVoucherRedeemer) =>
        new NamespaceVoucherRedeemer(
          new Map<string, VoucherRedeemerPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaVoucherRedeemer, EvmVoucherRedeemer],
    },

    {
      // "Redeem into hold" (G3.B1): the escrow's held payments, eip155 only.
      provide: HELD_PAYMENTS,
      useFactory: (evm: EvmHeldPayments) => new NamespaceHeldPayments(evm),
      inject: [EvmHeldPayments],
    },

    // `open_escrow`. Unlike the redeemer above, the account this
    // instruction moves rent for (`escrow`) is `init`, never signed by a
    // buyer — see `SolanaEscrowOpener`'s class comment. Same `ModuleRef`
    // resolution of the fee payer, and the same reason: only a process that
    // also imports `FeePayerSignerModule` can actually open one.
    SolanaEscrowOpener,
    {
      // Dispatched, not `useExisting`. The Solana opener base58-decodes the
      // buyer address, so binding it for every namespace answered a deposit on
      // `eip155:46630` with `409 PAYMENT_ESCROW_NOT_OPEN` quoting a base58
      // alphabet — measured, on the running API. The EVM member opens nothing,
      // because there is nothing to open; see `EvmEscrowOpener`.
      provide: ESCROW_OPENER,
      useFactory: (solana: SolanaEscrowOpener, evm: EvmEscrowOpener) =>
        new NamespaceEscrowOpener(
          new Map<string, EscrowOpenerPort>([
            [ChainNamespace.SOLANA, solana],
            [ChainNamespace.EIP155, evm],
          ]),
        ),
      inject: [SolanaEscrowOpener, EvmEscrowOpener],
    },
  ],
  exports: [
    // The MODULE, not the token: Nest refuses to re-export a provider that is
    // not this module's own, and `ENABLED_CHAINS` now lives in
    // `EnabledChainsModule` so that `EvmModule` can import it without a cycle.
    // Every existing consumer imports `ChainsModule` and resolves the token
    // transitively, exactly as before.
    EnabledChainsModule,
    ChainAdapterRegistry,
    ACCOUNT_WATCH_PORT,
    FACILITATOR_PORT,
    VAULT_PORT,
    VERIFIER_REGISTRY,
    ONCHAIN_STAKE_READER,
    ESCROW_BALANCE_READER,
    STAKE_INTENT_BUILDER,
    SLASH_EXECUTOR,
    SLASH_CAPS_READER,
    CHAIN_STATE_GATE,
    SLASH_DISPUTE_INTENTS,
    VOUCHER_REDEEMER,
    HELD_PAYMENTS,
    ESCROW_OPENER,
    ESCROW_INTENT_BUILDER,
    ESCROW_DELEGATION,
    RELAYED_ESCROW_INTENT,
    TIGHTEN_DELAY,
    MINIMUM_STAKE_READER,
    WITHDRAW_GAS_GRANT,
    DEPOSIT_REQUIREMENTS_BUILDER,
  ],
})
export class ChainsModule {}
