import { Injectable } from '@nestjs/common';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { ChainProposalStatus } from '@modules/slash/domain/chain-slash-outcome';
import { SlashCaseService } from '@modules/slash/services/slash-case.service';

/**
 * The operator's case brief: the provider's own case object, its timeline
 * and restoration record, and the on-chain mirror the console
 * acts on. Read-only.
 */
@Injectable()
export class OperatorCaseBriefService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly cases: SlashCaseService,
  ) {}

  async brief(organizationId: string, proposalId: string) {
    const [caseDto, timeline, restoration, proposal] = await Promise.all([
      this.cases.buildCase(organizationId, proposalId),
      this.cases.timeline(organizationId, proposalId),
      this.cases.restoration(organizationId, proposalId),
      this.proposals.findOneScoped(organizationId, proposalId),
    ]);

    return {
      case: caseDto,
      timeline,
      restoration,
      // Read-only, and for the operator alone: `cancel-intent` is guarded on
      // the on-chain record’s status, which the case status does not carry (a
      // case waiting for the settlement admin keeps its status), so the
      // console could never tell when to offer it.
      chainStatus: (proposal?.chainStatus ?? ChainProposalStatus.NONE) as ChainProposalStatus,
      // Read-only as well, and the deadline that goes with `CANCEL_REQUESTED`:
      // the settlement admin has to sign the cancel before this moment, because
      // from it on the record is anyone's to execute. Null until a record
      // stands on chain.
      chainExecutableAt: proposal?.chainExecutableAt ?? null,
      // How many of the case's parts are disputed on chain (audit E-4). With
      // `chainStatus: PENDING` and a non-zero count the case is partly
      // disputed: the other parts keep executing.
      chainDisputedParts: proposal?.chainDisputedParts ?? 0,
      // Why the last chain attempt failed (`chain_last_error`): a program error
      // name, a local refusal code such as `PROVIDER_STAKE_AUTHORITY_UNPROVEN`,
      // or `transport`. Null when the last attempt did not fail, so the console
      // can tell a stuck proposal from a healthy wait.
      chainLastError: proposal?.chainLastError ?? null,
      // C4: the provider's slash cases upheld or executed in the last 30 days,
      // so an operator knows when to ban a repeat offender with the blocklist.
      upheldViolations30d: proposal
        ? ((
            await this.proposals
              .countUpheldViolationsByProvider(
                [proposal.providerId],
                new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              )
              .catch(() => new Map<string, number>())
          ).get(proposal.providerId) ?? 0)
        : 0,
    };
  }
}
