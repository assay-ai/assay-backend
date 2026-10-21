import type { Redis } from 'ioredis';

import { NotificationChannelRepository } from '@database/postgres/repositories/notification-channel.repository';
import { NotificationDeliveryRepository } from '@database/postgres/repositories/notification-delivery.repository';
import { NotificationPreferenceRepository } from '@database/postgres/repositories/notification-preference.repository';
import { NotificationRepository } from '@database/postgres/repositories/notification.repository';
import { NotificationDeliverPublisher } from '@modules/notification/publishers/notification-deliver.publisher';
import {
  NotificationChannel,
  NotificationEvent,
  NotificationRequest,
} from '@modules/notification/ports/notification.port';
import { NotificationService } from '@modules/notification/services/notification.service';

import { FakeRedis } from './helpers/fake-redis';

/**
 * `NotificationService.notify`'s aggregation, fan-out and
 * "never throws" contract.
 *
 * Every real behaviour is driven off `NOTIFICATION_CATALOGUE` — this suite
 * picks one representative event per aggregation rule rather than
 * re-implementing the catalogue's own table, exactly as
 * `binding-ceiling.spec.ts` picks representative bindings rather than
 * enumerating every ceiling combination.
 */

let redis: FakeRedis;
let notifications: { insert: jest.Mock };
let channels: { findForOrganization: jest.Mock };
let preferences: { findForEvent: jest.Mock };
let deliveries: { insert: jest.Mock };
let publisher: { publishDeliver: jest.Mock };
let service: NotificationService;

const ORG = 'org-1';

function build(): void {
  redis = new FakeRedis();
  notifications = { insert: jest.fn().mockResolvedValue(undefined) };
  channels = { findForOrganization: jest.fn().mockResolvedValue([]) };
  preferences = { findForEvent: jest.fn().mockResolvedValue([]) };
  deliveries = { insert: jest.fn().mockResolvedValue(undefined) };
  publisher = { publishDeliver: jest.fn().mockResolvedValue(undefined) };

  service = new NotificationService(
    notifications as unknown as NotificationRepository,
    channels as unknown as NotificationChannelRepository,
    preferences as unknown as NotificationPreferenceRepository,
    deliveries as unknown as NotificationDeliveryRepository,
    publisher as unknown as NotificationDeliverPublisher,
    redis as unknown as Redis,
  );
}

function request(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    organizationId: ORG,
    event: NotificationEvent.DEPOSIT_CREDITED,
    title: 'Deposit credited',
    body: 'Your deposit landed.',
    ...overrides,
  };
}

beforeEach(() => {
  build();
});

describe('NotificationService — aggregation rules', () => {
  it('PER_EVENT never suppresses', async () => {
    // DEPOSIT_CREDITED is PER_EVENT in the catalogue.
    await service.notify(request({ dedupeKey: 'dep-1' }));
    await service.notify(request({ dedupeKey: 'dep-1' }));

    expect(notifications.insert).toHaveBeenCalledTimes(2);
  });

  it('ONCE suppresses the second call and lets the first through', async () => {
    // SESSION_EXPIRING is ONCE in the catalogue.
    const req = request({
      event: NotificationEvent.SESSION_EXPIRING,
      dedupeKey: 'cred-1:T-7',
    });

    await service.notify(req);
    const second = await service.notify(req);

    expect(notifications.insert).toHaveBeenCalledTimes(1);
    // An outcome, not `undefined` — callers read `deliveredNow` off it.
    expect(second).toEqual({ deliveredNow: false });
  });

  it('ONCE: a failed write releases the claim, so the next call sends it (not lost for the window)', async () => {
    const req = request({ event: NotificationEvent.SESSION_EXPIRING, dedupeKey: 'cred-1:T-7' });
    notifications.insert.mockRejectedValueOnce(new Error('db blip'));

    const failed = await service.notify(req);
    const retried = await service.notify(req);
    const third = await service.notify(req);

    expect(failed).toEqual({ deliveredNow: false, recorded: false });
    expect(retried.recorded).toBe(true);
    expect(notifications.insert).toHaveBeenCalledTimes(2);
    expect(third).toEqual({ deliveredNow: false });
  });

  it('a failure after the row is written keeps the claim (no duplicate row)', async () => {
    const req = request({ event: NotificationEvent.SESSION_EXPIRING, dedupeKey: 'cred-1:T-7' });
    deliveries.insert.mockRejectedValueOnce(new Error('db blip'));

    expect(await service.notify(req)).toEqual({ deliveredNow: false, recorded: true });
    await service.notify(req);

    expect(notifications.insert).toHaveBeenCalledTimes(1);
  });

  it('ONCE treats a different dedupeKey as a different window', async () => {
    await service.notify(
      request({ event: NotificationEvent.SESSION_EXPIRING, dedupeKey: 'cred-1:T-7' }),
    );
    await service.notify(
      request({ event: NotificationEvent.SESSION_EXPIRING, dedupeKey: 'cred-1:T-1' }),
    );

    expect(notifications.insert).toHaveBeenCalledTimes(2);
  });

  it('call_dispute.decided goes out once per side, however often it is announced (BUG-RETEST-R5a-01)', async () => {
    const decided = (organizationId: string, role: string) =>
      request({
        organizationId,
        event: NotificationEvent.CALL_DISPUTE_DECIDED,
        dedupeKey: `${NotificationEvent.CALL_DISPUTE_DECIDED}:dispute-1:${organizationId}:${role}`,
      });

    // At the decision, then again when the refund lands.
    for (let i = 0; i < 2; i += 1) {
      await service.notify(decided('buyer-org', 'buyer'));
      await service.notify(decided('provider-org', 'provider'));
    }

    expect(notifications.insert).toHaveBeenCalledTimes(2);
    expect(notifications.insert.mock.calls.map(([row]) => row.organizationId)).toEqual([
      'buyer-org',
      'provider-org',
    ]);
  });

  it('call_dispute.refunded stays once per dispute', async () => {
    const refunded = request({
      organizationId: 'buyer-org',
      event: NotificationEvent.CALL_DISPUTE_REFUNDED,
      dedupeKey: `${NotificationEvent.CALL_DISPUTE_REFUNDED}:dispute-1`,
    });
    await service.notify(refunded);
    await service.notify(refunded);
    expect(notifications.insert).toHaveBeenCalledTimes(1);
  });

  it('ONCE_PER_UTC_DAY suppresses a second call the same day', async () => {
    // BALANCE_ZERO is ONCE_PER_UTC_DAY in the catalogue.
    const req = request({ event: NotificationEvent.BALANCE_ZERO, dedupeKey: 'acct-1' });

    await service.notify(req);
    await service.notify(req);

    expect(notifications.insert).toHaveBeenCalledTimes(1);
  });

  it('ONCE_PER_INCIDENT suppresses a second call inside the incident window', async () => {
    // VELOCITY_ANOMALY is ONCE_PER_INCIDENT in the catalogue.
    const req = request({ event: NotificationEvent.VELOCITY_ANOMALY, dedupeKey: 'agent-1' });

    await service.notify(req);
    await service.notify(req);

    expect(notifications.insert).toHaveBeenCalledTimes(1);
  });

  it('DIGEST_ONLY writes nothing', async () => {
    // PAYMENT_INTENT_REFUNDED is DIGEST_ONLY in the catalogue.
    await service.notify(request({ event: NotificationEvent.PAYMENT_INTENT_REFUNDED }));

    expect(notifications.insert).not.toHaveBeenCalled();
    expect(deliveries.insert).not.toHaveBeenCalled();
  });
});

describe('NotificationService — fan-out', () => {
  it('a nonSuppressible event ignores a disabling preference row', async () => {
    // WITHDRAWAL_INITIATED is nonSuppressible, channels IN_APP + EMAIL.
    preferences.findForEvent.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: false },
    ]);
    channels.findForOrganization.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: true, destination: 'buyer@example.com' },
    ]);

    await service.notify(
      request({ event: NotificationEvent.WITHDRAWAL_INITIATED, dedupeKey: 'w-1' }),
    );

    const rows = deliveries.insert.mock.calls[0][0] as Array<{
      channel: NotificationChannel;
      status: string;
    }>;
    const email = rows.find((row) => row.channel === NotificationChannel.EMAIL);
    expect(email?.status).toBe('PENDING');
  });

  it('a suppressible event honours a disabling preference row', async () => {
    // BALANCE_LOW is not nonSuppressible, channels include EMAIL.
    preferences.findForEvent.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: false },
    ]);
    channels.findForOrganization.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: true, destination: 'buyer@example.com' },
    ]);

    await service.notify(request({ event: NotificationEvent.BALANCE_LOW, dedupeKey: 'acct-1' }));

    const rows = deliveries.insert.mock.calls[0][0] as Array<{
      channel: NotificationChannel;
      status: string;
    }>;
    const email = rows.find((row) => row.channel === NotificationChannel.EMAIL);
    expect(email?.status).toBe('SUPPRESSED');
  });

  it('a missing destination produces SUPPRESSED, not FAILED', async () => {
    // No channel row configured at all — EMAIL has nowhere to go.
    channels.findForOrganization.mockResolvedValue([]);

    await service.notify(request({ event: NotificationEvent.DEPOSIT_CREDITED }));

    const rows = deliveries.insert.mock.calls[0][0] as Array<{
      channel: NotificationChannel;
      status: string;
    }>;
    const email = rows.find((row) => row.channel === NotificationChannel.EMAIL);
    expect(email?.status).toBe('SUPPRESSED');
    expect(rows.every((row) => row.status !== 'FAILED')).toBe(true);
  });

  it('IN_APP is always DELIVERED regardless of preferences or channel rows', async () => {
    preferences.findForEvent.mockResolvedValue([
      { channel: NotificationChannel.IN_APP, enabled: false },
    ]);

    await service.notify(request({ event: NotificationEvent.DEPOSIT_CREDITED }));

    const rows = deliveries.insert.mock.calls[0][0] as Array<{
      channel: NotificationChannel;
      status: string;
    }>;
    const inApp = rows.find((row) => row.channel === NotificationChannel.IN_APP);
    expect(inApp?.status).toBe('DELIVERED');
  });

  it('enqueues delivery only for PENDING, non-IN_APP channels', async () => {
    channels.findForOrganization.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, enabled: true, destination: 'buyer@example.com' },
    ]);

    await service.notify(request({ event: NotificationEvent.DEPOSIT_CREDITED }));

    expect(publisher.publishDeliver).toHaveBeenCalledTimes(1);
    const [job] = publisher.publishDeliver.mock.calls[0];
    expect(job.channel).toBe(NotificationChannel.EMAIL);
  });
});

describe('NotificationService — never throws', () => {
  /**
   * And reports nothing delivered. A caller that starts a clock on
   * delivery must not start one for a notification that was never written — a
   * swallowed failure that claimed delivery would begin a provider's response
   * window against a message they cannot possibly have received.
   */
  it('does not throw when the repository throws, and claims no delivery', async () => {
    notifications.insert.mockRejectedValue(new Error('db down'));

    await expect(service.notify(request())).resolves.toEqual({
      deliveredNow: false,
      recorded: false,
    });
  });

  it('does not throw when Redis throws, and still sends', async () => {
    redis.down = true;

    await expect(
      service.notify(request({ event: NotificationEvent.BALANCE_ZERO, dedupeKey: 'acct-1' })),
    ).resolves.toEqual({ deliveredNow: true, recorded: true });

    expect(notifications.insert).toHaveBeenCalledTimes(1);
  });
});
