import { Injectable, Logger } from '@nestjs/common';

import { OperatorRepository } from '@database/postgres/repositories/operator.repository';

import { OperatorErrors } from '../errors/operator.errors';
import { OperatorSession, OperatorSessionPort } from '../ports/operator-session.port';
import { OperatorService } from '../services/operator.service';
import { OperatorSessionStore } from './operator-session.store';

/**
 * Resolves the session token a wallet sign-in issued (`OperatorSignInService`).
 *
 * Two checks, every request: the session is live in Redis (not expired, not
 * revoked by logout or by removal), and its operator row is still `ACTIVE`
 * (read through `OperatorService`'s few-second cache). The roles and the limit
 * come from the row, never from the session, so a change to either applies to
 * sessions already issued.
 */
@Injectable()
export class WalletOperatorSessionSource implements OperatorSessionPort {
  private readonly logger = new Logger(WalletOperatorSessionSource.name);

  constructor(
    private readonly store: OperatorSessionStore,
    private readonly directory: OperatorService,
    private readonly operators: OperatorRepository,
  ) {}

  async resolve(bearerToken: string | null): Promise<OperatorSession> {
    if (!bearerToken) throw OperatorErrors.credentialInvalid();

    const stored = await this.store.find(bearerToken);
    if (!stored) throw OperatorErrors.credentialInvalid();

    const operator = await this.directory.findActiveCached(stored.operatorId);
    if (!operator) {
      // Removed or suspended since signing in. The session can never be good
      // again, so it goes now rather than at its TTL.
      await this.store.revoke(bearerToken);
      throw OperatorErrors.notAuthorized();
    }

    this.stampLastSeen(operator.id);
    return this.directory.sessionOf(operator);
  }

  /**
   * Fire-and-forget: `last_seen_at` is observability, not authorization, so a
   * failed stamp must never fail the request.
   */
  private stampLastSeen(operatorId: string): void {
    this.operators.update({ id: operatorId }, { lastSeenAt: new Date() }).catch((error) => {
      this.logger.warn(`failed to stamp last_seen_at for operator ${operatorId}: ${error}`);
    });
  }
}
