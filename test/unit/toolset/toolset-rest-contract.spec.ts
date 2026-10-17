import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  AgentAccessController,
  CredentialAccessController,
} from '@modules/toolset/controllers/agent-access.controller';
import { ToolsetsController } from '@modules/toolset/controllers/toolsets.controller';
import { AgentAccessService } from '@modules/toolset/services/agent-access.service';
import { ToolsetPublishingService } from '@modules/toolset/services/toolset-publishing.service';
import { ToolsetsService } from '@modules/toolset/services/toolsets.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

const HUMAN = 'human-token';
const MACHINE = 'machine-token';
const ORG = '3c4d5e6f-7081-4923-a4b5-c6d7e8f90a1b';
const AGENT = '5e6f7081-9203-4a45-b6c7-d8e9f0a1b2c3';
const OTHER_AGENT = '6f708192-0314-4b56-87d8-e9f0a1b2c3d4';
const TOOL = '708192a3-1425-4c67-98e9-f0a1b2c3d4e5';

const session = (callerKind: McpCallerKind): McpSession => ({
  credentialId: 'cred',
  organizationId: ORG,
  agentId: AGENT,
  agentAccount: 'solana:x:a' as never,
  chainId: 'solana:x' as never,
  label: null,
  callerKind,
});

/**
 * The REST contract the web app builds against: bodies are validated before
 * a service sees them, writes are a person's, and a machine credential reads
 * only its own agent's access.
 */
describe('toolset REST contract', () => {
  let app: INestApplication;
  const toolsets = {
    list: jest.fn(),
    create: jest.fn(async (_org: string, body: unknown) => ({ id: 'created', body })),
    get: jest.fn(),
    update: jest.fn(),
    replaceEntries: jest.fn(async () => ({ id: 'replaced' })),
    delete: jest.fn(),
  };
  const publishing = {
    publish: jest.fn(async () => ({ version: { version: 1 } })),
    unpublish: jest.fn(),
    rotateToken: jest.fn(),
    listVersions: jest.fn(async () => []),
    getVersion: jest.fn(),
    copy: jest.fn(async () => ({ excluded: [] })),
    ownStats: jest.fn(),
  };
  const access = {
    get: jest.fn(async () => ({ agentId: AGENT })),
    patch: jest.fn(async () => ({ agentId: AGENT })),
    onlyConnected: jest.fn(),
    getCredential: jest.fn(),
    patchCredential: jest.fn(async () => ({ credentialId: 'c' })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ToolsetsController, AgentAccessController, CredentialAccessController],
      providers: [
        { provide: ToolsetsService, useValue: toolsets },
        { provide: AgentAccessService, useValue: access },
        { provide: ToolsetPublishingService, useValue: publishing },
        {
          provide: MCP_SESSION_SOURCE,
          useValue: {
            resolve: async (token: string | null) => {
              if (token === HUMAN) return session(McpCallerKind.HUMAN);
              if (token === MACHINE) return session(McpCallerKind.AGENT);
              throw McpErrors.credentialInvalid();
            },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('accepts a tool set with entries and provider rules', async () => {
    const response = await request(app.getHttpServer())
      .post('/toolsets')
      .set(as(HUMAN))
      .send({
        name: 'Weather desk',
        slug: 'weather-desk',
        icon: 'weather',
        discovery: 'FULL',
        pinnedTools: ['get_weather'],
        entries: [
          {
            toolId: TOOL,
            providerMode: 'ONLY',
            providerIds: [AGENT],
            minTier: 'ESTABLISHED',
            maxPrice: { amount: '10000', asset: 'solana:x/token:y' },
            minQuality: 0.95,
            onEmpty: 'FALLBACK_BEST',
          },
        ],
      });
    expect(response.status).toBe(201);
    expect(toolsets.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a bad slug', { name: 'x', slug: 'Not A Slug' }],
    ['an unknown icon', { name: 'x', icon: 'rocket' }],
    ['an unknown provider mode', { name: 'x', entries: [{ toolId: TOOL, providerMode: 'SOME' }] }],
    ['a tool id that is not a uuid', { name: 'x', entries: [{ toolId: 'get_weather' }] }],
    ['a quality above 1', { name: 'x', entries: [{ toolId: TOOL, minQuality: 1.5 }] }],
    [
      'a price that is not atomic units',
      { name: 'x', entries: [{ toolId: TOOL, maxPrice: { amount: '0.01', asset: 'a' } }] },
    ],
    ['an unknown field', { name: 'x', visibility: 'PUBLIC' }],
    ['no name', {}],
  ])('refuses %s with 400 before the service', async (_case, body) => {
    const response = await request(app.getHttpServer()).post('/toolsets').set(as(HUMAN)).send(body);
    expect(response.status).toBe(400);
    expect(toolsets.create).not.toHaveBeenCalled();
  });

  it('leaves writes to a person', async () => {
    const write = await request(app.getHttpServer())
      .put(`/toolsets/${TOOL}/entries`)
      .set(as(MACHINE))
      .send({ entries: [] });
    expect(write.status).toBe(403);

    const patch = await request(app.getHttpServer())
      .patch(`/agents/${AGENT}/access`)
      .set(as(MACHINE))
      .send({ accessMode: 'ALL' });
    expect(patch.status).toBe(403);
    expect(access.patch).not.toHaveBeenCalled();
  });

  it('lets a machine credential read its own agent access, and no other', async () => {
    await request(app.getHttpServer()).get(`/agents/${AGENT}/access`).set(as(MACHINE));
    expect(access.get).toHaveBeenLastCalledWith(ORG, AGENT, AGENT);

    await request(app.getHttpServer()).get(`/agents/${OTHER_AGENT}/access`).set(as(MACHINE));
    expect(access.get).toHaveBeenLastCalledWith(ORG, OTHER_AGENT, AGENT);

    await request(app.getHttpServer()).get(`/agents/${AGENT}/access`).set(as(HUMAN));
    expect(access.get).toHaveBeenLastCalledWith(ORG, AGENT, null);
  });

  it('validates an access patch', async () => {
    const ok = await request(app.getHttpServer())
      .patch(`/agents/${AGENT}/access`)
      .set(as(HUMAN))
      .send({
        accessMode: 'RESTRICTED',
        allowedToolsets: [{ toolsetId: TOOL, version: null, viaUrlOnly: true }],
        allowedToolIds: [TOOL],
        rules: {
          excludeProviderIds: [AGENT],
          maxPrice: '10000',
          minTier: 'TRUSTED',
          minQuality: null,
        },
        pinnedTools: ['get_weather'],
      });
    expect(ok.status).toBe(200);

    for (const body of [
      { accessMode: 'SOME' },
      { rules: { maxPrice: '-1' } },
      { rules: { minTier: 'GOLD' } },
      { allowedToolsets: [{ toolsetId: 'not-a-uuid' }] },
    ]) {
      const response = await request(app.getHttpServer())
        .patch(`/agents/${AGENT}/access`)
        .set(as(HUMAN))
        .send(body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('narrows a key, and accepts null to remove the narrowing', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/agent-credentials/${TOOL}/access`)
      .set(as(HUMAN))
      .send({ accessMode: null });
    expect(response.status).toBe(200);
    expect(access.patchCredential).toHaveBeenCalledWith(
      ORG,
      TOOL,
      { accessMode: null },
      expect.anything(),
    );
  });
});
