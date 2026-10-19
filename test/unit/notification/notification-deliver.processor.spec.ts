import { Job } from 'bullmq';

import { NotificationDeliverProcessor } from '@modules/notification/processors/notification-deliver.processor';
import { NotificationChannel } from '@modules/notification/ports/notification.port';

/**
 * The deliver processor tells the delivery observer, and only when a
 * channel actually delivered.
 *
 * This is the link that records a slash proposal's delivery on a queued
 * channel: `SlashProposalService.markDelivered` sets `notified_at`, which the
 * propose sweep waits for before it reserves any stake on chain.
 *
 * The processor runs in the **worker** process, which is why the hook lives
 * here and not in `NotificationService` — that class only writes the rows and
 * enqueues the job, and never learns whether a send succeeded. A clock started
 * there would be a clock started on dispatch.
 */

const ORG = 'org-1';
const NOTIFICATION_ID = 'notification-1';
const DELIVERY_ID = 'delivery-1';
const PROPOSAL_ID = 'proposal-1';

let notifications: { findOneBy: jest.Mock };
let deliveries: { findOneBy: jest.Mock; update: jest.Mock };
let channels: { findForOrganization: jest.Mock };
let observer: { onDelivered: jest.Mock };
let sender: { send: jest.Mock };
let processor: NotificationDeliverProcessor;

function build(options?: { subjectType?: string | null; subjectId?: string | null }): void {
  const subjectType = options?.subjectType === undefined ? 'slash_proposal' : options.subjectType;
  const subjectId = options?.subjectId === undefined ? PROPOSAL_ID : options.subjectId;

  notifications = {
    findOneBy: jest.fn().mockResolvedValue({
      id: NOTIFICATION_ID,
      organizationId: ORG,
      event: 'PROVIDER_SLASH_PROPOSED',
      title: 'A penalty is proposed against your stake',
      body: 'Open the case to object.',
      payload: {},
      subjectType,
      subjectId,
    }),
  };
  deliveries = {
    findOneBy: jest.fn().mockResolvedValue({ id: DELIVERY_ID, organizationId: ORG }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  channels = { findForOrganization: jest.fn().mockResolvedValue([]) };
  observer = { onDelivered: jest.fn().mockResolvedValue(undefined) };
  sender = { send: jest.fn().mockResolvedValue({ delivered: true }) };

  processor = new NotificationDeliverProcessor(
    notifications as never,
    deliveries as never,
    channels as never,
    new Map([[NotificationChannel.IN_APP, sender as never]]) as never,
    observer as never,
  );
}

function job(): Job<never> {
  return {
    data: {
      organizationId: ORG,
      notificationId: NOTIFICATION_ID,
      deliveryId: DELIVERY_ID,
      channel: NotificationChannel.IN_APP,
    },
  } as never;
}

describe('NotificationDeliverProcessor — the delivery observer', () => {
  it('tells the observer when the channel reported a delivery', async () => {
    build();

    await processor.process(job());

    expect(observer.onDelivered).toHaveBeenCalledTimes(1);
    const [organizationId, subjectType, subjectId, deliveredAt] =
      observer.onDelivered.mock.calls[0];
    expect(organizationId).toBe(ORG);
    expect(subjectType).toBe('slash_proposal');
    expect(subjectId).toBe(PROPOSAL_ID);
    expect(deliveredAt).toBeInstanceOf(Date);
  });

  it('does NOT tell the observer when the send failed', async () => {
    build();
    sender.send.mockResolvedValue({ delivered: false, error: 'smtp refused' });

    await processor.process(job()).catch(() => undefined);

    expect(observer.onDelivered).not.toHaveBeenCalled();
  });

  it('fails the job when the send failed, so the queue retries it', async () => {
    build();
    sender.send.mockResolvedValue({ delivered: false, error: 'smtp refused' });

    await expect(processor.process(job())).rejects.toThrow(/smtp refused/);
  });

  it('does NOT tell the observer when the notification names no subject', async () => {
    build({ subjectType: null, subjectId: null });

    await processor.process(job());

    expect(observer.onDelivered).not.toHaveBeenCalled();
  });

  /**
   * The observer runs after the delivery row is already written, so its failure
   * must not fail the job — a retried job would re-send a notification that was
   * delivered.
   */
  it('still marks the delivery when the observer throws', async () => {
    build();
    observer.onDelivered.mockRejectedValue(new Error('slash module exploded'));

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(deliveries.update).toHaveBeenCalledWith(
      { organizationId: ORG, id: DELIVERY_ID },
      expect.objectContaining({ status: 'DELIVERED' }),
    );
  });
});
