import { NotificationSettingsService } from '../../../src/modules/notification/services/notification-settings.service';
import { NOTIFICATION_CATALOGUE } from '../../../src/modules/notification/constants/notification-catalogue';
import {
  NotificationChannel,
  NotificationEvent,
} from '../../../src/modules/notification/ports/notification.port';

const actor = { type: 'user' as const, id: 'login-1' };

describe('NotificationSettingsService.upsertChannel', () => {
  const orgId = 'org-1';
  const existingRow = {
    id: 'row-1',
    channel: NotificationChannel.EMAIL,
    destination: 'a@example.com',
    enabled: true,
    verifiedAt: null,
    createdAt: new Date(0),
  };

  function build(rows: unknown[]) {
    const channels = {
      findForOrganization: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    // The writes go through the transaction's manager; it forwards to the
    // same spies the assertions below read.
    const manager = {
      update: jest.fn((_entity: unknown, criteria: unknown, values: unknown) =>
        channels.update(criteria, values),
      ),
      insert: jest.fn((_entity: unknown, values: unknown) => channels.insert(values)),
    };
    const dataSource = { transaction: jest.fn(async (work: any) => work(manager)) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationSettingsService(
      channels as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
      audit as any,
    );
    return { service, channels, manager, audit };
  }

  it.each([null, '', '   '])(
    'refuses a cleared destination (%j) with a 400 domain error',
    async (destination) => {
      const { service, channels } = build([existingRow]);
      await expect(
        service.upsertChannel(orgId, NotificationChannel.EMAIL, destination, true, actor),
      ).rejects.toMatchObject({ errorCode: 'NOTIFICATION_DESTINATION_REQUIRED', statusCode: 400 });
      expect(channels.update).not.toHaveBeenCalled();
    },
  );

  it('refuses creating a channel with no destination', async () => {
    const { service, channels } = build([]);
    await expect(
      service.upsertChannel(orgId, NotificationChannel.EMAIL, undefined, true, actor),
    ).rejects.toMatchObject({ errorCode: 'NOTIFICATION_DESTINATION_REQUIRED' });
    expect(channels.insert).not.toHaveBeenCalled();
  });

  it('keeps the stored destination when only toggling enabled', async () => {
    const { service, channels } = build([existingRow]);
    const dto = await service.upsertChannel(
      orgId,
      NotificationChannel.EMAIL,
      undefined,
      false,
      actor,
    );
    expect(dto.destination).toBe('a@example.com');
    expect(channels.update).toHaveBeenCalled();
  });

  it('trims a provided destination before storing', async () => {
    const { service } = build([existingRow]);
    const dto = await service.upsertChannel(
      orgId,
      NotificationChannel.EMAIL,
      ' b@example.com ',
      true,
      actor,
    );
    expect(dto.destination).toBe('b@example.com');
  });

  describe('audit log (BUG-R2-B4-01)', () => {
    it('records notification_channel.updated with the changed fields only', async () => {
      const { service, audit, manager } = build([existingRow]);
      await service.upsertChannel(orgId, NotificationChannel.EMAIL, 'b@example.com', false, actor);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(manager, {
        organizationId: orgId,
        actor,
        action: 'notification_channel.updated',
        resourceType: 'notification_channel',
        resourceId: 'row-1',
        before: { channel: 'EMAIL', destination: 'a@example.com', enabled: true },
        after: { channel: 'EMAIL', destination: 'b@example.com', enabled: false },
      });
    });

    it('records only the toggle when the destination is kept', async () => {
      const { service, audit } = build([existingRow]);
      await service.upsertChannel(orgId, NotificationChannel.EMAIL, undefined, false, actor);

      expect(audit.record.mock.calls[0][1]).toMatchObject({
        before: { channel: 'EMAIL', enabled: true },
        after: { channel: 'EMAIL', enabled: false },
      });
    });

    it('records nothing when the request changes nothing', async () => {
      const { service, audit } = build([existingRow]);
      await service.upsertChannel(orgId, NotificationChannel.EMAIL, 'a@example.com', true, actor);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('records notification_channel.created for a first destination', async () => {
      const { service, audit, channels } = build([]);
      const dto = await service.upsertChannel(
        orgId,
        NotificationChannel.EMAIL,
        'a@example.com',
        true,
        actor,
      );

      expect(channels.insert).toHaveBeenCalled();
      expect(audit.record.mock.calls[0][1]).toEqual({
        organizationId: orgId,
        actor,
        action: 'notification_channel.created',
        resourceType: 'notification_channel',
        resourceId: dto.id,
        before: null,
        after: { channel: 'EMAIL', destination: 'a@example.com', enabled: true },
      });
    });

    it.each([NotificationChannel.SLACK, NotificationChannel.WEBHOOK, NotificationChannel.PUSH])(
      'never stores a %s destination — its URL is itself a credential',
      async (channel) => {
        const row = { ...existingRow, channel, destination: 'https://hooks.example/T0/B0/old' };
        const { service, audit } = build([row]);
        await service.upsertChannel(orgId, channel, 'https://hooks.example/T0/B0/new', true, actor);

        const entry = audit.record.mock.calls[0][1];
        expect(entry.after).toEqual({ channel, destinationChanged: true });
        expect(JSON.stringify(entry)).not.toContain('hooks.example');
      },
    );

    it('fails the write when the audit entry cannot be recorded', async () => {
      const { service, audit } = build([existingRow]);
      audit.record.mockRejectedValue(new Error('audit down'));
      await expect(
        service.upsertChannel(orgId, NotificationChannel.EMAIL, undefined, false, actor),
      ).rejects.toThrow('audit down');
    });
  });
});

describe('NotificationSettingsService.upsertPreferences — audit log (BUG-R2-B4-01)', () => {
  const orgId = 'org-1';
  const event = Object.values(NotificationEvent).find(
    (name) => !NOTIFICATION_CATALOGUE[name].nonSuppressible,
  ) as NotificationEvent;
  const item = (enabled: boolean) => ({ event, channel: NotificationChannel.EMAIL, enabled });

  function build(existing: { id: string; enabled: boolean } | null) {
    const manager = {
      findOneBy: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { transaction: jest.fn(async (work: any) => work(manager)) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const preferences = { find: jest.fn().mockResolvedValue([]) };
    const service = new NotificationSettingsService(
      {} as any,
      preferences as any,
      {} as any,
      {} as any,
      dataSource as any,
      audit as any,
    );
    return { service, manager, audit };
  }

  it('records a changed preference, in the transaction that writes it', async () => {
    const { service, manager, audit } = build({ id: 'pref-1', enabled: true });
    await service.upsertPreferences(orgId, [item(false)], actor);

    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: orgId, id: 'pref-1' },
      { enabled: false },
    );
    expect(audit.record).toHaveBeenCalledWith(manager, {
      organizationId: orgId,
      actor,
      action: 'notification_preference.updated',
      resourceType: 'notification_preference',
      resourceId: 'pref-1',
      before: { enabled: true },
      after: { event, channel: 'EMAIL', enabled: false },
    });
  });

  it('records a first-time preference with no before', async () => {
    const { service, manager, audit } = build(null);
    await service.upsertPreferences(orgId, [item(false)], actor);

    const inserted = manager.insert.mock.calls[0][1];
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'notification_preference.updated',
      resourceId: inserted.id,
      before: null,
      after: { event, channel: 'EMAIL', enabled: false },
    });
  });

  it('records nothing for an item that keeps its value', async () => {
    const { service, audit } = build({ id: 'pref-1', enabled: true });
    await service.upsertPreferences(orgId, [item(true)], actor);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fails the batch when the audit entry cannot be recorded', async () => {
    const { service, audit } = build({ id: 'pref-1', enabled: true });
    audit.record.mockRejectedValue(new Error('audit down'));
    await expect(service.upsertPreferences(orgId, [item(false)], actor)).rejects.toThrow(
      'audit down',
    );
  });
});
