import { Module } from '@nestjs/common';
import { DemoModule } from './demo.module';
import { DemoPingProcessor } from './processors/demo-ping.processor';

/**
 * Worker-side demo module — imported only by `AppWorkerModule`.
 *
 * Holds anything whose mere instantiation kicks off background work — BullMQ
 * processors (`@Processor()` starts a Worker that immediately consumes from
 * Redis) and `@nestjs/schedule` cron sweepers (when feature work adds them).
 * Keeping these out of `DemoApiModule` is what guarantees the api process
 * does not accidentally become a consumer.
 */
@Module({
  imports: [DemoModule],
  providers: [DemoPingProcessor],
})
export class DemoWorkerModule {}
