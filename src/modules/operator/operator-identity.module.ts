import { Module } from '@nestjs/common';

import { OPERATOR_SESSION_SOURCE } from './ports/operator-session.port';
import {
  ConfigOperatorSessionSource,
  OPERATOR_CREDENTIAL_SNAPSHOT,
  loadOperatorCredentials,
} from './services/config-operator-session.source';
import { OperatorService } from './services/operator.service';

/**
 * The operator identity primitives: who is holding the token, and the small
 * lookups every arbitration flow needs.
 *
 * Deliberately narrow — no controller, no arbitration logic. `OperatorAuthGuard`
 * and `OperatorRolesGuard` (in `@shared/auth`) are what a controller actually
 * mounts; they resolve `OPERATOR_SESSION_SOURCE` from wherever this module is
 * imported. The console's routes, the decision flow and the override log
 * belong to a sibling module this one does not define — mirroring
 * `mcp.module.ts` / `mcp-http.module.ts`'s split between "the domain" and
 * "the thing that opens an HTTP route".
 */
@Module({
  providers: [
    // Empty until an operator points `OPERATOR_CREDENTIALS_FILE` at a file.
    // An empty snapshot refuses every request — the correct behaviour for a
    // server with no issued operator credentials.
    { provide: OPERATOR_CREDENTIAL_SNAPSHOT, useFactory: () => loadOperatorCredentials() },
    ConfigOperatorSessionSource,
    { provide: OPERATOR_SESSION_SOURCE, useExisting: ConfigOperatorSessionSource },
    OperatorService,
  ],
  exports: [ConfigOperatorSessionSource, OPERATOR_SESSION_SOURCE, OperatorService],
})
export class OperatorIdentityModule {}
