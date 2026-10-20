import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorApprovalExpiryJob } from '@modules/operator/jobs/operator-approval-expiry.job';
import { OperatorSchedulerModule } from '@modules/operator/operator-scheduler.module';

describe('OperatorApprovalExpiryJob', () => {
  it('stores EXPIRED on lapsed approvals', async () => {
    const expireStale = jest.fn().mockResolvedValue(2);
    const job = new OperatorApprovalExpiryJob({
      expireStale,
    } as unknown as OperatorApprovalRepository);

    await job.handleExpiry();

    expect(expireStale).toHaveBeenCalledTimes(1);
  });

  it('never lets a database error escape the cron handler', async () => {
    const job = new OperatorApprovalExpiryJob({
      expireStale: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as OperatorApprovalRepository);

    await expect(job.handleExpiry()).resolves.toBeUndefined();
  });

  it('is provided by the scheduler-only module', () => {
    const providers = Reflect.getMetadata('providers', OperatorSchedulerModule) as unknown[];
    expect(providers).toContain(OperatorApprovalExpiryJob);
  });
});
