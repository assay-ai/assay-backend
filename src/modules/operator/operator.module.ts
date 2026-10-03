import { Module } from '@nestjs/common';

import { OperatorIdentityModule } from './operator-identity.module';
import { OverrideLogService } from './services/override-log.service';

/**
 * The override register and the identity behind it.
 *
 * Deliberately small, and deliberately depending on nothing in the slash
 * domain. `SlashModule` imports this; nothing here imports that. The register
 * has to be writable by whatever comes next — a policy kill switch, a
 * compensating ledger entry, a suspended provider — and a register that knew
 * about slashing would have to gain an import for each of them.
 *
 * The console's own controllers are in `OperatorApiModule`, which is mounted
 * only by the API process. This module carries no controllers, so the scheduler
 * can import it for the override entries its sweepers do *not* write — the
 * automatic resolutions are system acts and appear on the case timeline rather
 * than in the register.
 */
@Module({
  imports: [OperatorIdentityModule],
  providers: [OverrideLogService],
  exports: [OverrideLogService, OperatorIdentityModule],
})
export class OperatorModule {}
