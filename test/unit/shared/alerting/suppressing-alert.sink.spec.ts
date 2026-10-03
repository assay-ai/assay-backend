import type { Redis } from 'ioredis';

import { Alert, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import {
  ALERT_INCIDENT_WINDOW_SECONDS,
  ALERT_SUPPRESSION_KEY_PREFIX,
  SuppressingAlertSink,
} from '@shared/alerting/suppressing-alert.sink';

import { FakeRedis } from '../../notification/helpers/fake-redis';

/**
 * The fix for repeated Telegram paging: an `ONCE_PER_INCIDENT` alert whose
 * condition is still true on the next pass must reach the downstream sink
 * (Telegram/webhook) once, not once per pass. `PER_EVENT` — the default when
 * `aggregation` is omitted — must behave exactly as `FanOutAlertSink` always
 * has: every call forwarded, no suppression.
 */
describe('SuppressingAlertSink', () => {
  class RecordingSink implements AlertPort {
    readonly received: Alert[] = [];
    async emit(alert: Alert): Promise<void> {
      this.received.push(alert);
    }
  }

  let redis: FakeRedis;
  let downstream: RecordingSink;
  let sink: SuppressingAlertSink;

  beforeEach(() => {
    redis = new FakeRedis();
    downstream = new RecordingSink();
    sink = new SuppressingAlertSink(downstream, redis as unknown as Redis);
  });

  function alert(overrides: Partial<Alert> = {}): Alert {
    return {
      severity: AlertSeverity.WARN,
      name: 'provider_stake_headroom_low',
      summary: 'Binding b-1 is within 10% of its stake floor',
      details: { bindingId: 'b-1' },
      ...overrides,
    };
  }

  it('forwards every call when aggregation is omitted (PER_EVENT)', async () => {
    await sink.emit(alert());
    await sink.emit(alert());

    expect(downstream.received).toHaveLength(2);
  });

  it('forwards the first ONCE_PER_INCIDENT call and suppresses the repeat', async () => {
    const a = alert({ aggregation: AlertAggregation.ONCE_PER_INCIDENT, dedupeKey: 'b-1' });

    await sink.emit(a);
    await sink.emit(a);

    expect(downstream.received).toEqual([a]);
  });

  it('keeps ONCE_PER_INCIDENT alerts with different dedupeKeys independent', async () => {
    const first = alert({ aggregation: AlertAggregation.ONCE_PER_INCIDENT, dedupeKey: 'b-1' });
    const second = alert({ aggregation: AlertAggregation.ONCE_PER_INCIDENT, dedupeKey: 'b-2' });

    await sink.emit(first);
    await sink.emit(second);

    expect(downstream.received).toEqual([first, second]);
  });

  it('keys on name as well as dedupeKey, so two alert kinds sharing a dedupeKey do not collide', async () => {
    const first = alert({
      name: 'provider_stake_headroom_low',
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: 'b-1',
    });
    const second = alert({
      name: 'provider_stake_grace_expired',
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: 'b-1',
    });

    await sink.emit(first);
    await sink.emit(second);

    expect(downstream.received).toEqual([first, second]);
  });

  it('claims the default one-hour window when no override is given', async () => {
    await sink.emit(alert({ aggregation: AlertAggregation.ONCE_PER_INCIDENT, dedupeKey: 'b-1' }));

    expect(redis.ttls.get(`${ALERT_SUPPRESSION_KEY_PREFIX}provider_stake_headroom_low:b-1`)).toBe(
      ALERT_INCIDENT_WINDOW_SECONDS,
    );
  });

  it('honours a per-alert window, so a standing condition can page daily instead of hourly', async () => {
    const daily = 24 * 60 * 60;

    await sink.emit(
      alert({
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: 'b-1',
        suppressionWindowSeconds: daily,
      }),
    );

    expect(redis.ttls.get(`${ALERT_SUPPRESSION_KEY_PREFIX}provider_stake_headroom_low:b-1`)).toBe(
      daily,
    );
  });

  it('ignores a window that is not a positive whole number of seconds', async () => {
    // Redis refuses `EX 0` and `EX -1` outright; a bad config value must
    // degrade to the default window, not make every alert throw.
    for (const bad of [0, -60, 1.5, Number.NaN]) {
      redis.flush();
      await sink.emit(
        alert({
          aggregation: AlertAggregation.ONCE_PER_INCIDENT,
          dedupeKey: 'b-1',
          suppressionWindowSeconds: bad,
        }),
      );

      expect(redis.ttls.get(`${ALERT_SUPPRESSION_KEY_PREFIX}provider_stake_headroom_low:b-1`)).toBe(
        ALERT_INCIDENT_WINDOW_SECONDS,
      );
    }
  });

  it('fails open and forwards when the suppression store is unreachable', async () => {
    redis.down = true;
    const a = alert({ aggregation: AlertAggregation.ONCE_PER_INCIDENT, dedupeKey: 'b-1' });

    await sink.emit(a);
    await sink.emit(a);

    expect(downstream.received).toEqual([a, a]);
  });
});
