import { ReconciliationSeverity } from '@modules/settlement/ports/reconciliation.types';

/**
 * `ReconciliationSeverity` as a Prometheus gauge value.
 *
 * A gauge is a number, and Grafana/Prometheus alerting reads a numeric
 * series far more easily than a string label switch — `x402_reconciliation_severity
 * > 1` is one alert rule for "critical on any asset," where a label match has
 * to be re-written every time an asset is added. `0/1/2` is ordered the same
 * way the severity words are ordered: worse is higher, matching `worstOf` in
 * `ReconciliationService`.
 */
export function reconciliationSeverityToNumber(severity: string): number {
  switch (severity) {
    case ReconciliationSeverity.CRITICAL:
      return 2;
    case ReconciliationSeverity.WARN:
      return 1;
    case ReconciliationSeverity.OK:
      return 0;
    default:
      // A severity value this table has never seen is not "healthy" by
      // default — treat it the same as CRITICAL so a schema change on the
      // write side cannot silently green-wash the dashboard.
      return 2;
  }
}
