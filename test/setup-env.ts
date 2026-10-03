/**
 * `.env` into `process.env`, before the module graph is imported.
 *
 * Registered as a Jest `setupFiles` entry, which runs before the test file and
 * therefore before anything it imports. That ordering is the whole point, and
 * it mirrors `src/load-env.ts` in the application: modules that read
 * `process.env` at *import* time — `asset-registry.ts` resolves
 * `SOLANA_DEVNET_USDC_MINT` there, deliberately — have already run by the time
 * a `ConfigModule.forRoot()` inside a test's harness module loads the file.
 *
 * Without this the suite runs against a *different asset registry* than the
 * application does, and the disagreement shows up somewhere unrelated: a seed
 * priced in the configured mint is refused as "not a registered asset" by a
 * test whose subject is dependency injection.
 */
import '../src/load-env';
