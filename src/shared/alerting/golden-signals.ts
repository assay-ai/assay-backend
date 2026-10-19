import { Alert, AlertSeverity } from './alert.port';

/**
 * The golden signals, as an identifier `AlertPort` consumers key routing off
 * (`Alert.name` itself, per that port's contract, must not carry per-occurrence values —
 * this is the identity, `evaluateGoldenSignal`'s `context` carries the rest).
 *
 * `RESERVE_HEALTH` is deliberately absent: its value is atomic money
 * (`bigint`), never a `number`, so it has its own evaluator,
 * {@link evaluateReserveHealth}, rather than being forced through the
 * fraction/duration table below.
 */
export enum GoldenSignal {
  FALSE_POSITIVE_RATE = 'FALSE_POSITIVE_RATE',
  FALSE_NEGATIVE_RATE = 'FALSE_NEGATIVE_RATE',
  GAS_RUNWAY_DAYS = 'GAS_RUNWAY_DAYS',
  TOOL_CALL_SUCCESS_RATE = 'TOOL_CALL_SUCCESS_RATE',
  PLATFORM_LATENCY_P95_MS = 'PLATFORM_LATENCY_P95_MS',
  SETTLEMENT_LAG_P95_MS = 'SETTLEMENT_LAG_P95_MS',
  PAYOUT_LAG_P95_MS = 'PAYOUT_LAG_P95_MS',
  OPEN_HOLD_AGE_MS = 'OPEN_HOLD_AGE_MS',
}

/** Extra figures a caller has on hand — `chainId`, `toolId`, the sample size. */
export type GoldenSignalContext = Readonly<Record<string, string | number>>;

interface ThresholdRule {
  /** `Alert.name` — stable, greppable, routes without carrying the number. */
  readonly alertName: string;
  /** Human label for the summary sentence. */
  readonly label: string;
  /** Whether a *higher* or a *lower* reading is the unhealthy direction. */
  readonly worseWhen: 'above' | 'below';
  readonly warn?: number;
  readonly critical?: number;
  readonly formatValue: (value: number) => string;
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const days = (value: number): string => `${value.toFixed(1)}d`;
const ms = (value: number): string => `${value}ms`;

/**
 * Every golden-signal threshold — do not "round" or "simplify" a number here;
 * each one is a deliberate operating threshold.
 */
const RULES: Readonly<Record<GoldenSignal, ThresholdRule>> = {
  /**
   * Warn > 2%, page > 5% — measured against a **manually labelled sample** of
   * FAIL verdicts, drawn daily.
   *
   * This evaluator does not compute the rate; it only classifies a `value` the
   * caller already measured. That is deliberate: the point is that `overturned
   * / total verdicts` (a dispute-derived proxy) makes the threshold unreachable
   * at 150M calls/month, so the one number this rule may ever see is one that
   * came from a labelled sample. No such producer exists in this codebase yet —
   * so nothing calls this with `FALSE_POSITIVE_RATE`. **Never wire a
   * dispute-overturn number into this signal** to make it "have a caller"
   * sooner; that is the exact substitution to avoid.
   */
  [GoldenSignal.FALSE_POSITIVE_RATE]: {
    alertName: 'verification_false_positive_rate_high',
    label: 'Verification false-positive rate',
    worseWhen: 'above',
    warn: 0.02,
    critical: 0.05,
    formatValue: percent,
  },
  /** Warn > 5%, no page tier. */
  [GoldenSignal.FALSE_NEGATIVE_RATE]: {
    alertName: 'verification_false_negative_rate_high',
    label: 'Verification false-negative rate',
    worseWhen: 'above',
    warn: 0.05,
    formatValue: percent,
  },
  /** Warn < 7 days, page < 2 days. Auto-refill (14d) is a separate, non-alerting action. */
  [GoldenSignal.GAS_RUNWAY_DAYS]: {
    alertName: 'gas_runway_low',
    label: 'Gas runway',
    worseWhen: 'below',
    warn: 7,
    critical: 2,
    formatValue: days,
  },
  /** Warn < 97%, no page tier. */
  [GoldenSignal.TOOL_CALL_SUCCESS_RATE]: {
    alertName: 'tool_call_success_rate_low',
    label: 'Tool-call success rate',
    worseWhen: 'below',
    warn: 0.97,
    formatValue: percent,
  },
  /** Warn > 25ms. Platform-added time only — never provider latency. */
  [GoldenSignal.PLATFORM_LATENCY_P95_MS]: {
    alertName: 'platform_latency_p95_high',
    label: 'Platform latency (p95)',
    worseWhen: 'above',
    warn: 25,
    formatValue: ms,
  },
  /** Warn > 60s, expressed in ms for the same unit as the other durations here. */
  [GoldenSignal.SETTLEMENT_LAG_P95_MS]: {
    alertName: 'settlement_lag_p95_high',
    label: 'Settlement lag (p95)',
    worseWhen: 'above',
    warn: 60_000,
    formatValue: ms,
  },
  /** Warn > 2h. */
  [GoldenSignal.PAYOUT_LAG_P95_MS]: {
    alertName: 'payout_lag_p95_high',
    label: 'Payout lag (p95)',
    worseWhen: 'above',
    warn: 2 * 60 * 60 * 1000,
    formatValue: ms,
  },
  /**
   * Page > 1h — no warn tier. An open hold is money already taken
   * from an agent and not yet resolved either way; "still open
   * after an hour" is page-worthy on its own, not as an escalation of a
   * warning.
   */
  [GoldenSignal.OPEN_HOLD_AGE_MS]: {
    alertName: 'open_hold_age_critical',
    label: 'Oldest open hold',
    worseWhen: 'above',
    critical: 60 * 60 * 1000,
    formatValue: ms,
  },
};

/**
 * Turn one measured value into an {@link Alert} at the threshold's severity,
 * or `null` when the value is inside its healthy range.
 *
 * Pure and synchronous on purpose: it has no caller yet for most of these
 * signals (see the class comments on {@link GoldenSignal.FALSE_POSITIVE_RATE}
 * and the reconciler's own hand-rolled path for `RESERVE_HEALTH`, which this
 * function does not cover — see {@link evaluateReserveHealth}), and the
 * seam a future producer needs is "I have a number, give me an alert or
 * nothing," not a service with dependencies of its own.
 */
export function evaluateGoldenSignal(
  signal: GoldenSignal,
  value: number,
  context: GoldenSignalContext = {},
): Alert | null {
  const rule = RULES[signal];
  const severity = severityFor(rule, value);
  if (severity === null) {
    return null;
  }

  return {
    severity,
    name: rule.alertName,
    summary: `${rule.label} is ${rule.formatValue(value)} (${severity.toLowerCase()} threshold ${
      rule.worseWhen === 'above' ? '>' : '<'
    } ${rule.formatValue(thresholdFor(rule, severity))})`,
    details: { value: rule.formatValue(value), ...context },
  };
}

function severityFor(rule: ThresholdRule, value: number): AlertSeverity | null {
  if (rule.critical !== undefined && breaches(rule.worseWhen, value, rule.critical)) {
    return AlertSeverity.CRITICAL;
  }
  if (rule.warn !== undefined && breaches(rule.worseWhen, value, rule.warn)) {
    return AlertSeverity.WARN;
  }
  return null;
}

function breaches(worseWhen: 'above' | 'below', value: number, threshold: number): boolean {
  return worseWhen === 'above' ? value > threshold : value < threshold;
}

function thresholdFor(rule: ThresholdRule, severity: AlertSeverity): number {
  // Non-null by construction: `severityFor` only returns a severity whose
  // threshold field produced the breach.
  return (severity === AlertSeverity.CRITICAL ? rule.critical : rule.warn) as number;
}

/**
 * **Page immediately if < 0** —
 * the only unconditional page in the table, and the only signal whose value
 * is money. Kept separate from {@link evaluateGoldenSignal} so this can never
 * be called with a `number` that already lost precision to a float.
 *
 * `src/modules/settlement/services/reconciliation.service.ts` computes and
 * alerts on this condition itself today (`raise()`, one alert per finding) —
 * this function does not replace that path and is not currently called by
 * it. It exists so a future caller — a read-only dashboard tile, a second
 * reconciliation consumer — can classify a surplus the same way without
 * re-deriving the "< 0 pages" rule.
 */
export function evaluateReserveHealth(
  surplusAtomic: bigint,
  context: GoldenSignalContext = {},
): Alert | null {
  if (surplusAtomic >= 0n) {
    return null;
  }

  return {
    severity: AlertSeverity.CRITICAL,
    name: 'reserve_health_breach',
    summary: `Reserve health breached: vault surplus is ${surplusAtomic.toString()} (atomic units) below zero`,
    details: { surplusAtomic: surplusAtomic.toString(), ...context },
  };
}
