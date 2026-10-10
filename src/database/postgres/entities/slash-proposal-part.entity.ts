import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One harmed agent's part of a window-level slash case, and the on-chain
 * judgement that pays it.
 *
 * A window-level SLA penalty on EVM is compensated **pro rata on chain**: one
 * verifier-signed `SlashAttestation` per harmed agent, each naming that
 * agent's account as `beneficiary` and its share of the window penalty as
 * `penalty`, so `executeSlash` pays the agent's 60% straight to the agent.
 * The case (`slash_proposals`) stays ONE case for the dispute flow; this table
 * is what that one judgement is made of on chain.
 *
 * Rows are per `(proposal, chain_epoch, agent)`. A cancel-and-bump moves the
 * case to a new epoch and the plan is recomputed under fresh request ids; the
 * previous epoch's rows stay as the record of what was signed then.
 *
 * Organization-scoped by the case's own `organization_id` (the provider's),
 * never the agent's: a part is a fact about the provider's judgement.
 *
 * No soft delete: a part names money that moved, or a reservation that held a
 * provider's stake.
 */
@Entity('slash_proposal_parts')
@Index('idx_slash_proposal_parts_proposal', ['proposalId', 'chainEpoch'])
export class SlashProposalPartEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'proposal_id', type: 'uuid' })
  proposalId: string;

  @Column({ name: 'chain_epoch', type: 'int' })
  chainEpoch: number;

  @Column({ name: 'window_id', type: 'uuid' })
  windowId: string;

  /** CAIP-10, normalised (EVM lower-case). The harmed agent. */
  @Column({ name: 'agent_account', type: 'varchar', length: 256 })
  agentAccount: string;

  /** CAIP-10. Who the attestation names; on EVM the agent's own account. */
  @Column({ name: 'beneficiary_account', type: 'varchar', length: 256 })
  beneficiaryAccount: string;

  /** Σ price of the agent's DATA_FAIL calls in the window, minor units. */
  @Column({ name: 'weight_amount', type: 'numeric', precision: 78, scale: 0 })
  weightAmount: string;

  /** The agent's exact share of the case penalty before any on-chain cap. */
  @Column({ name: 'uncapped_share_amount', type: 'numeric', precision: 78, scale: 0 })
  uncappedShareAmount: string;

  /** What the attestation is signed for. */
  @Column({ name: 'penalty_amount', type: 'numeric', precision: 78, scale: 0 })
  penaltyAmount: string;

  /** The case penalty the plan split, and Σ of every part's penalty — the same on every row. */
  @Column({ name: 'plan_penalty_amount', type: 'numeric', precision: 78, scale: 0 })
  planPenaltyAmount: string;

  @Column({ name: 'plan_capped_total', type: 'numeric', precision: 78, scale: 0 })
  planCappedTotal: string;

  /** `ProRataCapBinding` — what, if anything, scaled the plan down. */
  @Column({ name: 'cap_binding', type: 'varchar', length: 16 })
  capBinding: string;

  /** 32 bytes, lower-case hex — `slashPartRequestId(window, case request id, agent)`. */
  @Column({ name: 'chain_request_id', type: 'char', length: 64 })
  chainRequestId: string;

  /** `NONE`, `PENDING`, `EXECUTED`, `CANCELLED` or `REFUSED`. */
  @Column({ name: 'chain_status', type: 'varchar', length: 16, default: 'NONE' })
  chainStatus: string;

  @Column({ name: 'chain_proposed_at', type: 'timestamptz', nullable: true })
  chainProposedAt: Date | null;

  @Column({ name: 'chain_executable_at', type: 'timestamptz', nullable: true })
  chainExecutableAt: Date | null;

  @Column({ name: 'chain_reserved', type: 'numeric', precision: 78, scale: 0, nullable: true })
  chainReserved: string | null;

  @Column({ name: 'chain_proposal_signature', type: 'varchar', length: 256, nullable: true })
  chainProposalSignature: string | null;

  @Column({ name: 'applied_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  appliedAmount: string | null;

  @Column({ name: 'agent_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  agentAmount: string | null;

  @Column({ name: 'platform_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  platformAmount: string | null;

  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt: Date | null;

  @Column({ name: 'execution_signature', type: 'varchar', length: 256, nullable: true })
  executionSignature: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'chain_last_error', type: 'varchar', length: 64, nullable: true })
  chainLastError: string | null;

  /** Transient propose failures so far — the straggler cap counts these. */
  @Column({ name: 'propose_attempts', type: 'int', default: 0 })
  proposeAttempts: number;
}
