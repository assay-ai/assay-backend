import {
  SlaPositionState,
  SlaWarningLevel,
  SlaWindowCounters,
  SlaWindowOutcome,
  SlaWindowSnapshot,
  closeOutcomeFor,
  countsTowardWindow,
  decideWarning,
  positionFor,
  shouldClose,
  strikeArithmeticFor,
} from '@modules/provider/domain/sla/sla-window';
import { DEFAULT_SLA_WINDOW_CONFIG } from '@modules/provider/constants/sla-window.constants';
import { VERDICT_CONSEQUENCE, VerdictStatus } from '@modules/verification/domain/verdict';

const SNAPSHOT: SlaWindowSnapshot = Object.freeze({
  declaredFailureRate: 0.05,
  minVerifiedCalls: DEFAULT_SLA_WINDOW_CONFIG.minVerifiedCalls,
  zScore: DEFAULT_SLA_WINDOW_CONFIG.zScore,
  maxAgeMs: DEFAULT_SLA_WINDOW_CONFIG.maxAgeMs,
  warningRatio: DEFAULT_SLA_WINDOW_CONFIG.warningRatio,
  warningMinSampleFraction: DEFAULT_SLA_WINDOW_CONFIG.warningMinSampleFraction,
  penaltyMultiplier: DEFAULT_SLA_WINDOW_CONFIG.penaltyMultiplier,
});

/** `$0.001` in 6dp USDC minor units. */
const PRICE = 1_000n;

function counters(
  totalCalls: number,
  verifiedCalls: number,
  failedCalls: number,
): SlaWindowCounters {
  return {
    totalCalls,
    verifiedCalls,
    failedCalls,
    totalCallAmount: BigInt(totalCalls) * PRICE,
  };
}

describe('SLA window domain', () => {
  /**
   * Position at the four moments that matter.
   *
   * These are the boundaries a fixture-driven test only reaches by accident,
   * which is why the position calculation is a pure function.
   */
  describe('positionFor — the four edges', () => {
    it('opening: no observation, no rate, no budget spent', () => {
      const position = positionFor(SNAPSHOT, counters(0, 0, 0));

      expect(position.observedFailureRate).toBeNull();
      expect(position.confidenceInterval).toBeNull();
      expect(position.state).toBe(SlaPositionState.BELOW_SAMPLE_GATE);
      expect(position.slashable).toBe(false);
      expect(position.errorBudgetUsedCalls).toBe(0);

      // The budget is already knowable at call zero — that is what makes the
      // gauge useful on the first morning rather than on the last.
      // floor(0.0781 × 400) = 31 failures allowed across the whole window.
      expect(position.projectedSampleAtClose).toBe(400);
      expect(position.effectiveThresholdAtClose).toBeCloseTo(0.0781, 4);
      expect(position.errorBudgetCalls).toBe(31);
      expect(position.errorBudgetRemainingCalls).toBe(31);
      expect(position.errorBudgetUsedFraction).toBe(0);
      expect(position.projectedBreach).toBe(false);
    });

    it('middle: half the sample, comfortably inside the budget', () => {
      // 200 verified, 8 failed → 4.0% observed against a 5% declaration.
      const position = positionFor(SNAPSHOT, counters(25_000, 200, 8));

      expect(position.observedFailureRate).toBeCloseTo(0.04, 4);
      expect(position.slashable).toBe(false); // 200 < 400
      expect(position.state).toBe(SlaPositionState.BELOW_SAMPLE_GATE);
      expect(position.errorBudgetUsedCalls).toBe(8);
      expect(position.errorBudgetRemainingCalls).toBe(23);
      expect(position.errorBudgetUsedFraction).toBeCloseTo(8 / 31, 4);

      // The projection is the current rate held to close — 4% of 400 = 16.
      expect(position.projectedFailedCalls).toBe(16);
      expect(position.projectedBreach).toBe(false);

      // At 200 observations a 4% reading cannot distinguish itself from a 5%
      // true rate. That is exactly what the interval is for.
      expect(position.confidentlyAboveDeclared).toBe(false);
      expect(position.confidenceInterval!.lower).toBeLessThan(0.05);
      expect(position.confidenceInterval!.upper).toBeGreaterThan(0.05);
    });

    it('right under the threshold: at the gate, budget nearly spent, no breach', () => {
      // 400 verified, 31 failed → 7.75%, against an effective threshold of
      // 7.81%. The last window that does NOT breach.
      const position = positionFor(SNAPSHOT, counters(50_000, 400, 31));

      expect(position.slashable).toBe(true);
      expect(position.observedFailureRate).toBeCloseTo(0.0775, 4);
      expect(position.effectiveThresholdAtClose).toBeCloseTo(0.0781, 4);
      expect(position.observedFailureRate!).toBeLessThan(position.effectiveThresholdAtClose);

      expect(position.errorBudgetUsedCalls).toBe(31);
      expect(position.errorBudgetRemainingCalls).toBe(0);
      expect(position.errorBudgetUsedFraction).toBe(1);

      expect(position.projectedBreach).toBe(false);
      expect(position.state).toBe(SlaPositionState.WITHIN_SLA);
      expect(closeOutcomeFor(SNAPSHOT, counters(50_000, 400, 31))).toBe(
        SlaWindowOutcome.WITHIN_SLA,
      );
    });

    it('just over: one more failure flips the outcome and nothing else', () => {
      // 400 verified, 32 failed → 8.00% > 7.81%.
      const over = counters(50_000, 400, 32);
      const position = positionFor(SNAPSHOT, over);

      expect(position.observedFailureRate).toBeCloseTo(0.08, 4);
      expect(position.observedFailureRate!).toBeGreaterThan(position.effectiveThresholdAtClose);
      expect(position.projectedBreach).toBe(true);
      expect(position.state).toBe(SlaPositionState.PROJECTED_BREACH);
      expect(position.errorBudgetRemainingCalls).toBe(0);
      expect(position.errorBudgetUsedFraction).toBeGreaterThan(1);

      expect(closeOutcomeFor(SNAPSHOT, over)).toBe(SlaWindowOutcome.BREACH_PROPOSED);
    });

    it('a 0% declaration has no error budget and no division by it', () => {
      // A provider is allowed to declare zero. `usedFraction` must not become
      // Infinity or NaN on the screen that tells them how they are doing.
      const zero: SlaWindowSnapshot = { ...SNAPSHOT, declaredFailureRate: 0 };
      const position = positionFor(zero, counters(500, 400, 0));

      expect(position.errorBudgetCalls).toBe(0);
      expect(position.errorBudgetUsedFraction).toBeNull();
      expect(position.projectedBreach).toBe(false);
    });
  });

  /**
   * The warning fires at the right moment, and stays quiet
   * before it.
   */
  describe('decideWarning', () => {
    it('stays silent on an empty window', () => {
      expect(decideWarning(SNAPSHOT, positionFor(SNAPSHOT, counters(0, 0, 0)), null)).toBeNull();
    });

    it('does NOT fire on the first failure of a fresh window', () => {
      // 1 failure in 1 verified call is a 100% observed rate, which crosses 80%
      // of any declaration. Without the sample floor every binding would be
      // warned that it is about to breach on its first bad call, and the signal
      // would be worthless inside a week.
      const position = positionFor(SNAPSHOT, counters(120, 1, 1));

      expect(position.observedFailureRate).toBe(1);
      expect(decideWarning(SNAPSHOT, position, null)).toBeNull();
    });

    it('does NOT fire while the observation is inside the band', () => {
      // 150 verified (past the 100-call floor), 5 failed → 3.33%, under
      // 0.8 × 5% = 4%.
      const position = positionFor(SNAPSHOT, counters(20_000, 150, 5));

      expect(position.verifiedCalls).toBeGreaterThanOrEqual(100);
      expect(position.observedFailureRate!).toBeLessThan(0.04);
      expect(decideWarning(SNAPSHOT, position, null)).toBeNull();
    });

    it('fires WARNING once the band is crossed with enough sample to mean it', () => {
      // 150 verified, 7 failed → 4.67% ≥ 4%. Mid-window, still fixable, and
      // 24 of the 31 budgeted failures still unspent.
      const position = positionFor(SNAPSHOT, counters(20_000, 150, 7));

      expect(decideWarning(SNAPSHOT, position, null)).toBe(SlaWarningLevel.WARNING);
      expect(position.errorBudgetRemainingCalls).toBe(24);
      expect(position.slashable).toBe(false); // warned BEFORE it can be penalised
    });

    it('does not repeat a level it has already delivered', () => {
      const position = positionFor(SNAPSHOT, counters(20_000, 150, 7));

      expect(decideWarning(SNAPSHOT, position, SlaWarningLevel.WARNING)).toBeNull();
      expect(decideWarning(SNAPSHOT, position, SlaWarningLevel.CRITICAL)).toBeNull();
    });

    it('escalates to CRITICAL only when the observation can carry the claim', () => {
      // 150 verified, 30 failed → 20% observed. Projected far over the 7.81%
      // threshold AND the 99% lower bound (12.4%) is above the declared 5%, so
      // this is no longer "a bad morning".
      const position = positionFor(SNAPSHOT, counters(20_000, 150, 30));

      expect(position.projectedBreach).toBe(true);
      expect(position.confidentlyAboveDeclared).toBe(true);
      expect(decideWarning(SNAPSHOT, position, null)).toBe(SlaWarningLevel.CRITICAL);
      expect(decideWarning(SNAPSHOT, position, SlaWarningLevel.WARNING)).toBe(
        SlaWarningLevel.CRITICAL,
      );
    });

    it('withholds CRITICAL when the projection is over but the interval is not', () => {
      // 20 verified, 3 failed → 15% observed, over the threshold, but with a
      // 99% lower bound of 2.7% — below the 5% declaration. A window this thin
      // gets the softer statement, not the one that implies a penalty.
      const position = positionFor(SNAPSHOT, counters(2_500, 20, 3));

      expect(position.projectedBreach).toBe(true);
      expect(position.confidentlyAboveDeclared).toBe(false);
      expect(position.confidenceInterval!.lower).toBeLessThan(0.05);
      expect(decideWarning(SNAPSHOT, position, null)).toBeNull(); // below the 100-call floor
    });

    it('never steps back down from CRITICAL to WARNING', () => {
      // A window that recovers must not tell the provider it is now merely
      // approaching a threshold it already blew past.
      const recovered = positionFor(SNAPSHOT, counters(30_000, 300, 14));

      expect(recovered.projectedBreach).toBe(false);
      expect(decideWarning(SNAPSHOT, recovered, SlaWarningLevel.CRITICAL)).toBeNull();
    });
  });

  /**
   * The window is immune to day and time-zone boundaries.
   *
   * This is the test the earlier fold could not have passed. It computed a
   * window as a UTC calendar day, so "which window is this call in" depended on
   * a boundary the traffic did not choose, and the day bucket was derived
   * through an expression whose result moved with the session time zone
   * (`AbstractEntity`'s class comment documents that exact defect class, and
   * `FRESHNESS` still has a live instance of it).
   *
   * A window keyed on its own `openedAt` and an elapsed-millisecond deadline has
   * no calendar in it at all, and these tests are what says so out loud.
   */
  describe('window boundaries are absolute, not calendar', () => {
    const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati'];

    function withTimeZone<T>(zone: string, run: () => T): T {
      const previous = process.env.TZ;
      process.env.TZ = zone;
      try {
        return run();
      } finally {
        process.env.TZ = previous;
      }
    }

    it('closes at the same instant in every time zone', () => {
      // Opened 22:30 UTC — the same wall clock is the previous day in Los
      // Angeles and the next day in Kiritimati, and 05:30 the next morning in
      // Kolkata. A calendar-day window would have put these calls in
      // three different buckets.
      const openedAt = new Date('2026-08-10T22:30:00.000Z');
      const oneSecondShort = openedAt.getTime() + SNAPSHOT.maxAgeMs - 1_000;
      const oneSecondPast = openedAt.getTime() + SNAPSHOT.maxAgeMs + 1_000;
      const thin = counters(120, 10, 1);

      for (const zone of ZONES) {
        withTimeZone(zone, () => {
          expect(shouldClose(SNAPSHOT, thin, openedAt, oneSecondShort)).toBe(false);
          expect(shouldClose(SNAPSHOT, thin, openedAt, oneSecondPast)).toBe(true);
        });
      }
    });

    it('is unmoved by a DST transition inside the window', () => {
      // 2026-11-01 is the US fall-back: America/Los_Angeles gains an hour, so
      // seven *calendar* days and seven × 24 hours are not the same span there.
      // The deadline is elapsed milliseconds, so it does not notice.
      const openedAt = new Date('2026-10-28T12:00:00.000Z');
      const deadline = openedAt.getTime() + SNAPSHOT.maxAgeMs;
      const thin = counters(120, 10, 1);

      for (const zone of ZONES) {
        withTimeZone(zone, () => {
          expect(shouldClose(SNAPSHOT, thin, openedAt, deadline - 1)).toBe(false);
          expect(shouldClose(SNAPSHOT, thin, openedAt, deadline)).toBe(true);
        });
      }
    });

    it('closes on the sample gate regardless of elapsed time or zone', () => {
      const openedAt = new Date('2026-08-10T22:30:00.000Z');
      const oneMinuteIn = openedAt.getTime() + 60_000;

      for (const zone of ZONES) {
        withTimeZone(zone, () => {
          expect(shouldClose(SNAPSHOT, counters(50_000, 399, 10), openedAt, oneMinuteIn)).toBe(
            false,
          );
          expect(shouldClose(SNAPSHOT, counters(50_000, 400, 10), openedAt, oneMinuteIn)).toBe(
            true,
          );
        });
      }
    });

    it('a window spanning a month boundary is one window, not two', () => {
      // The concrete regression: under the fold, 2026-08-31 and 2026-09-01 were
      // separate windows and each could be below the sample gate while their
      // union was not.
      const openedAt = new Date('2026-08-29T18:00:00.000Z');
      const acrossTheBoundary = new Date('2026-09-02T04:00:00.000Z').getTime();

      expect(shouldClose(SNAPSHOT, counters(300, 250, 12), openedAt, acrossTheBoundary)).toBe(
        false,
      );
    });
  });

  describe('closeOutcomeFor', () => {
    it('refuses to find a breach below the sample gate, however bad it looks', () => {
      // 399 verified, 399 failed — a 100% failure rate — is still
      // INSUFFICIENT_SAMPLE. The gate is absolute; the answer to a suspicious
      // thin window is more sampling, not a penalty on noise.
      expect(closeOutcomeFor(SNAPSHOT, counters(50_000, 399, 399))).toBe(
        SlaWindowOutcome.INSUFFICIENT_SAMPLE,
      );
    });

    it('is WITHIN_SLA for a clean window at the gate', () => {
      expect(closeOutcomeFor(SNAPSHOT, counters(50_000, 400, 0))).toBe(SlaWindowOutcome.WITHIN_SLA);
    });

    it('is WITHIN_SLA for an empty-but-large window rather than a divide by zero', () => {
      const empty: SlaWindowCounters = {
        totalCalls: 0,
        verifiedCalls: 0,
        failedCalls: 0,
        totalCallAmount: 0n,
      };
      const noGate: SlaWindowSnapshot = { ...SNAPSHOT, minVerifiedCalls: 0 };

      expect(closeOutcomeFor(noGate, empty)).toBe(SlaWindowOutcome.WITHIN_SLA);
    });
  });

  describe('countsTowardWindow — the denominator rule', () => {
    it('admits exactly PASS and FAIL, read off the verdict vocabulary', () => {
      const counted = Object.values(VerdictStatus).filter((status) =>
        countsTowardWindow(VERDICT_CONSEQUENCE[status].metric),
      );

      expect(counted.sort()).toEqual([VerdictStatus.FAIL, VerdictStatus.PASS].sort());
    });

    it('excludes the three verdicts that are not the provider fault', () => {
      // The earlier fold counted `verificationVerdict IS NOT NULL`, which swept
      // all three into the denominator and understated the failure rate by an
      // amount that moved with the sample rate.
      for (const status of [
        VerdictStatus.SKIPPED,
        VerdictStatus.MISAPPLIED,
        VerdictStatus.DEGRADED,
      ]) {
        expect(countsTowardWindow(VERDICT_CONSEQUENCE[status].metric)).toBe(false);
      }
    });

    it('excludes the empty-result verdicts, which measure coverage not quality', () => {
      for (const status of [VerdictStatus.EMPTY_CONFIRMED, VerdictStatus.EMPTY_UNVERIFIED]) {
        expect(countsTowardWindow(VERDICT_CONSEQUENCE[status].metric)).toBe(false);
      }
    });
  });

  describe('strikeArithmeticFor', () => {
    it('reproduces the accountability doc worked example end to end', () => {
      // 400 verified of 50,000 served at $0.001, 60 failed → 15% observed.
      const breached = counters(50_000, 400, 60);
      const strike = strikeArithmeticFor(SNAPSHOT, breached);

      expect(strike.observedRate).toBeCloseTo(0.15, 6);
      expect(strike.tolerance).toBeCloseTo(0.028, 3);
      expect(strike.effectiveThreshold).toBeCloseTo(0.078, 3);
      expect(strike.excessRate).toBeCloseTo(0.1, 6);
      expect(strike.estimatedBadCalls).toBeCloseTo(5_000, 6);
      expect(strike.averagePriceAmount).toBe(1_000n); // $0.001 in 6dp
      expect(strike.penaltyAmount).toBe(10_000_000n); // $10.00
    });

    it('measures the excess from the DECLARATION, not from the threshold', () => {
      const strike = strikeArithmeticFor(SNAPSHOT, counters(50_000, 400, 60));

      // Charging from the 7.81% threshold would give an excess of 7.19% and a
      // penalty of $7.19 — a provider who promised 5% paying as though they had
      // promised 7.81%.
      expect(strike.excessRate).toBeCloseTo(strike.observedRate - 0.05, 6);
      expect(strike.excessRate).not.toBeCloseTo(strike.observedRate - strike.effectiveThreshold, 4);
    });

    it('carries the derivation, in order, with the sample gate shown', () => {
      const strike = strikeArithmeticFor(SNAPSHOT, counters(50_000, 400, 60));
      const labels = strike.computation.map((step) => step.label);

      expect(labels).toEqual([
        'observed_rate',
        'tolerance',
        'effective_threshold',
        'sample_gate',
        'excess_rate',
        'estimated_bad_calls',
        'average_price',
        'penalty',
      ]);
      expect(strike.computation.find((step) => step.label === 'sample_gate')!.value).toBe('true');
      expect(strike.computation.find((step) => step.label === 'penalty')!.value).toBe('10000000');
    });

    it('does not divide by a sample rate anywhere', () => {
      // The 10× error in the superseded use-case reading. At a 0.8% sample rate
      // dividing again would produce $1,250.00 instead of $10.00.
      const strike = strikeArithmeticFor(SNAPSHOT, counters(50_000, 400, 60));

      expect(strike.penaltyAmount).toBe(10_000_000n);
      expect(strike.penaltyAmount).not.toBe(10_000_000n * 125n);
    });
  });
});
