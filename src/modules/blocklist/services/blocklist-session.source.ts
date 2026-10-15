import { AccountErrors } from '@modules/account/errors/account.errors';
import { AuthErrors } from '@modules/auth/errors/auth.errors';
import {
  McpCallerKind,
  McpSession,
  McpSessionPort,
  SessionBlock,
} from '@modules/mcp/ports/mcp-session.port';
import { BaseError } from '@shared/errors/base.error';

import { BlockedRole, BlockSubjectKind } from '../domain/account-block';
import { AccountBlocklistService } from './account-blocklist.service';

/** The callers who may still read while blocked — the same set `HumanSessionGuard` admits. */
const READ_WHILE_BLOCKED: ReadonlySet<McpCallerKind> = new Set([
  McpCallerKind.HUMAN,
  McpCallerKind.CONFIG,
]);

/**
 * The account blocklist, applied to every bearer token at once.
 *
 * Wraps whichever `McpSessionPort` `AUTH_SESSION_SOURCE` selects, so every
 * route that resolves a session — `SessionAuthGuard`, the MCP endpoint, the
 * public demo — sees the block, and no source has to remember to check it.
 *
 * ## What a blocked caller gets
 *
 * - **A machine credential** (`AGENT`: the agent's own `assay_sk_live_…` key) is
 *   refused here. An agent has no "read why I am blocked" screen, and its
 *   token may be the very thing that leaked.
 * - **A person** (`HUMAN`, or `CONFIG`, which stands in for one) gets a session
 *   with `blocked` set. `SessionAuthGuard` lets it read and refuses every write;
 *   the MCP endpoint refuses it outright. That keeps the dashboard able to show
 *   the account's own data and the block itself (`GET /account/block-status`).
 *
 * The refusal for the organization is `AUTH_ORGANIZATION_SUSPENDED`, the code a
 * `SUSPENDED` organization already gets; for a wallet it is `ACCOUNT_BLOCKED`.
 */
export class BlocklistSessionSource implements McpSessionPort {
  constructor(
    private readonly inner: McpSessionPort,
    private readonly blocklist: AccountBlocklistService,
  ) {}

  async resolve(bearerToken: string | null): Promise<McpSession> {
    const session = await this.inner.resolve(bearerToken);

    const blocked = this.blocklist.firstBlocked([
      {
        role: BlockedRole.ORGANIZATION,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: session.organizationId,
      },
      { role: BlockedRole.PAYER, kind: BlockSubjectKind.WALLET, subject: session.agentAccount },
      {
        role: BlockedRole.DELEGATE,
        kind: BlockSubjectKind.WALLET,
        subject: session.delegateAccount ?? null,
      },
    ]);
    if (!blocked) return session;

    const block: SessionBlock = { role: blocked.role, subjectKind: blocked.hit.subjectKind };
    if (!READ_WHILE_BLOCKED.has(session.callerKind)) {
      throw sessionBlockedError(block);
    }
    return { ...session, blocked: block };
  }
}

/** The refusal for a blocked session — see the class comment for which code is which. */
export function sessionBlockedError(block: SessionBlock): BaseError {
  return block.role === BlockedRole.ORGANIZATION
    ? AuthErrors.organizationSuspended()
    : AccountErrors.accountBlocked({ role: block.role, subjectKind: block.subjectKind });
}
