import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { RequestContext } from '@shared/observability';

/** Who made the change — see `AuditLogEntryEntity` on why this is a pair. */
export interface AuditActor {
  readonly type: 'user' | 'agent' | 'system' | 'provider';
  readonly id: string;
}

export interface AuditEntryInput {
  readonly organizationId: string;
  readonly actor: AuditActor;
  /** Dotted and past-tense: `spend_policy.updated`, `credential.revoked`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  /** The changed fields only, as they were. Never a secret. */
  readonly before?: Record<string, unknown> | null;
  /** The changed fields only, as they are now. Never a secret. */
  readonly after?: Record<string, unknown> | null;
}

/**
 * A `before`/`after` key that names a secret is a programming error, refused
 * here rather than stored: the audit log is append-only, so a token or a
 * signature written once could never be removed. Top-level keys only — the
 * values this codebase records are flat.
 */
const SECRET_KEY = /token|secret|signature|password|private_?key/i;

/**
 * The actor behind a session: an agent machine credential is the `agent`, and
 * every other kind (a dashboard login, a config-file credential standing in for
 * one) is a `user`, named by the credential it presented — `McpSession` carries
 * no separate user id, the same answer `agent_credentials.revoked_by` gives.
 */
export function auditActorOf(session: McpSession): AuditActor {
  return session.callerKind === McpCallerKind.AGENT
    ? { type: 'agent', id: session.agentId }
    : { type: 'user', id: session.credentialId };
}

/**
 * The one writer of `audit_log_entries` (BUG-R2-B4-01).
 *
 * `request_id` is read from the ambient `RequestContext`. `ip_address` and
 * `user_agent` stay null: no request context exposes them to a service.
 */
@Injectable()
export class AuditLogWriter {
  private readonly logger = new Logger(AuditLogWriter.name);

  constructor(@InjectDataSource('postgres') private readonly dataSource: DataSource) {}

  /**
   * Appends one entry inside `manager`'s transaction. Throws on failure, so the
   * change it describes rolls back with it: no change without its entry.
   */
  async record(manager: EntityManager, entry: AuditEntryInput): Promise<void> {
    assertNoSecret(entry.before);
    assertNoSecret(entry.after);

    await manager.insert(AuditLogEntryEntity, {
      organizationId: entry.organizationId,
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ipAddress: null,
      userAgent: null,
      requestId: RequestContext.getRequestId(),
    });
  }

  /**
   * For a change that has no database transaction to join — a relayed chain
   * transaction that has already landed. Never throws: the change cannot be
   * undone, so a failed write is logged at `error` instead of lost silently.
   */
  async recordAfterCommit(entry: AuditEntryInput): Promise<void> {
    try {
      await this.record(this.dataSource.manager, entry);
    } catch (error) {
      this.logger.error(
        `audit entry ${entry.action} on ${entry.resourceType} ${entry.resourceId ?? ''} for ` +
          `organization ${entry.organizationId} was NOT recorded: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function assertNoSecret(values: Record<string, unknown> | null | undefined): void {
  const key = Object.keys(values ?? {}).find((name) => SECRET_KEY.test(name));
  if (key) {
    throw new Error(`audit entry refused: "${key}" names a secret and must not be recorded`);
  }
}

/** The keys of `after` whose value differs from `before`, as a before/after pair. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changed = Object.keys(after).filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key] ?? null])),
    after: Object.fromEntries(changed.map((key) => [key, after[key] ?? null])),
  };
}
