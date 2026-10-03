import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { NotificationsService } from '@modules/account/services/notifications.service';
import { SortDirection } from '@shared/api';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const NOTIFICATION_ID = '22222222-2222-2222-2222-222222222222';

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIFICATION_ID,
    event: 'payment_intent.refunded',
    severity: 'INFO',
    title: 'Refunded',
    body: 'Your call was refunded',
    subjectType: 'payment_intent',
    subjectId: 'pi_1',
    payload: {},
    readAt: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness(rows: ReturnType<typeof notificationRow>[] = []) {
  const fake = fakeQueryBuilder(rows);
  const notifications = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    countUnread: jest.fn().mockResolvedValue(0),
    findOneBy: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const service = new NotificationsService(notifications as any);
  return { service, fake, notifications };
}

describe('NotificationsService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(fake.wheres[0]).toEqual({
      sql: 'notification.organizationId = :organizationId',
      params: { organizationId: ORGANIZATION_ID },
    });
  });

  it('ORs repeated event values via IN', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery({ event: ['a.b', 'c.d'] }));

    expect(fake.wheres).toContainEqual({
      sql: 'notification.event IN (:...events)',
      params: { events: ['a.b', 'c.d'] },
    });
  });

  it('unreadOnly filters read_at IS NULL', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery({ unreadOnly: true }));

    expect(fake.wheres.map((w) => w.sql)).toContain('notification.readAt IS NULL');
  });

  it('omits the unread predicate when unreadOnly is not set', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORGANIZATION_ID, baseQuery());

    expect(fake.wheres.map((w) => w.sql)).not.toContain('notification.readAt IS NULL');
  });

  it('maps rows to the wire DTO without leaking extra fields', async () => {
    const { service } = buildHarness([notificationRow()]);
    const page = await service.list(ORGANIZATION_ID, baseQuery());

    expect(page.items[0]).toEqual({
      id: NOTIFICATION_ID,
      event: 'payment_intent.refunded',
      severity: 'INFO',
      title: 'Refunded',
      body: 'Your call was refunded',
      subjectType: 'payment_intent',
      subjectId: 'pi_1',
      payload: {},
      readAt: null,
      createdAt: new Date('2026-08-10T10:00:00.000Z'),
    });
  });
});

describe('NotificationsService.unreadCount', () => {
  it('reads the count straight from the repository', async () => {
    const { service, notifications } = buildHarness();
    notifications.countUnread.mockResolvedValue(4);

    await expect(service.unreadCount(ORGANIZATION_ID)).resolves.toEqual({ count: 4 });
    expect(notifications.countUnread).toHaveBeenCalledWith(ORGANIZATION_ID);
  });
});

describe('NotificationsService.markRead', () => {
  it('returns ACCOUNT_NOTIFICATION_NOT_FOUND for a cross-organization or missing id', async () => {
    const { service, notifications } = buildHarness();
    notifications.findOneBy.mockResolvedValue(null);

    await expectErrorCodeAsync(
      () => service.markRead(ORGANIZATION_ID, NOTIFICATION_ID),
      AccountErrorCode.ACCOUNT_NOTIFICATION_NOT_FOUND,
    );
  });

  it('sets readAt and persists it, scoped to the organization', async () => {
    const { service, notifications } = buildHarness();
    notifications.findOneBy.mockResolvedValue(notificationRow({ readAt: null }));

    const dto = await service.markRead(ORGANIZATION_ID, NOTIFICATION_ID);

    expect(dto.readAt).toBeInstanceOf(Date);
    expect(notifications.update).toHaveBeenCalledWith(
      { organizationId: ORGANIZATION_ID, id: NOTIFICATION_ID },
      { readAt: dto.readAt },
    );
  });

  it('is idempotent — an already-read notification keeps its original readAt', async () => {
    const originalReadAt = new Date('2026-08-01T00:00:00.000Z');
    const { service, notifications } = buildHarness();
    notifications.findOneBy.mockResolvedValue(notificationRow({ readAt: originalReadAt }));

    const dto = await service.markRead(ORGANIZATION_ID, NOTIFICATION_ID);

    expect(dto.readAt).toBe(originalReadAt);
    expect(notifications.update).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.markAllRead', () => {
  it('updates every unread row for the organization in one statement', async () => {
    const { service, notifications } = buildHarness();
    await service.markAllRead(ORGANIZATION_ID);

    expect(notifications.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = notifications.update.mock.calls[0];
    expect(criteria.organizationId).toBe(ORGANIZATION_ID);
    expect(patch.readAt).toBeInstanceOf(Date);
  });
});
