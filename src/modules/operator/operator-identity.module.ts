import { Module } from '@nestjs/common';

import { OperatorSessionStore } from './auth/operator-session.store';
import { OPERATOR_SIGN_IN_CONFIG, loadOperatorSignInConfig } from './auth/operator-sign-in.config';
import { OperatorSignInService } from './auth/operator-sign-in.service';
import { WalletOperatorSessionSource } from './auth/wallet-operator-session.source';
import { OPERATOR_SESSION_SOURCE } from './ports/operator-session.port';
import { OperatorAuthThrottle } from './services/operator-auth-throttle.service';
import { OperatorService } from './services/operator.service';

/**
 * The operator identity primitives: who holds a session, how a wallet signs
 * in for one, and the small lookups every arbitration flow needs.
 *
 * Deliberately narrow — no controller, no arbitration logic. `OperatorAuthGuard`
 * and `OperatorRolesGuard` (in `@shared/auth`) are what a controller actually
 * mounts; they resolve `OPERATOR_SESSION_SOURCE` from wherever this module is
 * imported. Redis comes from the global `RedisCacheModule`.
 */
@Module({
  providers: [
    { provide: OPERATOR_SIGN_IN_CONFIG, useFactory: () => loadOperatorSignInConfig() },
    OperatorSessionStore,
    OperatorSignInService,
    WalletOperatorSessionSource,
    { provide: OPERATOR_SESSION_SOURCE, useExisting: WalletOperatorSessionSource },
    OperatorAuthThrottle,
    OperatorService,
  ],
  exports: [
    OPERATOR_SESSION_SOURCE,
    OperatorSessionStore,
    OperatorSignInService,
    OperatorAuthThrottle,
    OperatorService,
  ],
})
export class OperatorIdentityModule {}
