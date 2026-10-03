import { SortDirection } from '@shared/api';
import { ToolRequestStatus } from '@modules/tool-request/domain/tool-request-state';
import { ToolRequestErrorCode } from '@modules/tool-request/errors/tool-request.errors';
import { ToolRequestService } from '@modules/tool-request/services/tool-request.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { fakeQueryBuilder } from './helpers/fake-query-builder';
import { FakeToolRequestRepository } from './helpers/fake-tool-request-repository';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '22222222-2222-2222-2222-222222222222';
const REQUEST_ID = '33333333-3333-3333-3333-333333333333';

function baseQuery(overrides: Record<string, unknown> = {}) {
  return Object.assign({ limit: 25, order: SortDirection.DESC }, overrides) as any;
}

describe('ToolRequestService.file', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('files an OPEN request owned by nobody, answered by nobody, closed by nobody', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    const dto = await service.file(ORG_ID, 'agent_1', {
      title: 'Weather lookup',
      description: 'Wraps the NWS API',
    });

    expect(dto.status).toBe(ToolRequestStatus.OPEN);
    expect(dto.ownerOperatorId).toBeNull();
    expect(dto.firstRespondedAt).toBeNull();
    expect(dto.resolutionNote).toBeNull();
    expect(dto.closedAt).toBeNull();
  });

  it('stamps the caller organization and agent onto the row', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    await service.file(ORG_ID, 'agent_1', { title: 'x', description: 'y' });

    const stored = [...requests.rows.values()][0];
    expect(stored.organizationId).toBe(ORG_ID);
    expect(stored.requestedByAgentId).toBe('agent_1');
  });

  it('accepts a null agent — an organization-only caller', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    await service.file(ORG_ID, null, { title: 'x', description: 'y' });

    expect([...requests.rows.values()][0].requestedByAgentId).toBeNull();
  });

  it('carries optional fields through, and defaults them to null when absent', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    const withOptionals = await service.file(ORG_ID, 'agent_1', {
      title: 'x',
      description: 'y',
      upstreamUrl: 'https://api.example.com',
      expectedMonthlyCalls: 5000,
    });
    expect(withOptionals.upstreamUrl).toBe('https://api.example.com');
    expect(withOptionals.expectedMonthlyCalls).toBe(5000);

    const withoutOptionals = await service.file(ORG_ID, 'agent_1', {
      title: 'x',
      description: 'y',
    });
    expect(withoutOptionals.upstreamUrl).toBeNull();
    expect(withoutOptionals.expectedMonthlyCalls).toBeNull();
  });

  /**
   * `first_response_due_at` is written at insert, two working days from
   * filing. Monday 10:00 + 2 working days -> Wednesday 10:00 — the same
   * arithmetic `working-days.spec.ts` verifies directly; this proves the
   * service actually calls it rather than leaving the column derived or
   * unset.
   */
  it('sets first_response_due_at to two working days from filing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-24T10:00:00.000Z')); // Monday

    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    const dto = await service.file(ORG_ID, 'agent_1', { title: 'x', description: 'y' });

    expect(dto.firstResponseDueAt.toISOString()).toBe('2026-08-26T10:00:00.000Z');
  });

  it('rolls the due date over a weekend the same way filing on a Friday would', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-21T09:00:00.000Z')); // Friday

    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    const dto = await service.file(ORG_ID, 'agent_1', { title: 'x', description: 'y' });

    expect(dto.firstResponseDueAt.toISOString()).toBe('2026-08-25T09:00:00.000Z'); // Tuesday
  });
});

describe('ToolRequestService.get', () => {
  it('returns the caller organization’s own request', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: ORG_ID, title: 'Mine' });
    const service = new ToolRequestService(requests as never);

    const dto = await service.get(ORG_ID, REQUEST_ID);
    expect(dto.title).toBe('Mine');
  });

  it('404s — never a lookup another tenant can distinguish from "does not exist" — on a foreign id', async () => {
    const requests = new FakeToolRequestRepository();
    requests.seed({ id: REQUEST_ID, organizationId: OTHER_ORG_ID, title: 'Not yours' });
    const service = new ToolRequestService(requests as never);

    await expectErrorCodeAsync(
      () => service.get(ORG_ID, REQUEST_ID),
      ToolRequestErrorCode.TOOL_REQUEST_NOT_FOUND,
    );
  });

  it('404s on an id that never existed', async () => {
    const requests = new FakeToolRequestRepository();
    const service = new ToolRequestService(requests as never);

    await expectErrorCodeAsync(
      () => service.get(ORG_ID, 'does-not-exist'),
      ToolRequestErrorCode.TOOL_REQUEST_NOT_FOUND,
    );
  });
});

describe('ToolRequestService.list', () => {
  function buildHarness(rows: unknown[] = []) {
    const fake = fakeQueryBuilder(rows);
    const requests = { createQueryBuilder: jest.fn().mockReturnValue(fake.qb) };
    const service = new ToolRequestService(requests as never);
    return { service, fake };
  }

  it('scopes the query to the caller organization', async () => {
    const { service, fake } = buildHarness();
    await service.list(ORG_ID, baseQuery());

    expect(fake.wheres[0]).toEqual({
      sql: 'request.organizationId = :organizationId',
      params: { organizationId: ORG_ID },
    });
  });

  it('maps rows to the wire DTO', async () => {
    const row = {
      id: REQUEST_ID,
      organizationId: ORG_ID,
      title: 'Weather lookup',
      description: 'Wraps the NWS API',
      upstreamUrl: null,
      expectedMonthlyCalls: null,
      status: 'OPEN',
      ownerOperatorId: null,
      firstResponseDueAt: new Date('2026-08-26T10:00:00.000Z'),
      firstRespondedAt: null,
      resolutionNote: null,
      closedAt: null,
      createdAt: new Date('2026-08-24T10:00:00.000Z'),
    };
    const { service } = buildHarness([row]);

    const page = await service.list(ORG_ID, baseQuery());

    expect(page.items[0].id).toBe(REQUEST_ID);
    expect(page.items[0].title).toBe('Weather lookup');
    expect(page.items[0].status).toBe('OPEN');
  });
});
