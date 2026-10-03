import {
  DEMO_RATE_LIMITS,
  DemoRateDecision,
  decideDemoRate,
} from '@modules/mcp/domain/demo-rate-limit';

/**
 * The live demo — how many demo calls one address may run.
 *
 * Pure: no Redis, no clock. The counting belongs to
 * `RedisDemoRateLimiter`; what is *decided* is here, where every boundary can
 * be stated exactly. Modelled on `signing-rate-limit.ts`, which separates the
 * two for the same reason.
 *
 * This limiter protects **the provider's upstream**. The demo agent's spend
 * policy protects the platform's wallet. Neither substitutes for the other, so
 * a test that only proved one of them would be proving the wrong thing.
 */
describe('decideDemoRate', () => {
  const limits = DEMO_RATE_LIMITS;

  it('allows a caller under the window ceiling', () => {
    const decision = decideDemoRate({ used: 0, limits });

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(limits.perAddressPerWindow);
  });

  it('allows the call that exactly reaches the ceiling', () => {
    // `used` counts calls ALREADY made, so at `limit - 1` this request is the
    // last one that fits. Off by one here either refuses a caller their final
    // allowance or hands out one more than the ceiling says.
    const decision = decideDemoRate({ used: limits.perAddressPerWindow - 1, limits });

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it('refuses once the ceiling is reached', () => {
    const decision = decideDemoRate({ used: limits.perAddressPerWindow, limits });

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.reason).toBe(DemoRateDecision.RATE_LIMITED);
  });

  it('refuses beyond the ceiling without reporting negative headroom', () => {
    // A concurrent burst can push the count past the limit between the read
    // and the write. `remaining` is a number this endpoint puts in a header,
    // and a negative one would be nonsense to a client.
    const decision = decideDemoRate({ used: limits.perAddressPerWindow + 7, limits });

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('refuses when the counter could not be read at all', () => {
    // Redis down. This limiter fails CLOSED, unlike the binding ceilings in
    // which fail open — the difference is what is behind each of them. A
    // binding ceiling protects throughput; this protects a third party's
    // upstream and the platform's own wallet, and an unauthenticated endpoint
    // that stops counting is an open tap.
    const decision = decideDemoRate({ used: null, limits });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(DemoRateDecision.COUNTER_UNAVAILABLE);
  });

  it('treats a zero ceiling as "demo disabled", not "unlimited"', () => {
    const decision = decideDemoRate({ used: 0, limits: { ...limits, perAddressPerWindow: 0 } });

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });
});
