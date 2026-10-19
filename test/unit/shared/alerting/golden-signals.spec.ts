import {
  AlertSeverity,
  GoldenSignal,
  evaluateGoldenSignal,
  evaluateReserveHealth,
} from '@shared/alerting';

/**
 * `evaluateGoldenSignal` / `evaluateReserveHealth` transcribe the golden-signal
 * thresholds into code. Every threshold here is a number from that table, exercised at and either side of
 * its boundary — the table uses strict inequalities ("Warn > 2%"), so the
 * boundary value itself must read healthy.
 */
describe('evaluateGoldenSignal', () => {
  it('FALSE_POSITIVE_RATE: warn > 2%, page > 5%, healthy at and below 2%', () => {
    expect(evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, 0.02)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, 0.01)).toBeNull();

    const warn = evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, 0.021);
    expect(warn?.severity).toBe(AlertSeverity.WARN);
    expect(warn?.name).toBe('verification_false_positive_rate_high');

    const critical = evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, 0.0501);
    expect(critical?.severity).toBe(AlertSeverity.CRITICAL);
  });

  it('FALSE_POSITIVE_RATE carries the caller-supplied context in details alongside the value', () => {
    const alert = evaluateGoldenSignal(GoldenSignal.FALSE_POSITIVE_RATE, 0.06, {
      sampleSize: 214,
      policyVersion: 3,
    });

    expect(alert?.details).toEqual({
      value: '6.00%',
      sampleSize: 214,
      policyVersion: 3,
    });
  });

  it('FALSE_NEGATIVE_RATE: warn > 5%, no page tier however extreme', () => {
    expect(evaluateGoldenSignal(GoldenSignal.FALSE_NEGATIVE_RATE, 0.05)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.FALSE_NEGATIVE_RATE, 0.06)?.severity).toBe(
      AlertSeverity.WARN,
    );
    expect(evaluateGoldenSignal(GoldenSignal.FALSE_NEGATIVE_RATE, 0.9)?.severity).toBe(
      AlertSeverity.WARN,
    );
  });

  it('GAS_RUNWAY_DAYS: warn < 7 days, page < 2 days (lower is worse)', () => {
    expect(evaluateGoldenSignal(GoldenSignal.GAS_RUNWAY_DAYS, 7)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.GAS_RUNWAY_DAYS, 6.9)?.severity).toBe(
      AlertSeverity.WARN,
    );
    // Exactly 2 days is not < 2, so it is still only a warn, not a page.
    expect(evaluateGoldenSignal(GoldenSignal.GAS_RUNWAY_DAYS, 2)?.severity).toBe(
      AlertSeverity.WARN,
    );
    expect(evaluateGoldenSignal(GoldenSignal.GAS_RUNWAY_DAYS, 1.9)?.severity).toBe(
      AlertSeverity.CRITICAL,
    );
  });

  it('TOOL_CALL_SUCCESS_RATE: warn < 97%', () => {
    expect(evaluateGoldenSignal(GoldenSignal.TOOL_CALL_SUCCESS_RATE, 0.97)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.TOOL_CALL_SUCCESS_RATE, 0.96)?.severity).toBe(
      AlertSeverity.WARN,
    );
  });

  it('PLATFORM_LATENCY_P95_MS: warn > 25ms', () => {
    expect(evaluateGoldenSignal(GoldenSignal.PLATFORM_LATENCY_P95_MS, 25)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.PLATFORM_LATENCY_P95_MS, 26)?.severity).toBe(
      AlertSeverity.WARN,
    );
  });

  it('SETTLEMENT_LAG_P95_MS: warn > 60s', () => {
    expect(evaluateGoldenSignal(GoldenSignal.SETTLEMENT_LAG_P95_MS, 60_000)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.SETTLEMENT_LAG_P95_MS, 60_001)?.severity).toBe(
      AlertSeverity.WARN,
    );
  });

  it('PAYOUT_LAG_P95_MS: warn > 2h', () => {
    const twoHoursMs = 2 * 60 * 60 * 1000;
    expect(evaluateGoldenSignal(GoldenSignal.PAYOUT_LAG_P95_MS, twoHoursMs)).toBeNull();
    expect(evaluateGoldenSignal(GoldenSignal.PAYOUT_LAG_P95_MS, twoHoursMs + 1)?.severity).toBe(
      AlertSeverity.WARN,
    );
  });

  it('OPEN_HOLD_AGE_MS: page > 1h, no warn tier in the doc so nothing pages early', () => {
    const oneHourMs = 60 * 60 * 1000;
    expect(evaluateGoldenSignal(GoldenSignal.OPEN_HOLD_AGE_MS, oneHourMs)).toBeNull();
    // Well inside "not yet an hour" territory — still healthy, because the
    // table gives this signal no warn threshold at all.
    expect(evaluateGoldenSignal(GoldenSignal.OPEN_HOLD_AGE_MS, oneHourMs - 1)).toBeNull();

    const alert = evaluateGoldenSignal(GoldenSignal.OPEN_HOLD_AGE_MS, oneHourMs + 1);
    expect(alert?.severity).toBe(AlertSeverity.CRITICAL);
    expect(alert?.name).toBe('open_hold_age_critical');
  });
});

describe('evaluateReserveHealth', () => {
  it('is healthy at exactly zero and at any positive surplus', () => {
    expect(evaluateReserveHealth(0n)).toBeNull();
    expect(evaluateReserveHealth(1_000_000n)).toBeNull();
  });

  it('pages unconditionally — the only unconditional page in the table — on any deficit', () => {
    const alert = evaluateReserveHealth(-1n);
    expect(alert?.severity).toBe(AlertSeverity.CRITICAL);
    expect(alert?.name).toBe('reserve_health_breach');
  });

  it('keeps full precision on a deficit too large for a float, via bigint', () => {
    const hugeDeficit = -123_456_789_012_345_678_901_234n;
    const alert = evaluateReserveHealth(hugeDeficit);

    expect(alert?.details.surplusAtomic).toBe('-123456789012345678901234');
  });

  it('carries caller-supplied context (e.g. assetId) into details', () => {
    const alert = evaluateReserveHealth(-500n, { assetId: 'usdc' });

    expect(alert?.details).toEqual({ surplusAtomic: '-500', assetId: 'usdc' });
  });
});
