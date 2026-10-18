import type { Redis } from 'ioredis';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  ProviderRoutingState,
  ProviderStats,
  ProviderStatus,
  ProviderTier,
} from '@modules/provider/ports/provider.types';
import {
  ConfigProviderRegistry,
  ProviderRegistrySnapshot,
} from '@modules/provider/services/config-provider-registry';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { ProviderStake, stakeKey } from '@modules/provider/ports/provider-stake.port';
import {
  ConfigProviderStakeSource,
  ProviderStakeSnapshot,
} from '@modules/provider/services/config-provider-stake.source';
import { StakeGraceLookup, StakeGracePort } from '@modules/provider/ports/stake-grace.port';
import {
  ProviderResponse,
  ResponseBodyKind,
} from '@modules/tool/domain/classification/classification.types';
import {
  CeilingKind,
  MinimumStakeParameters,
  RoutingCandidate,
  RoutingContext,
} from '@modules/tool/domain/routing';
import { BindingInvocation, BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import {
  BindingStatus,
  PricingMode,
  Tool,
  ToolBinding,
  ToolTier,
} from '@modules/tool/ports/tool.types';
import { BindingAttemptRecorder } from '@modules/tool/services/binding-attempt-recorder.service';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import { BindingCeilingService } from '@modules/tool/services/binding-ceiling.service';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';
import type { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import type { RequestSignerService } from '@modules/tool/request-auth/request-signer.service';
import type { EgressHttpClient } from '@shared/network/egress/egress-http.client';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { DEFAULT_ROUTER_TUNING, RouterConfig } from '@modules/tool/services/routing.config';
import { MoneyUtil } from '@utils/money.util';

import { FakeRedis } from './fake-redis';

/**
 * Fixtures for the router tests.
 *
 * The router is assembled by hand rather than through a Nest testing module.
 * Nine constructor dependencies, seven of them ports, so
 * `new ProviderRouterService(...)` is both shorter and more honest about what a
 * routing decision actually depends on than a DI graph would be.
 *
 * The two that are not ports are the per-binding traffic counters, and they are wired
 * **real** here — `BindingCeilingService` over {@link FakeRedis}, not a double
 * that returns a scripted verdict. A double would answer "is this binding at
 * its ceiling" without ever running the arithmetic that decides it, and the
 * property the ceiling wiring exists to prove is precisely arithmetic: a provider sheds at
 * the number they declared, not at that number divided by how many candidates
 * happened to be behind the tool. `BindingCallCounterService` is the one
 * exception (see {@link ScriptedCallCounter}) — it hydrates from
 * `payment_intents`, and standing up a repository to state "this binding has
 * served 40 calls" would obscure the fact being stated.
 */

export const STAKE_ASSET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
const USDC_DECIMALS = 6;

/**
 * A proved payout address, for the provider every other default here describes
 * as routable.
 *
 * One address for every fixture provider on purpose: nothing in routing reads
 * *which* address it is, only whether there is one, and giving each provider a
 * distinct one would invite a test to assert on a value the router does not
 * choose.
 */
export const PAYOUT_ACCOUNT: AccountId =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as AccountId;

/**
 * The chain the default fixtures settle on, derived from the two values that
 * decide it rather than restated.
 *
 * `filterEligible` asks `evaluatePayoutGate` about `chainIdOf(binding.assetId)`
 * — the chain the binding's price is quoted in — so a default provider is only
 * routable if {@link PAYOUT_ACCOUNT} is on that same chain. Deriving it from
 * both and asserting they agree keeps a future edit to {@link STAKE_ASSET}
 * from quietly making every default candidate unpayable, which would show up
 * as a hundred unrelated tests failing on `PAYOUT_ACCOUNT_UNPROVED`.
 */
export const PAYOUT_CHAIN: ChainId = chainIdOf(PAYOUT_ACCOUNT);

if (PAYOUT_CHAIN !== chainIdOf(STAKE_ASSET)) {
  throw new Error(
    `routing fixtures are inconsistent: PAYOUT_ACCOUNT is on ${PAYOUT_CHAIN} but the default ` +
      `binding settles on ${chainIdOf(STAKE_ASSET)}, so every default candidate would be refused`,
  );
}

/** USDC from a human figure: `usdc('0.05')` → 50000 atomic units. */
export function usdc(amount: string | number): Money {
  const [whole, fraction = ''] = String(amount).split('.');
  const padded = (fraction + '000000').slice(0, USDC_DECIMALS);
  return MoneyUtil.of(`${whole}${padded}`.replace(/^0+(?=\d)/, ''), STAKE_ASSET, USDC_DECIMALS);
}

/** `max($50, 1000 × price)` — the platform's minimum-stake parameters. */
export const MINIMUM_STAKE: MinimumStakeParameters = Object.freeze({
  floor: usdc(50),
  priceMultiple: 1000,
});

/**
 * The same floor, keyed on the chain its own asset names.
 *
 * Derived from {@link MINIMUM_STAKE} rather than restated, for the reason
 * `ToolModule` derives the production one that way: a `Money.asset` is CAIP-19,
 * so a floor already names the chain it is a floor on, and a second literal
 * here could drift from the asset it is supposed to be about.
 */
export const MINIMUM_STAKE_BY_CHAIN: ReadonlyMap<ChainId, MinimumStakeParameters> = Object.freeze(
  new Map([[chainIdOf(MINIMUM_STAKE.floor.asset), MINIMUM_STAKE]]),
);

/**
 * A {@link RoutingContext} whose chain sets narrow nothing.
 *
 * `settleableChains` is `payerChains ∩ settlementChains ∩ enabledChains`, so
 * naming every chain the candidates themselves offer on both sides leaves every
 * candidate with every chain it declared — which is what the gates saw before
 * the chain gate existed.
 *
 * For the ~dozen specs that are about the stake gate, the payout gate, the
 * ceilings or the weights and are **not** about which chain. A spec that IS
 * about the chain gate writes the sets out, because the whole subject is what
 * gets excluded — see `routing-chains.spec.ts`.
 */
export function anyChainContext(candidates: readonly RoutingCandidate[]): RoutingContext {
  const chains = [...new Set(candidates.flatMap((candidate) => candidate.settlementChains))];
  return {
    payerChains: chains,
    enabledChains: chains,
    defaultChainId: null,
    withdrawingChains: [],
  };
}

/** The one-chain context the default fixtures live on, with room to override. */
export function routingContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    payerChains: [PAYOUT_CHAIN],
    enabledChains: [PAYOUT_CHAIN],
    defaultChainId: null,
    // Nothing being withdrawn, so the withdraw gate narrows nothing — the same
    // reason the chain sets above name every chain. A spec ABOUT the gate
    // overrides it (`withdraw-gate.spec.ts`).
    withdrawingChains: [],
    ...overrides,
  };
}

/**
 * The context every `route()`/`quote()` in a spec that is NOT about chains
 * passes.
 *
 * A buyer on {@link PAYOUT_CHAIN}, on a deployment offering only that chain —
 * which is what this deployment is, and what every default fixture settles on.
 * The chain gate therefore narrows nothing and the spec is about whatever it
 * says it is about. A spec that IS about chains writes its own context out.
 */
export const ROUTING_CONTEXT: RoutingContext = Object.freeze(routingContext());

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const TOOL_ID = 'search_web';

export function buildTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: TOOL_ID,
    name: 'Search the web',
    description: 'Returns web results for a query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    ...overrides,
  };
}

export function buildBinding(
  providerId: string,
  overrides: Partial<ToolBinding> = {},
): ToolBinding {
  // Follows the asset unless the test says otherwise, and the spread below is
  // what makes "unless": an explicit `settlementChains` override wins. Deriving
  // it here reproduces exactly what `filterEligible` used to do for itself
  // (`chainIdOf(binding.assetId)`), so a fixture that overrides only the asset
  // — `stake-per-chain.spec.ts` has several — keeps settling where it always
  // did rather than silently reverting to the devnet default.
  const assetId = overrides.assetId ?? STAKE_ASSET;

  return {
    id: `binding-${providerId}`,
    toolId: TOOL_ID,
    providerId,
    endpoint: `https://${providerId}.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: { $path: '$.query' } } },
    responseMapping: { answer: { $path: '$.answer' } },
    pricingMode: PricingMode.PAID,
    // $0.05 → a computed minimum of exactly $50, which is also the floor.
    priceAmount: usdc('0.05').amount,
    assetId,
    // Offered on the chain this binding is priced on, which for
    // the default fixture is also the chain its provider is paid and staked on
    // — {@link PAYOUT_CHAIN} is asserted equal to `chainIdOf(STAKE_ASSET)`
    // above.
    settlementChains: [chainIdOf(assetId)],
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    // No ceiling declared — the default for every binding until a provider
    // sets one. Not `0`, which would mean "declared unroutable".
    maxRps: null,
    maxDailyCalls: null,
    slaFailureRate: 0.02,
    timeoutMs: 5_000,
    status: BindingStatus.ACTIVE,
    version: 1,
    ...overrides,
  };
}

export function buildProvider(
  providerId: string,
  overrides: Partial<ProviderRoutingState> = {},
): ProviderRoutingState {
  const stats: ProviderStats = {
    availabilityRate: 0.99,
    paidQualityRate: 0.95,
    freeQualityRate: 0.9,
    p50LatencyMs: 200,
    p95LatencyMs: 800,
    callsServed: 50_000,
    upheldSlashes: 0,
  };

  const merged: ProviderRoutingState = {
    providerId,
    status: ProviderStatus.ACTIVE,
    tier: ProviderTier.ESTABLISHED,
    stats,
    // A proved payout address by default, on the chain the default
    // binding settles on — because the default provider here is a routable one
    // and `evaluatePayoutGate` refuses a paid binding without an entry for
    // *that* chain. A test that wants the refusal overrides this with an empty
    // map, or with a map keyed on a DIFFERENT chain, which is the case
    // per-chain enrolment added: the same shape as every other default in this file — the
    // permissive value here, and the test that cares says so.
    payoutAccountByChain: new Map([[PAYOUT_CHAIN, PAYOUT_ACCOUNT]]),
    payoutEnrolmentChains: new Set(),
    ...overrides,
  };

  return {
    ...merged,
    // Derived from the address map unless the test says otherwise, so a fixture
    // that overrides only `payoutAccountByChain` stays internally consistent:
    // every ACTIVE enrolment is by definition an enrolment. A test that wants
    // the CLOSED case — an enrolment with no address, which is what a
    // `SUSPENDED` row looks like to routing — sets `payoutEnrolmentChains`
    // explicitly to a chain the map does not carry.
    payoutEnrolmentChains:
      overrides.payoutEnrolmentChains ?? new Set(merged.payoutAccountByChain.keys()),
  };
}

export function buildCandidate(
  providerId: string,
  options: {
    binding?: Partial<ToolBinding>;
    provider?: Partial<ProviderRoutingState>;
    staked?: Money | null;
    /**
     * The whole per-chain map, when a test is about per-chain stake itself.
     *
     * Takes precedence over {@link staked}, which is the one-chain shorthand:
     * it files the amount under {@link PAYOUT_CHAIN}, the chain the default
     * binding settles on, so every one-chain fixture keeps meaning what it meant.
     * A test that needs two chains, or a reading filed under the wrong one,
     * builds the map itself.
     */
    stakeByChain?: ReadonlyMap<ChainId, ProviderStake>;
    /**
     * The candidate's own chain list — the binding's declaration narrowed to
     * the provider's ACTIVE enrolments.
     *
     * Defaults to the binding's own list, so a fixture that overrides
     * `binding.settlementChains` alone stays internally consistent. A test
     * about the *narrowing* — a binding offering a chain its provider is not
     * enrolled on — sets this to the shorter list explicitly, which is the only
     * way to say it.
     */
    settlementChains?: readonly ChainId[];
    stakeGraceUntil?: Date | null;
    observedCalls?: number | null;
    ceilingHit?: CeilingKind | null;
  } = {},
): RoutingCandidate {
  const staked = options.staked === undefined ? usdc(1000) : options.staked;
  const binding = buildBinding(providerId, options.binding);

  return {
    binding,
    provider: buildProvider(providerId, options.provider),
    settlementChains: options.settlementChains ?? binding.settlementChains,
    stakeByChain:
      options.stakeByChain ??
      (staked
        ? new Map([
            [PAYOUT_CHAIN, { providerId, chainId: PAYOUT_CHAIN, staked, observedAt: new Date(0) }],
          ])
        : new Map()),
    // The grace, call-count and ceiling fields default to "nothing is going
    // on": no grace row open, no
    // call count read, no ceiling hit. Defaulted here rather than in each test
    // so that a test which cares about one of them says so by overriding it —
    // sprinkling three literals across a hundred cases would bury the two
    // places where the value is the point of the test.
    stakeGraceUntil: options.stakeGraceUntil ?? null,
    observedCalls: options.observedCalls ?? null,
    ceilingHit: options.ceilingHit ?? null,
  };
}

// ---------------------------------------------------------------------------
// A scripted grace source
// ---------------------------------------------------------------------------

/**
 * A {@link StakeGracePort} whose open rows are declared by the test, and which
 * remembers what it was asked.
 *
 * Both halves matter. The dates make "routing continues inside grace" and
 * "routing stops when grace runs out" assertable through `route()` rather than
 * against `applyStakeGrace` in isolation — the point is that something
 * *calls* it. And the recorded lookups are how a test can tell the loader ran
 * over every candidate from the loader happening to have been asked about the
 * one binding the test cared about.
 *
 * Deliberately does **not** hide an expired row. The production source does not
 * either, and for the same reason: an open row past its deadline is what makes
 * `STAKE_GRACE_EXPIRED` reachable, and a fake that filtered it would go green
 * on a router that could never produce that verdict.
 */
export class ScriptedStakeGraceSource implements StakeGracePort {
  /** One entry per call, so a test can assert the read was batched. */
  readonly lookups: StakeGraceLookup[][] = [];

  constructor(private readonly graces: Readonly<Record<string, Date>> = {}) {}

  async openGraceUntil(bindings: readonly StakeGraceLookup[]): Promise<ReadonlyMap<string, Date>> {
    this.lookups.push([...bindings]);

    const found = new Map<string, Date>();
    for (const entry of bindings) {
      const until = this.graces[entry.bindingId];
      if (until) found.set(entry.bindingId, until);
    }
    return found;
  }

  /** Every binding id this source has been asked about, across all calls. */
  get bindingIdsAsked(): string[] {
    return [...new Set(this.lookups.flat().map((entry) => entry.bindingId))];
  }
}

// ---------------------------------------------------------------------------
// A scripted call counter
// ---------------------------------------------------------------------------

/**
 * A {@link BindingCallCounterService} whose lifetime counts the test declares.
 *
 * The counter's own correctness — hydration off `payment_intents`, which
 * direction a lost key errs in, and why an unreadable count is `null` rather
 * than `0` — is `binding-call-counter.spec.ts`'s subject. What this stands in
 * for is the *input* to the exploration floor, so that "a binding with a real
 * count gets a different share of the traffic than one with `null`" is a
 * statement about the router rather than about Redis.
 *
 * The recorded batches are how a test tells "the loader ran over every
 * candidate, once" from "the loader happened to be asked about the one binding
 * the test cared about, N times".
 */
export class ScriptedCallCounter {
  /** One entry per call, so a test can assert the read was batched. */
  readonly batches: string[][] = [];

  constructor(private readonly counts: Readonly<Record<string, number | null>> = {}) {}

  async observedCallsAll(
    bindingIds: readonly string[],
  ): Promise<ReadonlyMap<string, number | null>> {
    this.batches.push([...bindingIds]);
    return new Map(bindingIds.map((bindingId) => [bindingId, this.counts[bindingId] ?? null]));
  }

  async observedCalls(bindingId: string): Promise<number | null> {
    return this.counts[bindingId] ?? null;
  }

  async record(): Promise<void> {}

  /** Every binding id this counter has been asked about, across all calls. */
  get bindingIdsAsked(): string[] {
    return [...new Set(this.batches.flat())];
  }
}

// ---------------------------------------------------------------------------
// A scripted invoker
// ---------------------------------------------------------------------------

export type InvokerScript = (invocation: BindingInvocation) => Promise<ProviderResponse>;

/**
 * A {@link BindingInvokerPort} whose answer per binding is written by the test.
 *
 * This is the seam that makes every routing rule assertable without a network:
 * "fail over on `SYSTEM_ERROR`" and "do not fail over on `REQUEST_ERROR`" are
 * statements about what the router does with an answer, and here the answer is
 * a value.
 */
export class ScriptedInvoker implements BindingInvokerPort {
  readonly invocations: BindingInvocation[] = [];

  constructor(private readonly script: Readonly<Record<string, InvokerScript>>) {}

  invoke(invocation: BindingInvocation): Promise<ProviderResponse> {
    this.invocations.push(invocation);

    const handler = this.script[invocation.binding.id];
    if (!handler) {
      throw new Error(`no scripted response for binding ${invocation.binding.id}`);
    }
    return handler(invocation);
  }

  get bindingIds(): string[] {
    return this.invocations.map((i) => i.binding.id);
  }

  get providerIds(): string[] {
    return this.invocations.map((i) => i.binding.providerId);
  }
}

/** A 2xx carrying an arbitrary JSON body. */
export function jsonResponse(value: Record<string, unknown>, code = 200): ProviderResponse {
  return {
    status: code,
    headers: { 'content-type': 'application/json' },
    body: { kind: ResponseBodyKind.JSON, value: value as never },
  };
}

/** A 2xx carrying a body the tool's `responseMapping` can read. */
export function ok(answer = 'forty-two'): ProviderResponse {
  return jsonResponse({ answer });
}

/** A status with a JSON body — used for the 5xx (`SYSTEM_ERROR`) and 4xx (`REQUEST_ERROR`) cases. */
export function status(code: number, body: Record<string, string> = {}): ProviderResponse {
  return {
    status: code,
    headers: { 'content-type': 'application/json' },
    body: { kind: ResponseBodyKind.JSON, value: body },
  };
}

/** Never resolves. For the timeout tests — the router must not wait on it. */
export function hang(): Promise<ProviderResponse> {
  return new Promise<ProviderResponse>(() => {});
}

// ---------------------------------------------------------------------------
// Assembling the router
// ---------------------------------------------------------------------------

export interface RouterHarnessOptions {
  readonly tool?: Tool;
  readonly bindings: readonly ToolBinding[];
  readonly providers: readonly ProviderRoutingState[];
  /**
   * `providerId` → staked amount **on {@link PAYOUT_CHAIN}**, the chain every
   * default fixture binding settles on. A provider absent here has no known
   * stake there.
   *
   * The one-chain shorthand, kept because ~12 specs outside `test/unit/tool/`
   * feed it and none of them is about which chain. A spec that IS about that
   * uses {@link stakesByChain}, which is keyed by `stakeKey` and is what the
   * snapshot actually holds.
   */
  readonly stakes: Readonly<Record<string, Money>>;
  /**
   * `stakeKey(providerId, chainId)` → staked amount, merged over
   * {@link stakes}.
   *
   * The escape hatch for per-chain stake: it is the only way to say "this provider is
   * bonded on one chain and not on another", which is the property the whole
   * per-chain stake exists to make expressible.
   */
  readonly stakesByChain?: Readonly<Record<string, Money>>;
  /**
   * `bindingId` → when its open grace row expires.
   *
   * A binding absent here has no open row at all, which is the default and is
   * NOT the same as an expired one — see `applyStakeGrace`.
   */
  readonly graces?: Readonly<Record<string, Date>>;
  /**
   * `bindingId` → its lifetime call count.
   *
   * A binding absent here reads `null`, which is "the counter was not read"
   * and is EXCLUDED from the exploration set — not `0`, which would be "brand
   * new" and is the permissive value. That default is the reason the field
   * exists as `number | null`, so the fixtures keep it rather than smoothing
   * it away.
   */
  readonly observedCalls?: Readonly<Record<string, number | null>>;
  /**
   * Which `(provider, chain)` pairs hold an ACTIVE enrolment.
   *
   * **Defaults to "every chain every binding names, for the provider that
   * published it"**, so a spec that is not about enrolments sees the binding's
   * own list survive the narrowing unchanged — which is what it saw before the
   * narrowing existed. A spec about the narrowing declares the shorter list,
   * which is the only way to say "the binding offers this chain and the
   * provider is not on it".
   */
  readonly enrolments?: readonly { readonly providerId: string; readonly chainId: ChainId }[];
  readonly invoker: BindingInvokerPort;
  readonly random?: () => number;
  readonly config?: Partial<RouterConfig>;
  /** The observed-stats recorder. Absent: the router records nothing, as before it existed. */
  readonly observations?: BindingAttemptRecorder;
}

export interface RouterHarness {
  readonly router: ProviderRouterService;
  readonly config: RouterConfig;
  /** The grace source the router was given, for asserting what it was asked. */
  readonly graceSource: ScriptedStakeGraceSource;
  /** The REAL ceiling service the router is using, for pre-spending tokens and reading headroom. */
  readonly ceilings: BindingCeilingService;
  /** The Redis behind it, for asserting which commands a decision issued. */
  readonly redis: FakeRedis;
  readonly callCounter: ScriptedCallCounter;
}

export function buildRouter(options: RouterHarnessOptions): RouterHarness {
  const tool = options.tool ?? buildTool();

  const catalogue = new InMemoryToolCatalogue({ tools: [tool], bindings: options.bindings });

  const registrySnapshot: ProviderRegistrySnapshot = Object.fromEntries(
    options.providers.map((provider) => [provider.providerId, provider]),
  );
  // The shorthand is expanded into real `stakeKey`s here, and never inside the
  // source: `ConfigProviderStakeSource` must be the production class, keyed the
  // production way, or the fixtures would be testing a different lookup from
  // the one that runs.
  const stakeSnapshot: ProviderStakeSnapshot = {
    ...Object.fromEntries(
      Object.entries(options.stakes).map(([providerId, money]) => [
        stakeKey(providerId, PAYOUT_CHAIN),
        money,
      ]),
    ),
    ...(options.stakesByChain ?? {}),
  };

  const config: RouterConfig = {
    ...DEFAULT_ROUTER_TUNING,
    minimumStakeByChain: MINIMUM_STAKE_BY_CHAIN,
    ...options.config,
  };

  const declared =
    options.enrolments ??
    options.bindings.flatMap((binding) =>
      (binding.settlementChains ?? []).map((chainId) => ({
        providerId: binding.providerId,
        chainId,
      })),
    );

  const enrolments: ChainEnrolmentPort = {
    // Answers about every declared pair, whoever was asked. Deliberately more
    // permissive than `DbChainEnrolmentSource`, which filters by provider in
    // SQL: a fake that filtered too would make the router's lookup key
    // unobservable, because the map would only ever hold rows the caller asked
    // for.
    enrolmentsOf: async () =>
      new Map(
        declared.map(({ providerId, chainId }) => [
          enrolmentKey(providerId, chainId),
          {
            providerId,
            chainId,
            payoutAccountId: PAYOUT_ACCOUNT,
            stakeAuthorityAccountId: null,
            status: ChainEnrolmentStatus.ACTIVE,
            enrolledAt: new Date(0),
          } as ChainEnrolment,
        ]),
      ),
  };

  const graceSource = new ScriptedStakeGraceSource(options.graces ?? {});
  const redis = new FakeRedis();
  const ceilings = new BindingCeilingService(redis as unknown as Redis);
  const callCounter = new ScriptedCallCounter(options.observedCalls ?? {});

  const router = new ProviderRouterService(
    catalogue,
    new ConfigProviderRegistry(registrySnapshot),
    new ConfigProviderStakeSource(stakeSnapshot),
    enrolments,
    graceSource,
    options.invoker,
    callCounter as unknown as BindingCallCounterService,
    ceilings,
    config,
    // Defaults to "always draw the first entry", which makes selection
    // deterministic for every test that is not about the distribution.
    options.random ?? (() => 0),
    options.observations ?? null,
  );

  return { router, config, graceSource, ceilings, redis, callCounter };
}

/**
 * A seeded PRNG (mulberry32).
 *
 * The distribution tests draw tens of thousands of samples and assert the
 * result against a declared share. With `Math.random` that assertion would be
 * true *most* of the time, which is another way of saying the suite would fail
 * on someone else's commit for no reason. Seeded, it is either right or it is a
 * bug.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Re-exported so specs can build the production invoker without a second import path. */
export { EgressBindingInvoker };

/** A vault with no stored credentials for any binding. */
export const NO_CREDENTIALS = {
  headersFor: async () => [],
} as unknown as CredentialVaultService;

/** A vault that holds one API key for every binding and origin. */
export const ONE_CREDENTIAL = {
  headersFor: async () => [{ name: 'X-Provider-Key', value: 'test-key' }],
} as unknown as CredentialVaultService;

/** A signer with no keys, as in a non-production deployment that configured none. */
export const UNSIGNED = { sign: async () => ({}) } as unknown as RequestSignerService;

/** The production invoker with no credentials and no signature. */
export function plainInvoker(
  http: EgressHttpClient,
  vault: CredentialVaultService = NO_CREDENTIALS,
): EgressBindingInvoker {
  return new EgressBindingInvoker(http, vault, UNSIGNED);
}
