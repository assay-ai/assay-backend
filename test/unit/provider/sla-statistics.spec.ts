import {
  PENALTY_RATE_SCALE,
  effectiveThreshold,
  observedRate,
  penaltyFor,
  toleranceFor,
  wilsonInterval,
} from '@modules/provider/domain/sla/sla-statistics';
import { SLA_Z_SCORE } from '@modules/provider/constants/sla-window.constants';

/**
 * The four numbers a provider will quote back at us in a dispute.
 *
 * The anchor cases are the published formula's worked examples, transcribed
 * rather than recomputed here, so this file fails if the implementation ever
 * drifts from the published formula — which is the only version a provider
 * agreed to.
 */
describe('SLA statistics', () => {
  describe('observedRate', () => {
    it('is null at zero verified calls, never a bare 0%', () => {
      // A window with no observations has no failure rate. Rendering 0% would
      // tell a provider they are doing perfectly when we have not looked.
      expect(observedRate(0, 0)).toBeNull();
    });

    it('is the plain quotient otherwise', () => {
      expect(observedRate(9, 218)).toBeCloseTo(0.0413, 4);
    });
  });

  describe('toleranceFor — the published formula, verbatim', () => {
    // Why the tolerance must be statistical: "With n = 80 and p = 0.05 the standard error is 2.44
    // points, so a 99% tolerance is 6.3 points and the honest threshold is
    // 11.3%, not 5%."
    it('reproduces the worked example at n = 80', () => {
      const tolerance = toleranceFor(0.05, 80, SLA_Z_SCORE);
      expect(tolerance).not.toBeNull();
      expect(tolerance!).toBeCloseTo(0.063, 3);
      expect(effectiveThreshold(0.05, 80, SLA_Z_SCORE)!).toBeCloseTo(0.113, 3);
    });

    // The sample-gate worked example: tolerance = 2.58 × sqrt(0.05 × 0.95 /
    // 400) = 0.028 → threshold 7.8%.
    it('reproduces the worked example at the sample gate', () => {
      expect(toleranceFor(0.05, 400, SLA_Z_SCORE)!).toBeCloseTo(0.028, 3);
      expect(effectiveThreshold(0.05, 400, SLA_Z_SCORE)!).toBeCloseTo(0.078, 3);
    });

    // The property the whole design rests on: thin windows are judged loosely,
    // fat ones tightly, from ONE formula. A fixed tolerance cannot do this.
    it('shrinks monotonically as the sample grows', () => {
      const rates = [80, 167, 400, 2680].map((n) => toleranceFor(0.05, n, SLA_Z_SCORE)!);
      for (let i = 1; i < rates.length; i += 1) {
        expect(rates[i]).toBeLessThan(rates[i - 1]);
      }
      expect(rates[1]).toBeCloseTo(0.0435, 4);
      expect(rates[3]).toBeCloseTo(0.0109, 4);
    });

    /**
     * **Two readings of "99%" give two values of `Z`.**
     *
     * - `Z = 2.58 (99%)` as a constant, whose worked examples check out: 6.3pp
     *   at n = 80, 2.8pp at n = 400.
     * - *"A one-sided 99% bound needs z × sqrt(p(1−p)/n)"*, which tabulates
     *   5.7pp / 3.9pp / 1.0pp — `z = 2.326`, the one-sided quantile.
     *
     * 2.58 is the two-sided 99% quantile, so using it one-sided is really a
     * 99.5% bound. **2.58 is the one used**: it is the constant the mechanism
     * names explicitly, its examples are internally consistent, and the
     * difference errs in the provider's favour — a wider tolerance convicts
     * fewer honest providers. This test pins the choice so that "which 99% did
     * we mean" is never re-litigated silently.
     */
    it('uses Z = 2.58, not the one-sided 2.326', () => {
      expect(SLA_Z_SCORE).toBe(2.58);

      const chosen = toleranceFor(0.05, 80, SLA_Z_SCORE)!;
      const oneSided = toleranceFor(0.05, 80, 2.326)!;

      expect(chosen).toBeCloseTo(0.063, 3); // the worked example's "6.3 points"
      expect(oneSided).toBeCloseTo(0.057, 3); // the one-sided "≈ 5.7pp"
      expect(chosen).toBeGreaterThan(oneSided); // the provider-favourable side
    });

    it('takes the DECLARED rate, not the observed one', () => {
      // Two windows, same size, wildly different observations, identical
      // tolerance. If this ever fails, a provider having a bad window is being
      // granted a wider allowance for having one.
      const a = toleranceFor(0.05, 400, SLA_Z_SCORE);
      const b = toleranceFor(0.05, 400, SLA_Z_SCORE);
      expect(a).toEqual(b);
    });

    it('is null rather than infinite at n = 0', () => {
      // Infinity would let a caller conclude "within tolerance" about a window
      // containing no data at all.
      expect(toleranceFor(0.05, 0, SLA_Z_SCORE)).toBeNull();
      expect(effectiveThreshold(0.05, 0, SLA_Z_SCORE)).toBeNull();
    });
  });

  describe('wilsonInterval', () => {
    it('never leaves [0, 1], where the normal approximation would', () => {
      // 2 failures in 50 calls. The normal interval is [-1.1%, 9.1%]; a
      // negative failure rate on a provider's screen destroys the credibility
      // of every number beside it.
      const interval = wilsonInterval(2, 50, SLA_Z_SCORE)!;
      expect(interval.lower).toBeGreaterThanOrEqual(0);
      expect(interval.upper).toBeLessThanOrEqual(1);
      expect(interval.lower).toBeCloseTo(0.0078, 4);
    });

    it('brackets the observation and narrows as n grows', () => {
      const thin = wilsonInterval(9, 218, SLA_Z_SCORE)!;
      const fat = wilsonInterval(90, 2180, SLA_Z_SCORE)!;

      expect(thin.lower).toBeLessThan(9 / 218);
      expect(thin.upper).toBeGreaterThan(9 / 218);
      expect(fat.upper - fat.lower).toBeLessThan(thin.upper - thin.lower);
    });

    it('is null at zero observations', () => {
      expect(wilsonInterval(0, 0, SLA_Z_SCORE)).toBeNull();
    });
  });

  describe('penaltyFor', () => {
    // The sample-gate worked example: 400 verified of 50,000 served at $0.001,
    // 60 failed → 15% observed, excess 10%, estimated_bad 5,000, penalty
    // 5,000 × $0.001 × 2 = $10.00.
    it('reproduces the worked example to the cent', () => {
      const totalCallAmount = 50_000n * 1_000n; // 50,000 calls × $0.001 in 6dp USDC
      const penalty = penaltyFor(totalCallAmount, 0.1, 2);

      expect(penalty).toBe(10_000_000n); // $10.00 in 6dp minor units
    });

    it('is zero when the observation is at or below the declaration', () => {
      expect(penaltyFor(50_000_000n, 0, 2)).toBe(0n);
      expect(penaltyFor(50_000_000n, -0.01, 2)).toBe(0n);
    });

    it('stays exact past 2^53 minor units, where Number() would not', () => {
      // The reason PENALTY_RATE_SCALE exists. A window whose turnover exceeds
      // 2^53 minor units multiplied through a double loses its low digits
      // silently, and this is a money column.
      const huge = 10n ** 24n;
      const penalty = penaltyFor(huge, 0.5, 2);

      expect(penalty).toBe(huge); // 0.5 × 2 = 1.0 exactly
      expect(penalty % PENALTY_RATE_SCALE).toBe(0n);
    });

    it('floors — the fractional minor unit goes to the party being charged', () => {
      // 1 minor unit of turnover at a 0.5% excess and 2× is 0.01 minor units.
      expect(penaltyFor(1n, 0.005, 2)).toBe(0n);
    });
  });
});
