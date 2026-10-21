import {
  MetricsSnapshotDto,
  SignalReadingDto,
} from '@modules/observability/dto/metrics-snapshot.dto';
import { renderDashboardHtml } from '@modules/observability/services/dashboard-html.renderer';

function snapshot(signals: Partial<SignalReadingDto>[]): MetricsSnapshotDto {
  return {
    generatedAt: '2026-10-21T00:00:00.000Z',
    cacheTtlMs: 0,
    reconciliation: [],
    failRateByPolicy: [],
    signals: signals.map((s) => ({
      signal: 'OPEN_HOLD_AGE',
      label: 'Oldest open hold',
      section: 'money',
      availability: 'SOURCED',
      value: null,
      unit: 'seconds',
      gate: null,
      reason: null,
      ...s,
    })),
  } as unknown as MetricsSnapshotDto;
}

describe('renderDashboardHtml: duration readings (BUG-OPS-CORE-05)', () => {
  it.each([
    [85.682, '1 min 25 s'],
    [66913.636, '18 h 35 min'],
  ])('shows %s seconds as a whole duration', (value, text) => {
    const html = renderDashboardHtml(snapshot([{ value }]), 'op');
    expect(html).toContain(text);
    expect(html).not.toMatch(/\d\.\d{3} <span class="reason">seconds/);
  });
});
