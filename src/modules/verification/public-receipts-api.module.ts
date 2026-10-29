import { Module } from '@nestjs/common';

import { CatalogueModule } from '@modules/catalogue/catalogue.module';

import { PublicReceiptsController } from './public-receipt/public-receipt.controller';
import { PublicReceiptService } from './public-receipt/public-receipt.service';

/**
 * The public receipt route, in a module of its own so it imports nothing from
 * the verification, payment or dispute internals: the catalogue (to say which
 * providers are public) and the global Postgres module are all it needs.
 */
@Module({
  imports: [CatalogueModule],
  controllers: [PublicReceiptsController],
  providers: [PublicReceiptService],
})
export class PublicReceiptsApiModule {}
