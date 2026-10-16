import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { applyHttpSecurity } from '@shared/security/security-headers';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { StructuredLogger } from '@shared/observability';
import { LoggingInterceptor } from '@shared/interceptors/logging.interceptor';
import { AppFacilitatorModule } from './app.module';

/**
 * The x402 facilitator process — its own service type, its own port, its own
 * address space, so the fee-payer signer's credentials (a Kora RPC endpoint, or
 * a local keypair file when `FEE_PAYER_SIGNER=local`) are never loaded into the
 * API process.
 *
 * No `app.setGlobalPrefix()` — the routes are exactly `/verify`, `/settle`,
 * `/supported`, per `facilitator.wire.ts`; a versioned `/api/v1/` prefix would
 * make this facilitator unreachable by a standard x402 client that expects
 * the bare paths from the x402 specification.
 *
 * No `TransformInterceptor` — see `facilitator.controller.ts`'s doc comment.
 * `AllExceptionsFilter` is still the single global filter: a malformed
 * request still needs to leave as the one platform `ErrorResponse` shape, the
 * same as every other process.
 */
async function bootstrapFacilitator() {
  const app = await NestFactory.create(AppFacilitatorModule, {
    logger: new StructuredLogger(),
  });
  const configService = app.get(ConfigService);

  const port = configService.get<number>('app.facilitator.port');

  applyHttpSecurity(app);

  // Any origin, but without credentials: an x402 client authenticates with the
  // payment payload, never a cookie, and `*` with credentials would be refused
  // by browsers anyway (R17-R-02).
  app.enableCors({ origin: '*' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Logging only. `TransformInterceptor` stays absent — the x402
  // facilitator responses are specified by someone else and may not be
  // wrapped — but a correlated log line changes no response body.
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.listen(port);

  console.log(`
  💸 [FACILITATOR SERVER] x402 SVM facilitator is running on: http://localhost:${port}
     POST /verify · POST /settle · GET /supported
  `);
}

export { bootstrapFacilitator };
