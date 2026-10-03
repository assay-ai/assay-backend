import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EgressHttpClient } from './egress';

/**
 * Outbound HTTP, for every service type.
 *
 * `@Global` so that no module has to remember to import it: a module that
 * cannot inject `EgressHttpClient` is a module that will reach for `axios`, and
 * the whole point of `src/shared/network/egress/` is that there is nowhere else
 * to reach.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [EgressHttpClient],
  exports: [EgressHttpClient],
})
export class NetworkModule {}
