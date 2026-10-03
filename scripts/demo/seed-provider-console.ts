/**
 * Seed the provider console with data it can actually render.
 *
 * ```bash
 * yarn demo:seed
 * ```
 *
 * ## What this exists for
 *
 * Twelve provider screens were built against a database holding **two** payment
 * intents, **one** verification record and **zero** payouts. Every one of them
 * rendered its empty state, so nothing they claim to show had ever been seen:
 * a classification breakdown cannot be demonstrated by a CSV with one data row,
 * and a "live SLA position" cannot be demonstrated by a window that closed
 * yesterday. This writes the traffic those screens describe.
 *
 * ## It is a demo seeder, and it goes through the real services
 *
 * Every intent here is created by `PaymentIntentService` and driven through the
 * real transition table; every verdict is produced by
 * `VerificationSettlementService` judging a real response against the real
 * policy `yarn mcp:policies` promotes. Nothing writes a status, a verdict or a
 * ledger balance by hand — a seeder that did would be describing a machine that
 * does not exist, and the screens would be validated against fiction.
 *
 * Two places are honest exceptions, and both are named where they happen:
 *
 * - **`created_at` is rewritten afterwards** (see {@link backdate}). A row's
 *   creation timestamp is not an input to any service, and ten days of history
 *   cannot be produced in one process any other way. `ledger_entries` is never
 *   touched by it — that table refuses `UPDATE` by design (append-only) and this
 *   script does not go near the trigger.
 * - **`tool_bindings`, `binding_versions`, `binding_test_runs`,
 *   `provider_payouts` and the `providers` row are written through their
 *   repositories**, not through `BindingEditorService` / `ProviderPayoutBatchService`.
 *   Those services live in `ProviderApiModule`, which this context does not
 *   load, and the payout batch additionally needs a Squads vault. The rows
 *   written match what those services write, constraint for constraint.
 *
 * ## Idempotent
 *
 * Safe to re-run. Every unit of work is keyed on something the schema already
 * makes unique — `payment_intents.call_id`, `tool_bindings (organization_id,
 * tool_id)`, `binding_test_runs.call_id`, `provider_payouts (organization_id,
 * asset_id, period_start)` — and is skipped when it is already there. A partial
 * run can be resumed by running it again.
 *
 * ## What it deliberately does NOT seed
 *
 * `disputes`, `notifications`, `audit_log_entries` and slash proposals. Those
 * screens are blocked on backend gaps no seed can close — the verdict and
 * dispute queries scope on the **payer's** `organization_id`, so a provider's
 * own rows are invisible to them, and four screens have no route at all.
 * Seeding them would produce rows no
 * endpoint can return to a provider, which reads as a working feature until
 * somebody opens the screen.
 *
 * The second demo organization (`mcp_demo_token_new_provider`) is left with **no
 * `providers` row on purpose**: "a console session for an organization that has
 * never registered" is a state the UI has to render, and it has no other way to
 * reach it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  BindingTestRunEntity,
  BindingTestRunRepository,
  BindingVersionEntity,
  BindingVersionRepository,
  ProviderEntity,
  ProviderPayoutEntity,
  ProviderPayoutRepository,
  ProviderRepository,
  ToolBindingEntity,
  ToolBindingRepository,
  VerificationRecordRepository,
} from '@database/postgres';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerJournalService } from '@modules/ledger/services/ledger-journal.service';
import { runInLedgerTransaction } from '@modules/ledger/services/ledger-transaction.util';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import {
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import {
  normalizeRequestMapping,
  normalizeResponseMapping,
  type RequestMappingSpec,
  type ResponseMappingSpec,
} from '@modules/tool/domain/mapping';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import { VerificationSettlementService } from '@modules/verification/services/verification-settlement.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { AppMcpModule } from '../../src/bootstrap/mcp/app.module';
import { DEMO_CREDENTIALS, SEED_DIR } from '../mcp/demo-config';
import { readPolicySeed, seedDecisionPolicy } from '../mcp/policies';

// ── The demo cast ──────────────────────────────────────────────────────────

/** The organization `mcp_demo_token_provider` belongs to. Serves every seeded call. */
const PROVIDER_ORG = 'a965eec3-ad93-4257-bf9b-e172361ee56c';
/**
 * `mcp_demo_token_new_provider`. Named here only so the rule is greppable:
 * **nothing in this file may write a row for it.** See the header.
 */
const UNREGISTERED_ORG = '2f6b1c84-9e07-4a3d-8b52-71d0c6f4ae19';

const ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
const DECIMALS = 6;
const CHAIN: ChainId = CHAIN_IDS.SOLANA_DEVNET;

/** `PLATFORM_FEE_BPS` in `.env`. Restated so the split satisfies `chk_payment_intents_fee_split`. */
const PLATFORM_FEE_BPS = 2000n;

/** What every buyer agent is topped up to before the calls run. 500 USDC. */
const BUYER_TARGET_BALANCE = 500_000_000n;

/** The provider's own wallet — where `PROVIDER_CREDIT` lands and `PAYOUT` leaves from. */
const PROVIDER_ACCOUNT = `${CHAIN}:ProviderDemoWalletAddress4444444` as AccountId;
/** A different wallet: what a payout is *sent to*, proved separately from the credit account. */
const PROVIDER_PAYOUT_ACCOUNT = `${CHAIN}:ProviderDemoPayoutWallet66666666`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the seeded traffic reaches. Must be ≥ 10 — reconciliation reads a window. */
const HISTORY_DAYS = 12;

// ── Bindings ───────────────────────────────────────────────────────────────

/**
 * A plan as written below, in the mapping language's **sugar** — a bare
 * `'$.latitude'` for a path, a bare `'temperature_2m'` for a constant. This is
 * what a provider types, and it is deliberately NOT what gets stored.
 */
interface BindingPlan {
  readonly label: string;
  readonly toolId: string;
  readonly endpoint: string;
  readonly requestMapping: Record<string, unknown>;
  readonly responseMapping: Record<string, unknown>;
  /** Atomic units of {@link ASSET}. */
  readonly priceAmount: bigint;
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly mappingVersion: number;
  readonly maxRps: number | null;
  readonly maxDailyCalls: number | null;
}

interface CataloguedTool {
  readonly id: string;
  readonly name: string;
  readonly outputSchema: Record<string, unknown>;
}

/**
 * Both tools of `TOOL_CATALOGUE_SEED_FILE`, bound to the one demo provider.
 *
 * The prices are this file's, not `catalogue.json`'s. `DatabaseToolCatalogue`
 * reads bindings from `tool_bindings` and never from the seed file's own
 * `bindings` array, so there is nothing to disagree with — and a price of
 * `0.01` makes the Capital screen's requirement collapse onto the `$50` floor,
 * which hides the `1000 ×` rule the screen exists to explain. At `$0.25` the
 * requirement is `1000 × price`, and the derivation string says so.
 */
/**
 * The plans below are written in the mapping language's **sugar** — a bare
 * `'$.latitude'` for a path and a bare `'temperature_2m'` for a constant —
 * because that is what a provider actually types.
 *
 * Every production writer normalises before it stores: `catalogue-seed.ts`
 * calls `normalizeRequestMapping`, and `BindingEditorService` calls
 * `inspectRequestMapping(...).spec` at Save. **A seeder that writes the sugar
 * straight into the `jsonb` column bypasses both**, and `evaluateNode` then
 * receives a bare string, fails all three `typeof node === 'object'` guards,
 * and falls to `Object.entries('$')` -> `[['0','$']]` -> infinite recursion.
 *
 * That is not a seeding inconvenience: `EgressBindingInvoker.invoke` calls the
 * same `mapRequest`, so an unnormalised row hangs the **production router**
 * with `RangeError: Maximum call stack size exceeded`. It shipped that way
 * once and took out the whole mapping tester (2026-08-21).
 *
 * So normalise here, at the single point where a plan becomes a row.
 */
type StoredBindingPlan = Omit<BindingPlan, 'requestMapping' | 'responseMapping'> & {
  readonly requestMapping: RequestMappingSpec;
  readonly responseMapping: ResponseMappingSpec;
};

function normalizedPlan(plan: BindingPlan): StoredBindingPlan {
  return {
    ...plan,
    requestMapping: normalizeRequestMapping(plan.requestMapping),
    responseMapping: normalizeResponseMapping(plan.responseMapping),
  };
}

const RAW_BINDINGS: readonly BindingPlan[] = [
  {
    label: 'weather',
    toolId: '06399979-f8b8-4c9e-a9b1-bd2a5924d442',
    endpoint: 'https://api.open-meteo.com',
    requestMapping: {
      method: 'GET',
      path: '/v1/forecast',
      query: { latitude: '$.latitude', longitude: '$.longitude', current: 'temperature_2m' },
    },
    responseMapping: {
      temperatureC: { $path: '$.current.temperature_2m' },
      observedAt: { $path: '$.current.time' },
    },
    priceAmount: 250_000n,
    status: 'ACTIVE',
    mappingVersion: 2,
    maxRps: 20,
    maxDailyCalls: 50_000,
  },
  {
    label: 'fx',
    toolId: 'a4b9882a-9bc1-4d64-807a-27c0b93daf0a',
    endpoint: 'https://api.frankfurter.dev',
    requestMapping: { method: 'GET', path: '/v1/latest', query: { base: 'USD', symbols: 'EUR' } },
    responseMapping: {
      rate: { $path: '$.rates.EUR' },
      publishedFor: { $path: '$.date' },
    },
    priceAmount: 100_000n,
    status: 'PAUSED',
    mappingVersion: 1,
    maxRps: null,
    maxDailyCalls: null,
  },
];

const BINDINGS: readonly StoredBindingPlan[] = RAW_BINDINGS.map(normalizedPlan);

// ── Calls ──────────────────────────────────────────────────────────────────

/**
 * How a seeded call ends.
 *
 * Every member is reached by driving the **real** transition table; none of
 * them writes a status directly. `SETTLED` and `REFUNDED` are not in this list
 * because they are not chosen — they are whatever the verdict decides, which is
 * the point of {@link VERIFIED_GOOD} / {@link VERIFIED_BAD}.
 */
enum CallShape {
  /** Judged against a response the policy accepts → `PASS` → `SETTLED`. */
  VERIFIED_GOOD = 'VERIFIED_GOOD',
  /** Judged against a response the policy rejects → `FAIL` → `REFUNDED`. */
  VERIFIED_BAD = 'VERIFIED_BAD',
  /** Reserved, never executed, swept. `EXPIRED` + `SYSTEM_ERROR`. */
  EXPIRED_SYSTEM = 'EXPIRED_SYSTEM',
  /** Reserved, the agent's arguments were wrong. `EXPIRED` + `REQUEST_ERROR`. */
  EXPIRED_REQUEST = 'EXPIRED_REQUEST',
  /** The provider answered something unusable. `VOIDED` + `SYSTEM_ERROR`. */
  VOIDED_SYSTEM = 'VOIDED_SYSTEM',
  /** Still in flight at `VERIFYING` — the export's `PENDING` class. */
  IN_FLIGHT = 'IN_FLIGHT',
}

interface CallPlan {
  readonly dayOffset: number;
  readonly shape: CallShape;
  readonly callClass: PaymentIntentCallClass;
  readonly binding: StoredBindingPlan;
  readonly buyerIndex: number;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });

  // The connection is registered under the **named** `'postgres'` token, not
  // the default one — the same detail that makes `app.close()` throw below.
  const dataSource = app.get<DataSource>(getDataSourceToken('postgres'));
  const ledger = app.get(LedgerService);
  const intents = app.get(PaymentIntentService);
  const verification = app.get(VerificationSettlementService);
  const records = app.get(VerificationRecordRepository);
  const policies = app.get(DecisionPolicyService);
  const providers = app.get(ProviderRepository);
  const bindings = app.get(ToolBindingRepository);
  const versions = app.get(BindingVersionRepository);
  const testRuns = app.get(BindingTestRunRepository);
  const payouts = app.get(ProviderPayoutRepository);
  const journal = app.get(LedgerJournalService);

  const tools = readCatalogueTools();
  assertAssetIsCurrent();

  log(`asset ${ASSET}`);

  // 1. Policies first. Without an `ACTIVE` one, `decide()` returns null and
  //    every verdict below is `UNVERIFIED` — no stages, no tally, no evidence.
  for (const entry of readPolicySeed()) {
    await seedDecisionPolicy(policies, entry);
  }
  log(`policies  ${readPolicySeed().length} tools have a serving decision policy`);

  // 2. The provider whose console this is.
  await seedProvider(providers, dataSource);
  log(`provider  ${PROVIDER_ORG}`);

  // 3. Its bindings, their revision history and their tester runs.
  const bindingRows = await seedBindings(bindings, versions, testRuns);
  log(
    `bindings  ${bindingRows.map((row) => `${row.toolId.slice(0, 8)}=${row.status}`).join('  ')}`,
  );

  // 4. Buyers. Topped up to a target rather than deposited blindly, so a
  //    re-run does not mint another 500 USDC per agent.
  const buyers = fundableBuyers();
  for (const buyer of buyers) {
    await topUp(ledger, buyer);
  }
  log(`buyers    ${buyers.map((b) => b.label).join(', ')}`);

  // 5. The traffic.
  const plans = planCalls(buyers.length);
  const written = await seedCalls({
    plans,
    buyers,
    bindingRows,
    tools,
    intents,
    verification,
    records,
    dataSource,
  });
  log(`calls     ${written} written, ${plans.length - written} already present`);

  // 6. Earnings out. Needs the credits from step 5 to already be in the ledger.
  const paid = await seedPayouts(payouts, journal, dataSource);
  log(`payouts   ${paid} provider_payouts rows`);

  await report(dataSource);

  // See the note in `scripts/mcp/ledger.ts`: closing a context that registered
  // the named `'postgres'` connection throws on shutdown, pre-existing and
  // unrelated to this script.
  await app.close().catch(() => undefined);
  process.exit(0);
}

// ── Guards ─────────────────────────────────────────────────────────────────

/**
 * Refuse to seed against an asset the running process cannot resolve.
 *
 * This is the exact failure this seeder was written after: 285 rows carrying a
 * mint that `SOLANA_DEVNET_USDC_MINT` no longer names, and every endpoint that
 * serialises money answering `400 CHAIN_ASSET_UNKNOWN`. The registry resolves
 * its devnet slot **once, at module load**, so the only safe moment to check is
 * before the first row is written.
 */
function assertAssetIsCurrent(): void {
  // An ARRAY of `{ providerId, chainId, amount, asset, decimals }` since
  // multichain support — the stake seed is keyed on the (provider, chain) pair, which a JSON
  // object key cannot hold. Every entry for this provider is checked, not the
  // first: an entry on a second chain in a stale asset would fail exactly the
  // same way and is exactly as invisible.
  const stakes = JSON.parse(readFileSync(join(SEED_DIR, 'stakes.json'), 'utf8')) as readonly {
    providerId: string;
    chainId: string;
    asset: string;
  }[];
  const own = stakes.filter((entry) => entry.providerId === PROVIDER_ORG);

  if (own.length === 0) {
    throw new Error(
      `PROVIDER_STAKE_SEED_FILE names no stake for ${PROVIDER_ORG}, so the Capital screen ` +
        `would report hasKnownStake: false against its own seed. Add an entry before seeding.`,
    );
  }

  for (const entry of own) {
    if (entry.asset !== ASSET) {
      throw new Error(
        `PROVIDER_STAKE_SEED_FILE stakes ${PROVIDER_ORG} on ${entry.chainId} in ${entry.asset}, ` +
          `but this process resolves ${ASSET}. The Capital screen would report ` +
          `STAKE_ASSET_MISMATCH against its own seed. Point SOLANA_DEVNET_USDC_MINT and ` +
          `stakes.json at the same mint before seeding.`,
      );
    }
  }
}

function readCatalogueTools(): ReadonlyMap<string, CataloguedTool> {
  const path = process.env.TOOL_CATALOGUE_SEED_FILE ?? join(SEED_DIR, 'catalogue.json');
  const catalogue = JSON.parse(readFileSync(path, 'utf8')) as { tools: CataloguedTool[] };
  return new Map(catalogue.tools.map((tool) => [tool.id, tool]));
}

// ── The provider ───────────────────────────────────────────────────────────

/**
 * The `providers` row `DbProviderRegistry` reads, and `ProviderPayoutBatchService`
 * would pay from.
 *
 * The enrolment's `stake_authority_account_id` is left null on purpose
 * (`providers.stake_authority` before multichain support). Setting it makes
 * `ProviderStakeService.readChain` issue a devnet RPC call on every load of the
 * Capital screen; with no authority the screen answers out of Postgres alone
 * and reports `chainReadable: true` with the chain-derived fields absent, which
 * is the honest state for a provider who has never signed the challenge.
 */
async function seedProvider(providers: ProviderRepository, dataSource: DataSource): Promise<void> {
  const existing = await providers.findOneBy({ organizationId: PROVIDER_ORG });
  const row = existing ?? new ProviderEntity();

  row.organizationId = PROVIDER_ORG;
  row.legalName = 'Open-Meteo Demo BV';
  row.technicalContact = { name: 'Dana Ruiz', email: 'tech@open-meteo-demo.test' } as never;
  row.ownerContact = { name: 'Ada Okonkwo', email: 'owner@open-meteo-demo.test' } as never;
  row.timezone = 'Europe/Amsterdam';
  row.acceptedTerms = {
    providerAgreementVersion: process.env.PROVIDER_TERMS_AGREEMENT_VERSION ?? 'v1.0',
    payoutTermsVersion: process.env.PROVIDER_TERMS_PAYOUT_VERSION ?? 'v1.0',
    slashPolicyVersion: process.env.PROVIDER_TERMS_SLASH_POLICY_VERSION ?? 'v1.0',
    acceptedAt: new Date(Date.now() - HISTORY_DAYS * DAY_MS).toISOString(),
    acceptedBy: 'cred-demo-provider',
  } as never;
  row.status = 'ACTIVE';
  row.tier = 'ESTABLISHED';
  row.endpoint = 'https://api.open-meteo.com';
  await providers.save(row);

  // The payout address is the ENROLMENT's, not the provider's, and
  // without one the demo provider is unroutable: `evaluatePayoutGate` refuses
  // every PAID binding for a provider with no entry on the settling chain.
  // Written as an upsert on (organization, chain) because the seed is re-run.
  const provedAt = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
  await dataSource.query(
    `INSERT INTO provider_chain_enrolments
       (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
        status, enrolled_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $5)
     ON CONFLICT (organization_id, chain_id) DO UPDATE SET
       payout_account_id = EXCLUDED.payout_account_id,
       payout_proof      = EXCLUDED.payout_proof,
       payout_proved_at  = EXCLUDED.payout_proved_at`,
    [
      PROVIDER_ORG,
      CHAIN,
      PROVIDER_PAYOUT_ACCOUNT,
      JSON.stringify({
        challengeId: uuidFromLabel('demo:payout-challenge'),
        signature: 'demo-seed-signature-not-a-real-ed25519-signature',
        messageVersion: 'x402-payout-proof/v1',
        provedAt: provedAt.toISOString(),
      }),
      provedAt,
    ],
  );
}

// ── Bindings ───────────────────────────────────────────────────────────────

async function seedBindings(
  bindings: ToolBindingRepository,
  versions: BindingVersionRepository,
  testRuns: BindingTestRunRepository,
): Promise<ToolBindingEntity[]> {
  const written: ToolBindingEntity[] = [];

  for (const plan of BINDINGS) {
    // `uq_tool_bindings_organization_tool` — one binding per (org, tool), so
    // the pair is the idempotency key rather than the id.
    const existing = await bindings.findOneBy({
      organizationId: PROVIDER_ORG,
      toolId: plan.toolId,
    });
    const row = existing ?? new ToolBindingEntity();

    row.organizationId = PROVIDER_ORG;
    row.toolId = plan.toolId;
    row.endpoint = plan.endpoint;
    row.requestMapping = plan.requestMapping as never;
    row.responseMapping = plan.responseMapping as never;
    row.pricingMode = 'PAID';
    row.priceAmount = plan.priceAmount.toString();
    row.assetId = ASSET;
    // `CHAIN` is the same constant the payout enrolment above is
    // written under, so the demo provider is offered exactly where it can be
    // paid — read from the fixture's own declaration rather than parsed back
    // out of `ASSET`.
    row.settlementChains = [CHAIN];
    row.freeQuotaPerAgent = null;
    row.freeDailyBudget = null;
    row.slaFailureRate = '0.02000';
    row.timeoutMs = 10_000;
    row.mappingVersion = plan.mappingVersion;
    row.status = plan.status;
    // `chk_tool_bindings_active_is_published` — ACTIVE and PAUSED both require
    // a published revision, because both are states a published binding is in.
    row.publishedVersion = plan.mappingVersion;
    row.publishedAt = daysAgo(HISTORY_DAYS - 1);
    row.maxRps = plan.maxRps;
    row.maxDailyCalls = plan.maxDailyCalls;
    // `chk_tool_bindings_pause_attributed` — a pause always says who paused it.
    row.pauseReason = plan.status === 'PAUSED' ? 'PROVIDER_REQUESTED' : null;
    row.pausedAt = plan.status === 'PAUSED' ? daysAgo(2) : null;

    written.push(await bindings.save(row));
  }

  for (const [index, plan] of BINDINGS.entries()) {
    const row = written[index];

    // Every revision up to the current one, so the editor has a history to
    // show. `uq_binding_versions_binding_mapping_version` keys the skip.
    for (let mappingVersion = 1; mappingVersion <= plan.mappingVersion; mappingVersion += 1) {
      const already = await versions.findOneBy({
        organizationId: PROVIDER_ORG,
        bindingId: row.id,
        mappingVersion,
      });
      if (already) continue;

      const version = new BindingVersionEntity();
      version.organizationId = PROVIDER_ORG;
      version.bindingId = row.id;
      version.mappingVersion = mappingVersion;
      version.toolId = plan.toolId;
      version.endpoint = plan.endpoint;
      version.requestMapping = plan.requestMapping as never;
      version.responseMapping = plan.responseMapping as never;
      version.pricingMode = 'PAID';
      version.priceAmount = plan.priceAmount.toString();
      version.assetId = ASSET;
      version.timeoutMs = 10_000;
      version.authoredBy = 'cred-demo-provider';
      // `chk_binding_versions_published_attributed` — both or neither.
      version.publishedAt = daysAgo(HISTORY_DAYS - mappingVersion);
      version.publishedBy = 'cred-demo-provider';
      await versions.save(version);
    }

    // One tester run per revision. The **current** revision passes, because a
    // published binding whose latest run failed is a state the publish gate
    // refuses — seeding it would show the console a binding it could not have
    // published. Earlier revisions carry the failure that motivated the edit.
    for (let mappingVersion = 1; mappingVersion <= plan.mappingVersion; mappingVersion += 1) {
      const passed = mappingVersion === plan.mappingVersion;
      const callId = uuidFromLabel(`demo:test-run:${plan.label}:${mappingVersion}`);
      if (await testRuns.findOneBy({ organizationId: PROVIDER_ORG, callId })) continue;

      const run = new BindingTestRunEntity();
      run.organizationId = PROVIDER_ORG;
      run.bindingId = row.id;
      run.mappingVersion = mappingVersion;
      run.callId = callId;
      run.outcome = passed ? 'PASSED' : 'FAILED';
      // `chk_binding_test_runs_failure_is_located` — a failure names its layer.
      run.failedLayer = passed ? null : 'RESPONSE_MAPPING';
      run.sampleInput = sampleInputFor(plan) as never;
      run.report = testReport(plan, callId, passed) as never;
      run.ranBy = 'cred-demo-provider';
      await testRuns.save(run);
    }
  }

  return written;
}

function sampleInputFor(plan: StoredBindingPlan): Record<string, unknown> {
  return plan.label === 'weather' ? { latitude: 52.37, longitude: 4.89 } : {};
}

/**
 * A `BindingTestReport`, shaped exactly as `BindingMappingTesterService` stores
 * it — five layers in order, every one of them present.
 *
 * The receipt's rule applies here too: an absent layer reads as a tick to anyone
 * scanning the list, so a failed run records the layers after the failure as
 * `NOT_REACHED` rather than omitting them.
 */
function testReport(
  plan: StoredBindingPlan,
  callId: string,
  passed: boolean,
): Record<string, unknown> {
  const layers = ['REQUEST_MAPPING', 'UPSTREAM', 'CLASSIFICATION', 'RESPONSE_MAPPING', 'VERIFICATION'];
  const failedAt = passed ? -1 : layers.indexOf('RESPONSE_MAPPING');

  return {
    callId,
    outcome: passed ? 'PASSED' : 'FAILED',
    failedLayer: passed ? null : 'RESPONSE_MAPPING',
    layers: layers.map((layer, index) => ({
      layer,
      status:
        passed || failedAt < 0 || index < failedAt
          ? 'PASSED'
          : index === failedAt
            ? 'FAILED'
            : 'NOT_REACHED',
      code: index === failedAt ? 'MAPPING_SELECTOR_RESOLVED_TO_NOTHING' : null,
      detail:
        index === failedAt
          ? 'The selector for `observedAt` resolved to nothing in this response.'
          : null,
      fault: index === failedAt ? 'PROVIDER' : null,
    })),
    request: {
      method: 'GET',
      url: `${plan.endpoint}${(plan.requestMapping as { path: string }).path}`,
      headerNames: ['accept', 'x-x402-call-id'],
      body: null,
    },
    upstream: {
      status: 200,
      latencyMs: plan.label === 'weather' ? 148 : 212,
      rawBody: JSON.stringify(upstreamBodyFor(plan)),
      rawBodyTruncated: false,
      contentType: 'application/json',
      transportError: null,
    },
    classification: 'DATA_RESULT',
    mapped: passed ? goodResponseFor(plan) : null,
    verification: passed
      ? {
          policySource: 'STORED_POLICY',
          policyId: `${plan.label === 'weather' ? 'get_weather' : 'get_usd_eur_rate'}.default`,
          policyVersion: 1,
          stages: [],
          verdict: 'PASS',
        }
      : null,
  };
}

function upstreamBodyFor(plan: StoredBindingPlan): Record<string, unknown> {
  return plan.label === 'weather'
    ? { current: { temperature_2m: 12.4, time: new Date().toISOString() } }
    : { rates: { EUR: 0.92 }, date: new Date().toISOString().slice(0, 10) };
}

// ── Buyers ─────────────────────────────────────────────────────────────────

interface Buyer {
  readonly label: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: AccountId;
}

/**
 * Every demo credential that can hold money, except the provider's own.
 *
 * The provider organization is excluded because it is the payee here, not a
 * payer, and an intent whose `organization_id` equals its `provider_id` would
 * quietly make the "`providerId == organizationId` is load-bearing" assumption
 * look true for a reason it is not.
 */
function fundableBuyers(): readonly Buyer[] {
  return DEMO_CREDENTIALS.filter(
    (credential) =>
      credential.fundable &&
      credential.organizationId !== PROVIDER_ORG &&
      credential.organizationId !== UNREGISTERED_ORG,
  ).map((credential) => ({
    label: credential.label,
    organizationId: credential.organizationId,
    agentId: credential.agentId,
    agentAccount: credential.agentAccount as AccountId,
  }));
}

/** Deposits the difference, never a fixed amount — so a re-run does not double the balance. */
async function topUp(ledger: LedgerService, buyer: Buyer): Promise<void> {
  const balance = await ledger.getBalance(
    buyer.organizationId,
    buyer.agentAccount as LedgerAccountId,
    ASSET,
  );
  const shortfall = BUYER_TARGET_BALANCE - MoneyUtil.toAtomic(balance.available);
  if (shortfall <= 0n) return;

  await ledger.appendNow({
    organizationId: buyer.organizationId,
    accountId: buyer.agentAccount as LedgerAccountId,
    entryType: LedgerEntryType.DEPOSIT,
    money: MoneyUtil.of(shortfall, ASSET, DECIMALS),
  });
}

// ── Calls ──────────────────────────────────────────────────────────────────

/**
 * The traffic plan: what happened, on which day, on which binding.
 *
 * Deterministic — no randomness anywhere — so two runs on two machines produce
 * the same history, and a screenshot of a demo is reproducible.
 *
 * Day 0 is today (UTC), and it is deliberately busy: `ProviderSlaWindowsService`
 * marks a window `IN_PROGRESS` only when its day is today, so a seed with no
 * calls today has no live window for the live SLA position screen to render.
 */
function planCalls(buyerCount: number): CallPlan[] {
  const plans: CallPlan[] = [];

  // One repeating pattern of shapes and call classes. Six settled to one
  // refused is roughly the mix a healthy provider sees, and every class the
  // export can print appears at least twice across the window.
  const pattern: readonly (readonly [CallShape, PaymentIntentCallClass])[] = [
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_BAD, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.EXPLORATION],
    [CallShape.EXPIRED_SYSTEM, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.PAID],
    [CallShape.EXPIRED_REQUEST, PaymentIntentCallClass.PAID],
    [CallShape.VERIFIED_GOOD, PaymentIntentCallClass.FREE],
    [CallShape.VOIDED_SYSTEM, PaymentIntentCallClass.PAID],
  ];

  let step = 0;
  for (let dayOffset = HISTORY_DAYS - 1; dayOffset >= 0; dayOffset -= 1) {
    // Six calls a day, and eight today — the current window has to look alive.
    const perDay = dayOffset === 0 ? 8 : 6;
    for (let index = 0; index < perDay; index += 1) {
      const [shape, callClass] = pattern[step % pattern.length];
      // The PAUSED binding served traffic until it was paused two days ago —
      // which is what makes its earnings history non-empty and its recent
      // history empty, exactly as a paused binding's should be.
      const binding =
        step % 4 === 3 && dayOffset > 2 ? BINDINGS[1] : BINDINGS[0];

      plans.push({
        dayOffset,
        // Today's last two calls are left in flight, so the export has a
        // `PENDING` row and the live window has something still open in it.
        shape: dayOffset === 0 && index >= perDay - 2 ? CallShape.IN_FLIGHT : shape,
        callClass,
        binding,
        buyerIndex: step % buyerCount,
      });
      step += 1;
    }
  }

  return plans;
}

interface SeedCallsInput {
  readonly plans: readonly CallPlan[];
  readonly buyers: readonly Buyer[];
  readonly bindingRows: readonly ToolBindingEntity[];
  readonly tools: ReadonlyMap<string, CataloguedTool>;
  readonly intents: PaymentIntentService;
  readonly verification: VerificationSettlementService;
  readonly records: VerificationRecordRepository;
  readonly dataSource: DataSource;
}

async function seedCalls(input: SeedCallsInput): Promise<number> {
  const bindingByTool = new Map(input.bindingRows.map((row) => [row.toolId, row]));
  let written = 0;

  for (const [index, plan] of input.plans.entries()) {
    // Keyed on the call's own UTC **date**, not on its index in the plan.
    //
    // An index-keyed id makes the seeder idempotent in the wrong dimension:
    // re-running it the next day finds all 74 ids present and writes nothing,
    // so day 0 stays where it was and there is no `IN_PROGRESS` window any
    // more. `ProviderSlaWindowsService` marks a window live only when its day
    // is today, so the live SLA position screen — entirely about the window in
    // flight — had nothing to render the morning after the seed ran (2026-08-21).
    //
    // With the date in the id, a run on a new UTC day writes exactly the calls
    // whose date is missing and skips the history it already has. Re-running
    // twice on the same day is still a no-op.
    const day = daysAgo(plan.dayOffset).toISOString().slice(0, 10).replace(/-/gu, '');
    const callId = `demo-${day}-${String(index).padStart(3, '0')}-${plan.binding.label}`;

    // `idx_payment_intents_call_id` is UNIQUE across every organization, so
    // this one lookup is the whole idempotency guarantee for the traffic.
    //
    // Through the `DataSource` rather than `PaymentIntentRepository`, because
    // it is genuinely cross-organization — the seeded calls are spread over
    // several buyer organizations and the question here is "does this call id
    // exist anywhere", which `OrganizationScopedRepository` correctly refuses
    // to answer.
    const found = (await input.dataSource.query(
      'SELECT 1 FROM payment_intents WHERE call_id = $1 LIMIT 1',
      [callId],
    )) as unknown[];
    if (found.length > 0) continue;

    await seedOneCall(input, plan, callId, bindingByTool.get(plan.binding.toolId));
    written += 1;
  }

  return written;
}

async function seedOneCall(
  input: SeedCallsInput,
  plan: CallPlan,
  callId: string,
  bindingRow: ToolBindingEntity,
): Promise<void> {
  const buyer = input.buyers[plan.buyerIndex];
  const price =
    plan.callClass === PaymentIntentCallClass.FREE ? 0n : plan.binding.priceAmount;
  const platformFee = (price * PLATFORM_FEE_BPS) / 10_000n;
  const at = daysAgo(plan.dayOffset, plan.dayOffset === 0 ? 1 : 3 + (plan.buyerIndex % 8));

  const intent = await input.intents.create({
    organizationId: buyer.organizationId,
    agentId: buyer.agentId,
    agentAccount: buyer.agentAccount,
    toolId: plan.binding.toolId,
    rail: PaymentRail.RAIL_B_VOUCHER,
    callId,
    callClass: plan.callClass,
    price: MoneyUtil.of(price, ASSET, DECIMALS),
    platformFee: MoneyUtil.of(platformFee, ASSET, DECIMALS),
    requestHash: `sha256:${sha256(callId)}`,
    chainId: CHAIN,
    voucherNonce: sha256(`nonce:${callId}`).slice(0, 32),
  });

  if (price === 0n) {
    // The relay path. `LedgerHoldService.createHold` refuses a zero-amount
    // hold — "a hold must reserve a non-zero amount" — so a free call has no
    // hold to open, and `secureFunds()` cannot be the edge that moves it.
    // The transition table still owns the edge; only the money is absent.
    await input.intents.transition(
      buyer.organizationId,
      intent.id,
      PaymentIntentStatus.CREATED,
      PaymentIntentStatus.FUNDS_SECURED,
      { reason: 'demo seed: free call, nothing to reserve' },
    );
  } else {
    await input.intents.secureFunds(buyer.organizationId, intent.id);
  }

  const payee = {
    providerId: PROVIDER_ORG,
    providerAccount: PROVIDER_ACCOUNT,
    bindingId: bindingRow.id,
  };

  if (plan.shape === CallShape.EXPIRED_SYSTEM || plan.shape === CallShape.EXPIRED_REQUEST) {
    // The sweep's own edge: reserved, never executed, released back to the
    // agent. The payee is written on it anyway — the provider was selected,
    // and a call missing from their own export because it never ran is a call
    // they cannot reconcile against their access log.
    await input.intents.resolve(
      buyer.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.EXPIRED,
      {
        ...payee,
        reason: 'demo seed: the reservation expired before the provider answered',
        classification:
          plan.shape === CallShape.EXPIRED_SYSTEM ? 'SYSTEM_ERROR' : 'REQUEST_ERROR',
      },
    );
    await backdate(input.dataSource, intent.id, at);
    return;
  }

  const executing = await input.intents.transition(
    buyer.organizationId,
    intent.id,
    PaymentIntentStatus.FUNDS_SECURED,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    payee,
  );

  if (plan.shape === CallShape.VOIDED_SYSTEM) {
    await input.intents.resolve(
      buyer.organizationId,
      executing.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      {
        reason: 'demo seed: the provider returned an unusable response',
        classification: 'SYSTEM_ERROR',
      },
    );
    await backdate(input.dataSource, intent.id, at);
    return;
  }

  await input.intents.transition(
    buyer.organizationId,
    executing.id,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    PaymentIntentStatus.VERIFYING,
    { classification: 'DATA_RESULT' },
  );

  if (plan.shape === CallShape.IN_FLIGHT) {
    // Left at `VERIFYING` with an open hold — the export's `PENDING` class and
    // the withheld figure on the earnings screen. No verification record: the
    // call has not been handed to the worker yet.
    await backdate(input.dataSource, intent.id, at);
    return;
  }

  const tool = input.tools.get(plan.binding.toolId);
  const good = plan.shape === CallShape.VERIFIED_GOOD;

  // The real path: durably record the evidence, then judge and settle it. Both
  // halves belong to the verification worker, and both are re-entrant — a worker draining the
  // wakeups this publishes finds the record already `SETTLED` and does nothing.
  await input.verification.enqueue({
    organizationId: buyer.organizationId,
    intentId: intent.id,
    toolId: plan.binding.toolId,
    providerId: PROVIDER_ORG,
    request: sampleInputFor(plan.binding) as never,
    response: (good ? goodResponseFor(plan.binding) : badResponseFor(plan.binding)) as never,
    outputSchema: (tool?.outputSchema ?? {}) as never,
  });
  await input.verification.judgeAndSettle(buyer.organizationId, intent.id);

  await backdate(input.dataSource, intent.id, at);
}

/** A response the tool's policy accepts. */
function goodResponseFor(plan: StoredBindingPlan): Record<string, unknown> {
  return plan.label === 'weather'
    ? { temperatureC: 12.4, observedAt: new Date().toISOString() }
    : { rate: 0.923, publishedFor: new Date().toISOString().slice(0, 10) };
}

/**
 * A response the tool's policy rejects — and rejects for a reason a provider
 * would recognise.
 *
 * Not malformed: it satisfies the `outputSchema` and fails a **rule**, so the
 * verdict is `FAIL` from `FAILURES_AT_LEAST` rather than from the schema
 * verifier. A demo whose only failure mode is a broken shape teaches nothing
 * about why the rules layer exists.
 */
function badResponseFor(plan: StoredBindingPlan): Record<string, unknown> {
  return plan.label === 'weather'
    ? { temperatureC: 9999, observedAt: new Date().toISOString() }
    : { rate: 0, publishedFor: new Date().toISOString().slice(0, 10) };
}

/**
 * Move a finished call back in time.
 *
 * The one thing here no service can do. `created_at` is stamped by the entity
 * and read by every provider report as the call's day, so ten days of history
 * needs ten days of `created_at` — and a seeder cannot wait ten days.
 *
 * **`ledger_entries` is not touched.** `trg_ledger_entries_append_only` refuses
 * `UPDATE` and `DELETE` on that table, which is the ledger's guarantee working as
 * designed; the journal keeps the real time the money moved, and every report a
 * provider reads dates a call from `payment_intents` rather than the journal.
 * The evidence in `verification_records.response` likewise keeps the timestamp
 * it was actually judged against.
 */
async function backdate(dataSource: DataSource, intentId: string, at: Date): Promise<void> {
  await dataSource.query(
    `UPDATE payment_intents
        SET created_at = $2::timestamptz,
            updated_at = $2::timestamptz,
            expires_at = $2::timestamptz + interval '5 minutes'
      WHERE id = $1`,
    [intentId, at],
  );
  await dataSource.query(
    `UPDATE verification_records
        SET created_at = $2::timestamptz,
            updated_at = $2::timestamptz,
            evaluated_at = CASE WHEN evaluated_at IS NULL THEN NULL ELSE $2::timestamptz END,
            settled_at   = CASE WHEN settled_at   IS NULL THEN NULL ELSE $2::timestamptz END
      WHERE intent_id = $1`,
    [intentId, at],
  );
}

// ── Payouts ────────────────────────────────────────────────────────────────

interface PayoutPlan {
  readonly weeksAgo: number;
  readonly amount: bigint;
  readonly callCount: number;
  readonly status: 'PENDING' | 'SUBMITTED' | 'RECORDED';
}

/**
 * Four payout runs across three states — the three `chk_provider_payouts_status`
 * allows.
 *
 * A `RECORDED` row is the only one that has actually moved money, so it is the
 * only one that gets a `PAYOUT` ledger entry.
 *
 * ## That entry is written the long way round, and the reason is a real defect
 *
 * `GET /providers/me/payouts` lists `PAYOUT` ledger entries **with a
 * `batch_id`** (`ProviderPayoutsService`). Nothing in `src/` can write one:
 *
 * - `LedgerWriterService.append` — the only writer that stamps a `batch_id`,
 *   inside `flush()` — **refuses `PAYOUT` outright** (`LEDGER_ENTRY_NOT_BUFFERABLE`:
 *   "can reduce a balance and must be written through, not buffered");
 * - `LedgerService.appendNow` — what `ProviderPayoutBatchService.record()`
 *   actually calls — has no `batchId` on its input at all;
 * - `ledger_entries` refuses `UPDATE`, so it cannot be stamped afterwards.
 *
 * So the writer and the reader disagree, and the payouts screen is empty for
 * every payout the platform will ever make. Seeding around that with a raw
 * `INSERT` would leave `account_balances` unfolded and make the reconciler
 * disagree with the journal, so this takes the same two public journal calls
 * `LedgerWriterService.flushOnce` takes — `prepare(input, batchId)` then
 * `applyEntries` inside `runInLedgerTransaction` — with the batch id chosen up
 * front rather than minted inside `flush()`. The balance moves, the snapshot
 * folds, and the row is exactly what a working batch would have written.
 */
const PAYOUTS: readonly PayoutPlan[] = [
  { weeksAgo: 3, amount: 3_000_000n, callCount: 41, status: 'RECORDED' },
  { weeksAgo: 2, amount: 2_500_000n, callCount: 33, status: 'RECORDED' },
  { weeksAgo: 1, amount: 1_500_000n, callCount: 19, status: 'SUBMITTED' },
  { weeksAgo: 0, amount: 750_000n, callCount: 11, status: 'PENDING' },
];

async function seedPayouts(
  payouts: ProviderPayoutRepository,
  journal: LedgerJournalService,
  dataSource: DataSource,
): Promise<number> {
  let seq = 0n;

  for (const plan of PAYOUTS) {
    const periodStart = daysAgo(7 * (plan.weeksAgo + 1));
    const periodEnd = daysAgo(7 * plan.weeksAgo);

    // `uq_provider_payouts_org_asset_period` is the idempotency key.
    const existing = await payouts.findOneBy({
      organizationId: PROVIDER_ORG,
      assetId: ASSET,
      periodStart,
    });
    if (existing) {
      seq += BigInt(plan.callCount) * 2n;
      continue;
    }

    const chainTxRef =
      plan.status === 'PENDING' ? null : `demo_squads_proposal_${plan.weeksAgo}`;

    const batchId = uuidFromLabel(`demo:payout-batch:${plan.weeksAgo}`);

    let ledgerEntryId: string | null = null;
    if (plan.status === 'RECORDED') {
      const prepared = journal.prepare(
        {
          organizationId: PROVIDER_ORG,
          accountId: PROVIDER_ACCOUNT as LedgerAccountId,
          entryType: LedgerEntryType.PAYOUT,
          money: MoneyUtil.of(plan.amount, ASSET, DECIMALS),
          chainTxRef,
        },
        batchId,
      );
      const [entry] = await runInLedgerTransaction(dataSource, (queryRunner) =>
        journal.applyEntries(queryRunner, PROVIDER_ORG, [prepared]),
      );
      ledgerEntryId = entry.id;
    }

    const row = new ProviderPayoutEntity();
    row.organizationId = PROVIDER_ORG;
    row.assetId = ASSET;
    row.decimals = DECIMALS;
    row.periodStart = periodStart;
    row.periodEnd = periodEnd;
    row.amount = plan.amount.toString();
    row.fromSeq = seq.toString();
    row.toSeq = (seq + BigInt(plan.callCount) * 2n).toString();
    row.callCount = plan.callCount;
    row.status = plan.status;
    row.batchId = batchId;
    row.sourceAccountId = PROVIDER_ACCOUNT;
    row.payoutAccountId = PROVIDER_PAYOUT_ACCOUNT;
    row.chainTxRef = chainTxRef;
    row.ledgerEntryId = ledgerEntryId;
    await payouts.save(row);

    seq += BigInt(plan.callCount) * 2n;
  }

  const [{ count }] = (await dataSource.query(
    'SELECT count(*)::int AS count FROM provider_payouts WHERE organization_id = $1',
    [PROVIDER_ORG],
  )) as [{ count: number }];
  return count;
}

// ── Reporting ──────────────────────────────────────────────────────────────

async function report(dataSource: DataSource): Promise<void> {
  const rows = (await dataSource.query(
    `SELECT status, call_class, count(*)::int AS calls
       FROM payment_intents
      WHERE provider_id = $1
      GROUP BY status, call_class
      ORDER BY status, call_class`,
    [PROVIDER_ORG],
  )) as { status: string; call_class: string; calls: number }[];

  const verdicts = (await dataSource.query(
    `SELECT COALESCE(verdict_status, 'PENDING') AS verdict, count(*)::int AS calls
       FROM verification_records
      WHERE provider_id = $1
      GROUP BY 1 ORDER BY 1`,
    [PROVIDER_ORG],
  )) as { verdict: string; calls: number }[];

  const days = (await dataSource.query(
    `SELECT count(DISTINCT (created_at AT TIME ZONE 'UTC')::date)::int AS days
       FROM payment_intents WHERE provider_id = $1`,
    [PROVIDER_ORG],
  )) as [{ days: number }];

  log('');
  log(`intents across ${days[0].days} UTC days`);
  for (const row of rows) log(`  ${row.status.padEnd(20)} ${row.call_class.padEnd(12)} ${row.calls}`);
  log('verdicts');
  for (const row of verdicts) log(`  ${row.verdict.padEnd(20)} ${row.calls}`);
}

// ── Small helpers ──────────────────────────────────────────────────────────

function daysAgo(days: number, hour = 12): Date {
  const now = new Date();
  const at = new Date(now.getTime() - days * DAY_MS);
  at.setUTCHours(hour, (days * 7) % 60, (days * 13) % 60, 0);
  // A day-0 timestamp must never land in the future — the SLA window and the
  // export both bound on `created_at < now`.
  return at.getTime() > now.getTime() ? new Date(now.getTime() - 60_000) : at;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A stable uuid for a readable label.
 *
 * The same trick `test/integration/helpers/test-database.ts` uses, restated
 * rather than imported: that file belongs to the test harness and binds to the
 * test databases. Deterministic is the point — it is what makes a re-run
 * address the same row instead of writing a second one.
 */
function uuidFromLabel(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function log(line: string): void {
  console.log(line);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
