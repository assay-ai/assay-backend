import fc from 'fast-check';

import {
  DEFAULT_SIGNING_RATE_LIMITS,
  RateWindowObservation,
  SigningRateVerdict,
  decideSigningRate,
} from '@modules/verification/signing/domain/signing-rate-limit';

/** The signing rate limit, at the decision layer. The Redis half is the integration test. */
describe('decideSigningRate', () => {
  const limits = { ...DEFAULT_SIGNING_RATE_LIMITS, perKey: 10, perRequester: 4, warnRatio: 0.5 };

  it('allows quietly while both scopes are well inside their budget', () => {
    const decision = decideSigningRate(
      [observation('requester:worker', 1, 4), observation('key:k', 1, 10)],
      limits,
    );

    expect(decision.verdict).toBe(SigningRateVerdict.ALLOW);
    expect(decision.elevated).toEqual([]);
    expect(decision.breached).toBeNull();
  });

  it('allows and alerts once a scope crosses the warn ratio', () => {
    // The useful moment is when the rate stops looking like production, not
    // when it hits the ceiling — by then an attacker has had the whole budget.
    const decision = decideSigningRate(
      [observation('requester:worker', 2, 4), observation('key:k', 2, 10)],
      limits,
    );

    expect(decision.verdict).toBe(SigningRateVerdict.ALLOW_AND_ALERT);
    expect(decision.elevated.map((o) => o.scope)).toEqual(['requester:worker']);
    expect(decision.breached).toBeNull();
  });

  it('allows exactly at the limit and refuses the one after', () => {
    // `observed` includes the attempt being decided, so the ceiling means what
    // it says: deciding on the pre-increment count lets `limit + 1` through.
    expect(decideSigningRate([observation('key:k', 10, 10)], limits).verdict).toBe(
      SigningRateVerdict.ALLOW_AND_ALERT,
    );
    expect(decideSigningRate([observation('key:k', 11, 10)], limits).verdict).toBe(
      SigningRateVerdict.REFUSE,
    );
  });

  it('names the narrowest breached scope, because that is the actionable one', () => {
    // Caller order is the priority order. "This caller is out of budget" points
    // at something to fix; "the key is" does not.
    const decision = decideSigningRate(
      [observation('requester:worker', 9, 4), observation('key:k', 20, 10)],
      limits,
    );

    expect(decision.verdict).toBe(SigningRateVerdict.REFUSE);
    expect(decision.breached?.scope).toBe('requester:worker');
    expect(decision.elevated).toHaveLength(2);
  });

  it('reports every elevated scope even when refusing, so the alert is complete', () => {
    const decision = decideSigningRate(
      [observation('requester:worker', 5, 4), observation('key:k', 11, 10)],
      limits,
    );

    expect(decision.elevated.map((o) => o.scope)).toEqual(['requester:worker', 'key:k']);
  });

  describe('properties', () => {
    it('never refuses without naming what breached, and never names one otherwise', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              scope: fc.string({ minLength: 1 }),
              observed: fc.integer({ min: 0, max: 500 }),
              limit: fc.integer({ min: 1, max: 100 }),
            }),
            { maxLength: 6 },
          ),
          fc.double({ min: 0.01, max: 1, noNaN: true }),
          (observations, warnRatio) => {
            const decision = decideSigningRate(observations, { ...limits, warnRatio });

            const refused = decision.verdict === SigningRateVerdict.REFUSE;
            expect(refused).toBe(decision.breached !== null);
            // A refusal is always also elevated — the ceiling is above the warn
            // line by construction, so an alert always accompanies a block.
            if (refused) {
              expect(decision.elevated).toContain(decision.breached);
            }
            if (decision.verdict === SigningRateVerdict.ALLOW) {
              expect(decision.elevated).toEqual([]);
            }
          },
        ),
      );
    });

    it('is monotone: more observed never turns a refusal back into an allow', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), (a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const severity = (n: number) =>
            [
              SigningRateVerdict.ALLOW,
              SigningRateVerdict.ALLOW_AND_ALERT,
              SigningRateVerdict.REFUSE,
            ].indexOf(decideSigningRate([observation('key:k', n, 10)], limits).verdict);

          expect(severity(high)).toBeGreaterThanOrEqual(severity(low));
        }),
      );
    });
  });
});

function observation(scope: string, observed: number, limit: number): RateWindowObservation {
  return { scope, observed, limit };
}
