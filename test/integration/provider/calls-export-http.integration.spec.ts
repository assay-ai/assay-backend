/**
 * `GET /providers/me/calls/export` over real HTTP — a Nest testing app, a
 * real bearer-authenticated request via
 * `supertest`, against the real test database.
 */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import request from 'supertest';

import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';

import { SessionAuthGuard } from '@shared/auth';
import {
  MCP_SESSION_SOURCE,
  McpCallerKind,
  McpSession,
  McpSessionPort,
} from '@modules/mcp/ports/mcp-session.port';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ProviderController } from '@modules/provider/controllers/provider.controller';
import { ProviderCallsExportService } from '@modules/provider/services/provider-calls-export.service';
import { ProviderEarningsService } from '@modules/provider/services/provider-earnings.service';
import { ProviderProfileService } from '@modules/provider/services/provider-profile.service';
import { ProviderStakeService } from '@modules/provider/services/provider-stake.service';

import { PaymentTestContext, createPaymentTestContext } from '../helpers/payment-test-context';

const BEARER_TOKEN = 'test-bearer-token';

describe('GET /providers/me/calls/export — real HTTP', () => {
  let context: PaymentTestContext;
  let app: INestApplication;
  let providerId: string;

  beforeAll(async () => {
    context = await createPaymentTestContext();
    providerId = context.id('http-export:provider');

    const session: McpSession = {
      credentialId: 'cred-http-export',
      organizationId: providerId,
      agentId: context.id('http-export:agent'),
      agentAccount: context.account('http-export-agent'),
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as never,
      label: 'export test',
      callerKind: McpCallerKind.CONFIG,
      paymentsAllowed: true,
    };

    const sessionSource: McpSessionPort = {
      resolve: async (bearerToken) => {
        if (bearerToken !== BEARER_TOKEN) {
          throw new Error('unknown bearer token in test stub');
        }
        return session;
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderController],
      providers: [
        SessionAuthGuard,
        { provide: MCP_SESSION_SOURCE, useValue: sessionSource },
        {
          provide: ProviderCallsExportService,
          useValue: new ProviderCallsExportService(context.repository),
        },
        // The other dependencies of `ProviderController` are irrelevant
        // to this endpoint and are never called — stand-ins rather than the
        // real services, so this test does not have to wire the whole
        // provider module's DI graph (registry, stake source, egress...) to
        // exercise one route.
        { provide: ProviderProfileService, useValue: {} },
        { provide: ProviderEarningsService, useValue: {} },
        { provide: ProviderStakeService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // The real API registers this globally (`src/bootstrap/api/main.ts`), and
    // the cache-header assertion below is meaningless without it.
    app.useGlobalInterceptors(
      new CacheHeaderInterceptor(app.get(Reflector), {
        get: (_key: string, fallback: unknown) => fallback,
      } as unknown as ConfigService),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await context.close();
  });

  it('streams a real CSV file, downloaded over HTTP, that reconciles by row count', async () => {
    const agent = context.account('http-export-agent');
    await context.fund(agent, 10_000_000n);

    const created: Date[] = [];
    for (const label of ['a', 'b']) {
      const intent = await context.createIntent(label, {
        agentAccount: agent,
        providerId,
        providerAccount: context.account('http-export-provider'),
        toolId: context.id(`http-export:${label}:tool`),
      });
      created.push(intent.createdAt);

      await context.intents.secureFunds(context.organizationId, intent.id);
      await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.FUNDS_SECURED,
        PaymentIntentStatus.PROVIDER_EXECUTING,
      );
      const verifying = await context.intents.transition(
        context.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VERIFYING,
      );
      await context.intents.resolve(
        context.organizationId,
        verifying.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
        { reason: 'a "quoted" reason, with a comma' },
      );
    }

    const from = new Date(Math.min(...created.map((d) => d.getTime())) - 1_000).toISOString();
    const to = new Date(Math.max(...created.map((d) => d.getTime())) + 1_000).toISOString();

    const response = await request(app.getHttpServer())
      .get('/providers/me/calls/export')
      .set('Authorization', `Bearer ${BEARER_TOKEN}`)
      .query({ from, to })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-assay-export-total-matching']).toBe('2');
    expect(response.headers['x-assay-export-row-count']).toBe('2');
    expect(response.headers['x-assay-export-truncated']).toBe('false');

    const body: string = response.text;
    const lines = body.split('\r\n').filter((line) => line.length > 0);

    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toBe(
      'call_id,intent_id,created_at,tool_id,status,classification,reason,verification_verdict,provider_amount,platform_fee,price_amount,asset,decimals',
    );
    // The comma-and-quote-bearing reason round-trips correctly (RFC 4180).
    expect(lines[1]).toContain('"a ""quoted"" reason, with a comma"');
    // A rail-B intent the verdict settled but no redemption has retired yet: not
    // credited, so not PAID_CREDITED.
    expect(lines[1]).toContain('PAID_AWAITING_REDEMPTION');

    console.log('First lines of the downloaded CSV:\n' + lines.slice(0, 3).join('\n'));
  });

  /**
   * A regression test for a defect this endpoint shipped with.
   *
   * `CacheHeaderInterceptor` sets its headers in a `tap` on the response
   * observable, i.e. *after* the handler returns. This route takes the socket
   * over with `@Res()` and calls `res.end()` itself, so the `tap` fired after
   * the bytes had gone and every `setHeader` was a no-op — the response went
   * out with no `Cache-Control` and no `CDN-Cache-Control` whatsoever, while
   * every ordinary route on the same interceptor got `private` plus
   * `CDN-Cache-Control: no-store`.
   *
   * That is one provider's entire per-call financial history, cacheable by any
   * intermediary that does not implement RFC 9111 §3.5 strictly — the same
   * class of cross-tenant cache leak already fixed once. `@NoCacheHeader()`
   * is the only branch of that interceptor which runs *before* `next.handle()`,
   * which is what makes it the one that works on a `@Res()` route.
   *
   * The assertion is on the wire, not on the decorator: a future refactor that
   * drops the decorator, or reorders the interceptor, has to fail here.
   */
  it("refuses caching on the wire — no intermediary may store one provider's call history", async () => {
    const response = await request(app.getHttpServer())
      .get('/providers/me/calls/export')
      .set('Authorization', `Bearer ${BEARER_TOKEN}`)
      .query({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' })
      .expect(200);

    expect(response.headers['cache-control']).toBeDefined();
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['cdn-cache-control']).toBe('no-store');
    expect(response.headers['cache-control']).not.toContain('public');

    console.log(
      'Export cache headers on the wire:\n' +
        `  cache-control    : ${response.headers['cache-control']}\n` +
        `  cdn-cache-control: ${response.headers['cdn-cache-control']}`,
    );
  });
});
