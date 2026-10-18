import { Inject, Injectable, Logger } from '@nestjs/common';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { agentLabelOf, formatNoticeTime } from '@modules/notification/domain/notice-text';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';

import {
  CREDENTIAL_EXPIRY_SWEEP_CONFIG,
  CREDENTIAL_EXPIRY_WARNING_T1_MS,
  CREDENTIAL_EXPIRY_WARNING_T7_MS,
  CredentialExpirySweepConfig,
} from '../constants/credential-expiry.constants';

export interface CredentialExpirySweepSummary {
  readonly checked: number;
  readonly warnedT7: number;
  readonly warnedT1: number;
  readonly expired: number;
}

/**
 * Sweeps `agent_credentials.expires_at` for `session.expiring` /
 * `session.expired`.
 *
 * ## This is a credential, not a "session"
 *
 * `AgentCredentialEntity` is the machine token `POST
 * /agents/:agentId/credentials` issues — a bearer secret an
 * agent's own process holds, hashed at rest, revocable, with no human present
 * at call time. Privy connect is where a *session signer* — a
 * human-authorised delegation with its own lifecycle — will eventually exist,
 * and it does not exist anywhere in this codebase yet. This class, its
 * events, and their copy must never call an `AgentCredentialEntity` row a
 * "session"; doing so would claim a feature that is not built. The
 * notification catalogue uses the word for both concepts loosely —
 * `session.expiring` is the wire event name and predates the
 * Privy/credential distinction — but the row underneath it, today, is always
 * a credential.
 *
 * ## Why the sweep tolerates being found in the same window twice
 *
 * A cron that ran on the exact day a credential crosses T−7d would need to
 * never miss a run — a deploy, a scheduler restart, or a slow pass would skip
 * that credential's only chance to warn. Instead this sweep is deliberately
 * imprecise: every pass re-finds every credential still inside its warning
 * window and calls `notify()` again. `NotificationAggregation.ONCE`, keyed by
 * `` `${credentialId}:T-7` ``, is what turns "found repeatedly" into
 * "delivered exactly once" — see `NOTIFICATION_CATALOGUE[SESSION_EXPIRING]`.
 */
@Injectable()
export class CredentialExpirySweepService {
  private readonly logger = new Logger(CredentialExpirySweepService.name);

  constructor(
    private readonly credentials: AgentCredentialRepository,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(CREDENTIAL_EXPIRY_SWEEP_CONFIG) private readonly config: CredentialExpirySweepConfig,
    // Read only to name the agent in a notice body.
    private readonly agents: AgentRepository,
  ) {}

  /** One pass over every organization's credentials. Never throws. */
  async sweep(): Promise<CredentialExpirySweepSummary> {
    const now = new Date(this.config.now());
    const horizon = new Date(now.getTime() + CREDENTIAL_EXPIRY_WARNING_T7_MS);

    let candidates: AgentCredentialEntity[];
    try {
      candidates = await this.credentials
        .createQueryBuilder('credential')
        // Cross-organization, deliberately: this is the platform's own promise
        // to warn before every credential lapses, not a query scoped to one
        // tenant that happens to ask about all of them — the same idiom
        // `ProviderRepository.findAllProviders` and the evidence-retention
        // sweeps use, and it is on `surface-consistency.spec.ts`'s allowlist
        // under this file's own path.
        .where('credential.organizationId IS NOT NULL')
        .andWhere('credential.revokedAt IS NULL')
        .andWhere('credential.expiresAt IS NOT NULL')
        .andWhere('credential.expiresAt <= :horizon', { horizon })
        .getMany();
    } catch (error) {
      this.logger.error(`Could not read credentials due for expiry: ${describe(error)}`);
      return { checked: 0, warnedT7: 0, warnedT1: 0, expired: 0 };
    }

    let warnedT7 = 0;
    let warnedT1 = 0;
    let expired = 0;

    for (const credential of candidates) {
      try {
        const outcome = await this.evaluate(credential, now);
        if (outcome === 'T7') warnedT7 += 1;
        else if (outcome === 'T1') warnedT1 += 1;
        else if (outcome === 'EXPIRED') expired += 1;
      } catch (error) {
        this.logger.error(
          `Credential-expiry notification failed for ${credential.id}: ${describe(error)}`,
        );
      }
    }

    return { checked: candidates.length, warnedT7, warnedT1, expired };
  }

  private async evaluate(
    credential: AgentCredentialEntity,
    now: Date,
  ): Promise<'T7' | 'T1' | 'EXPIRED' | 'none'> {
    const msUntilExpiry = credential.expiresAt.getTime() - now.getTime();
    if (msUntilExpiry > CREDENTIAL_EXPIRY_WARNING_T7_MS) return 'none';

    const key = await this.keyPhrase(credential);
    const expires = formatNoticeTime(credential.expiresAt);

    if (msUntilExpiry <= 0) {
      await this.notifications.notify({
        organizationId: credential.organizationId,
        event: NotificationEvent.SESSION_EXPIRED,
        title: 'Agent credential expired',
        body: `${key} expired and can no longer authenticate. Make a new key to keep this agent running.`,
        subjectType: 'credential',
        subjectId: credential.id,
        payload: {
          credentialId: credential.id,
          agentId: credential.agentId,
          expiresAt: credential.expiresAt,
        },
        dedupeKey: credential.id,
      });
      return 'EXPIRED';
    }

    if (msUntilExpiry <= CREDENTIAL_EXPIRY_WARNING_T1_MS) {
      await this.notifications.notify({
        organizationId: credential.organizationId,
        event: NotificationEvent.SESSION_EXPIRING,
        title: 'Agent credential expiring tomorrow',
        body: `${key} expires ${expires}. Renew it now or this agent stops working.`,
        subjectType: 'credential',
        subjectId: credential.id,
        payload: {
          credentialId: credential.id,
          agentId: credential.agentId,
          expiresAt: credential.expiresAt,
          stage: 'T-1',
        },
        dedupeKey: `${credential.id}:T-1`,
      });
      return 'T1';
    }

    if (msUntilExpiry <= CREDENTIAL_EXPIRY_WARNING_T7_MS) {
      await this.notifications.notify({
        organizationId: credential.organizationId,
        event: NotificationEvent.SESSION_EXPIRING,
        title: 'Agent credential expiring in a week',
        body: `${key} expires ${expires}. Renew it before then.`,
        subjectType: 'credential',
        subjectId: credential.id,
        payload: {
          credentialId: credential.id,
          agentId: credential.agentId,
          expiresAt: credential.expiresAt,
          stage: 'T-7',
        },
        dedupeKey: `${credential.id}:T-7`,
      });
      return 'T7';
    }

    return 'none';
  }

  /** `Key "CI deploy" (assay_live_ab12…) of "research-bot"`: names, never ids. */
  private async keyPhrase(credential: AgentCredentialEntity): Promise<string> {
    const label = await agentLabelOf(this.agents, credential.organizationId, credential.agentId);
    return `Key "${credential.name}" (${credential.prefix}…) of ${label ? `"${label}"` : 'your agent'}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
