import { ResponseClass } from '@modules/tool/domain/classification/classification.types';
import { EXPLORATION_FLOOR_SHARE, IneligibilityReason } from '@modules/tool/domain/routing';
import { ToolErrorCode } from '@modules/tool/errors/tool.errors';
import { ToolBinding } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import {
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  ok,
  status,
  usdc,
} from './helpers/routing-fixtures';

/**
 * The router loads all three per-binding traffic facts and spends the token.
 *
 * Originally `RoutingCandidate.observedCalls` and `.ceilingHit` were both
 * hardcoded `null` in `gatherCandidates`, and nothing anywhere called
 * `BindingCeilingService.consume`. So the exploration floor was inert,
 * the declared ceilings were never consulted, and no token was ever spent — while
 * every test in the suite stayed green, because each of those three pieces was
 * tested in isolation against inputs a test supplied by hand.
 *
 * ```text
 *   gatherCandidates ──▶ observedCallsAll()  ─┐  one wave, once per tool call
 *                    ──▶ readAll()           ─┘
 *        │                                       candidate.observedCalls
 *        │                                       candidate.ceilingHit
 *   filterEligible   ──▶ CEILING_REACHED         pure, synchronous, no Redis
 *   computeWeights   ──▶ exploration floor
 *        │
 *   selection        ──▶ consume()               exactly ONE token, one binding
 *        └─ refused? ──▶ shed → failover, same as a filter-time hit
 * ```
 *
 * ## The claim worth defending: the threshold is the DECLARED one
 *
 * Asking only *does traffic shed*, never *at what threshold*, lets the obvious
 * wrong implementation (check-and-take inside `filterEligible`) pass. That version spends one
 * token per **candidate** per routing decision, so every binding behind a tool
 * is debited for calls that went somewhere else, and a provider who declared
 * `max_rps: 10` behind a tool with five candidates is really held to two.
 *
 * That is why this file drives the **real** `BindingCeilingService` over a fake
 * Redis rather than a scripted double: a double asked "is this at its ceiling"
 * would answer without running the arithmetic that is the actual subject.
 *
 * ## Shedding is not an error
 *
 * A candidate at its ceiling is removed from the draw and the call goes to
 * another provider. No `SYSTEM_ERROR`, no strike, nothing in the quality
 * profile, and no `RoutingAttempt` — nothing was attempted. Only when *every*
 * candidate is at its ceiling does the call fail, with the ordinary
 * `TOOL_NO_ELIGIBLE_BINDING`.
 */

const A = 'provider-a';
const B = 'provider-b';
const C = 'provider-c';

const RICH = { [A]: usdc(1000), [B]: usdc(1000), [C]: usdc(1000) };

const bindingOf = (providerId: string) => `binding-${providerId}`;

/** Every binding answers with a mappable 2xx. */
function healthyInvoker(...providerIds: string[]): ScriptedInvoker {
  return new ScriptedInvoker(
    Object.fromEntries(providerIds.map((id) => [bindingOf(id), async () => ok()])),
  );
}

const call = {
  toolId: TOOL_ID,
  callId: 'test-call-id',
  input: { query: 'x' },
  context: ROUTING_CONTEXT,
};

// ---------------------------------------------------------------------------
// 1. The two fields are loaded
// ---------------------------------------------------------------------------

describe('gatherCandidates loads the traffic facts', () => {
  it('loads observedCalls onto every candidate — not the hardcoded null', async () => {
    const harness = buildRouter({
      bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker: healthyInvoker(A, B, C),
      observedCalls: { [bindingOf(A)]: 0 },
    });

    await harness.router.route(call);

    // Every candidate, once, in one batch — not one round trip per candidate on
    // the path an agent is blocked on.
    expect(harness.callCounter.batches).toHaveLength(1);
    expect(harness.callCounter.batches[0].sort()).toEqual(
      [bindingOf(A), bindingOf(B), bindingOf(C)].sort(),
    );
  });

  it('makes the exploration floor live — a real count changes the share, null does not', async () => {
    // Identical providers, identical bindings, identical seed. The ONLY
    // difference between the two runs is that A's binding has a real lifetime
    // count in the second, so anything that moves is the exploration floor.
    const build = (observedCalls: Record<string, number | null>) =>
      buildRouter({
        bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
        providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
        stakes: RICH,
        invoker: healthyInvoker(A, B, C),
        observedCalls,
      });

    // `random = () => 0` draws the first candidate, and `RoutingAttempt.weight`
    // records the share it held at the moment it was drawn.
    const inert = await build({}).router.route(call);
    const exploring = await build({ [bindingOf(A)]: 0 }).router.route(call);

    expect(inert.attempts[0].bindingId).toBe(bindingOf(A));
    expect(exploring.attempts[0].bindingId).toBe(bindingOf(A));

    // Three identical candidates share the traffic evenly when nothing is new.
    expect(inert.attempts[0].weight).toBeCloseTo(1 / 3, 6);

    // One explorer reserves 5% off the top and still competes for the rest.
    const expected = EXPLORATION_FLOOR_SHARE + (1 - EXPLORATION_FLOOR_SHARE) * (1 / 3);
    expect(exploring.attempts[0].weight).toBeCloseTo(expected, 6);
    expect(exploring.attempts[0].weight).toBeGreaterThan(inert.attempts[0].weight);
  });

  it('leaves a binding with no counter reading OUT of the exploration set', async () => {
    // The fail-closed direction, and the one a hardcoded `null` would have hidden
    // forever: `null` must not read as "brand new", or an outage hands every
    // binding on the platform a new binding's allowance at once.
    //
    // The fixture MUST be asymmetric, and an earlier version of this test was
    // not — it gave all three candidates `null` and asserted 1/3. That is
    // vacuous: if `null` were treated as exploring, all three would take an
    // equal floor plus an equal share of the remainder, summing back to exactly
    // 1/3. The assertion could not tell the two worlds apart, and the mutation
    // it exists to catch passed it. (The same symmetry trap was found and fixed
    // in `routing-weights.spec.ts`; it is the default shape a fixture falls
    // into, so check for it whenever a share is asserted.)
    //
    // B is given a real, large count so it is definitively NOT exploring. A
    // must land on exactly B's share — under the mutation A takes a floor B
    // does not get, and the two diverge.
    const harness = buildRouter({
      bindings: [buildBinding(A), buildBinding(B), buildBinding(C)],
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker: healthyInvoker(A, B, C),
      observedCalls: { [bindingOf(A)]: null, [bindingOf(B)]: 50_000 },
    });

    // Nobody is exploring, so every candidate holds exactly 1/3 and it does not
    // matter which one the draw picked. Under the mutation A and C hold
    // 0.05 + 0.9/3 = 0.35 and B holds 0.3 — no branch lands on 1/3.
    const result = await harness.router.route(call);

    expect(result.attempts[0].weight).toBeCloseTo(1 / 3, 6);
  });

  it('loads ceilingHit onto every candidate', async () => {
    const bindings = [
      buildBinding(A, { maxRps: 2 }),
      buildBinding(B, { maxRps: 2 }),
      // Declares nothing, and is still asked about — "no ceiling" has to be a
      // fact about the binding, not about which bindings we bothered to read.
      buildBinding(C),
    ];
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker: healthyInvoker(A, B, C),
    });

    const readAll = jest.spyOn(harness.ceilings, 'readAll');
    await harness.ceilings.consume(bindings[0]);
    await harness.ceilings.consume(bindings[0]);
    const consume = jest.spyOn(harness.ceilings, 'consume');

    const result = await harness.router.route(call);

    // One batched read per tool call, over every candidate — including the one
    // that declared nothing, which is what makes the answer "no ceiling" a fact
    // about the binding rather than about which bindings we bothered to ask.
    expect(readAll).toHaveBeenCalledTimes(1);
    expect(readAll.mock.calls[0][0].map((binding: ToolBinding) => binding.id).sort()).toEqual(
      [bindingOf(A), bindingOf(B), bindingOf(C)].sort(),
    );

    // And the value it returned reached the decision. A's ceiling was hit
    // BEFORE filtering, so A never entered the draw and `consume` was never
    // asked about it. Without the load, A would still be shed — but at the
    // reservation, one round trip later and after winning a draw it should not
    // have been in. That is the difference this asserts, because the
    // reservation is a backstop for a race, not the mechanism.
    expect(result.binding.providerId).toBe(B);
    expect(consume.mock.calls.map(([binding]: [ToolBinding]) => binding.id)).toEqual([
      bindingOf(B),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Shedding
// ---------------------------------------------------------------------------

describe('a binding at its ceiling sheds', () => {
  it('sheds a binding at its ceiling and fails over to another provider', async () => {
    const atCeiling = buildBinding(A, { maxRps: 1 });
    const invoker = healthyInvoker(A, B);
    const harness = buildRouter({
      bindings: [atCeiling, buildBinding(B)],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker,
    });

    // Fill A's bucket the way traffic would have — through the same service the
    // router reads, not by writing a key the test invented.
    expect(await harness.ceilings.consume(atCeiling)).toBeNull();
    const consume = jest.spyOn(harness.ceilings, 'consume');

    const result = await harness.router.route(call);

    expect(result.binding.id).toBe(bindingOf(B));
    // Not attempted, not dialled, not on the receipt. Nothing happened to A.
    expect(invoker.bindingIds).toEqual([bindingOf(B)]);
    expect(result.attempts).toHaveLength(1);
    // Shed at the FILTER, from the value loaded onto the candidate — A was
    // never drawn, so no token was ever asked for on its behalf.
    expect(consume.mock.calls.map(([binding]: [ToolBinding]) => binding.id)).toEqual([
      bindingOf(B),
    ]);
  });

  it('never produces SYSTEM_ERROR for a provider at their ceiling', async () => {
    const atCeiling = buildBinding(A, { maxDailyCalls: 1 });
    const harness = buildRouter({
      bindings: [atCeiling, buildBinding(B)],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker: healthyInvoker(A, B),
    });

    await harness.ceilings.consume(atCeiling);

    const result = await harness.router.route(call);

    expect(result.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
    // The whole reason a declared ceiling is worth having: the same event
    // without the declaration is a 429 that lands on the provider's own
    // availability record.
    for (const attempt of result.attempts) {
      expect(attempt.classification.responseClass).not.toBe(ResponseClass.SYSTEM_ERROR);
      expect(attempt.providerId).not.toBe(A);
    }
  });

  it('sheds at the DECLARED threshold, not at maxRps/N', async () => {
    // The real question behind "does it shed?". Three candidates behind one
    // tool, each declaring the same ceiling, and every call drawn to A.
    const DECLARED = 5;
    const bindings = [A, B, C].map((id) => buildBinding(id, { maxRps: DECLARED }));
    const invoker = healthyInvoker(A, B, C);
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker,
    });

    for (let i = 0; i < DECLARED; i += 1) {
      const result = await harness.router.route(call);
      expect(result.binding.id).toBe(bindingOf(A));
    }

    // A served its whole declared allowance — five calls, not `5 / 3`.
    expect(invoker.bindingIds).toEqual(Array<string>(DECLARED).fill(bindingOf(A)));
    expect((await harness.ceilings.remaining(bindings[0])).rps).toBe(0);

    // And the two candidates that served nothing were debited nothing. This is
    // the half that a check-and-take inside `filterEligible` gets wrong: it
    // would have spent five tokens on each of B and C as well, and the sixth
    // call below would have found no supply at all instead of failing over.
    expect((await harness.ceilings.remaining(bindings[1])).rps).toBe(DECLARED);
    expect((await harness.ceilings.remaining(bindings[2])).rps).toBe(DECLARED);

    const sixth = await harness.router.route(call);
    expect(sixth.binding.providerId).toBe(B);
  });

  it('returns TOOL_NO_ELIGIBLE_BINDING when every candidate is at its ceiling', async () => {
    const bindings = [A, B, C].map((id) => buildBinding(id, { maxRps: 1 }));
    const invoker = healthyInvoker(A, B, C);
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker,
    });

    for (const binding of bindings) {
      expect(await harness.ceilings.consume(binding)).toBeNull();
    }

    const error = await harness.router
      .route(call)
      .then(() => null)
      .catch((e: AppError) => e);

    // The ordinary "no supply" error, not `TOOL_ALL_BINDINGS_FAILED`: nothing
    // failed, because nothing was attempted.
    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
    expect(error?.message).toContain(IneligibilityReason.CEILING_REACHED);
    expect(invoker.invocations).toHaveLength(0);
  });

  it('does not spend the attempt budget on candidates it never attempted', async () => {
    // Five candidates, all at their ceiling, against a three-attempt cap. A
    // shed is not an attempt, so the router must not run out of attempts before
    // it runs out of candidates and report an outage that never happened.
    const ids = [A, B, C, 'provider-d', 'provider-e'];
    const bindings = ids.map((id) => buildBinding(id, { maxRps: 1 }));
    const harness = buildRouter({
      bindings,
      providers: ids.map((id) => buildProvider(id)),
      stakes: Object.fromEntries(ids.map((id) => [id, usdc(1000)])),
      invoker: healthyInvoker(...ids),
      config: { maxAttempts: 3 },
    });

    for (const binding of bindings) await harness.ceilings.consume(binding);

    const error = await harness.router
      .route(call)
      .then(() => null)
      .catch((e: AppError) => e);

    expect(error?.errorCode).toBe(ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING);
  });

  it('treats a bucket that emptied between the read and the consume as an ordinary shed', async () => {
    // The race accepted rather than locked against: `readAll` said A
    // had headroom, and by the time the token was taken another pod had spent
    // it. `consume` returns the same `CeilingKind` the filter would have, and
    // the caller fails over exactly as if it had been hit at filter time.
    const bindings = [buildBinding(A, { maxRps: 4 }), buildBinding(B, { maxRps: 4 })];
    const invoker = healthyInvoker(A, B);
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker,
    });

    const real = harness.ceilings.consume.bind(harness.ceilings);
    jest.spyOn(harness.ceilings, 'consume').mockImplementationOnce(async (binding: ToolBinding) => {
      // Somebody else took the last token in the microsecond between.
      for (let i = 0; i < 4; i += 1) await real(binding);
      return real(binding);
    });

    const result = await harness.router.route(call);

    expect(result.binding.providerId).toBe(B);
    expect(invoker.bindingIds).toEqual([bindingOf(B)]);
    // Not an error and not on the receipt — one attempt, and it succeeded.
    expect(result.attempts).toHaveLength(1);
    expect(result.classification.responseClass).toBe(ResponseClass.DATA_RESULT);
  });
});

// ---------------------------------------------------------------------------
// 3. Exactly one token, on the binding that served
// ---------------------------------------------------------------------------

describe('the router spends the token', () => {
  it('spends exactly one token per routed call, on the binding that served', async () => {
    const bindings = [
      buildBinding(A, { maxRps: 10, maxDailyCalls: 100 }),
      buildBinding(B, { maxRps: 10, maxDailyCalls: 100 }),
    ];
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker: healthyInvoker(A, B),
    });

    const result = await harness.router.route(call);
    expect(result.binding.id).toBe(bindingOf(A));

    expect(await harness.ceilings.remaining(bindings[0])).toEqual({ rps: 9, daily: 99 });
    // The candidate that was drawn against and not chosen is untouched. One
    // token per *call*, never one per candidate.
    expect(await harness.ceilings.remaining(bindings[1])).toEqual({ rps: 10, daily: 100 });
  });

  it('spends a token for each binding actually dialled during failover', async () => {
    // A failed-over binding WAS delivered a call — that is what its 500 is —
    // so it is debited. What the ceiling bounds is calls that reached a
    // provider's endpoint, not calls that ended up being useful.
    const bindings = [
      buildBinding(A, { maxRps: 10, maxDailyCalls: 100 }),
      buildBinding(B, { maxRps: 10, maxDailyCalls: 100 }),
      buildBinding(C, { maxRps: 10, maxDailyCalls: 100 }),
    ];
    const invoker = new ScriptedInvoker({
      [bindingOf(A)]: async () => status(503),
      [bindingOf(B)]: async () => ok(),
      [bindingOf(C)]: async () => ok(),
    });
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B), buildProvider(C)],
      stakes: RICH,
      invoker,
    });

    const result = await harness.router.route(call);

    expect(result.attempts).toHaveLength(2);
    expect((await harness.ceilings.remaining(bindings[0])).daily).toBe(99);
    expect((await harness.ceilings.remaining(bindings[1])).daily).toBe(99);
    // Never drawn, never dialled, never debited.
    expect((await harness.ceilings.remaining(bindings[2])).daily).toBe(100);
  });

  it('spends nothing for a binding that declared no ceiling', async () => {
    const harness = buildRouter({
      bindings: [buildBinding(A)],
      providers: [buildProvider(A)],
      stakes: RICH,
      invoker: healthyInvoker(A),
    });

    await harness.router.route(call);

    // A round trip per candidate for a limit nobody set is a cost every routing
    // decision on the platform would pay.
    expect(harness.redis.commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The quote agrees, and pays nothing
// ---------------------------------------------------------------------------

describe('quote() and the ceilings', () => {
  it('quote sees the same ceiling decision as select(), and consumes nothing', async () => {
    // A is the dearest, so if the quote ignored the ceiling it would publish a
    // price for a binding routing would refuse to use.
    const dear = buildBinding(A, { maxRps: 1, priceAmount: usdc('0.09').amount });
    const cheap = buildBinding(B, { priceAmount: usdc('0.05').amount });
    const harness = buildRouter({
      bindings: [dear, cheap],
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker: healthyInvoker(A, B),
    });

    await harness.ceilings.consume(dear);
    const consume = jest.spyOn(harness.ceilings, 'consume');

    const quote = await harness.router.quote(TOOL_ID, ROUTING_CONTEXT);

    expect(quote?.routableBindings).toBe(1);
    expect(quote?.price?.amount).toBe(cheap.priceAmount);

    // A price question is not a call. Nothing is spent, and A's remaining
    // headroom is exactly what filling its bucket above left it.
    expect(consume).not.toHaveBeenCalled();
    expect((await harness.ceilings.remaining(dear)).rps).toBe(0);
    expect((await harness.ceilings.remaining(cheap)).rps).toBeNull();
  });

  it('reports no routable supply — with the reason — when every binding is at its ceiling', async () => {
    const bindings = [A, B].map((id) => buildBinding(id, { maxDailyCalls: 1 }));
    const harness = buildRouter({
      bindings,
      providers: [buildProvider(A), buildProvider(B)],
      stakes: RICH,
      invoker: healthyInvoker(A, B),
    });

    for (const binding of bindings) await harness.ceilings.consume(binding);

    const quote = await harness.router.quote(TOOL_ID, ROUTING_CONTEXT);

    expect(quote?.routableBindings).toBe(0);
    expect(quote?.price).toBeNull();
    // "nobody has registered for this tool" and "everyone is at their ceiling"
    // have to be distinguishable from outside.
    expect(quote?.unroutableReason).toContain(IneligibilityReason.CEILING_REACHED);
  });
});
