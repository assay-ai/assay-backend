import { Injectable } from '@nestjs/common';

import { BlockedRole, BlockHit, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { AccountBlockStatusDto, AccountBlockStatusEntryDto } from '../dto/account-block-status.dto';

/**
 * The blocks that apply to a session: its organization, its account and its
 * delegate key — the same three `BlocklistSessionSource` checks, read from the
 * same in-memory copy, so the banner and the refusals cannot disagree.
 */
@Injectable()
export class AccountBlockStatusService {
  constructor(private readonly blocklist: AccountBlocklistService) {}

  statusOf(session: McpSession): AccountBlockStatusDto {
    const candidates: [BlockedRole, BlockHit | null][] = [
      [BlockedRole.ORGANIZATION, this.blocklist.organizationBlock(session.organizationId)],
      [BlockedRole.PAYER, this.blocklist.walletBlock(session.agentAccount)],
      [BlockedRole.DELEGATE, this.blocklist.walletBlock(session.delegateAccount ?? null)],
    ];

    const blocks: AccountBlockStatusEntryDto[] = candidates
      .filter((entry): entry is [BlockedRole, BlockHit] => entry[1] !== null)
      .map(([role, hit]) => ({
        role,
        subjectKind: hit.subjectKind as BlockSubjectKind,
        subject: hit.subject,
        reasonCode: hit.reasonCode,
        blockedAt: hit.blockedAt,
      }));

    return { blocked: blocks.length > 0, blocks };
  }
}
