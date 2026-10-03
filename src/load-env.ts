import { config } from 'dotenv';

/**
 * `.env` into `process.env`, **before any module is imported**.
 *
 * `ConfigModule.forRoot({ envFilePath: [...] })` also loads these files, and it
 * is still the right way to read configuration. But it runs when the module
 * graph is *constructed*, and a module that reads `process.env` while it is
 * being *imported* has already run by then — so it sees the ambient
 * environment, not the file.
 *
 * That is not a hypothetical shape. `src/modules/chains/ports/asset-registry.ts`
 * resolves `SOLANA_DEVNET_USDC_MINT` at import time, deliberately: an asset id
 * that changed mid-process would split one asset into two registry entries and
 * make a balance held under the old id unreachable under the new one. Under
 * `nest start` the variable was never in the environment at that moment, so the
 * registry fell back to the default mint while every script — which preloads
 * dotenv via `-r dotenv/config` — used the configured one. The two disagreed by
 * one string, and the symptom was a funded agent being told it had insufficient
 * funds, because its balance was booked under an asset the server never priced
 * anything in.
 *
 * Importing this module for its side effect, first, closes that gap. It has to
 * be an import rather than a call at the top of `main.ts`: in the emitted
 * CommonJS, every `require` runs before the first statement of the module body,
 * so a `config()` call there would still be too late.
 *
 * `.env.local` wins over `.env`, matching every `ConfigModule.forRoot` in
 * `src/bootstrap/`. Neither overrides a variable that is genuinely already set:
 * a real environment beats a file, which is what makes a container's
 * configuration authoritative over a checked-out `.env`.
 */
config({ path: ['.env.local', '.env'] });
