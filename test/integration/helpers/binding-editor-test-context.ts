import { VoucherDelegate1759600000000 } from '@database/postgres/migrations/1759600000000-voucher-delegate';
import { VoucherAdmissionIndex1759600000003 } from '@database/postgres/migrations/1759600000003-voucher-admission-index';
import { PaymentIntentCredential1759600000004 } from '@database/postgres/migrations/1759600000004-payment-intent-credential';
import { VoucherAdmissionPause1759600000005 } from '@database/postgres/migrations/1759600000005-voucher-admission-pause';
import { VoucherAdmissionPausePerRequest1759600000006 } from '@database/postgres/migrations/1759600000006-voucher-admission-pause-per-request';
import { PaymentIntentRedemptionTxRefs1760200000000 } from '@database/postgres/migrations/1760200000000-payment-intent-redemption-tx-refs';
import { PaymentIntentRedemptionLastError1760600000000 } from '@database/postgres/migrations/1760600000000-payment-intent-redemption-last-error';
import { PaymentIntentRedemptionLapsed1760700000000 } from '@database/postgres/migrations/1760700000000-payment-intent-redemption-lapsed';
import { PaymentIntentDebtReplacing1760800000000 } from '@database/postgres/migrations/1760800000000-payment-intent-debt-replacing';
import { VoucherSeqDebtReplacement1760900000000 } from '@database/postgres/migrations/1760900000000-voucher-seq-debt-replacement';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AccountBalanceEntity } from '@database/postgres/entities/account-balance.entity';
import { BindingTestRunEntity } from '@database/postgres/entities/binding-test-run.entity';
import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerHoldEntity } from '@database/postgres/entities/ledger-hold.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerHoldRepository } from '@database/postgres/repositories/ledger-hold.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { CreateLedger1755100000000 } from '@database/postgres/migrations/1755100000000-create-ledger';
import { CreatePaymentIntents1755200000000 } from '@database/postgres/migrations/1755200000000-create-payment-intents';
import { CreateProviderRegistrationTables1756600000000 } from '@database/postgres/migrations/1756600000000-create-provider-registration-tables';
import { ProviderEarningsAndPayouts1756700000000 } from '@database/postgres/migrations/1756700000000-provider-earnings-and-payouts';
import { CreateToolBindingTables1756900000000 } from '@database/postgres/migrations/1756900000000-create-tool-binding-tables';
import { ProviderStakeAuthority1757000000000 } from '@database/postgres/migrations/1757000000000-provider-stake-authority';
import { CreateProviderChainEnrolments1759300000001 } from '@database/postgres/migrations/1759300000001-create-provider-chain-enrolments';
import { DropProviderPayoutColumns1759300000002 } from '@database/postgres/migrations/1759300000002-drop-provider-payout-columns';
import { ToolBindingSettlementChains1759300000004 } from '@database/postgres/migrations/1759300000004-tool-binding-settlement-chains';
import { CreateProviderStakeGrace1757100000000 } from '@database/postgres/migrations/1757100000000-create-provider-stake-grace';
import { BindingTrafficControls1757200000000 } from '@database/postgres/migrations/1757200000000-binding-traffic-controls';
import { StakeGraceAmounts1757300000000 } from '@database/postgres/migrations/1757300000000-stake-grace-amounts';
import {
  AccountId,
  CHAIN_IDS,
  ChainId,
  chainIdOf,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { AssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerBalanceService } from '@modules/ledger/services/ledger-balance.service';
import { LedgerHoldService } from '@modules/ledger/services/ledger-hold.service';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWriterService } from '@modules/ledger/services/ledger-writer.service';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { BindingMappingTesterService } from '@modules/provider/services/binding-mapping-tester.service';
import { ProviderEgressLimiter } from '@modules/provider/services/provider-egress-limiter.service';
import { BindingPauseService } from '@modules/provider/services/binding-pause.service';
import { BindingPublishService } from '@modules/provider/services/binding-publish.service';
import { DbChainEnrolmentSource } from '@modules/provider/services/db-chain-enrolment.source';
import { DbProviderRegistry } from '@modules/provider/services/db-provider-registry';
import { ProviderToolBindingsService } from '@modules/provider/services/provider-tool-bindings.service';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, ToolTier } from '@modules/tool/ports/tool.types';
import { DatabaseToolCatalogue } from '@modules/tool/services/database-tool-catalogue';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  TEST_POOL_SIZE,
  USDC_ASSET,
  USDC_DECIMALS,
  ensureTestDatabase,
  testConnectionOptions,
} from './test-database';
import { noBlocks } from '../../unit/helpers/blocklist';

loadEnv();

export { USDC_ASSET, USDC_DECIMALS };

/** The chain `USDC_ASSET` names — every binding in these fixtures settles here. */
export const STAKE_CHAIN: ChainId = chainIdOf(USDC_ASSET as AssetId);

/**
 * The binding editor, the mapping tester and the publish gate against a real
 * database.
 *
 * The ledger tables are here for one assertion and it is a stated
 * requirement: *"the tester must not charge anyone — check the ledger is unchanged
 * before and after."* Proving that needs a ledger with something in it, so the
 * context boots the real `LedgerService` over the real migration and funds an
 * account. A test that compared two empty tables would pass against a tester
 * that charged every call.
 *
 * `PROVIDER_STAKE_SOURCE` is a fake, deliberately: `ConfigProviderStakeSource`
 * reads a seed file and the on-chain source replaces it, so what the gate
 * needs from this context is a number it can move — not a fixture of whichever
 * implementation happens to be bound this month. `PROVIDER_REGISTRY` is the
 * **real** `DbProviderRegistry`, because the publish check is what bound it
 * and "a registered provider is now visible to routing" is a claim worth
 * testing rather than stubbing.
 */
export const TOOL: Tool = Object.freeze({
  id: 'search_web',
  name: 'Search the web',
  description: 'Returns web results for a query.',
  inputSchema: {
    type: 'object' as const,
    properties: { query: { type: 'string' as const } },
    required: ['query'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: { answer: { type: 'string' as const } },
    required: ['answer'],
  },
  verificationPolicyId: 'policy-default',
  tier: ToolTier.VERIFIED,
});

/**
 * A stake reading the test moves between assertions.
 *
 * Keyed per `(provider, chain)`, and `set` defaults to
 * {@link STAKE_CHAIN} — the chain `USDC_ASSET` names, which is the chain every
 * fixture binding here settles on. A test about two chains passes the chain.
 */
export class MutableStakeSource implements ProviderStakePort {
  private readings = new Map<string, ProviderStake>();

  set(providerId: string, staked: Money | null, chainId: ChainId = STAKE_CHAIN): void {
    const key = stakeKey(providerId, chainId);
    if (staked === null) {
      this.readings.delete(key);
      return;
    }
    this.readings.set(key, { providerId, chainId, staked, observedAt: new Date() });
  }

  stakeOn(keys: readonly ProviderChainStakeKey[]): Promise<ReadonlyMap<string, ProviderStake>> {
    const found = new Map<string, ProviderStake>();
    for (const { providerId, chainId } of keys) {
      const reading = this.readings.get(stakeKey(providerId, chainId));
      if (reading) found.set(stakeKey(providerId, chainId), reading);
    }
    return Promise.resolve(found);
  }
}

export interface BindingEditorTestContext {
  readonly dataSource: DataSource;
  readonly editor: BindingEditorService;
  readonly tester: BindingMappingTesterService;
  readonly publisher: BindingPublishService;
  /** The pause button — the provider's own, never the health breaker's. */
  readonly pauser: BindingPauseService;
  readonly bindingsList: ProviderToolBindingsService;
  readonly catalogue: ToolCataloguePort;
  readonly stakes: MutableStakeSource;
  readonly ledger: LedgerService;
  readonly bindings: ToolBindingRepository;
  readonly versions: BindingVersionRepository;
  readonly runs: BindingTestRunRepository;
  /** Rotated by `reset()` — one organization per test, no cleanup step. */
  organizationId: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  /**
   * `payoutAccountId` defaults to a proved address: the provider this
   * context describes is a routable one, and the publish gate now refuses a
   * PAID binding without one. Pass `null` to test that refusal.
   */
  registerProvider(options?: { payoutAccountId?: LedgerAccountId | null }): Promise<void>;
  fund(accountId: LedgerAccountId, atomic: bigint): Promise<void>;
  /** A CAIP-10 ledger account from a readable label. */
  account(label: string): LedgerAccountId;
  /** Every row of every money table, for a before/after comparison. */
  ledgerSnapshot(): Promise<unknown>;
  usdc(atomic: bigint): Money;
}

export const MINIMUM_STAKE: MinimumStakeParameters = Object.freeze({
  floor: MoneyUtil.of('50000000', USDC_ASSET, USDC_DECIMALS),
  priceMultiple: 1000,
});

/**
 * `DbChainEnrolmentSource` pages when it cannot type a row. Nothing in this
 * suite writes an untypeable one, so the port is satisfied and never called;
 * a jest mock would claim more than that.
 */
const NO_ALERTS = { emit: async (): Promise<void> => undefined };

export async function createBindingEditorTestContext(
  invoker: BindingInvokerPort,
): Promise<BindingEditorTestContext> {
  const database = await ensureTestDatabase(
    process.env.BINDING_TEST_DATABASE || `${process.env.DATABASE_NAME || 'app'}_binding_test`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [
      LedgerEntryEntity,
      LedgerHoldEntity,
      AccountBalanceEntity,
      ProviderEntity,
      ToolBindingEntity,
      BindingVersionEntity,
      BindingTestRunEntity,
      // The payout address the publish gate reads is on the
      // enrolment now, not on `providers`.
      ProviderChainEnrolmentEntity,
      // `payment_intents` is already migrated here for the sake of its table;
      // the entity is registered so `BindingCallCounterService` can hydrate a
      // binding's lifetime count from it rather than degrading to
      // `null` and printing a warning per candidate per routing decision.
      PaymentIntentEntity,
    ],
    migrations: [
      CreateLedger1755100000000,
      CreateProviderRegistrationTables1756600000000,
      // `ProviderEntity` gained `payout_threshold_override` here, and TypeORM
      // inserts every mapped column — so the row this context writes needs the
      // schema that has it, even though payouts are no part of this suite.
      ProviderEarningsAndPayouts1756700000000,
      CreateToolBindingTables1756900000000,
      // The stake-authority migration put `stake_authority`, `stake_proof` and
      // `stake_proved_at` on `ProviderEntity`. `registerProvider()` below
      // saves that entity, and TypeORM names every mapped column in its
      // INSERT — so without this migration every test in this context dies on
      // the first `registerProvider()`, which is what was happening.
      ProviderStakeAuthority1757000000000,
      // The traffic-controls migration spans two tables — the binding's ceilings and pause
      // columns, and `payment_intents.binding_id`, which is what makes the
      // exploration floor countable. This context has no payment surface and
      // wants none, but the ALTER lands on a table that has to exist, so the
      // CREATE comes along. Nothing here reads or writes an intent.
      CreatePaymentIntents1755200000000,
      // `ToolBindingEntity` gained the two ceilings and the two pause columns,
      // and TypeORM names every mapped column in its INSERT and its SELECT. So
      // this context needs the schema that has them even though no service in
      // this suite writes one; `chk_tool_bindings_pause_attributed` arrives
      // with them, which is what `binding-pause` asserts against.
      BindingTrafficControls1757200000000,
      // Stake grace. `provider_stake_grace` FKs to `tool_bindings`, so this
      // is the only context that can host it — and its six CHECK constraints
      // were, until `provider-stake-grace-constraints`, asserted by nothing but
      // the comments that wrote them. No service in this suite touches the
      // table; the migrations are here so that spec can reach a real schema.
      CreateProviderStakeGrace1757100000000,
      StakeGraceAmounts1757300000000,
      // Creates `provider_chain_enrolments` (and backfills it from
      // `providers`, a no-op here), then drops the three payout columns. Both
      // are needed: `registerProvider()` below writes an enrolment, and
      // `ProviderEntity` no longer maps the dropped columns, so a schema one
      // migration short would fail every INSERT with "column does not exist".
      CreateProviderChainEnrolments1759300000001,
      DropProviderPayoutColumns1759300000002,
      // `tool_bindings.settlement_chains`, which
      // `ToolBindingEntity` maps. TypeORM names every mapped column in its
      // INSERT and its SELECT, so without this migration every binding this
      // context writes fails on a column that does not exist. The column is
      // NOT NULL with a non-empty CHECK, so the fixture bodies name a chain.
      ToolBindingSettlementChains1759300000004,
      // `payment_intents.voucher_delegate`, which `PaymentIntentEntity` maps
      // (agent payment delegation).
      VoucherDelegate1759600000000,
      VoucherAdmissionIndex1759600000003,
      PaymentIntentCredential1759600000004,
      // `voucher_admission_pauses`, which the voucher admission reads (BUG-D1-07).
      VoucherAdmissionPause1759600000005,
      VoucherAdmissionPausePerRequest1759600000006,
      // `redemption_tx_refs`, `redemption_last_error`, `redemption_lapsed_at`,
      // `redemption_replaced_at` and `voucher_resource`, all mapped by
      // `PaymentIntentEntity` (redemption tracking and buyer debt).
      PaymentIntentRedemptionTxRefs1760200000000,
      PaymentIntentRedemptionLastError1760600000000,
      PaymentIntentRedemptionLapsed1760700000000,
      PaymentIntentDebtReplacing1760800000000,
      VoucherSeqDebtReplacement1760900000000,
    ],
    synchronize: false,
    logging: process.env.BINDING_TEST_LOGGING === 'true',
    extra: { max: TEST_POOL_SIZE },
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const bindings = new ToolBindingRepository(dataSource);
  const versions = new BindingVersionRepository(dataSource);
  const runs = new BindingTestRunRepository(dataSource);
  const providers = new ProviderRepository(dataSource);
  const chainEnrolments = new ProviderChainEnrolmentRepository(dataSource);

  const journal = new LedgerJournalService(
    new LedgerEntryRepository(dataSource),
    new AccountBalanceRepository(dataSource),
    dataSource,
  );
  const writer = new LedgerWriterService(journal, dataSource);
  const ledger = new LedgerService(
    journal,
    writer,
    new LedgerBalanceService(new AccountBalanceRepository(dataSource), journal),
    new LedgerHoldService(new LedgerHoldRepository(dataSource), journal, dataSource),
  );

  const catalogue = new DatabaseToolCatalogue({ tools: [TOOL], bindings: [] }, bindings, versions);
  const stakes = new MutableStakeSource();

  // No policy is registered for any tool yet, which is also what production
  // sees — `VerificationAggregatorService.decide` gets `null` and settles
  // unverified. The tester labels its run `TOOL_SCHEMA_ONLY` rather than
  // pretending otherwise.
  const policies = { resolveForTraffic: async () => null } as unknown as DecisionPolicyService;

  // The write-time chain gate reads the REAL enrolment table
  // this context already writes, and the same mutable stake source the publish
  // gate is given — so a binding saved here is refused for exactly the reasons
  // production would refuse it, rather than passing a stubbed gate.
  const editor = new BindingEditorService(
    bindings,
    catalogue,
    dataSource,
    new DbChainEnrolmentSource(chainEnrolments, NO_ALERTS),
    stakes,
    [STAKE_CHAIN],
    new Map([[STAKE_CHAIN, MINIMUM_STAKE]]),
  );
  const tester = new BindingMappingTesterService(
    editor,
    runs,
    catalogue,
    invoker,
    policies,
    new ProviderEgressLimiter(),
  );
  const publisher = new BindingPublishService(
    editor,
    runs,
    stakes,
    new DbProviderRegistry(
      providers,
      new DbChainEnrolmentSource(chainEnrolments, NO_ALERTS),
      noBlocks(),
    ),
    new Map([[STAKE_CHAIN, MINIMUM_STAKE]]),
    dataSource,
  );

  const context: BindingEditorTestContext = {
    dataSource,
    editor,
    tester,
    publisher,
    pauser: new BindingPauseService(editor, bindings),
    // Three constructor arguments since the catalogue endpoint landed;
    // this call site had only ever passed one, which is why every suite on this
    // context failed to compile. The catalogue is the same port the editor
    // holds, and `ConfigService` falls back to `PLATFORM_STAKE_ASSET_ID`'s
    // default when the variable is unset — neither is exercised by the binding
    // list, which is all this context uses the service for.
    bindingsList: new ProviderToolBindingsService(bindings, catalogue, new ConfigService()),
    catalogue,
    stakes,
    ledger,
    bindings,
    versions,
    runs,
    organizationId: randomUUID(),

    async reset(): Promise<void> {
      for (let attempt = 0; attempt < 5 && writer.pending > 0; attempt += 1) {
        try {
          await writer.flush();
        } catch {
          // A batch a previous test abandoned is that test's business.
        }
      }
      writer.drainQuarantine();
      context.organizationId = randomUUID();
    },

    async close(): Promise<void> {
      await dataSource.destroy();
    },

    /**
     * The `providers` row and the chain enrolment `DbProviderRegistry` reads.
     *
     * Written directly rather than through `ProviderRegistrationService`: this
     * suite is about bindings, and registration has its own 29 tests. What is
     * set here is exactly what routing consults — and since multichain support that is
     * two tables, because the payout address moved onto the enrolment.
     */
    async registerProvider(
      options: { payoutAccountId?: LedgerAccountId | null } = {},
    ): Promise<void> {
      // Upsert, not insert: `uq_providers_organization_id` allows one row per
      // organization, and a test that re-registers to change one column (a
      // payout address, say) must update the row rather than collide with it.
      const row =
        (await providers.findOne({ where: { organizationId: context.organizationId } })) ??
        new ProviderEntity();
      row.organizationId = context.organizationId;
      row.legalName = 'Marine Traffic BV';
      row.technicalContact = { name: 'Dan', email: 'dan@example.test' } as never;
      row.ownerContact = { name: 'Ada', email: 'ada@example.test' } as never;
      row.timezone = 'Europe/Amsterdam';
      row.acceptedTerms = {
        providerAgreementVersion: 'v1.0',
        payoutTermsVersion: 'v1.0',
        slashPolicyVersion: 'v1.0',
        acceptedAt: new Date().toISOString(),
        acceptedBy: 'cred-test',
      } as never;
      await providers.save(row);

      // Per chain — the publish gate and `filterEligible`
      // both refuse a PAID binding whose provider has proved no payout address
      // ON THE CHAIN THE BINDING SETTLES ON. In production this row has exactly
      // one writer, `ProviderPayoutAddressService`, and it only writes after
      // verifying a signature; here it is written directly for the same reason
      // the rest of the provider row is.
      //
      // The chain comes from the address, not from a constant: `account()`
      // mints CAIP-10 on `SOLANA_MAINNET` and the bindings in this suite are
      // priced in `USDC_SOLANA_MAINNET`, so the two agree — and if either ever
      // moves, `chainIdOf` moves the enrolment with it instead of filing the
      // address under a chain nothing settles on.
      const payoutAccountId =
        options.payoutAccountId === undefined
          ? (context.account('registered-provider-payout') as string)
          : (options.payoutAccountId as string | null);

      // Re-registering to CHANGE the address must not leave the old enrolment
      // behind: `uq_provider_chain_enrolments_org_chain` would refuse the
      // insert, and a test that expects "no proved address" would then be
      // reading a row it thought it had replaced.
      await dataSource.query('DELETE FROM provider_chain_enrolments WHERE organization_id = $1', [
        context.organizationId,
      ]);

      if (payoutAccountId) {
        await dataSource.query(
          `INSERT INTO provider_chain_enrolments
             (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
              status, enrolled_at)
           VALUES ($1, $2, $3, $4, now(), 'ACTIVE', now())`,
          [
            context.organizationId,
            chainIdOf(payoutAccountId as AccountId),
            payoutAccountId,
            JSON.stringify({
              challengeId: randomUUID(),
              signature: 'test-signature',
              messageVersion: 'x402-payout-proof/v1',
              provedAt: new Date().toISOString(),
            }),
          ],
        );
      }
    },

    async fund(accountId: LedgerAccountId, atomic: bigint): Promise<void> {
      await ledger.appendNow({
        organizationId: context.organizationId,
        accountId,
        entryType: LedgerEntryType.DEPOSIT,
        money: context.usdc(atomic),
      });
    },

    async ledgerSnapshot(): Promise<unknown> {
      // Whole rows, not counts. A tester that wrote and then reversed an entry
      // would keep the count and change the table, and the count is exactly
      // the check that would miss it.
      const [entries, balances, holds] = await Promise.all([
        dataSource.query('SELECT * FROM ledger_entries ORDER BY seq'),
        dataSource.query('SELECT * FROM account_balances ORDER BY account_id, asset_id'),
        dataSource.query('SELECT * FROM ledger_holds ORDER BY created_at, id'),
      ]);
      return { entries, balances, holds };
    },

    account(label: string): LedgerAccountId {
      return toAccountId(CHAIN_IDS.SOLANA_MAINNET, label) as AccountId;
    },

    usdc(atomic: bigint): Money {
      return MoneyUtil.of(atomic, USDC_ASSET as AssetId, USDC_DECIMALS);
    },
  };

  return context;
}
