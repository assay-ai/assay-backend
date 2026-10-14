import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { DisputeErrorCode } from '@modules/dispute/errors/dispute.errors';
import { DisputeState, DisputeSubjectType } from '@modules/dispute/dto/dispute.dto';
import { ListDisputesQueryDto } from '@modules/dispute/dto/list-disputes.dto';
import { CreateDisputeBodyDto } from '@modules/dispute/dto/create-dispute.dto';
import { DisputeService } from '@modules/dispute/services/dispute.service';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { SortDirection } from '@shared/api';

import { fakeQueryBuilder } from './helpers/fake-query-builder';

const ORG = 'org-11111111-1111-4111-8111-111111111111';
const PROVIDER = 'provider-2222-2222-4222-8222-222222222222';
const VERDICT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const INTENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const WINDOW_ID = 'cccccccc-3333-4333-8333-333333333333';

const SESSION: McpSession = {
  credentialId: 'cred-1',
  organizationId: ORG,
  agentId: 'agent-1',
  agentAccount: 'solana:mainnet:agent' as any,
  chainId: 'solana:mainnet' as any,
  label: null,
  callerKind: McpCallerKind.CONFIG,
};

function buildDispute(overrides: Partial<DisputeEntity> = {}): DisputeEntity {
  return {
    id: 'dispute-1',
    organizationId: ORG,
    subjectType: DisputeSubjectType.VERDICT,
    subjectId: VERDICT_ID,
    providerId: null,
    state: DisputeState.OPEN,
    claimType: 'FALSE_POSITIVE',
    reason: 'the check did not fit the response',
    evidence: [],
    openedBy: 'agent-1',
    acknowledgedAt: null,
    deadlineAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    restoredAmount: null,
    assetId: null,
    decimals: null,
    createdAt: new Date('2026-08-10T10:00:00.000Z'),
    updatedAt: new Date('2026-08-10T10:00:00.000Z'),
    version: 1,
    ...overrides,
  } as unknown as DisputeEntity;
}

function createBody(overrides: Partial<CreateDisputeBodyDto> = {}): CreateDisputeBodyDto {
  return {
    subjectType: DisputeSubjectType.VERDICT,
    subjectId: VERDICT_ID,
    claimType: 'FALSE_POSITIVE',
    reason: 'the check did not fit the response',
    evidence: [],
    ...overrides,
  };
}

function listQuery(overrides: Partial<ListDisputesQueryDto> = {}): ListDisputesQueryDto {
  return Object.assign(
    new ListDisputesQueryDto(),
    { limit: 10, order: SortDirection.DESC },
    overrides,
  );
}

/**
 * `paymentIntentProviderRow` / `verificationRecordProviderRow` seed the fake
 * `createQueryBuilder().getOne()` `assertSubjectExists`'s **provider path**
 * reaches when the payer-path `findOneBy` misses — `undefined` (the default)
 * means that query builder answers `null`, i.e. no match on the provider side
 * either.
 */
function build(
  rows: DisputeEntity[] = [],
  options: {
    paymentIntentProviderRow?: unknown;
    verificationRecordProviderRow?: unknown;
  } = {},
) {
  const fake = fakeQueryBuilder(rows);
  const disputes = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
    findOneBy: jest.fn(),
    save: jest.fn(async (entity: DisputeEntity) => entity),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as DisputeRepository;
  const paymentIntentProviderQuery = fakeQueryBuilder(
    options.paymentIntentProviderRow ? [options.paymentIntentProviderRow] : [],
  );
  const paymentIntents = {
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(paymentIntentProviderQuery.qb),
  } as unknown as PaymentIntentRepository;
  const verificationRecordProviderQuery = fakeQueryBuilder(
    options.verificationRecordProviderRow ? [options.verificationRecordProviderRow] : [],
  );
  const verificationRecords = {
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(verificationRecordProviderQuery.qb),
  } as unknown as VerificationRecordRepository;
  const slaWindows = {
    findOneBy: jest.fn(),
  } as unknown as SlaWindowRepository;

  return {
    service: new DisputeService(disputes, paymentIntents, verificationRecords, slaWindows),
    disputes,
    paymentIntents,
    paymentIntentProviderQuery,
    verificationRecords,
    verificationRecordProviderQuery,
    slaWindows,
    fake,
  };
}

describe('DisputeService.list', () => {
  it('scopes to the caller organization', async () => {
    const { service, fake } = build([buildDispute()]);

    await service.list(ORG, listQuery());

    const orgWhere = fake.wheres.find((w) => w.sql.includes('dispute.organizationId'));
    expect(orgWhere?.params).toEqual({ organizationId: ORG });
  });

  it('AND-s every filter, OR-ing repeated values within state', async () => {
    const { service, fake } = build([buildDispute()]);

    await service.list(
      ORG,
      listQuery({
        state: [DisputeState.OPEN, DisputeState.UNDER_REVIEW],
        subjectType: DisputeSubjectType.VERDICT,
        claimType: 'FALSE_POSITIVE',
        providerId: 'provider-1',
      }),
    );

    expect(fake.wheres.find((w) => w.sql.includes('dispute.state'))?.params).toEqual({
      states: [DisputeState.OPEN, DisputeState.UNDER_REVIEW],
    });
    expect(fake.wheres.find((w) => w.sql.includes('dispute.subjectType'))?.params).toEqual({
      subjectType: DisputeSubjectType.VERDICT,
    });
    expect(fake.wheres.find((w) => w.sql.includes('dispute.claimType'))?.params).toEqual({
      claimType: 'FALSE_POSITIVE',
    });
    expect(fake.wheres.find((w) => w.sql.includes('dispute.providerId'))?.params).toEqual({
      providerId: 'provider-1',
    });
  });

  it('maps each row to the wire shape, with a null restoredAmount when nothing was restored', async () => {
    const { service } = build([buildDispute()]);

    const page = await service.list(ORG, listQuery());

    expect(page.items[0]).toMatchObject({
      id: 'dispute-1',
      subjectType: DisputeSubjectType.VERDICT,
      subjectId: VERDICT_ID,
      state: DisputeState.OPEN,
      claimType: 'FALSE_POSITIVE',
    });
    expect(page.items[0].restoredAmount).toBeNull();
  });
});

describe('DisputeService.getById', () => {
  it("404s on an id that is not this organization's", async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(service.getById(ORG, 'nope')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_FOUND,
      statusCode: 404,
    });
  });
});

describe('DisputeService.create', () => {
  it('opens a dispute, OPEN, with no acknowledgedAt/deadlineAt yet', async () => {
    const { service, verificationRecords } = build();
    (verificationRecords.findOneBy as jest.Mock).mockResolvedValue({ id: VERDICT_ID });

    const dispute = await service.create(ORG, SESSION, createBody());

    expect(dispute.state).toBe(DisputeState.OPEN);
    expect(dispute.acknowledgedAt).toBeNull();
    expect(dispute.deadlineAt).toBeNull();
    expect(dispute.openedBy).toBe('agent-1');
    // The payer path — unchanged by provider-filed disputes — never stamps a provider.
    expect(dispute.providerId).toBeNull();
  });

  it("validates a VERDICT subject exists within the caller's organization before opening", async () => {
    const { service, verificationRecords } = build();
    (verificationRecords.findOneBy as jest.Mock).mockResolvedValue({ id: VERDICT_ID });

    await service.create(
      ORG,
      SESSION,
      createBody({ subjectType: DisputeSubjectType.VERDICT, subjectId: VERDICT_ID }),
    );

    expect(verificationRecords.findOneBy).toHaveBeenCalledWith({
      organizationId: ORG,
      id: VERDICT_ID,
    });
  });

  it('404s — not 403, not 422 — when the VERDICT subject does not exist in this organization, and is not served by this caller as provider either', async () => {
    const { service, verificationRecords } = build();
    (verificationRecords.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(
      service.create(
        ORG,
        SESSION,
        createBody({ subjectType: DisputeSubjectType.VERDICT, subjectId: VERDICT_ID }),
      ),
    ).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('validates a PAYMENT_INTENT subject the same way', async () => {
    const { service, paymentIntents } = build();
    (paymentIntents.findOneBy as jest.Mock).mockResolvedValue({ id: INTENT_ID });

    await service.create(
      ORG,
      SESSION,
      createBody({ subjectType: DisputeSubjectType.PAYMENT_INTENT, subjectId: INTENT_ID }),
    );

    expect(paymentIntents.findOneBy).toHaveBeenCalledWith({ organizationId: ORG, id: INTENT_ID });
  });

  it('404s a malformed subjectId without ever reaching the database', async () => {
    const { service, verificationRecords } = build();

    await expect(
      service.create(
        ORG,
        SESSION,
        createBody({ subjectType: DisputeSubjectType.VERDICT, subjectId: 'not-a-uuid' }),
      ),
    ).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
      statusCode: 404,
    });
    expect(verificationRecords.findOneBy).not.toHaveBeenCalled();
  });

  describe('the provider path: a provider disputing a call it served', () => {
    const providerSession: McpSession = { ...SESSION, organizationId: PROVIDER };

    it('resolves a PAYMENT_INTENT the caller served as provider (not as payer), and stamps providerId', async () => {
      const { service, paymentIntents, paymentIntentProviderQuery } = build([], {
        paymentIntentProviderRow: { id: INTENT_ID, providerId: PROVIDER },
      });
      (paymentIntents.findOneBy as jest.Mock).mockResolvedValue(null);

      const dispute = await service.create(
        PROVIDER,
        providerSession,
        createBody({ subjectType: DisputeSubjectType.PAYMENT_INTENT, subjectId: INTENT_ID }),
      );

      // The payer path is tried first, exactly as before — and misses.
      expect(paymentIntents.findOneBy).toHaveBeenCalledWith({
        organizationId: PROVIDER,
        id: INTENT_ID,
      });
      expect(dispute.providerId).toBe(PROVIDER);
      expect(
        paymentIntentProviderQuery.wheres.find((w) => w.sql.includes('intent.providerId'))?.params,
      ).toEqual({ providerId: PROVIDER });
    });

    it('resolves a VERDICT the caller served as provider (not as payer), and stamps providerId', async () => {
      const { service, verificationRecords, verificationRecordProviderQuery } = build([], {
        verificationRecordProviderRow: { id: VERDICT_ID, providerId: PROVIDER },
      });
      (verificationRecords.findOneBy as jest.Mock).mockResolvedValue(null);

      const dispute = await service.create(
        PROVIDER,
        providerSession,
        createBody({ subjectType: DisputeSubjectType.VERDICT, subjectId: VERDICT_ID }),
      );

      expect(verificationRecords.findOneBy).toHaveBeenCalledWith({
        organizationId: PROVIDER,
        id: VERDICT_ID,
      });
      expect(dispute.providerId).toBe(PROVIDER);
      expect(
        verificationRecordProviderQuery.wheres.find((w) => w.sql.includes('record.providerId'))
          ?.params,
      ).toEqual({ providerId: PROVIDER });
    });

    it('404s — not 403 — a PAYMENT_INTENT the caller neither paid for nor served: a provider cannot dispute a call it did not serve', async () => {
      const { service, paymentIntents } = build();
      (paymentIntents.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create(
          PROVIDER,
          providerSession,
          createBody({ subjectType: DisputeSubjectType.PAYMENT_INTENT, subjectId: INTENT_ID }),
        ),
      ).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
        statusCode: 404,
      });
    });

    it('404s — not 403 — a VERDICT the caller neither paid for nor served', async () => {
      const { service, verificationRecords } = build();
      (verificationRecords.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create(
          PROVIDER,
          providerSession,
          createBody({ subjectType: DisputeSubjectType.VERDICT, subjectId: VERDICT_ID }),
        ),
      ).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
        statusCode: 404,
      });
    });
  });

  describe('SLA_WINDOW — sla_windows now backs this subject type', () => {
    it('404s a malformed SLA_WINDOW subjectId without ever reaching the database', async () => {
      const { service, slaWindows } = build();

      await expect(
        service.create(
          PROVIDER,
          { ...SESSION, organizationId: PROVIDER },
          createBody({ subjectType: DisputeSubjectType.SLA_WINDOW, subjectId: 'w_4471' }),
        ),
      ).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
        statusCode: 404,
      });
      expect(slaWindows.findOneBy).not.toHaveBeenCalled();
    });

    it('404s an SLA_WINDOW subject that does not exist for this caller', async () => {
      const { service, slaWindows } = build();
      (slaWindows.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create(
          PROVIDER,
          { ...SESSION, organizationId: PROVIDER },
          createBody({ subjectType: DisputeSubjectType.SLA_WINDOW, subjectId: WINDOW_ID }),
        ),
      ).rejects.toMatchObject({
        errorCode: DisputeErrorCode.DISPUTE_SUBJECT_NOT_FOUND,
        statusCode: 404,
      });
      expect(slaWindows.findOneBy).toHaveBeenCalledWith({
        organizationId: PROVIDER,
        id: WINDOW_ID,
      });
    });

    it("opens a dispute against the caller's own SLA_WINDOW, stamping providerId — SLA windows have no payer side to dispute from", async () => {
      const { service, slaWindows } = build();
      (slaWindows.findOneBy as jest.Mock).mockResolvedValue({
        id: WINDOW_ID,
        organizationId: PROVIDER,
      });

      const dispute = await service.create(
        PROVIDER,
        { ...SESSION, organizationId: PROVIDER },
        createBody({ subjectType: DisputeSubjectType.SLA_WINDOW, subjectId: WINDOW_ID }),
      );

      expect(dispute.state).toBe(DisputeState.OPEN);
      expect(dispute.providerId).toBe(PROVIDER);
    });
  });
});

describe('DisputeService.acknowledge', () => {
  it('sets acknowledgedAt and derives deadlineAt as +72h from it, never from createdAt', async () => {
    const { service, disputes } = build();
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    (disputes.findOneBy as jest.Mock).mockResolvedValue(buildDispute({ createdAt }));

    const before = Date.now();
    const dispute = await service.acknowledge(ORG, 'dispute-1');
    const after = Date.now();

    expect(dispute.acknowledgedAt).not.toBeNull();
    const ackMs = dispute.acknowledgedAt!.getTime();
    expect(ackMs).toBeGreaterThanOrEqual(before);
    expect(ackMs).toBeLessThanOrEqual(after);

    expect(dispute.deadlineAt).not.toBeNull();
    const deltaHours = (dispute.deadlineAt!.getTime() - ackMs) / (60 * 60 * 1000);
    expect(deltaHours).toBeCloseTo(72, 5);
    // Not derived from createdAt, which is a month earlier.
    expect(dispute.deadlineAt!.getTime()).not.toBe(createdAt.getTime() + 72 * 60 * 60 * 1000);
  });

  it("404s on an id that is not this organization's", async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(service.acknowledge(ORG, 'nope')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('refuses to re-acknowledge — the clock starts once, not on every call', async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(
      buildDispute({
        acknowledgedAt: new Date('2026-08-10T11:00:00.000Z'),
        deadlineAt: new Date('2026-08-13T11:00:00.000Z'),
      }),
    );

    await expect(service.acknowledge(ORG, 'dispute-1')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_ALREADY_ACKNOWLEDGED,
      statusCode: 409,
    });
  });

  it('refuses to acknowledge a dispute already in a terminal state', async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(
      buildDispute({ state: DisputeState.WITHDRAWN }),
    );

    await expect(service.acknowledge(ORG, 'dispute-1')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_ACKNOWLEDGEABLE,
      statusCode: 409,
    });
  });
});

describe('DisputeService.withdraw', () => {
  it('moves state to WITHDRAWN', async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(buildDispute());

    const dispute = await service.withdraw(ORG, 'dispute-1');

    expect(dispute.state).toBe(DisputeState.WITHDRAWN);
    expect(disputes.update).toHaveBeenCalledWith(
      { organizationId: ORG, id: 'dispute-1' },
      { state: DisputeState.WITHDRAWN },
    );
  });

  it("404s on an id that is not this organization's", async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(null);

    await expect(service.withdraw(ORG, 'nope')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_FOUND,
      statusCode: 404,
    });
  });

  it('refuses to withdraw a dispute already in a terminal state', async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(
      buildDispute({ state: DisputeState.UPHELD }),
    );

    await expect(service.withdraw(ORG, 'dispute-1')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_WITHDRAWABLE,
      statusCode: 409,
    });
  });
});

describe('DisputeService on a slash objection (review S-10)', () => {
  it('refuses to acknowledge or withdraw it: the slash case owns its lifecycle', async () => {
    const { service, disputes } = build();
    (disputes.findOneBy as jest.Mock).mockResolvedValue(
      buildDispute({ subjectType: 'SLASH_PROPOSAL' as never }),
    );

    await expect(service.acknowledge(ORG, 'dispute-1')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_ACKNOWLEDGEABLE,
      statusCode: 409,
    });
    await expect(service.withdraw(ORG, 'dispute-1')).rejects.toMatchObject({
      errorCode: DisputeErrorCode.DISPUTE_NOT_WITHDRAWABLE,
      statusCode: 409,
    });
    expect(disputes.update).not.toHaveBeenCalled();
  });
});
