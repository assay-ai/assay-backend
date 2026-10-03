import { Logger } from '@nestjs/common';

import { AlertSeverity, LoggingAlertSink } from '@shared/alerting';

/**
 * What on-call actually sees.
 *
 * The reconciler's whole value is that a breach is *loud and specific*, and
 * the last hop in that chain is this renderer. A sink that dropped `details`
 * would leave every alert saying "reserves breached" with no figure — which is
 * indistinguishable, at 3am, from having no alert at all.
 */
describe('LoggingAlertSink', () => {
  const lines: { level: string; message: string }[] = [];

  beforeEach(() => {
    lines.length = 0;
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: any) => lines.push({ level: 'error', message }));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: any) => lines.push({ level: 'warn', message }));
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: any) => lines.push({ level: 'log', message }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders a CRITICAL alert at error level with every figure inline', async () => {
    await new LoggingAlertSink().emit({
      severity: AlertSeverity.CRITICAL,
      name: 'reserves_breach',
      summary: 'PROOF OF RESERVES BREACH: vault holds 10.000000 but the ledger owes 12.500000',
      details: { vaultBalance: '10000000', totalLiabilities: '12500000', shortfall: '2500000' },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].message).toBe(
      '[CRITICAL] reserves_breach: PROOF OF RESERVES BREACH: vault holds 10.000000 but the ' +
        'ledger owes 12.500000 — vaultBalance=10000000 totalLiabilities=12500000 ' +
        'shortfall=2500000',
    );
  });

  it('routes a WARN to warn and an INFO to log', async () => {
    const sink = new LoggingAlertSink();
    await sink.emit({ severity: AlertSeverity.WARN, name: 'a', summary: 's', details: {} });
    await sink.emit({ severity: AlertSeverity.INFO, name: 'b', summary: 's', details: {} });

    expect(lines.map((line) => line.level)).toEqual(['warn', 'log']);
  });

  it('omits the separator when there are no figures', async () => {
    await new LoggingAlertSink().emit({
      severity: AlertSeverity.WARN,
      name: 'quiet',
      summary: 'nothing to add',
      details: {},
    });

    expect(lines[0].message).toBe('[WARN] quiet: nothing to add');
  });
});
