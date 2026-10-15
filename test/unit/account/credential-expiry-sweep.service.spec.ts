import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { CredentialExpirySweepConfig } from '@modules/account/constants/credential-expiry.constants';
import { CredentialExpirySweepService } from '@modules/account/services/credential-expiry-sweep.service';
import { NotificationEvent, NotificationPort } from '@modules/notification/ports/notification.port';

/**
 * The credential-expiry sweeper.
 *
 * This is `CredentialExpirySweepService` alone, with `NotificationPort`
 * mocked: the "fires exactly twice before expiry and once after" property is
 * a claim about which event this class calls `notify()` with at each stage,
 * not about `NotificationAggregation.ONCE` collapsing repeats — that half is
 * `notification.service.spec.ts`'s.
 */

const ORG = 'org-1';
const CREDENTIAL_ID = 'cred-1';

function buildCredential(expiresAt: Date): AgentCredentialEntity {
  return {
    id: CREDENTIAL_ID,
    organizationId: ORG,
    agentId: 'agent-1',
    name: 'CI deploy',
    prefix: 'assay_live_ab12',
    tokenHash: 'hash',
    scopes: [],
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
  } as unknown as AgentCredentialEntity;
}

function buildHarness(credential: AgentCredentialEntity, now: number) {
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([credential]),
  };
  const credentials = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const config: CredentialExpirySweepConfig = { now: () => now };

  const service = new CredentialExpirySweepService(
    credentials as unknown as AgentCredentialRepository,
    notifications as unknown as NotificationPort,
    config,
  );

  return { service, notifications, credentials };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRES_AT = new Date('2026-09-01T00:00:00.000Z');

describe('CredentialExpirySweepService', () => {
  it('fires SESSION_EXPIRING at T-7d, exactly once for that pass', async () => {
    const credential = buildCredential(EXPIRES_AT);
    const now = EXPIRES_AT.getTime() - 6 * ONE_DAY_MS; // inside the T-7 window
    const { service, notifications } = buildHarness(credential, now);

    const summary = await service.sweep();

    expect(summary.warnedT7).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [request] = notifications.notify.mock.calls[0];
    expect(request.event).toBe(NotificationEvent.SESSION_EXPIRING);
    expect(request.dedupeKey).toBe(`${CREDENTIAL_ID}:T-7`);
  });

  it('fires SESSION_EXPIRING at T-1d, exactly once for that pass', async () => {
    const credential = buildCredential(EXPIRES_AT);
    const now = EXPIRES_AT.getTime() - 12 * 60 * 60 * 1000; // inside the T-1 window
    const { service, notifications } = buildHarness(credential, now);

    const summary = await service.sweep();

    expect(summary.warnedT1).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [request] = notifications.notify.mock.calls[0];
    expect(request.event).toBe(NotificationEvent.SESSION_EXPIRING);
    expect(request.dedupeKey).toBe(`${CREDENTIAL_ID}:T-1`);
  });

  it('fires SESSION_EXPIRED once, after expiry', async () => {
    const credential = buildCredential(EXPIRES_AT);
    const now = EXPIRES_AT.getTime() + 60 * 60 * 1000; // one hour past expiry
    const { service, notifications } = buildHarness(credential, now);

    const summary = await service.sweep();

    expect(summary.expired).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [request] = notifications.notify.mock.calls[0];
    expect(request.event).toBe(NotificationEvent.SESSION_EXPIRED);
    expect(request.dedupeKey).toBe(CREDENTIAL_ID);
  });

  it('does not fire outside either warning window', async () => {
    const credential = buildCredential(EXPIRES_AT);
    const now = EXPIRES_AT.getTime() - 8 * ONE_DAY_MS; // 8 days out — before T-7
    const { service, notifications } = buildHarness(credential, now);

    const summary = await service.sweep();

    expect(summary.warnedT7).toBe(0);
    expect(summary.warnedT1).toBe(0);
    expect(summary.expired).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('never throws when the repository throws', async () => {
    const credentials = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockRejectedValue(new Error('db down')),
      }),
    };
    const notifications = { notify: jest.fn() };
    const service = new CredentialExpirySweepService(
      credentials as unknown as AgentCredentialRepository,
      notifications as unknown as NotificationPort,
      { now: () => Date.now() },
    );

    await expect(service.sweep()).resolves.toEqual({
      checked: 0,
      warnedT7: 0,
      warnedT1: 0,
      expired: 0,
    });
  });

  it('never throws when notify() itself throws', async () => {
    const credential = buildCredential(EXPIRES_AT);
    const now = EXPIRES_AT.getTime() + 1;
    const { service, notifications } = buildHarness(credential, now);
    notifications.notify.mockRejectedValue(new Error('notify blew up'));

    await expect(service.sweep()).resolves.toEqual({
      checked: 1,
      warnedT7: 0,
      warnedT1: 0,
      expired: 0,
    });
  });
});
