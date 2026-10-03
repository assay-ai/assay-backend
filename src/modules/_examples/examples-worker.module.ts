import { Module } from '@nestjs/common';
import { PostsWorkerModule } from './posts/posts-worker.module';
import { DemoWorkerModule } from './demo/demo-worker.module';

/**
 * Worker-side grouping of the starter's reference modules — see `./README.md`.
 *
 * Imported by `AppWorkerModule` behind `areExamplesEnabled()`. Holds only the
 * `*-worker.module.ts` variants: these instantiate `@Processor()` classes,
 * which start consuming from Redis the moment they are constructed.
 */
@Module({
  imports: [PostsWorkerModule, DemoWorkerModule],
})
export class ExamplesWorkerModule {}
