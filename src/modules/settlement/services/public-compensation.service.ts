import { Inject, Injectable } from '@nestjs/common';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

export const PUBLIC_COMPENSATION_CONFIG = Symbol('PUBLIC_COMPENSATION_CONFIG');

export interface PublicCompensationConfig {
  /** The one executed proposal this page shows. Unset ⇒ the strip does not render. */
  readonly proposalId: string | null;
}

export interface PublicCompensation {
  /** What the chain took from the provider's bonded stake, in minor units. */
  readonly appliedAmount: string;
  /** What reached the harmed agents. Summed from the ledger, never derived. */
  readonly agentAmount: string;
  readonly platformAmount: string;
  readonly asset: string;
  readonly decimals: number;
  readonly executionSignature: string;
  readonly executedAt: Date;
}

/**
 * The live demo's compensation strip — one **real, already-executed** slash.
 *
 * ## Why it is not about the call the visitor just ran
 *
 * A slash needs a violated SLA window, a signed attestation and a **72-hour
 * timelock**; the visitor has no account, so there is no "you" to credit. A
 * present-tense claim — *"the provider was slashed $1.00"*, about this call
 * — cannot be true. The page shows a slash that really happened, with its
 * on-chain signature, and says so.
 *
 * ## Three numbers, and the arithmetic that does not work
 *
 * `applied ≠ agent + platform`. On the real executed proposal:
 *
 * ```text
 * applied   520000     what the chain took from bonded
 * agent     312000     60%, summed from the ledger's SLASH_DISTRIBUTION credits
 * platform  156000     30%, on the proposal row
 * retained   52000     10%, which never leaves the provider
 * ```
 *
 * So the page must not add two of them and call the result a penalty, and the
 * agent's share cannot be `applied − platform` (that is `364000` — wrong by the
 * retained tenth). It is read from where it was written.
 *
 * ## Unconfigured means the strip does not render
 *
 * Not an empty strip and not `$0.00`. Same discipline as the proof-of-reserves page's
 * `NO_RECONCILIATION`: silence asserts nothing, an empty block asserts zero.
 */
@Injectable()
export class PublicCompensationService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly entries: LedgerEntryRepository,
    @Inject(PUBLIC_COMPENSATION_CONFIG) private readonly config: PublicCompensationConfig,
  ) {}

  async read(): Promise<PublicCompensation | null> {
    if (!this.config.proposalId) {
      return null;
    }

    // The repository's own two-step: a cross-tenant point read establishes the
    // owner, then the scoped read fetches the row. The base class's guard is
    // not weakened, only entered one step later with the tenant established
    // rather than supplied — its doc comment makes that the sanctioned shape.
    const tenant = await this.proposals.tenantOf(this.config.proposalId);
    const proposal = tenant
      ? await this.proposals.findOneScoped(tenant, this.config.proposalId)
      : null;

    // Every one of these is a reason the strip has nothing true to say. A
    // proposal that was never executed has no signature and no applied amount,
    // and rendering it would describe a penalty that did not happen.
    if (
      !proposal ||
      !proposal.executedAt ||
      !proposal.executionSignature ||
      !proposal.appliedAmount ||
      !proposal.platformAmount
    ) {
      return null;
    }

    const agentAmount = await this.entries.sumSlashDistributionBySignature(
      proposal.executionSignature,
    );

    return {
      appliedAmount: proposal.appliedAmount,
      agentAmount,
      platformAmount: proposal.platformAmount,
      asset: proposal.assetId,
      decimals: proposal.decimals,
      executionSignature: proposal.executionSignature,
      executedAt: proposal.executedAt,
    };
  }
}
