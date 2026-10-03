import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChainsModule } from './chains.module';
import { PUBLIC_RPC_URLS, PUBLIC_RPC_URLS_ENV, parsePublicRpcUrls } from './public-rpc-urls';
import { ChainsController } from './controllers/chains.controller';
import { ChainDirectoryService } from './services/chain-directory.service';

/**
 * The api-only half of `chains/` — one controller.
 *
 * Separate from `ChainsModule` for the reason `docs/architecture.md` §"Queue
 * Pattern" gives for every other `*-api.module.ts`: the worker, scheduler and
 * MCP bootstraps import `ChainsModule` for its ports and must not gain an HTTP
 * route by doing so.
 */
@Module({
  imports: [ChainsModule],
  controllers: [ChainsController],
  providers: [
    {
      // Read here rather than in `ChainsModule`: only the chain list serves it,
      // and a value every process parses is a value every process could leak.
      provide: PUBLIC_RPC_URLS,
      useFactory: (config: ConfigService) =>
        parsePublicRpcUrls(config.get<string>(PUBLIC_RPC_URLS_ENV)),
      inject: [ConfigService],
    },
    ChainDirectoryService,
  ],
})
export class ChainsApiModule {}
