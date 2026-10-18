import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';

import { SlashRecordSnapshot } from '../ports/slash-executor.port';
import { ChainProposalStatus } from './chain-slash-outcome';
import { SlashProposalStatus } from './slash-proposal-state';

/**
 * B18: the three operator actions for a case stuck behind a requested cancel,
 * and the one rule that says when each may run. Pure, so the guard matrix is
 * tested without a database or a chain, and so the case brief (which offers an
 * action) and the action itself (which re-checks it on a fresh read) can never
 * disagree about it.
 *
 * ## Which cases are "stuck"
 *
 * Only a partitioned (EVM window) case with **no parts in its current epoch**:
 * one opened before the parts model, whose judgement is the single record
 * under the case's own `chainRequestId`. The admin-cancel sweep reads such a
 * case through `SlashPartsService.readRecord`, which folds nothing into `null`,
 * so the sweep can never mirror its cancel, record its execution or re-propose
 * it; the watcher looks the record up by part and finds none either. Every
 * other shape (a single record, a case with parts) is settled by the sweep
 * from its own read within a tick, so no manual action is offered for it: an
 * action there would only race the sweep.
 */

/** What stands on chain for a case, as the brief says it (`chainRecord`). */
export enum ChainRecordState {
  STANDING = 'STANDING',
  EXECUTED = 'EXECUTED',
  GONE = 'GONE',
  UNKNOWN = 'UNKNOWN',
}

/** A live read of a stuck case's own record. */
export interface StuckCaseRead {
  readonly state: ChainRecordState;
  /** The record as read; `null` when none was found or it could not be read. */
  readonly record: SlashRecordSnapshot | null;
  /** True when the chain could not be read at all (error, timeout, no executor or enrolment). */
  readonly unreadable: boolean;
  /**
   * For an `Executed` record: whether its `beneficiary` (who the contract paid
   * the agent share to) is an agent that paid for a failed call in the
   * case's window. Only then did the money reach a harmed agent directly, as
   * the pro-rata model (and the skipped ledger compensation) assumes. Absent
   * when it was not checked.
   */
  readonly beneficiaryIsAgent?: boolean;
  /**
   * For an `Executed` record: how many distinct harmed agents the window has
   * (payers of failed calls to this provider). A stuck case's record is ONE
   * record with ONE beneficiary, so it cannot pay more than one agent its
   * share: with two or more, someone was underpaid. Absent when not checked.
   */
  readonly harmedAgents?: number;
}

export type StuckCaseAction = 'CLOSE_NOTHING_STANDING' | 'RECORD_EXECUTION' | 'REPROPOSE';

export const STUCK_CASE_ACTIONS: readonly StuckCaseAction[] = [
  'CLOSE_NOTHING_STANDING',
  'RECORD_EXECUTION',
  'REPROPOSE',
];

/** Why an action is refused, as a stable code the console turns into a sentence. */
export type StuckCaseRefusal =
  /** The mirror is not `CANCEL_REQUESTED`: nothing is stuck behind a cancel. */
  | 'NOT_CANCEL_REQUESTED'
  /** A shape the admin-cancel sweep settles on its own (see the header). */
  | 'SWEEP_SETTLES'
  /** The chain could not be read, or what it says could not be told (a written record not found): refused, never assumed. */
  | 'CHAIN_UNKNOWN'
  /** The record still stands (Pending or Disputed): the arbiter's cancel is the way. */
  | 'STANDING'
  /** The record was executed: closing it would say nothing was taken. */
  | 'EXECUTED'
  /** Nothing was executed: there is no execution to record. */
  | 'NOT_EXECUTED'
  /** No confirmed cancelled record (a missing record is an anomaly, never "gone"). */
  | 'NOT_GONE'
  /** An upheld case: closing it would drop the decided penalty; re-propose it instead. */
  | 'UPHELD_USE_REPROPOSE'
  /** The case status does not allow this action. */
  | 'CASE_STATUS'
  /** The execution is already on the row. */
  | 'ALREADY_RECORDED'
  /** The chain took more than the case says is owed: the row cannot record it (S-5 and a human). */
  | 'EXECUTED_BEYOND_DECISION'
  /** The provider disputed the record on chain, or won a dispute of the case (B7). */
  | 'DISPUTED_ON_CHAIN'
  /**
   * The record paid its agent share to an account that is not a harmed agent
   * of the window (a vault, escrow or treasury, or unknown): recording it
   * would leave that money credited to nobody. Needs a compensation decision.
   */
  | 'BENEFICIARY_NOT_AN_AGENT'
  /**
   * The window has more than one harmed agent, and the single record paid
   * the whole agent share to one account: it cannot express a per-agent
   * split, so another agent was underpaid. A human decides the compensation.
   */
  | 'SPLIT_NOT_EXPRESSIBLE';

/** Closed in the app with no penalty: the statuses a nothing-standing cancel may be closed under. */
export const CLOSABLE_STATUSES: readonly string[] = [
  SlashProposalStatus.OVERTURNED,
  SlashProposalStatus.CANCELLED,
  SlashProposalStatus.WAIVED,
];

/** Statuses an execution may not be recorded under: the executor's own claim, or already recorded. */
const NOT_RECORDABLE: readonly string[] = [
  SlashProposalStatus.EXECUTING,
  SlashProposalStatus.EXECUTED,
  SlashProposalStatus.REVERSED,
];

export type StuckCaseFacts = Pick<
  SlashProposalEntity,
  'status' | 'chainStatus' | 'penaltyAmount' | 'executedAt' | 'chainDisputeWonAt'
>;

/**
 * Why `action` may not run on this case now, or `null` when it may.
 *
 * `read` is `null` when the case is not a stuck shape (`SWEEP_SETTLES`).
 *
 * - **Close** (`CLOSE_NOTHING_STANDING`): the record reads `Cancelled` on
 *   chain, positively — a record that was written and is not found is an
 *   anomaly, never "gone" — and the case is closed in the app with no penalty.
 * - **Record** (`RECORD_EXECUTION`): the record reads `Executed`, the row does
 *   not carry it yet, and the chain took no more than the case says is owed.
 * - **Re-propose** (`REPROPOSE`): the record reads `Cancelled`, the case is
 *   still `UPHELD` (a downward recalculation waiting for its cancel), and the
 *   provider never disputed it on chain nor won a dispute of the case: a record
 *   cancelled while disputed, or expired unruled, is the provider's win (B7)
 *   and is never proposed again.
 */
export function stuckCaseRefusal(
  action: StuckCaseAction,
  proposal: StuckCaseFacts,
  read: StuckCaseRead | null,
): StuckCaseRefusal | null {
  if (proposal.chainStatus !== ChainProposalStatus.CANCEL_REQUESTED) return 'NOT_CANCEL_REQUESTED';
  if (!read) return 'SWEEP_SETTLES';
  if (read.unreadable || read.state === ChainRecordState.UNKNOWN) return 'CHAIN_UNKNOWN';
  if (read.state === ChainRecordState.STANDING) return 'STANDING';

  const status = read.record?.status ?? null;
  switch (action) {
    case 'CLOSE_NOTHING_STANDING':
      if (read.state === ChainRecordState.EXECUTED) return 'EXECUTED';
      if (status !== 'CANCELLED') return 'NOT_GONE';
      if (proposal.status === SlashProposalStatus.UPHELD) return 'UPHELD_USE_REPROPOSE';
      if (!CLOSABLE_STATUSES.includes(proposal.status)) return 'CASE_STATUS';
      return null;

    case 'RECORD_EXECUTION':
      if (read.state !== ChainRecordState.EXECUTED || status !== 'EXECUTED') return 'NOT_EXECUTED';
      if (proposal.executedAt) return 'ALREADY_RECORDED';
      if (NOT_RECORDABLE.includes(proposal.status)) return 'CASE_STATUS';
      if (read.beneficiaryIsAgent !== true) return 'BENEFICIARY_NOT_AN_AGENT';
      // One record, one beneficiary: it matches every agent's share only when
      // the window has exactly one harmed agent (who is owed the whole share).
      if (read.harmedAgents !== 1) return 'SPLIT_NOT_EXPRESSIBLE';
      {
        const applied = minor(read.record?.appliedMinor);
        const owed = minor(proposal.penaltyAmount);
        // A figure that cannot be read is not one to record money from.
        if (applied === null || owed === null) return 'CHAIN_UNKNOWN';
        if (applied > owed) return 'EXECUTED_BEYOND_DECISION';
      }
      return null;

    case 'REPROPOSE':
      if (read.state === ChainRecordState.EXECUTED) return 'EXECUTED';
      if (status !== 'CANCELLED') return 'NOT_GONE';
      if (proposal.status !== SlashProposalStatus.UPHELD) return 'CASE_STATUS';
      if (
        proposal.chainDisputeWonAt ||
        read.record?.disputedAt ||
        read.record?.cancelReason === 'DISPUTE_UNRESOLVED'
      ) {
        return 'DISPUTED_ON_CHAIN';
      }
      return null;
  }
}

function minor(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
  return BigInt(value);
}

/** Every action's refusal at once, for the case brief. */
export function stuckCaseOptions(
  proposal: StuckCaseFacts,
  read: StuckCaseRead | null,
): Record<StuckCaseAction, StuckCaseRefusal | null> {
  return {
    CLOSE_NOTHING_STANDING: stuckCaseRefusal('CLOSE_NOTHING_STANDING', proposal, read),
    RECORD_EXECUTION: stuckCaseRefusal('RECORD_EXECUTION', proposal, read),
    REPROPOSE: stuckCaseRefusal('REPROPOSE', proposal, read),
  };
}

/** The live classification of a single record read, shared by the brief and the actions. */
export function classifyRecord(
  record: SlashRecordSnapshot | null,
  chainProposedAt: Date | null,
): ChainRecordState {
  if (record?.status === 'PENDING' || record?.status === 'DISPUTED') {
    return ChainRecordState.STANDING;
  }
  if (record?.status === 'EXECUTED') return ChainRecordState.EXECUTED;
  if (record?.status === 'CANCELLED') return ChainRecordState.GONE;
  // No record: gone only when none was ever written; one that was written and
  // is not found is an anomaly (a moved deployment, a wrong RPC), unknown.
  return chainProposedAt ? ChainRecordState.UNKNOWN : ChainRecordState.GONE;
}
