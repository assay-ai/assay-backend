import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { PostsApiModule } from './posts/posts-api.module';
import { DemoApiModule } from './demo/demo-api.module';

/**
 * API-side grouping of the starter's reference modules — see `./README.md`.
 *
 * Imported by `AppApiModule` behind `areExamplesEnabled()`. One grouping module
 * per service means the examples load and unload as a unit; gating each sample
 * separately is how you end up with a controller mounted whose worker half is
 * not, which is a confusing failure to debug for code nobody is meant to run.
 */
@Module({
  imports: [AuthModule, PostsApiModule, DemoApiModule],
})
export class ExamplesApiModule {}
