import { AddressInfo } from 'node:net';

import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { chainIdOf } from '@modules/chains/ports/caip.types';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { StakeGraceLookup, StakeGracePort } from '@modules/provider/ports/stake-grace.port';
import { DbChainEnrolmentSource } from '@modules/provider/services/db-chain-enrolment.source';
import { DbProviderRegistry } from '@modules/provider/services/db-provider-registry';
import { ResponseClass } from '@modules/tool/domain/classification';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { BindingAuthMode, BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import { BindingCeilingService } from '@modules/tool/services/binding-ceiling.service';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';
import { DEFAULT_ROUTER_TUNING, RouterConfig } from '@modules/tool/services/routing.config';
import { EgressHttpClient } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import { plainInvoker } from '../../unit/tool/helpers/routing-fixtures';
import {
  BindingEditorTestContext,
  MINIMUM_STAKE,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';
import { FakeRedis } from '../../unit/tool/helpers/fake-redis';
import { noBlocks } from '../../unit/helpers/blocklist';

/**
 * How long a paused binding keeps serving, **measured**.
 *
 * The requirement is not a design review, it is a stopwatch: *"press pause,
 * **MEASURE** the time until the last call gets through, prove it is under 5
 * seconds."*
 *
 * `binding-pause.integration.spec.ts` argues the number should be small, and
 * the argument is sound: `DatabaseToolCatalogue` holds no cache, the router
 * re-reads `tool_bindings` on every routing decision, and `filterEligible`
 * already refuses anything that is not `ACTIVE`. But an argument is not a
 * measurement. The failure this file exists to catch is the one the argument
 * cannot see — a cache someone adds in front of the catalogue next quarter, a
 * connection pool that serialises the pause behind a queue of routing reads, a
 * router that gathers its candidates once per process. Each of those leaves
 * every existing assertion green and moves this number from milliseconds to
 * minutes.
 *
 * So this drives **real traffic** — a loop calling `ProviderRouterService.route`
 * against a real Postgres and a real HTTP provider — presses pause while it is
 * flowing, and prints the interval between the two.
 *
 * ## What makes the number mean something
 *
 * A test that started the loop, paused, and found no traffic could be green for
 * three reasons, and only one of them is the feature working:
 *
 * - the loop only ever issued one call, so "traffic stopped" is vacuous;
 * - traffic stopped for some *other* reason — the stake gate, an excluded
 *   provider, an empty catalogue — and the pause was incidental;
 * - the pause did it.
 *
 * All three are separated below. Traffic is asserted to have been flowing
 * before the pause (more than one call, actually classified `DATA_RESULT` by a
 * real provider), every refusal after the pause is asserted to name
 * `BINDING_NOT_ACTIVE` and nothing else, and a **resume** is asserted to bring
 * the traffic back — which is the only one of the three that rules out a
 * harness that had quietly broken itself.
 */
const SUBJECT = 'cred-integration';
const PROVIDER_ADDRESS = '93.184.216.34';

/**
 * How long the loop waits between calls.
 *
 * Small enough that the measurement is not quantised by the poll interval — a
 * 500ms gap would report "under 5 seconds" from a mechanism that took 4.9 — and
 * large enough that a tight loop does not starve the pause's own `UPDATE` of a
 * connection and end up measuring the harness instead of the feature.
 */
const CALL_INTERVAL_MS = 10;

/**
 * How many consecutive refusals count as "traffic has stopped".
 *
 * One is not enough: a single refusal could be a transient. Three consecutive
 * refusals spanning three separate catalogue reads is the loop saying the
 * binding is gone and staying gone.
 */
const QUIET_CALLS = 3;

/** The bound this whole file exists to prove. */
const PAUSE_BUDGET_MS = 5_000;

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
const openSockets: Array<{ destroy: () => void }> = [];

function body(): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: `http://provider.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    // $0.05, so the computed minimum is exactly the $50 floor.
    priceAmount: '50000',
    assetId: USDC_ASSET,
    // `STAKE_CHAIN` is the chain `USDC_ASSET` names and the one
    // this context provisions; this suite measures pause latency and is not
    // about chains.
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 5_000,
    authMode: BindingAuthMode.NONE,
  } as SaveToolBindingBodyDto;
}

const usdc = (whole: number) =>
  MoneyUtil.of(String(BigInt(whole) * 1_000_000n), USDC_ASSET, USDC_DECIMALS);

/**
 * No grace rows anywhere.
 *
 * `provider_stake_grace` has a real source (`DbStakeGraceSource`) and a real
 * table in this context, but grace is a *stake* mechanism and this file is
 * about a pause. An empty source keeps the only variable that moves during the
 * measurement the one being measured — see the class doc's second failure mode.
 */
class NoGrace implements StakeGracePort {
  openGraceUntil(_bindings: readonly StakeGraceLookup[]): Promise<ReadonlyMap<string, Date>> {
    return Promise.resolve(new Map());
  }
}

let context: BindingEditorTestContext;
let router: ProviderRouterService;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
    });
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const invoker = plainInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );

  context = await createBindingEditorTestContext(invoker);

  // Keyed on the chain the floor's own asset names, exactly as `ToolModule`
  // builds it — the floor is a `Money` and a `Money.asset` is CAIP-19.
  const config: RouterConfig = {
    ...DEFAULT_ROUTER_TUNING,
    minimumStakeByChain: new Map([[chainIdOf(MINIMUM_STAKE.floor.asset), MINIMUM_STAKE]]),
  };

  // Assembled by hand, exactly as `test/unit/tool/helpers/routing-fixtures.ts`
  // does and for the same reason: almost every dependency is a port, so the
  // argument list is a more honest statement of what a routing decision depends
  // on than a DI graph would be. What differs from the unit harness is that
  // most of them are the **production** implementations reading a real
  // database — which is the whole point, because the claim under test is about
  // how fast a row change reaches a routing decision.
  //
  // The two rate/ceiling counters are the production classes too, over an in-memory
  // Redis. Substituting no-ops would quietly remove two reads from the very
  // path this file exists to time, and the day one of them acquires a cache or
  // a blocking call the number printed below is what has to notice.
  const redis = new FakeRedis() as unknown as Redis;

  const enrolments = new DbChainEnrolmentSource(
    new ProviderChainEnrolmentRepository(context.dataSource),
    { emit: async () => undefined },
  );

  router = new ProviderRouterService(
    context.catalogue,
    new DbProviderRegistry(new ProviderRepository(context.dataSource), enrolments, noBlocks()),
    context.stakes,
    // The router narrows each binding's declared chains by
    // the provider's ACTIVE enrolments. The same source the registry reads, so
    // this harness cannot drift into agreeing with itself.
    enrolments,
    new NoGrace(),
    invoker,
    new BindingCallCounterService(redis, new PaymentIntentRepository(context.dataSource)),
    new BindingCeilingService(redis),
    config,
    () => 0,
    noBlocks(),
  );
});

afterAll(async () => {
  await context.close();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await context.reset();
  await context.registerProvider();
  context.stakes.set(context.organizationId, usdc(100));
});

/** A published, `ACTIVE` binding — the only state a pause is reachable from. */
async function publishedBindingId(): Promise<string> {
  const binding = await context.editor.create(context.organizationId, SUBJECT, body());
  await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
  const published = await context.publisher.publish(context.organizationId, SUBJECT, binding.id);
  expect(published.status).toBe(BindingStatus.ACTIVE);
  return binding.id;
}

interface Refusal {
  readonly at: number;
  readonly code: string;
  readonly message: string;
}

/**
 * A loop that keeps calling the router until told to stop, recording when each
 * call got through and why each one did not.
 *
 * Only a `DATA_RESULT` counts as "got through": a `SYSTEM_ERROR` reached a
 * provider but produced nothing, and counting it would let a broken upstream
 * masquerade as flowing traffic. That distinction is what makes the
 * "traffic *was* flowing" assertion below worth writing down.
 */
function startContinuousRouting(toolId: string) {
  const routedAt: number[] = [];
  const refusals: Refusal[] = [];
  let running = true;
  let quiet = 0;

  const finished = (async () => {
    while (running) {
      try {
        const call = await router.route({
          toolId,
          input: { query: 'x' },
          callId: randomUUID(),
          // Supplied, never inferred. This harness has one chain
          // (`STAKE_CHAIN`, the chain `USDC_ASSET` names), and every field is
          // it: the buyer pays from it, defaults to it, and the deployment
          // serves only it. The subject here is pause latency, so the chain
          // gate must pass every candidate through untouched.
          context: {
            payerChains: [STAKE_CHAIN],
            defaultChainId: STAKE_CHAIN,
            withdrawingChains: [],
            enabledChains: [STAKE_CHAIN],
          },
        });

        if (call.classification.responseClass === ResponseClass.DATA_RESULT) {
          routedAt.push(Date.now());
          quiet = 0;
        }
      } catch (error) {
        const failure = error as { errorCode?: string; message?: string };
        refusals.push({
          at: Date.now(),
          code: failure.errorCode ?? 'UNKNOWN',
          message: failure.message ?? String(error),
        });
        quiet += 1;
      }

      await new Promise((resolve) => setTimeout(resolve, CALL_INTERVAL_MS));
    }
  })();

  return {
    routedAt,
    refusals,
    get routedCount(): number {
      return routedAt.length;
    },

    /** Block until `count` calls have been served, so the pause lands on live traffic. */
    async waitUntilFlowing(count: number, timeoutMs = 20_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (routedAt.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `traffic never started: ${routedAt.length} routed, ` +
              `${refusals.length} refused (last: ${refusals.at(-1)?.message ?? 'none'})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, CALL_INTERVAL_MS));
      }
    },

    /**
     * Block until {@link QUIET_CALLS} consecutive calls have been refused, and
     * return the moment the **last** call got through.
     *
     * The timeout is generous on purpose. It is not the assertion — the
     * five-second bound below is — and a tight one would turn a slow machine
     * into a timeout with no number in it, which is precisely the outcome that
     * makes a measurement useless.
     */
    async waitUntilNoneRouted(timeoutMs = 30_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (quiet < QUIET_CALLS) {
        if (Date.now() > deadline) {
          throw new Error(
            `traffic never stopped: ${routedAt.length} calls routed, last at ` +
              `${new Date(routedAt.at(-1) ?? 0).toISOString()}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, CALL_INTERVAL_MS));
      }
      return routedAt.at(-1) ?? 0;
    },

    async stop(): Promise<void> {
      running = false;
      await finished;
    },
  };
}

describe('a pause cuts traffic within five seconds, measured', () => {
  it('stops traffic within 5 seconds of the pause landing', async () => {
    const bindingId = await publishedBindingId();
    const traffic = startContinuousRouting(TOOL.id);

    try {
      // The pause has to land on traffic that is actually moving, or the
      // measurement is of an idle system.
      await traffic.waitUntilFlowing(3);
      const routedBeforePause = traffic.routedCount;
      const refusalsBeforePause = traffic.refusals.length;

      const pausedAt = Date.now();
      await context.pauser.pause(context.organizationId, bindingId, {
        reason: 'measuring how long the tap takes to close',
      });

      const lastThrough = await traffic.waitUntilNoneRouted();
      const measuredMs = lastThrough - pausedAt;

      // Printed so the measured figure can be recorded.
      console.log(
        `measured: ${measuredMs}ms from pause to the last call through ` +
          `(${routedBeforePause} calls routed before the pause, ` +
          `${traffic.routedCount - routedBeforePause} after it)`,
      );

      // 1. Traffic was flowing. Without this the rest is a statement about a
      //    system that was never serving anything.
      expect(routedBeforePause).toBeGreaterThan(1);
      expect(refusalsBeforePause).toBe(0);

      // 2. The measurement itself — the requirement.
      expect(measuredMs).toBeLessThan(PAUSE_BUDGET_MS);
      // Deliberately NOT `toBeGreaterThanOrEqual(0)`. A negative interval here
      // does not mean something is wrong — it means the pause committed while
      // the loop was between calls, so ZERO calls got through afterwards and
      // the last one predates the pause. That is the pause working *better*
      // than the budget, and asserting non-negativity would fail the test on a
      // correctly behaving system, at random, depending on loop phase.
      //
      // What must hold is the thing the requirement actually asks: the last call
      // through is inside the budget on both sides of the pause. Assertion 3
      // below is what proves it stopped *because* of the pause.
      expect(measuredMs).toBeGreaterThan(-PAUSE_BUDGET_MS);

      // 3. It stopped BECAUSE of the pause. `BINDING_NOT_ACTIVE` is the only
      //    reason `filterEligible` may give here — a stake refusal, an asset
      //    mismatch or an empty catalogue would each produce a different
      //    summary, and each would mean this test measured something else.
      const afterPause = traffic.refusals.filter((refusal) => refusal.at >= pausedAt);
      expect(afterPause.length).toBeGreaterThanOrEqual(QUIET_CALLS);
      for (const refusal of afterPause) {
        expect(refusal.code).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
        expect(refusal.message).toContain('BINDING_NOT_ACTIVE');
      }

      // 4. And the harness had not simply broken. A resume brings the same
      //    loop, the same router and the same provider back — which no amount
      //    of asserting on a stopped system can show.
      const routedWhilePaused = traffic.routedCount;
      await context.pauser.resume(context.organizationId, bindingId);
      await traffic.waitUntilFlowing(routedWhilePaused + 2);
      expect(traffic.routedCount).toBeGreaterThan(routedWhilePaused);
    } finally {
      await traffic.stop();
    }
  }, 90_000);
});
