import { Module } from '@nestjs/common';

import { SlashLifecycleJob } from './jobs/slash-lifecycle.job';
import { SLASH_CHAIN_RULINGS } from './ports/slash-chain-rulings.port';
import { SlashChainRulingService } from './services/slash-chain-ruling.service';
import { SlashModule } from './slash.module';

/**
 * Scheduler-only half of the slash domain.
 *
 * Same shape and same reason as `ProviderSchedulerModule`: only
 * `AppSchedulerModule` imports this, and the scheduler runs as a single
 * instance. Importing it into the API would let every replica race the same
 * sweep — the compare-and-swaps would leave exactly one winner, so nothing
 * would break, but N-1 replicas would spend a query a minute discovering they
 * lost.
 *
 * More importantly, it is the process boundary that decides where a slash can
 * actually be *run* from: `SlashLifecycleJob` — the only caller of
 * `executeDue()` in `src/` — exists solely in the process that imports this.
 *
 * ## What that boundary is NOT
 *
 * It is **not** `SLASH_EXECUTOR` being absent elsewhere. `ChainsModule` provides
 * `{ provide: SLASH_EXECUTOR, useExisting: SolanaSlashExecutor }`
 * unconditionally, with no `SERVICE_TYPE` gate.
 *
 * What keeps an API pod from taking a provider's stake is one level down:
 * `SolanaSlashExecutor` resolves `VerifierSigningService` through `ModuleRef`
 * **at call time**, and only the worker bootstrap imports
 * `VerifierSigningModule`, so in every other process that lookup throws — loudly,
 * at the first call, in whichever process has no business signing. That is the
 * real control, it is documented where it lives (`chains.module.ts`, and
 * `SolanaSlashExecutor`'s class comment), and it is strictly stronger than a
 * missing provider would be.
 *
 * Worth stating precisely because the wrong version travels: it reached project
 * memory and, from there, the evidence string of a devnet acceptance step, which
 * ended up asserting a guarantee the wiring does not give. Three hops from one
 * sentence.
 */
@Module({
  imports: [SlashModule],
  providers: [
    SlashLifecycleJob,
    // The chain watcher's `SlashDisputed` / `SlashUpheld` (D-19) land here; the
    // watcher resolves the token through `ModuleRef` in this same process.
    SlashChainRulingService,
    { provide: SLASH_CHAIN_RULINGS, useExisting: SlashChainRulingService },
  ],
})
export class SlashSchedulerModule {}
