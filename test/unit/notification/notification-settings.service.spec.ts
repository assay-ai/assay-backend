import { NotificationSettingsService } from '../../../src/modules/notification/services/notification-settings.service';
import { NotificationChannel } from '../../../src/modules/notification/ports/notification.port';

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
    const service = new NotificationSettingsService(
      channels as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, channels };
  }

  it.each([null, '', '   '])(
    'refuses a cleared destination (%j) with a 400 domain error',
    async (destination) => {
      const { service, channels } = build([existingRow]);
      await expect(
        service.upsertChannel(orgId, NotificationChannel.EMAIL, destination, true),
      ).rejects.toMatchObject({ errorCode: 'NOTIFICATION_DESTINATION_REQUIRED', statusCode: 400 });
      expect(channels.update).not.toHaveBeenCalled();
    },
  );

  it('refuses creating a channel with no destination', async () => {
    const { service, channels } = build([]);
    await expect(
      service.upsertChannel(orgId, NotificationChannel.EMAIL, undefined, true),
    ).rejects.toMatchObject({ errorCode: 'NOTIFICATION_DESTINATION_REQUIRED' });
    expect(channels.insert).not.toHaveBeenCalled();
  });

  it('keeps the stored destination when only toggling enabled', async () => {
    const { service, channels } = build([existingRow]);
    const dto = await service.upsertChannel(orgId, NotificationChannel.EMAIL, undefined, false);
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
    );
    expect(dto.destination).toBe('b@example.com');
  });
});
