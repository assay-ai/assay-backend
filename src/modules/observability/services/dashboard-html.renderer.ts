import { MetricsSnapshotDto, SignalReadingDto } from '../dto/metrics-snapshot.dto';
import { SignalAvailability } from '../domain/signal-catalog';

/**
 * `GET /operator/dashboard` — a static, server-rendered HTML string.
 *
 * **No `<script>`, no external stylesheet, no external font, no image.**
 * Every value is interpolated once, server-side, into inline-styled markup;
 * refreshing the page is the only way to see a new number, which is correct
 * for a page whose stated purpose is to be opened
 * once and screenshotted. A page with a `fetch()` polling loop would violate
 * "no external network requests" the moment it is opened somewhere the
 * backend is not reachable, which is exactly the situation a screenshot tool
 * is in.
 *
 * Every string interpolated from data (asset ids, policy ids, gate
 * summaries) goes through {@link escapeHtml} — none of it is a literal this
 * file wrote, all of it came out of the database or `@shared/alerting`.
 */
export function renderDashboardHtml(
  snapshot: MetricsSnapshotDto,
  operatorDisplayName: string,
): string {
  const money = snapshot.signals.filter((s) => s.section === 'money');
  const traffic = snapshot.signals.filter((s) => s.section === 'traffic');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Assay — Operator Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0; padding: 32px; background: #0b0d12; color: #e6e9ef;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #9aa4b2; font-size: 13px; margin-bottom: 28px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa4b2;
       border-bottom: 1px solid #262b36; padding-bottom: 8px; margin: 28px 0 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { text-align: left; padding: 8px 10px; font-size: 13px; border-bottom: 1px solid #1c2029; }
  th { color: #7d8798; font-weight: 500; }
  td.value { font-variant-numeric: tabular-nums; font-size: 15px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-ok { background: #113b24; color: #4ade80; }
  .badge-warn { background: #423311; color: #facc15; }
  .badge-critical { background: #401616; color: #f87171; }
  .badge-absent { background: #1c2029; color: #7d8798; }
  .reason { color: #7d8798; font-size: 12px; margin-top: 2px; }
  .gate { font-size: 12px; margin-top: 2px; }
  footer { margin-top: 32px; color: #5c6472; font-size: 12px; }
</style>
</head>
<body>
  <h1>Assay — Operator Dashboard</h1>
  <div class="meta">
    Generated ${escapeHtml(snapshot.generatedAt)} · cached ${snapshot.cacheTtlMs / 1000}s ·
    viewing as ${escapeHtml(operatorDisplayName)}
  </div>

  <h2>Money</h2>
  <table>
    <thead><tr><th>Signal</th><th>Value</th><th>Gate</th></tr></thead>
    <tbody>
      ${snapshot.reconciliation.map(reconciliationRow).join('\n')}
      ${money.map(signalRow).join('\n')}
    </tbody>
  </table>

  <h2>Traffic</h2>
  <table>
    <thead><tr><th>Signal</th><th>Value</th><th>Gate</th></tr></thead>
    <tbody>
      ${traffic.map(signalRow).join('\n')}
    </tbody>
  </table>

  <h2>FAIL rate by policy</h2>
  <table>
    <thead><tr><th>Policy</th><th>Version</th><th>Verdicts (1h)</th><th>FAIL rate</th></tr></thead>
    <tbody>
      ${
        snapshot.failRateByPolicy.length === 0
          ? '<tr><td colspan="4" class="reason">No verdicts in the trailing hour.</td></tr>'
          : snapshot.failRateByPolicy
              .map(
                (row) => `<tr>
        <td>${escapeHtml(row.policyId)}</td>
        <td>${row.policyVersion}</td>
        <td class="value">${row.total}</td>
        <td class="value">${(row.failRate * 100).toFixed(1)}%</td>
      </tr>`,
              )
              .join('\n')
      }
    </tbody>
  </table>

  <footer>
    Money and Traffic are the two dashboards served here. Quality, Providers, and both
    self-serve dashboards are not built yet. A "no data source" badge
    means this codebase has no table or in-process counter for that signal today, not that the value
    is zero.
  </footer>
</body>
</html>`;
}

function reconciliationRow(row: MetricsSnapshotDto['reconciliation'][number]): string {
  const value =
    row.differenceDisplay === null
      ? '<span class="badge badge-absent">read failed</span>'
      : `${row.differenceDisplay.toLocaleString(undefined, { maximumFractionDigits: 6 })} <span class="reason">(${Math.round(row.ageSeconds)}s ago)</span>`;

  // The asset belongs in the LABEL, not in the value. There is one of these
  // rows per asset, and when the vault read fails the value collapses to a
  // badge — which is exactly when an on-call reader most needs to know which
  // asset failed. Two identically-labelled "read failed" rows is what this
  // looked like before, on the one dashboard whose job is to say where the
  // money is.
  return `<tr>
    <td>Reserve health (vault − liabilities)<div class="reason">${escapeHtml(row.asset)}</div></td>
    <td class="value">${value}</td>
    <td>${gateCell(row.gate)}</td>
  </tr>`;
}

function signalRow(signal: SignalReadingDto): string {
  const value =
    signal.availability !== SignalAvailability.SOURCED || signal.value === null
      ? `<span class="badge badge-absent">no data source</span>`
      : `${formatValue(signal.value, signal.unit)} <span class="reason">${escapeHtml(signal.unit)}</span>`;

  const extra =
    signal.extra && Object.keys(signal.extra).length > 0
      ? `<div class="reason">${Object.entries(signal.extra)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${escapeHtml(k)}: ${v}`)
          .join(', ')}</div>`
      : '';

  const reason = signal.reason ? `<div class="reason">${escapeHtml(signal.reason)}</div>` : '';

  return `<tr>
    <td>${escapeHtml(signal.label)}${reason}</td>
    <td class="value">${value}${extra}</td>
    <td>${gateCell(signal.gate)}</td>
  </tr>`;
}

function gateCell(gate: MetricsSnapshotDto['reconciliation'][number]['gate']): string {
  if (!gate) return '<span class="reason">no threshold</span>';
  const cls =
    gate.status === 'CRITICAL'
      ? 'badge-critical'
      : gate.status === 'WARN'
        ? 'badge-warn'
        : 'badge-ok';
  return `<span class="badge ${cls}">${gate.status}</span><div class="gate reason">${escapeHtml(gate.summary)}</div>`;
}

function formatValue(value: number, unit: string): string {
  if (unit === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
