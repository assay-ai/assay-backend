import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';

/**
 * Refuses to boot any process that carries the payment module — the API, the
 * MCP server and the scheduler — when the buyer-debt migrations
 * (`1760600000000`, `1760700000000`, `1760800000000`) have not run
 * (review-buyer-debt H2). `migrationsRun` is off, so nothing else would stop a
 * build from starting against an older schema, and every paid call would then
 * fail on the debt check with a SQL error. The deploy order and the rollback
 * hazard are in `docs/runbooks/buyer-debt-deploy.md`.
 */
@Injectable()
export class BuyerDebtSchemaCheck implements OnApplicationBootstrap {
  constructor(private readonly intents: PaymentIntentRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.intents.assertBuyerDebtSchema();
  }
}
