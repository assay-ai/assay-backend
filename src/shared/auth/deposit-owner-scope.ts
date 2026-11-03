import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { isHumanCallerKind } from './human-session.guard';

/**
 * Whose deposit intents a caller may see and act on: always one organization,
 * and one agent unless the caller is a person.
 *
 * A required value rather than an optional trailing `agentId` meaning "the
 * whole organization when left out": a new call site that forgot it used to
 * widen silently to org-wide. Every reader and writer of deposit intents takes
 * this, built here and nowhere else, so the rule is one line in one place.
 */
export interface DepositOwnerScope {
  readonly organizationId: string;
  /** `null` = every agent of the organization (a person's session); otherwise that agent only. */
  readonly agentId: string | null;
}

export function depositOwnerScope(session: McpSession): DepositOwnerScope {
  return {
    organizationId: session.organizationId,
    agentId: isHumanCallerKind(session.callerKind) ? null : session.agentId,
  };
}

/** The platform's own reads (sweeps, a row this request already read through a scope). */
export function organizationWideDepositScope(organizationId: string): DepositOwnerScope {
  return { organizationId, agentId: null };
}
