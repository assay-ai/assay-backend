import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `SLASH_*` — the proposal lifecycle, arbitration and on-chain execution.
 *
 * The register `DisputeErrorCode` said had *"no error codes here yet"*.
 */
export enum SlashErrorCode {
  SLASH_PROPOSAL_NOT_FOUND = 'SLASH_PROPOSAL_NOT_FOUND',
  SLASH_PROPOSAL_NOT_DISPUTABLE = 'SLASH_PROPOSAL_NOT_DISPUTABLE',
  SLASH_PROPOSAL_ALREADY_DISPUTED = 'SLASH_PROPOSAL_ALREADY_DISPUTED',
  SLASH_INVALID_TRANSITION = 'SLASH_INVALID_TRANSITION',
  SLASH_ALREADY_REVERSED = 'SLASH_ALREADY_REVERSED',
  SLASH_NOT_EXECUTED = 'SLASH_NOT_EXECUTED',
  SLASH_NO_BENEFICIARY = 'SLASH_NO_BENEFICIARY',
  /** A route needed the settlement program and this deployment has none. */
  SLASH_CHAIN_UNAVAILABLE = 'SLASH_CHAIN_UNAVAILABLE',
  /** The signature offered as a compensation does not show the deposit it claims. */
  SLASH_COMPENSATION_NOT_CONFIRMED = 'SLASH_COMPENSATION_NOT_CONFIRMED',
  SLASH_COMPENSATION_ALREADY_USED = 'SLASH_COMPENSATION_ALREADY_USED',
  SLASH_PLAN_EVIDENCE_MISMATCH = 'SLASH_PLAN_EVIDENCE_MISMATCH',
  /** A pro-rata window case found no agent with a priced DATA_FAIL call to compensate. */
  SLASH_NO_HARMED_AGENTS = 'SLASH_NO_HARMED_AGENTS',
  /** A case whose beneficiary cannot be named on this chain (e.g. the EVM vault). */
  SLASH_BENEFICIARY_UNSUPPORTED = 'SLASH_BENEFICIARY_UNSUPPORTED',
  /** A dispute-upgrade batch (D-19) the chain would revert: one entry per refused id. */
  SLASH_CHAIN_BATCH_REFUSED = 'SLASH_CHAIN_BATCH_REFUSED',
  SLASH_BENEFICIARY_EVIDENCE_REFUSED = 'SLASH_BENEFICIARY_EVIDENCE_REFUSED',
  /** Review R2-6: the superseded-record cancel was asked for a record that is not one. */
  SLASH_RECORD_NOT_SUPERSEDED = 'SLASH_RECORD_NOT_SUPERSEDED',
  /** A cancel was asked for a case with nothing Pending or Disputed on chain. */
  SLASH_NOTHING_STANDING = 'SLASH_NOTHING_STANDING',
  /** B18: an operator action on a stuck case whose guard does not hold (or no longer holds). */
  SLASH_MANUAL_ACTION_REFUSED = 'SLASH_MANUAL_ACTION_REFUSED',
  /** Review 2026-10-23 M-1: every unsent part pays a buyer linked to the provider. */
  SLASH_LINKED_BENEFICIARY = 'SLASH_LINKED_BENEFICIARY',
  /** Review 2026-10-23 M-1: signing now would exceed the provider's on-chain window for the day. */
  SLASH_PROVIDER_DAILY_BUDGET = 'SLASH_PROVIDER_DAILY_BUDGET',
}

export type SlashErrorCodesArePrefixed = AssertDomainErrorCodes<'SLASH', `${SlashErrorCode}`>;

export const SlashErrors = createDomainErrorFactory('SLASH', {
  /** Cross-organization id or no such row — indistinguishable, on purpose. */
  proposalNotFound: {
    code: SlashErrorCode.SLASH_PROPOSAL_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Slash proposal not found${context?.proposalId ? ` with id: ${context.proposalId}` : ''}`,
  },
  /** The case has moved past the point where an objection can be filed. */
  notDisputable: {
    code: SlashErrorCode.SLASH_PROPOSAL_NOT_DISPUTABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This proposal cannot be disputed from its current state` +
      `${context?.status ? `: ${context.status}` : ''}`,
  },
  alreadyDisputed: {
    code: SlashErrorCode.SLASH_PROPOSAL_ALREADY_DISPUTED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This proposal already has an objection on file` +
      `${context?.disputeId ? `: ${context.disputeId}` : ''}`,
  },
  /**
   * A transition the state machine does not allow.
   *
   * `409`, and it is usually somebody losing a race rather than misusing the
   * API: a sweeper closed the case while an operator was typing. The message
   * names both states so the loser can tell which happened.
   */
  invalidTransition: {
    code: SlashErrorCode.SLASH_INVALID_TRANSITION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Cannot move a slash proposal from ${context?.from ?? 'its current state'} to ` +
      `${context?.to ?? 'the requested state'}`,
  },
  /**
   * An operator action asked for in a status it does not apply to.
   *
   * The same code as {@link invalidTransition}, because it is the same answer —
   * the case is not where this action needs it to be — but it names the action
   * and the statuses it is possible in, for the actions that are not a move to
   * one target status (a claim, an extension, a build-only intent, a sweep).
   * Borrowing another action's refusal instead told an operator extending a
   * deadline that the case "cannot be disputed".
   */
  actionNotAllowedInStatus: {
    code: SlashErrorCode.SLASH_INVALID_TRANSITION,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Cannot ${context?.action ?? 'do this'} while the case is ` +
      `${context?.status ?? 'in its current status'}` +
      `${context?.allowed ? `; only while it is ${context.allowed}` : ''}`,
  },
  /**
   * Reversing the same case twice.
   *
   * Refused in three places; this is the one that produces a readable message.
   * The other two are `markReversedIfExecuted`'s `reversed_at IS NULL`
   * predicate and the program's own `SlashAlreadyReversed`.
   */
  alreadyReversed: {
    code: SlashErrorCode.SLASH_ALREADY_REVERSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This slash has already been reversed` +
      `${context?.reversedAt ? ` at ${context.reversedAt}` : ''}` +
      `. A slash is reversible exactly once.`,
  },
  notExecuted: {
    code: SlashErrorCode.SLASH_NOT_EXECUTED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Nothing to compensate: this proposal never executed` +
      `${context?.status ? ` (${context.status})` : ''}`,
  },
  /**
   * The two build-only chain routes — the admin's `cancel_slash` and the
   * treasury's compensating `deposit_stake` — need a settlement program to
   * build against. A deployment with none is legitimate, so this is the
   * call-time failure rather than a boot-time one, and it is a `503` because
   * nothing about the request is wrong.
   */
  /**
   * The transaction an operator offered as proof of compensation does not, on
   * the cluster, contain a `deposit_stake` into this provider's stake for at
   * least what was taken.
   *
   * Four different things arrive here — an unknown signature, a failed
   * transaction, a deposit into somebody else's stake, and a deposit that was
   * too small — and the message names the amounts rather than the cause,
   * because the remedy is the same for all four: pay the provider properly and
   * offer that signature instead.
   */
  compensationNotConfirmed: {
    code: SlashErrorCode.SLASH_COMPENSATION_NOT_CONFIRMED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `That transaction does not show a confirmed deposit by the settlement treasury into this ` +
      `provider's stake, made after the slash executed, for at ` +
      `least ${String(context?.owed ?? 'the amount taken')}` +
      `${context?.deposited ? ` — it deposited ${String(context.deposited)}` : ''}` +
      `${context?.signature ? ` (${String(context.signature)})` : ''}` +
      `. Nothing on the case was changed.`,
  },
  /** One deposit compensates one case (review M-3, `uq_slash_proposals_reversal_signature`). */
  compensationAlreadyUsed: {
    code: SlashErrorCode.SLASH_COMPENSATION_ALREADY_USED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `That deposit${context?.signature ? ` (${String(context.signature)})` : ''} already ` +
      `compensates another case. One deposit compensates one case. Nothing on this case was changed.`,
  },
  chainUnavailable: {
    code: SlashErrorCode.SLASH_CHAIN_UNAVAILABLE,
    statusCode: 503,
    // The reason is this platform's own wording (never an RPC payload), so the console can show it.
    publicContext: ['proposalId', 'reason'],
    message: (context?: Record<string, any>) =>
      `No transaction could be built for this case` +
      `${context?.reason ? `: ${context.reason}` : ''}` +
      `. Nothing was signed or submitted; retry once the settlement program is reachable.`,
  },
  /**
   * A window-level penalty has no single harmed agent to name.
   *
   * One attestation carries exactly one `beneficiary`, and the intended
   * settlement model is a pro-rata distribution across every agent who spent in
   * the window. That is either many attestations or an off-chain distribution
   * from one account, and it is **undecided** — open work in slash execution.
   * Until it is decided, a window proposal can be adjudicated but cannot
   * execute, and this is the honest refusal rather than a guess about who
   * should be paid.
   */
  noBeneficiary: {
    code: SlashErrorCode.SLASH_NO_BENEFICIARY,
    statusCode: 409,
    message: () =>
      'This proposal has no single beneficiary, so it cannot execute. A window-level penalty ' +
      'is owed to every agent who spent in the window, and how that is distributed on chain ' +
      'has not been decided.',
  },
  /**
   * Nothing to propose: no agent in the window had a DATA_FAIL call with a
   * price, or every share was reduced to nothing by the on-chain caps. Left
   * for a human rather than voided — the provider still breached its SLA.
   */
  /**
   * The stored pro-rata plan does not follow from the window's evidence
   * (review H-2), so nothing was signed or sent. Not a chain refusal: the
   * case stays PROPOSING, `chain_last_error` names this code, and a
   * `PLAN_REFUSED` event on the timeline asks an operator to look.
   */
  planEvidenceMismatch: {
    code: SlashErrorCode.SLASH_PLAN_EVIDENCE_MISMATCH,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Slash case ${context?.proposalId ?? ''}: the stored plan does not match the evidence` +
      `${context?.reason ? ` (${context.reason})` : ''}. Nothing was signed or sent.`,
  },
  noHarmedAgents: {
    code: SlashErrorCode.SLASH_NO_HARMED_AGENTS,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Window ${context?.windowId ?? ''} has no harmed agent to compensate on chain` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * On EVM the "vault" is the `AssayEscrow` contract, and an ERC-20 transfer
   * into it credits nobody — naming it as a beneficiary would burn the agent
   * share. EVM window cases are paid pro rata to the agents instead; a case
   * with no window (call-level) has no EVM beneficiary rule yet.
   */
  beneficiaryUnsupported: {
    code: SlashErrorCode.SLASH_BENEFICIARY_UNSUPPORTED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No beneficiary can be named for this case on ${context?.chainId ?? 'this chain'}` +
      `${context?.reason ? `: ${context.reason}` : ''}`,
  },
  /**
   * `disputeSlashBatch`, `upholdSlashBatch` and `cancelSlashBatch` are atomic:
   * one bad id reverts them all. Nothing was built; `context.refusals` names
   * every id the chain would refuse and why (`NotSlashedProvider`,
   * `SlashNotPending`, `DisputeWindowClosed`, `SlashNotDisputed`,
   * `DisputeTimedOut`, `SlashAlreadyDisputed`, `NoSuchRecord`,
   * `DuplicateId`).
   */
  /**
   * Follow-up C5: a part's beneficiary is not a payer of the window's failed
   * calls, or the part is more than that payer's pro-rata share of the formula
   * penalty (one minor unit of rounding allowed). Nothing was signed; the case stays PROPOSING and
   * a `BENEFICIARY_REFUSED` timeline entry names every part that failed.
   */
  /**
   * Review 2026-10-23 M-1 (self-slashing): every part left to sign pays a buyer
   * linked to the provider — the provider's own organization, the publisher
   * of the tool, or a wallet the provider enrolled. Those parts are REFUSED
   * and nothing was signed for them.
   */
  linkedBeneficiary: {
    code: SlashErrorCode.SLASH_LINKED_BENEFICIARY,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Slash case ${context?.proposalId ?? ''}: refused before signing — every remaining ` +
      `beneficiary is linked to the provider`,
  },
  /**
   * Review 2026-10-23 M-1: the provider's attestations signed in the last
   * rolling day, plus this case's, would exceed its on-chain slash window
   * (`atRisk × slashCapBps`). Nothing was signed; the case stays PROPOSING and
   * is retried as the day rolls on, so no record is signed that the window
   * could never execute.
   */
  providerDailyBudget: {
    code: SlashErrorCode.SLASH_PROVIDER_DAILY_BUDGET,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Slash case ${context?.proposalId ?? ''}: not signed yet — ${context?.signed ?? '?'} ` +
      `already holds provider ${context?.providerId ?? ''}'s slash budget (standing records ` +
      `plus the last day's executions) and ${context?.wanted ?? '?'} more would exceed ` +
      `${context?.allowance ?? '?'}`,
  },
  beneficiaryEvidenceRefused: {
    code: SlashErrorCode.SLASH_BENEFICIARY_EVIDENCE_REFUSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Slash case ${context?.proposalId ?? ''}: refused before signing — ` +
      `${context?.reason ?? 'a beneficiary does not match the paid vouchers'}`,
  },
  /**
   * Review R2-6: the guarded cancel of a superseded earlier-epoch record was
   * asked for an id that is not one standing on that chain (a live record of
   * the current epoch is ruled on from the disputes list instead).
   */
  recordNotSuperseded: {
    code: SlashErrorCode.SLASH_RECORD_NOT_SUPERSEDED,
    statusCode: 409,
    publicContext: ['requestId', 'chainId'],
    message: (context?: Record<string, any>) =>
      `Record ${context?.requestId ?? ''} is not a superseded earlier-epoch record standing on ` +
      `${context?.chainId ?? 'this chain'}; nothing was built`,
  },
  /**
   * The cancel has nothing to act on: no record of this case is `Pending` or
   * `Disputed` on chain, so nothing can be executed against the provider and
   * nothing needs a signature. Read from the chain, never assumed;
   * `chainStatus` says what it is (`EXECUTED` — the stake was taken while the
   * cancel waited; `CANCELLED`; `NOT_FOUND`; `PROPOSING` — a part may still
   * land). Nothing is written: the case keeps its status.
   */
  nothingStanding: {
    code: SlashErrorCode.SLASH_NOTHING_STANDING,
    statusCode: 409,
    publicContext: ['proposalId', 'chainStatus'],
    message: (context?: Record<string, any>) =>
      `Nothing of this case stands on chain` +
      `${context?.chainStatus ? ` (the record reads ${String(context.chainStatus)})` : ''}` +
      `, so there is nothing to sign. Nothing was changed.`,
  },
  /**
   * B18: a manual action on a case stuck behind a requested cancel was
   * refused. `reason` is the guard's code (`StuckCaseRefusal`, or `CHANGED`
   * when the case moved since it was read); `chainRecord` what the live read
   * said. Nothing was written.
   */
  manualActionRefused: {
    code: SlashErrorCode.SLASH_MANUAL_ACTION_REFUSED,
    statusCode: 409,
    publicContext: ['proposalId', 'action', 'reason', 'chainRecord'],
    message: (context?: Record<string, any>) =>
      `This action cannot run on this case now` +
      `${context?.reason ? ` (${String(context.reason)})` : ''}` +
      `${context?.chainRecord ? `; the chain reads ${String(context.chainRecord)}` : ''}` +
      `. Nothing was changed.`,
  },
  chainBatchRefused: {
    code: SlashErrorCode.SLASH_CHAIN_BATCH_REFUSED,
    statusCode: 422,
    // The caller's own ids and why each would revert: on the wire as
    // `error.context`, so a client need not parse the message.
    publicContext: ['functionName', 'refusals'],
    message: (context?: Record<string, any>) => {
      const refusals = (context?.refusals ?? []) as { requestId: string; reason: string }[];
      return (
        `${refusals.length} of the request ids would make the chain revert the whole ` +
        `${context?.functionName ?? 'batch'}; nothing was built: ` +
        refusals.map((refusal) => `0x${refusal.requestId} (${refusal.reason})`).join(', ')
      );
    },
  },
});
