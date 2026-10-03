import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { PostgresModule } from '@database/postgres/postgres.module';
import {
  PUBLIC_COMPENSATION_CONFIG,
  PublicCompensationConfig,
  PublicCompensationService,
} from '@modules/settlement/services/public-compensation.service';
import { EnabledChainsModule } from '@modules/chains/enabled-chains.module';
import { ToolModule } from '@modules/tool/tool.module';

import { PublicDemoController } from './controllers/public-demo.controller';
import { DEMO_RATE_LIMITS, DemoRateLimits } from './domain/demo-rate-limit';
import { McpModule } from './mcp.module';
import { PublicDemoVerdictService } from './services/public-demo-verdict.service';
import {
  PUBLIC_DEMO_CONFIG,
  PublicDemoConfig,
  PublicDemoService,
} from './services/public-demo.service';
import {
  DEMO_RATE_LIMITS_TOKEN,
  DEMO_RATE_REDIS,
  RedisDemoRateLimiter,
} from './services/redis-demo-rate-limiter.service';

export const DEMO_MCP_TOKEN_ENV = 'DEMO_MCP_TOKEN';
export const DEMO_ORGANIZATION_ID_ENV = 'DEMO_ORGANIZATION_ID';
export const DEMO_SLASH_PROPOSAL_ID_ENV = 'DEMO_SLASH_PROPOSAL_ID';

/** The two tools the demo calls — see `scripts/mcp/seed/demo-broken-binding.ts`. */
const HEALTHY_TOOL = 'search_wikipedia';
const BROKEN_TOOL = 'search_wikipedia_demo_broken';

/** Free text, bounded — the bound plus the rate limit plus the spend policy. */
const MAX_QUERY_LENGTH = 200;

/**
 * Is the live demo configured on this deployment?
 *
 * Called **inline** in the API bootstrap's `imports`, after
 * `ConfigModule.forRoot(...)`, per `docs/architecture.md` §"Feature Flags": a
 * `process.env` read from a top-of-file constant resolves before `.env` is
 * loaded and would silently disable the module on every developer machine.
 *
 * Unset means the routes are not registered and `/demo` 404s, which the page
 * renders as "not configured on this deployment" — the same discipline the
 * proof-of-reserves page uses, and for the same reason: a demo that renders empty is a demo that
 * appears broken.
 */
export function isPublicDemoConfigured(): boolean {
  return (
    (process.env[DEMO_MCP_TOKEN_ENV] ?? '').trim().length > 0 &&
    (process.env[DEMO_ORGANIZATION_ID_ENV] ?? '').trim().length > 0
  );
}

/**
 * The live demo's public surface.
 *
 * Imports `McpModule` for the session port and the call service — the demo runs
 * through exactly the machinery an agent runs through, which is the page's
 * whole architectural claim. Nothing here is a second code path.
 */
@Module({
  imports: [EnabledChainsModule, McpModule, ToolModule, PostgresModule],
  controllers: [PublicDemoController],
  providers: [
    PublicDemoService,
    PublicDemoVerdictService,
    PublicCompensationService,
    {
      // Optional, unlike the two above: an unset proposal id means the page
      // renders no compensation strip at all, which is the honest state on a
      // deployment that has never executed a slash. It is NOT a boot failure.
      provide: PUBLIC_COMPENSATION_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PublicCompensationConfig => ({
        proposalId: (config.get<string>(DEMO_SLASH_PROPOSAL_ID_ENV) ?? '').trim() || null,
      }),
    },
    RedisDemoRateLimiter,
    { provide: DEMO_RATE_LIMITS_TOKEN, useValue: DEMO_RATE_LIMITS as DemoRateLimits },
    {
      // Its own connection rather than the shared cache client, for the reason
      // `verifier-signing.module.ts` gives next door: this one is on the path
      // that decides whether money is spent, and it must not queue behind cache
      // traffic or be taken down by it.
      provide: DEMO_RATE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.get<string>('redis.url') as string, {
          password: config.get<string>('redis.password') || undefined,
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
        }),
    },
    {
      provide: PUBLIC_DEMO_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PublicDemoConfig => {
        const token = (config.get<string>(DEMO_MCP_TOKEN_ENV) ?? '').trim();
        const organizationId = (config.get<string>(DEMO_ORGANIZATION_ID_ENV) ?? '').trim();

        // A throwing factory, the idiom `chains.module.ts` uses throughout: it
        // fails the deploy rather than logging. A demo whose organization id is
        // wrong would not break — it would answer 404 to every verdict poll and
        // look like a stuck worker, which is far harder to diagnose than a boot
        // failure naming the variable.
        if (!token || !organizationId) {
          throw new Error(
            `${DEMO_MCP_TOKEN_ENV} and ${DEMO_ORGANIZATION_ID_ENV} are both required when the ` +
              'live demo is enabled. Mint them with `yarn demo:identity`.',
          );
        }

        return {
          token,
          organizationId,
          healthyTool: HEALTHY_TOOL,
          brokenTool: BROKEN_TOOL,
          maxQueryLength: MAX_QUERY_LENGTH,
        };
      },
    },
  ],
})
export class McpApiModule {}
