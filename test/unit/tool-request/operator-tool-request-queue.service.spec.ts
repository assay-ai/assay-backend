import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ToolRequestRepository } from '@database/postgres/repositories/tool-request.repository';
import { SortDirection } from '@shared/api';
import { ListToolRequestQueueQueryDto } from '@modules/tool-request/dto/tool-request.dto';
import { ToolRequestStatus } from '@modules/tool-request/domain/tool-request-state';
import { ToolRequestErrorCode } from '@modules/tool-request/errors/tool-request.errors';
import { ToolRequestQueueService } from '@modules/tool-request/services/operator-tool-request-queue.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';
import { FakeToolRequestRepository } from './helpers/fake-tool-request-repository';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const REQUEST_ID = '33333333-3333-3333-3333-333333333333';
const OPERATOR_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_OPERATOR_ID = '55555555-5555-5555-5555-555555555555';

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.ASC }, overrides) as any;
}

describe('ToolRequestQueueService.listQueue', () => {
  it('reads through queueQueryBuilder — the cross-organization one', async () => {
    const fake = fakeQueryBuilder([]);
    const requests = { queueQueryBuilder: jest.fn().mockReturnValue(fake.qb) };
    const service = new ToolRequestQueueService(requests as never);

    await service.listQueue(baseQuery());

    expect(requests.queueQueryBuilder).toHaveBeenCalledTimes(1);
    expect(requests.queueQueryBuilder).toHaveBeenCalledWith(undefined);
  });

  it('passes ?status= through, so acknowledged requests can be listed and accepted later', async () => {
    const fake = fakeQueryBuilder([]);
    const requests = { queueQueryBuilder: jest.fn().mockReturnValue(fake.qb) };
    const service = new ToolRequestQueueService(requests as never);

    await service.listQueue(baseQuery({ status: [ToolRequestStatus.ACKNOWLEDGED] }));

    expect(requests.queueQueryBuilder).toHaveBeenCalledWith([ToolRequestStatus.ACKNOWLEDGED]);
  });

  it('the repository filters by status when asked, else on the unanswered ones', () => {
    const fake = fakeQueryBuilder([]);
    const repository = Object.create(ToolRequestRepository.prototype) as ToolRequestRepository;
    Object.defineProperty(repository, 'manager', {
      value: { createQueryBuilder: () => fake.qb },
    });

    repository.queueQueryBuilder([ToolRequestStatus.ACKNOWLEDGED, ToolRequestStatus.OPEN]);
    repository.queueQueryBuilder();

    expect(fake.wheres).toEqual([
      {
        sql: 'request.status IN (:...statuses)',
        params: { statuses: ['ACKNOWLEDGED', 'OPEN'] },
      },
      { sql: 'request.first_responded_at IS NULL', params: {} },
    ]);
  });

  it('?status= reads one value, a repeated one, or a comma list, and rejects an unknown state', async () => {
    const parse = async (status: unknown) => {
      const dto = plainToInstance(ListToolRequestQueueQueryDto, { status });
      return { dto, errors: await validate(dto) };
    };
    expect((await parse('ACKNOWLEDGED')).dto.status).toEqual(['ACKNOWLEDGED']);
    expect((await parse(['OPEN', 'ACKNOWLEDGED'])).dto.status).toEqual(['OPEN', 'ACKNOWLEDGED']);
    expect((await parse('OPEN,ACKNOWLEDGED')).dto.status).toEqual(['OPEN', 'ACKNOWLEDGED']);
    expect((await parse('NOPE')).errors.map((error) => error.property)).toEqual(['status']);
  });

  it('maps rows to the thinner queue-row DTO', async () => {
    const row = {
      id: REQUEST_ID,
      organizationId: ORG_ID,
      title: 'Weather lookup',
      expectedMonthlyCalls: 5000,
      status: 'OPEN',
      ownerOperatorId: null,
      firstResponseDueAt: new Date('2026-08-26T10:00:00.000Z'),
      createdAt: new Date('2026-08-24T10:00:00.000Z'),
    };
    const fake = fakeQueryBuilder([row]);
    const requests = { queueQueryBuilder: jest.fn().mockReturnValue(fake.qb) };
    const service = new ToolRequestQueueService(requests as never);

    const page = await service.listQueue(baseQuery());

    expect(page.items[0]).toEqual({
      id: REQUEST_ID,
      organizationId: ORG_ID,
      title: 'Weather lookup',
      expectedMonthlyCalls: 5000,
      status: 'OPEN',
      ownerOperatorId: null,
      firstResponseDueAt: row.firstResponseDueAt,
      createdAt: row.createdAt,
    });
  });
});

describe('ToolRequestQueueService.answer', () => {
  it('404s on an id no organization owns', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () =>
        service.answer(OPERATOR_ID, 'does-not-exist', { status: ToolRequestStatus.ACKNOWLEDGED }),
      ToolRequestErrorCode.TOOL_REQUEST_NOT_FOUND,
    );
  });

  it('OPEN -> ACKNOWLEDGED stamps first_responded_at, assigns the owner, and leaves it open', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, status: ToolRequestStatus.OPEN });
    const service = new ToolRequestQueueService(requests as never);

    const dto = await service.answer(OPERATOR_ID, REQUEST_ID, {
      status: ToolRequestStatus.ACKNOWLEDGED,
    });

    expect(dto.status).toBe(ToolRequestStatus.ACKNOWLEDGED);
    expect(dto.ownerOperatorId).toBe(OPERATOR_ID);
    expect(dto.firstRespondedAt).not.toBeNull();
    expect(dto.closedAt).toBeNull();
    expect(dto.resolutionNote).toBeNull();
  });

  it('OPEN -> ACCEPTED (skipping ACKNOWLEDGED) requires and stores a resolution note', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, status: ToolRequestStatus.OPEN });
    const service = new ToolRequestQueueService(requests as never);

    const dto = await service.answer(OPERATOR_ID, REQUEST_ID, {
      status: ToolRequestStatus.ACCEPTED,
      resolutionNote: 'We will build this next sprint',
    });

    expect(dto.status).toBe(ToolRequestStatus.ACCEPTED);
    expect(dto.resolutionNote).toBe('We will build this next sprint');
    expect(dto.closedAt).not.toBeNull();
    expect(dto.firstRespondedAt).not.toBeNull();
  });

  it('refuses ACCEPTED with no resolution note', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, status: ToolRequestStatus.OPEN });
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () => service.answer(OPERATOR_ID, REQUEST_ID, { status: ToolRequestStatus.ACCEPTED }),
      ToolRequestErrorCode.TOOL_REQUEST_RESOLUTION_NOTE_REQUIRED,
    );
  });

  it('refuses DECLINED with a blank resolution note', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, status: ToolRequestStatus.OPEN });
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () =>
        service.answer(OPERATOR_ID, REQUEST_ID, {
          status: ToolRequestStatus.DECLINED,
          resolutionNote: '   ',
        }),
      ToolRequestErrorCode.TOOL_REQUEST_RESOLUTION_NOTE_REQUIRED,
    );
  });

  it('does not overwrite first_responded_at on the second transition', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({
      id: REQUEST_ID,
      organizationId: ORG_ID,
      status: ToolRequestStatus.ACKNOWLEDGED,
      ownerOperatorId: OPERATOR_ID,
      firstRespondedAt: new Date('2026-08-24T10:00:00.000Z'),
    });
    const service = new ToolRequestQueueService(requests as never);

    const dto = await service.answer(OTHER_OPERATOR_ID, REQUEST_ID, {
      status: ToolRequestStatus.ACCEPTED,
      resolutionNote: 'Approved',
    });

    expect(dto.firstRespondedAt).toEqual(new Date('2026-08-24T10:00:00.000Z'));
  });

  it('does not reassign the owner away from whoever answered first', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({
      id: REQUEST_ID,
      organizationId: ORG_ID,
      status: ToolRequestStatus.ACKNOWLEDGED,
      ownerOperatorId: OPERATOR_ID,
      firstRespondedAt: new Date('2026-08-24T10:00:00.000Z'),
    });
    const service = new ToolRequestQueueService(requests as never);

    const dto = await service.answer(OTHER_OPERATOR_ID, REQUEST_ID, {
      status: ToolRequestStatus.DECLINED,
      resolutionNote: 'Out of scope',
    });

    expect(dto.ownerOperatorId).toBe(OPERATOR_ID);
  });

  it('refuses a move out of a terminal state', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({
      id: REQUEST_ID,
      organizationId: ORG_ID,
      status: ToolRequestStatus.ACCEPTED,
      closedAt: new Date(),
      resolutionNote: 'Already decided',
      firstRespondedAt: new Date(),
    });
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () => service.answer(OPERATOR_ID, REQUEST_ID, { status: ToolRequestStatus.ACKNOWLEDGED }),
      ToolRequestErrorCode.TOOL_REQUEST_INVALID_TRANSITION,
    );
  });

  it('reports a lost race as an invalid transition rather than silently double-writing', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, status: ToolRequestStatus.OPEN });
    // Simulate another operator's answer landing between this call's read and
    // its compare-and-swap write.
    requests.transitionIfIn = async () => 0;
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () => service.answer(OPERATOR_ID, REQUEST_ID, { status: ToolRequestStatus.ACKNOWLEDGED }),
      ToolRequestErrorCode.TOOL_REQUEST_INVALID_TRANSITION,
    );
  });
});

describe('ToolRequestQueueService.brief', () => {
  it('reads cross-organization by id', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, title: 'Cross-tenant read' });
    const service = new ToolRequestQueueService(requests as never);

    const dto = await service.brief(REQUEST_ID);
    expect(dto.title).toBe('Cross-tenant read');
  });

  it('404s on an id nobody owns', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestQueueService(requests as never);

    await expectErrorCodeAsync(
      () => service.brief('does-not-exist'),
      ToolRequestErrorCode.TOOL_REQUEST_NOT_FOUND,
    );
  });
});
