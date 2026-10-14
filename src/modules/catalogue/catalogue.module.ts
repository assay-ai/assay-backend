import { Module } from '@nestjs/common';

import { BlocklistModule } from '@modules/blocklist/blocklist.module';
import { ChainsModule } from '@modules/chains/chains.module';
import { FreeTierModule } from '@modules/free-tier/free-tier.module';
import { ProviderModule } from '@modules/provider/provider.module';
import { ToolModule } from '@modules/tool/tool.module';

import { CatalogueService } from './services/catalogue.service';
import { PublicCatalogueService } from './services/public-catalogue.service';
import { PublicNotChargedService } from './services/public-not-charged.service';

/**
 * The buyer's read model over the tool and provider domains.
 *
 * It owns no table and no port. `ToolModule` gives it `TOOL_CATALOGUE` and the
 * router's `quote()`; `ProviderModule` gives it `PROVIDER_STAKE_SOURCE`; the
 * three repositories resolve out of the `@Global` `PostgresModule`. That is the
 * whole dependency list, and it is why this is a module rather than a handful
 * of routes bolted onto one of the two domains: the catalogue is *about* the
 * join between them, and putting it in either would make that domain import the
 * other for a reason unrelated to its own work.
 *
 * No cycle: `ToolModule` already imports `ProviderModule`, and nothing imports
 * this.
 */
@Module({
  // `ChainsModule` for `ENABLED_CHAINS` alone: this catalogue is anonymous, so
  // the `RoutingContext` it quotes with names every chain the deployment offers
  // rather than a buyer's.
  // `FreeTierModule` for `FREE_QUOTA_CONFIG`: a binding with no quota of its
  // own grants the platform default, and the catalogue says which.
  imports: [ChainsModule, ToolModule, ProviderModule, BlocklistModule, FreeTierModule],
  providers: [CatalogueService, PublicCatalogueService, PublicNotChargedService],
  exports: [CatalogueService, PublicCatalogueService, PublicNotChargedService],
})
export class CatalogueModule {}
