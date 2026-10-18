import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { HandlesController } from '@modules/toolset/controllers/handles.controller';
import { PublicToolsetsController } from '@modules/toolset/controllers/public-toolsets.controller';
import { ReportsController } from '@modules/toolset/controllers/reports.controller';
import { ToolsetsController } from '@modules/toolset/controllers/toolsets.controller';
import { EMPTY_FILTER, EndpointKind, McpPathKind } from '@modules/toolset/domain/mcp-url';
import { ListingStatus, SharingState, ToolsetVisibility } from '@modules/toolset/domain/sharing';
import { McpEndpointView, listMetaOf } from '@modules/toolset/domain/view';
import { HandlesService } from '@modules/toolset/services/handles.service';
import { PublicToolsetsService } from '@modules/toolset/services/public-toolsets.service';
import { noticeBody } from '@modules/toolset/services/toolset-notices.service';
import {
  ToolsetPublishingService,
  copyExclusion,
  startOfUtcDay,
  visibleToOthers,
} from '@modules/toolset/services/toolset-publishing.service';
import { ToolsetReportsService } from '@modules/toolset/services/toolset-reports.service';
import { isoDay, mondayOf } from '@modules/toolset/services/toolset-stats.service';
import { ToolsetsService } from '@modules/toolset/services/toolsets.service';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

const HUMAN = 'human-token';
const MACHINE = 'machine-token';
const ORG = '3c4d5e6f-7081-4923-a4b5-c6d7e8f90a1b';
const ID = '5e6f7081-9203-4a45-b6c7-d8e9f0a1b2c3';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz';

const session = (callerKind: McpCallerKind): McpSession => ({
  credentialId: 'cred',
  organizationId: ORG,
  agentId: ID,
  agentAccount: 'solana:x:a' as never,
  chainId: 'solana:x' as never,
  label: null,
  callerKind,
  paymentsAllowed: true,
});

/** The T2 publishing REST contract: bodies are validated before a service runs; writes are a person's. */
describe('toolset publishing REST contract', () => {
  let app: INestApplication;
  const publishing = {
    publish: jest.fn(async () => ({ version: { version: 1 } })),
    unpublish: jest.fn(async () => ({})),
    rotateToken: jest.fn(async () => ({})),
    listVersions: jest.fn(async () => []),
    getVersion: jest.fn(async () => ({})),
    copy: jest.fn(async () => ({ excluded: [] })),
    ownStats: jest.fn(async () => ({})),
  };
  const handles = {
    get: jest.fn(async () => ({ handle: null, status: null, lockedAt: null, canChange: true })),
    claim: jest.fn(async () => ({
      handle: 'acme',
      status: 'ACTIVE',
      lockedAt: null,
      canChange: true,
    })),
  };
  const reports = { create: jest.fn(async () => ({ id: 'r', createdAt: 'now' })) };
  const publicToolsets = {
    list: jest.fn(async () => ({ toolsets: [], total: 0 })),
    page: jest.fn(async () => ({})),
    versionsOf: jest.fn(async () => ({ versions: [] })),
    versionOf: jest.fn(async () => ({})),
    byToken: jest.fn(async () => ({})),
    profile: jest.fn(async () => ({})),
    categories: jest.fn(async () => ({ categories: [] })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ToolsetsController,
        HandlesController,
        ReportsController,
        PublicToolsetsController,
      ],
      providers: [
        { provide: ToolsetsService, useValue: {} },
        { provide: ToolsetPublishingService, useValue: publishing },
        { provide: HandlesService, useValue: handles },
        { provide: ToolsetReportsService, useValue: reports },
        { provide: PublicToolsetsService, useValue: publicToolsets },
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
  const http = () => request(app.getHttpServer());

  it('publishes with a visibility and an optional changelog', async () => {
    const response = await http()
      .post(`/toolsets/${ID}/publish`)
      .set(as(HUMAN))
      .send({ visibility: 'UNLISTED', changelog: 'Added a tool.' });
    expect(response.status).toBe(200);
    expect(publishing.publish).toHaveBeenCalledWith(
      ORG,
      ID,
      { visibility: 'UNLISTED', changelog: 'Added a tool.' },
      expect.anything(),
    );
  });

  it.each([
    ['an unknown visibility', { visibility: 'SECRET' }],
    ['no visibility', {}],
    ['a control character in the changelog', { visibility: 'PUBLIC', changelog: 'a\u0007b' }],
    ['a changelog over 500 characters', { visibility: 'PUBLIC', changelog: 'x'.repeat(501) }],
  ])('refuses %s with 400', async (_case, body) => {
    const response = await http().post(`/toolsets/${ID}/publish`).set(as(HUMAN)).send(body);
    expect(response.status).toBe(400);
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it('leaves publishing, stop sharing, rotating, copying and handles to a person', async () => {
    for (const [path, body] of [
      [`/toolsets/${ID}/publish`, { visibility: 'PUBLIC' }],
      [`/toolsets/${ID}/unpublish`, {}],
      [`/toolsets/${ID}/unlisted-token/rotate`, {}],
      [`/toolsets/${ID}/copy`, {}],
      ['/reports', { toolsetId: ID, reason: 'spam spam' }],
    ] as const) {
      expect((await http().post(path).set(as(MACHINE)).send(body)).status).toBe(403);
    }
    expect((await http().put('/org/handle').set(as(MACHINE)).send({ handle: 'acme' })).status).toBe(
      403,
    );
    // Reads are fine for a machine credential of the organization.
    expect((await http().get(`/toolsets/${ID}/versions`).set(as(MACHINE))).status).toBe(200);
    expect((await http().get('/org/handle').set(as(MACHINE))).status).toBe(200);
  });

  it('validates a copy and a version path', async () => {
    expect(
      (await http().post(`/toolsets/${ID}/copy`).set(as(HUMAN)).send({ unlistedToken: 'BAD!' }))
        .status,
    ).toBe(400);
    expect(
      (
        await http()
          .post(`/toolsets/${ID}/copy`)
          .set(as(HUMAN))
          .send({ unlistedToken: TOKEN, version: 2 })
      ).status,
    ).toBe(201);
    expect((await http().get(`/toolsets/${ID}/versions/0`).set(as(HUMAN))).status).toBe(400);
    expect((await http().get(`/toolsets/${ID}/versions/3`).set(as(HUMAN))).status).toBe(200);
    expect(publishing.getVersion).toHaveBeenCalledWith(ORG, ID, 3);
  });

  it('serves the public routes without a token, with the handle in the path', async () => {
    expect((await http().get('/public/toolsets?sort=trending&publisher=official')).status).toBe(
      200,
    );
    expect((await http().get('/public/toolsets?sort=random')).status).toBe(400);
    expect((await http().get('/public/toolsets/@acme/twitter-kit')).status).toBe(200);
    expect(publicToolsets.page).toHaveBeenCalledWith('acme', 'twitter-kit');
    expect((await http().get('/public/toolsets/@acme/twitter-kit/versions')).status).toBe(200);
    expect((await http().get('/public/toolsets/@ACME!/kit')).status).toBe(400);
    expect((await http().get('/public/handles/acme')).status).toBe(200);
    expect((await http().get('/public/categories')).status).toBe(200);
    // The token travels in the body, never the URL.
    expect((await http().post('/public/toolsets/by-token').send({ token: TOKEN })).status).toBe(
      200,
    );
    expect((await http().post('/public/toolsets/by-token').send({ token: 'x' })).status).toBe(400);
  });

  it('serves one version by number, with an optional diffFrom, on the same public terms', async () => {
    expect((await http().get('/public/toolsets/@acme/twitter-kit/versions/3')).status).toBe(200);
    expect(publicToolsets.versionOf).toHaveBeenLastCalledWith('acme', 'twitter-kit', 3, undefined);
    expect(
      (await http().get('/public/toolsets/@acme/twitter-kit/versions/3?diffFrom=1')).status,
    ).toBe(200);
    expect(publicToolsets.versionOf).toHaveBeenLastCalledWith('acme', 'twitter-kit', 3, 1);
    for (const path of ['versions/0', 'versions/x', 'versions/2?diffFrom=0', 'versions/2?a=1']) {
      expect((await http().get(`/public/toolsets/@acme/twitter-kit/${path}`)).status).toBe(400);
    }
    expect(
      (await http().post('/public/toolsets/by-token').send({ token: TOKEN, v: 3, diffFrom: 2 }))
        .status,
    ).toBe(200);
    expect(publicToolsets.byToken).toHaveBeenLastCalledWith(TOKEN, 3, 2);
    expect(
      (await http().post('/public/toolsets/by-token').send({ token: TOKEN, diffFrom: 0 })).status,
    ).toBe(400);
  });
});

describe('publishing rules', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const state = (over: Partial<SharingState>): SharingState => ({
    visibility: ToolsetVisibility.PRIVATE,
    listingStatus: null,
    graceVisibility: null,
    graceUntil: null,
    unlistedToken: null,
    removedAt: null,
    deletedAt: null,
    delistedAt: null,
    firstSharedAt: null,
    ...over,
  });

  it('lets another org see a listed toolset, or a link-only one with its current token only', () => {
    const listed = state({
      visibility: ToolsetVisibility.PUBLIC,
      listingStatus: ListingStatus.LISTED,
    });
    expect(visibleToOthers(listed, undefined, now)).toBe(true);
    const linkOnly = state({ visibility: ToolsetVisibility.UNLISTED, unlistedToken: TOKEN });
    expect(visibleToOthers(linkOnly, undefined, now)).toBe(false);
    expect(visibleToOthers(linkOnly, 'zyxwvutsrqponmlkjihgfedcba', now)).toBe(false);
    expect(visibleToOthers(linkOnly, TOKEN, now)).toBe(true);
    expect(visibleToOthers(state({}), TOKEN, now)).toBe(false);
    expect(visibleToOthers({ ...listed, removedAt: now }, undefined, now)).toBe(false);
  });

  it('excludes removed tools and another org’s link-only tools from a copy', () => {
    expect(copyExclusion(undefined, ORG)).toBe('REMOVED');
    expect(copyExclusion({ status: 'REMOVED', visibility: 'LISTED', ownerOrgId: null }, ORG)).toBe(
      'REMOVED',
    );
    expect(copyExclusion({ status: 'ACTIVE', visibility: 'UNLISTED', ownerOrgId: ID }, ORG)).toBe(
      'LINK_ONLY',
    );
    expect(
      copyExclusion({ status: 'ACTIVE', visibility: 'UNLISTED', ownerOrgId: ORG }, ORG),
    ).toBeNull();
    expect(
      copyExclusion({ status: 'ACTIVE', visibility: 'LISTED', ownerOrgId: null }, ORG),
    ).toBeNull();
  });

  it('writes an update notice a person can read', () => {
    expect(
      noticeBody({ added: ['a'], removed: ['b'], rulesChanged: [], settingsChanged: [] }, 3, 4),
    ).toBe(
      'Added: a. Removed: b. Your app still uses v3 until you replace its URL with the v4 one.',
    );
  });

  it('works in UTC days and weeks', () => {
    expect(isoDay(startOfUtcDay(new Date('2026-10-17T23:59:59Z')))).toBe('2026-10-17');
    expect(isoDay(mondayOf(new Date('2026-10-18T10:00:00Z')))).toBe('2026-10-12');
    expect(isoDay(mondayOf(new Date('2026-10-19T00:00:00Z')))).toBe('2026-10-19');
  });

  it('puts the version, grace end and rename on a list result', () => {
    const view = {
      canonicalUrl: 'x',
      path: { kind: McpPathKind.PUBLIC_TOOLSET, handle: 'old', slug: 'kit', version: null },
      kind: EndpointKind.TOOLSET,
      filter: EMPTY_FILTER,
      toolset: { id: ID, slug: 'kit', name: 'Kit', version: 4, latest: true },
      handle: 'old',
      baseToolIds: [],
      entryRules: new Map(),
      settings: null,
      notice: { sharingEndsAt: now, renamedTo: 'acme' },
    } as McpEndpointView;
    expect(listMetaOf(view)).toEqual({
      'assay/toolsetVersion': 4,
      'assay/sharingEnds': now.toISOString(),
      'assay/renamed': { to: 'acme' },
    });
    expect(
      listMetaOf({ ...view, toolset: { ...view.toolset!, latest: false }, notice: null }),
    ).toEqual({});
  });
});
