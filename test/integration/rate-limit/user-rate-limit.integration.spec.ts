import { randomUUID } from 'node:crypto';

import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Global,
  INestApplication,
  Injectable,
  Module,
  Post,
  UseGuards,
  VersioningType,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';

import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import { SESSION_REQUEST_KEY } from '@shared/auth/session-request.key';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { HEAVY_READ_LIMIT, READ_RULE } from '@shared/rate-limit/user-rate-limit.config';
import { UserRateLimitInterceptor } from '@shared/rate-limit/user-rate-limit.interceptor';
import { UserRateLimitModule } from '@shared/rate-limit/user-rate-limit.module';

/**
 * The per-caller windows against a real Redis, through Nest's own pipeline
 * (global prefix, URI versioning, guard before interceptor, the error filter),
 * as `bootstrapApi` wires it.
 *
 * The routes are stand-ins at the dashboard's real paths: the limiter keys on
 * the matched route and the caller, never on what the handler does, so the
 * handlers here only answer.
 */

/** Plays `SessionAuthGuard`: the caller named by `x-test-agent` is a person of `x-test-org`. */
@Injectable()
class TestSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const agentId = req.headers['x-test-agent'];
    if (!agentId) return false;
    req[SESSION_REQUEST_KEY] = {
      credentialId: `privy:${agentId}`,
      organizationId: req.headers['x-test-org'],
      agentId,
      agentAccount: `eip155:46630:${agentId}`,
      chainId: 'eip155:46630',
      label: null,
      callerKind: McpCallerKind.HUMAN,
      paymentsAllowed: true,
    };
    return true;
  }
}

/** What the console's pages read on a load (the new frontend's set). */
const PAGE_LOAD = [
  '/me/status',
  '/overview',
  '/agents?include=credentials,health',
  '/escrow',
  '/spend-policy',
  '/toolsets',
  '/notifications',
  '/org/handle',
  '/free-quota',
  '/tool-calls',
];

@UseGuards(TestSessionGuard)
@Controller()
class DashboardStandInController {
  @Get('overview') overview() {
    return { ok: true };
  }
  @Get('me/status') meStatus() {
    return { ok: true };
  }
  @Get('agents') agents() {
    return { ok: true };
  }
  @Get('escrow') escrow() {
    return { ok: true };
  }
  @Get('spend-policy') spendPolicy() {
    return { ok: true };
  }
  @Get('toolsets') toolsets() {
    return { ok: true };
  }
  @Get('notifications') notifications() {
    return { ok: true };
  }
  @Get('org/handle') handle() {
    return { ok: true };
  }
  @Get('free-quota') freeQuota() {
    return { ok: true };
  }
  @Get('tool-calls') toolCalls() {
    return { ok: true };
  }
  @Post('toolsets') createToolset() {
    return { ok: true };
  }
}

/** No guard: a public read, which this limiter must not count. */
@Controller('public')
class PublicStandInController {
  @Get('toolsets') list() {
    return { ok: true };
  }
}

describe('UserRateLimitInterceptor (integration, real Redis)', () => {
  let app: INestApplication;
  let redis: Redis;
  let clock: number;

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });

    // As `RedisCacheModule` is: global, so the limiter's module sees the client.
    @Global()
    @Module({
      providers: [{ provide: REDIS_CACHE_CLIENT, useValue: redis }],
      exports: [REDIS_CACHE_CLIENT],
    })
    class TestRedisModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        TestRedisModule,
        UserRateLimitModule,
      ],
      controllers: [DashboardStandInController, PublicStandInController],
      providers: [TestSessionGuard],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);
    // The limiter's clock, moved by the tests: five minutes run in seconds.
    app.get(UserRateLimitInterceptor).now = () => clock;
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
  });

  beforeEach(() => {
    // Each test starts just past a minute boundary, with organizations of its own.
    clock = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
  });

  const person = () => ({ org: `org-${randomUUID()}`, agent: `agent-${randomUUID()}` });
  type Person = ReturnType<typeof person>;

  const get = (who: Person, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('x-test-org', who.org)
      .set('x-test-agent', who.agent);

  it('never refuses three tabs of the console for five minutes, reloads included', async () => {
    const alice = person();
    const statuses = new Map<number, number>();
    const record = (status: number) => statuses.set(status, (statuses.get(status) ?? 0) + 1);

    /** One tab loading its page: every read at once, the way React Query starts them. */
    const reload = async () => {
      for (let tab = 0; tab < 3; tab += 1) {
        const answers = await Promise.all(PAGE_LOAD.map((path) => get(alice, path)));
        answers.forEach((answer) => record(answer.status));
      }
    };

    await reload();
    // Five minutes, one second at a time: `/overview` and `/agents?include`
    // every 30 s and `/me/status` every 60 s, in each of three tabs, with a
    // second reload of all three at 2.5 min (sign-in, a deploy, a person).
    for (let second = 1; second <= 300; second += 1) {
      clock += 1_000;
      const due: string[] = [];
      if (second % 30 === 0) due.push('/overview', '/agents?include=credentials,health');
      if (second % 60 === 0) due.push('/me/status');
      for (let tab = 0; tab < 3; tab += 1) {
        for (const path of due) record((await get(alice, path)).status);
      }
      if (second === 150) await reload();
    }

    expect(statuses.get(429) ?? 0).toBe(0);
    // 2 reloads × 3 tabs × 10 reads, 10 × 3 × 2 half-minute polls, 5 × 3 minute polls.
    expect(statuses.get(200)).toBe(60 + 60 + 15);
  });

  it('refuses the read past the limit with 429, Retry-After and the error envelope', async () => {
    const bob = person();
    for (let i = 0; i < READ_RULE.limit; i += 1) {
      expect((await get(bob, '/tool-calls')).status).toBe(200);
    }

    // 21 s into the window (it started at the minute; the clock at +1 s).
    clock += 20_000;
    const refused = await get(bob, '/tool-calls');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('39');
    expect(refused.body).toMatchObject({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', statusCode: 429, path: '/api/v1/tool-calls' },
    });

    // Another person of the same organization has a window of their own.
    expect((await get({ ...bob, agent: 'agent-other' }, '/tool-calls')).status).toBe(200);
    // And the next minute is a fresh window.
    clock += 39_000;
    expect((await get(bob, '/tool-calls')).status).toBe(200);
  });

  it('holds a heavy read to its own window', async () => {
    const carol = person();
    for (let i = 0; i < HEAVY_READ_LIMIT; i += 1) {
      expect((await get(carol, '/overview')).status).toBe(200);
    }
    expect((await get(carol, '/overview')).status).toBe(429);
    expect((await get(carol, '/me/status')).status).toBe(200);
  });

  it('keeps the count in Redis, where every replica reads the same window', async () => {
    const dan = person();
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/toolsets')
        .set('x-test-org', dan.org)
        .set('x-test-agent', dan.agent);
      expect(res.status).toBe(201);
    }
    const keys = await redis.keys(`rate:user:write:person:${dan.org}:${dan.agent}:*`);
    expect(keys).toHaveLength(1);
    expect(await redis.get(keys[0])).toBe('20');

    const refused = await request(app.getHttpServer())
      .post('/api/v1/toolsets')
      .set('x-test-org', dan.org)
      .set('x-test-agent', dan.agent);
    expect(refused.status).toBe(429);
  });

  it('does not count public reads or requests the guard refused', async () => {
    for (let i = 0; i < READ_RULE.limit + 5; i += 1) {
      expect((await request(app.getHttpServer()).get('/api/v1/public/toolsets')).status).toBe(200);
    }
    // No caller: the guard answers 403 and nothing is counted.
    expect((await request(app.getHttpServer()).get('/api/v1/tool-calls')).status).toBe(403);
    expect(await redis.keys('rate:user:*:ip:*')).toEqual([]);
  });
});
