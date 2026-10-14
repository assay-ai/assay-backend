import { Injectable } from '@nestjs/common';

import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import {
  LookupSlashRequestsResponseDto,
  SlashRequestMatchDto,
} from '../dto/slash-request-lookup.dto';

/**
 * Which on-chain slash request ids are this provider's own Assay cases.
 *
 * The provider console's "Penalties on chain" page reads slash records from
 * the chain and asks here which of them Assay decided. A `Pending` record with
 * no case behind it is the signature of a forged slash — a leaked verifier key
 * proposing a penalty no Assay process decided — so the answer has to be
 * exact, and it has to be private:
 *
 * - **Both tables.** A case's own id is `slash_proposals.chain_request_id`; a
 *   pro-rata case is put on chain as one record per harmed agent, each under
 *   its part's `slash_proposal_parts.chain_request_id`.
 * - **Scoped to the caller.** Both reads bind `organization_id` to the session,
 *   so another provider's id answers exactly like an id that never existed:
 *   absent. Nothing in the response depends on whether a foreign case exists.
 */
@Injectable()
export class SlashRequestLookupService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly parts: SlashProposalPartRepository,
  ) {}

  async lookup(
    organizationId: string,
    requestIds: readonly string[],
  ): Promise<LookupSlashRequestsResponseDto> {
    // Stored as 64 lower-case hex characters with no prefix.
    const wanted = [...new Set(requestIds.map((id) => id.slice(2).toLowerCase()))];

    const [cases, parts] = await Promise.all([
      this.proposals.findOwnByChainRequestIds(organizationId, wanted),
      this.parts.findOwnByChainRequestIds(organizationId, wanted),
    ]);

    const matches: SlashRequestMatchDto[] = [
      ...cases.map((row) => ({ requestId: `0x${row.chainRequestId}`, proposalId: row.id })),
      ...parts.map((row) => ({
        requestId: `0x${row.chainRequestId}`,
        proposalId: row.proposalId,
        partId: row.id,
      })),
    ];
    // In the order asked, so a client can zip the answer against its request.
    const order = new Map(wanted.map((id, index) => [`0x${id}`, index]));
    matches.sort((a, b) => (order.get(a.requestId) ?? 0) - (order.get(b.requestId) ?? 0));

    return { matches };
  }
}
