import { Alert, AlertPort, AlertSeverity, FanOutAlertSink } from '@shared/alerting';

/**
 * `FanOutAlertSink` — the compose-not-replace guarantee alerting needs.
 *
 * Adding `WebhookAlertSink` hinges on one property: adding an off-platform sink
 * must never cost the log sink an alert it already had. These tests assert
 * that property directly rather than trusting `AlertPort`'s "must not throw"
 * docstring — a fan-out that assumed every sink honoured its contract
 * perfectly would be exactly one buggy sink away from silently losing
 * everything behind it.
 */
describe('FanOutAlertSink', () => {
  class RecordingSink implements AlertPort {
    readonly received: Alert[] = [];
    async emit(alert: Alert): Promise<void> {
      this.received.push(alert);
    }
  }

  class ThrowingSink implements AlertPort {
    async emit(): Promise<void> {
      throw new Error('sink is down');
    }
  }

  const alert: Alert = {
    severity: AlertSeverity.WARN,
    name: 'gas_runway_low',
    summary: 'Gas runway is 5.0d',
    details: { chainId: 'solana:mainnet', days: 5 },
  };

  it('delivers the same alert to every composed sink', async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const fanOut = new FanOutAlertSink([a, b]);

    await fanOut.emit(alert);

    expect(a.received).toEqual([alert]);
    expect(b.received).toEqual([alert]);
  });

  it('still delivers to the other sinks when one throws, and never rejects itself', async () => {
    const good = new RecordingSink();
    const fanOut = new FanOutAlertSink([new ThrowingSink(), good]);

    await expect(fanOut.emit(alert)).resolves.toBeUndefined();
    expect(good.received).toEqual([alert]);
  });

  it('resolves even when every sink throws', async () => {
    const fanOut = new FanOutAlertSink([new ThrowingSink(), new ThrowingSink()]);

    await expect(fanOut.emit(alert)).resolves.toBeUndefined();
  });

  it('resolves with no sinks configured', async () => {
    const fanOut = new FanOutAlertSink([]);

    await expect(fanOut.emit(alert)).resolves.toBeUndefined();
  });
});
