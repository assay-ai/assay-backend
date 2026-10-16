import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder, SwaggerCustomOptions } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import { assertTrustProxyHopsConfigured, parseCorsAllowedOrigins } from '@config/app.config';
import { applyHttpSecurity } from '@shared/security/security-headers';
import { buildApiCorsOptionsDelegate } from '@shared/security/cors-policy';
import { AppApiModule } from './app.module';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { HttpCacheInterceptor } from '@shared/interceptors/http-cache.interceptor';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { CacheHeaderInterceptor } from '@shared/interceptors/cache-header.interceptor';
import { CacheService } from '@shared/cache/redis-cache/cache.service';
import { SingleFlightService } from '@shared/services/single-flight.service';
import { SingleFlightInterceptor } from '@shared/interceptors/single-flight.interceptor';
import { StructuredLogger } from '@shared/observability';

async function bootstrapApi() {
  const app = await NestFactory.create<NestExpressApplication>(AppApiModule, {
    logger: new StructuredLogger(),
  });
  const configService = app.get(ConfigService);

  // Get config
  const port = configService.get<number>('app.api.port');

  // Client address
  //
  // `request.ip` is what the operator sign-in throttle counts against. Behind
  // a load balancer it is the balancer's address unless Express is told how
  // many proxies to trust, and then every caller shares one counter. Production
  // sets `API_TRUST_PROXY_HOPS` to the number of proxies in front of the API;
  // locally it is 0 and `X-Forwarded-For` is ignored (`parseTrustProxyHops`).
  // Production refuses to start with it unset; `.env` is loaded by now.
  assertTrustProxyHopsConfigured();
  app.set('trust proxy', configService.get<number>('app.api.trustProxyHops') ?? 0);

  // Security headers, and no `X-Powered-By` (R17-R-02).
  applyHttpSecurity(app);

  // Global prefix
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI, // /api/v1/..., /api/v2/...
    defaultVersion: '1', // Default v1
  });

  // CORS
  //
  // Two policies, chosen per request (`src/shared/security/cors-policy.ts`):
  //
  // - Reads of `/api/v1/public/*` get a fixed `Access-Control-Allow-Origin: *`
  //   with no credentials and only GET/HEAD/OPTIONS. Those responses are
  //   CDN-cacheable (`CDN-Cache-Control: public`) and Cloudflare does not key
  //   on `Vary: Origin`; an origin-reflecting header there would let whichever
  //   request fills the cache decide CORS for every visitor.
  //
  // - Everything else uses the `CORS_ALLOWED_ORIGINS` allowlist, never `*`:
  //   with `credentials: true` a wildcard would let any website call the API
  //   as the signed-in user. Only a listed origin is reflected back; outside
  //   production the default is the local dashboards on :3000, :4000-:4005 and
  //   :4020, and production refuses to start without the variable
  //   (`parseCorsAllowedOrigins`).
  //
  // `exposedHeaders` (`API_EXPOSED_HEADERS`) is not decoration. A cross-origin
  // browser client can read only the seven CORS-safelisted response headers
  // unless the server names the rest, so without this list
  // `GET /providers/me/calls/export` reaches the console as a CSV body with no
  // metadata: `X-Assay-Export-Row-Count`, `X-Assay-Export-Total-Matching`,
  // `X-Assay-Export-Truncated` and even the filename in `Content-Disposition`
  // are silently dropped by the browser, with no error anywhere. `Retry-After`
  // is exposed so a client can show how long a 429 asks it to wait.
  //
  // The three `X-Assay-Export-*` headers are `docs/api-list-contract.md`'s
  // no-silent-caps rule applied to a response the JSON envelope cannot wrap —
  // they are the only way the export says how many rows it returned and whether
  // it hit its cap. A client that cannot read `X-Assay-Export-Truncated` has to
  // either show nothing or assume `false`, and assuming `false` tells a provider
  // their financial export is complete on exactly the evidence that it might not
  // be. That is the failure mode this list exists to prevent.
  //
  // `Content-Type`, `Cache-Control`, `Pragma` and `Expires` are already
  // safelisted. `CDN-Cache-Control` and `Vary` are instructions to
  // intermediaries and no browser client reads them.
  //
  // `src/bootstrap/mcp/main.ts` sets its own list for the Streamable HTTP
  // session headers; the two services expose different things and neither list
  // is the other's.
  app.enableCors(buildApiCorsOptionsDelegate(parseCorsAllowedOrigins()));

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global filter — exactly one, deliberately. AllExceptionsFilter catches
  // every exception and emits the single ErrorResponse shape. A second filter
  // registered here would take precedence for its own exception type and
  // reintroduce the two-shape problem it replaced.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global interceptors
  const reflector = app.get(Reflector);
  const configServiceInstance = app.get(ConfigService);

  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(reflector),
    new CacheHeaderInterceptor(reflector, configServiceInstance),
    new SingleFlightInterceptor(reflector, app.get(SingleFlightService)),
    new HttpCacheInterceptor(app.get(CacheService), reflector, configServiceInstance),
  );

  // Swagger
  //
  // The description below is the contract a client author needs before reading
  // any single endpoint — how to page, how to sort, what an error looks like,
  // and why a resource that exists can answer 404. Putting it here rather than
  // repeating it on 40 `@ApiOperation`s means there is one copy to keep true.
  const config = new DocumentBuilder()
    .setTitle('GoAssay.AI API')
    .setDescription(
      [
        'REST surface for the GoAssay.AI buyer and provider dashboards.',
        '',
        '### Responses',
        'Success bodies are wrapped: `{ data, statusCode, message }`.',
        'Failures use one shape and only one:',
        '```json',
        '{ "success": false, "error": { "code": "PAYMENT_INTENT_NOT_FOUND",',
        '  "message": "…", "statusCode": 404, "path": "…", "timestamp": "…" } }',
        '```',
        '',
        '### Pagination — cursor, everywhere',
        'Every list endpoint takes `cursor`, `limit` (1–100, default 25), `sort`,',
        '`order` (`asc`/`desc`), `from`, `to`, `search`, and returns',
        '`{ items, pageInfo: { nextCursor, hasMore } }`.',
        '',
        'Cursors are **opaque** — pass back `pageInfo.nextCursor` verbatim. Do not',
        'construct or parse them. A cursor is bound to the ordering it was taken',
        'under, so changing `sort` or `order` mid-pagination returns',
        '`API_INVALID_CURSOR` rather than a silently mis-paged result.',
        '',
        '`nextCursor: null` is the only end-of-list signal. A short page does not',
        'mean the end — filters are applied before the limit.',
        '',
        'There is no total count on a page. Totals come from the summary endpoints',
        '(`/receipts/summary`), which aggregate server-side and state their window.',
        '',
        '### Time windows',
        '`from` / `to` are half-open — `[from, to)` — so adjacent windows partition',
        'rather than overlap. All timestamps are ISO-8601 UTC.',
        '',
        '### Money',
        'Always `{ amount, asset, decimals }`, where `amount` is atomic units as a',
        'decimal **string**. Never a float, never a bare number.',
        '',
        '### Authorisation, and why you may see a 404 for something that exists',
        'Send `Authorization: Bearer <session token>`. Every request is scoped to',
        'the organization behind that token; `organizationId` is never accepted as',
        'a parameter.',
        '',
        'Asking for another organization’s resource id returns **404, not 403**.',
        'A 403 would confirm the resource exists, which lets an id be enumerated',
        'from the status code alone. From the caller’s tenant, 404 is also true.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description:
        'Session token. Resolved through `McpSessionPort` — the same credential MCP uses.',
    })
    .addServer(`http://localhost:${port}`, 'Local')
    .build();

  const customOptions: SwaggerCustomOptions = {
    swaggerOptions: {
      persistAuthorization: true,
      // Endpoints are grouped by tag and collapsed; the surface is wide enough
      // that an expanded default renders as an unreadable wall.
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'GoAssay.AI API',
  };

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, customOptions);

  await app.listen(port);

  const bullBoardEnabled = configService.get<boolean>('bullboard.enabled');
  const bullBoardPath = configService.get<string>('bullboard.path');
  const bullBoardLine = bullBoardEnabled
    ? `\n  🐂 Bull Board: http://localhost:${port}/api${bullBoardPath}`
    : '';

  console.log(`
  🚀 [API SERVER] Application is running on: http://localhost:${port}
  📚 Swagger documentation: http://localhost:${port}/api/docs${bullBoardLine}
  `);
}

export { bootstrapApi };
