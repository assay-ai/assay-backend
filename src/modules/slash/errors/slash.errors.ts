import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

/**
 * `SLASH_*` — the proposal lifecycle, arbitration and on-chain execution.
 *
 * The register `DisputeErrorCode` said had *"no error codes here yet"*.
 */
export enum SlashErrorCode {
  SLASH_PROPOSAL_NOT_FOUND = 'SLASH_PROPOSAL_NOT_FOUND',
  SLASH_PROPOSAL_ALREADY_EXISTS = 'SLASH_PROPOSAL_ALREADY_EXISTS',
  SLASH_PROPOSAL_NOT_DISPUTABLE = 'SLASH_PROPOSAL_NOT_DISPUTABLE',
  SLASH_PROPOSAL_RESPONSE_WINDOW_CLOSED = 'SLASH_PROPOSAL_RESPONSE_WINDOW_CLOSED',
  SLASH_PROPOSAL_ALREADY_DISPUTED = 'SLASH_PROPOSAL_ALREADY_DISPUTED',
  SLASH_INVALID_TRANSITION = 'SLASH_INVALID_TRANSITION',
  SLASH_INVALID_REASON_CODE = 'SLASH_INVALID_REASON_CODE',
  SLASH_SECOND_SIGNATURE_REQUIRED = 'SLASH_SECOND_SIGNATURE_REQUIRED',
  SLASH_SECOND_SIGNATURE_NOT_PENDING = 'SLASH_SECOND_SIGNATURE_NOT_PENDING',
  SLASH_SECOND_READER_MUST_DIFFER = 'SLASH_SECOND_READER_MUST_DIFFER',
  SLASH_RECALCULATION_EXCEEDS_ORIGINAL = 'SLASH_RECALCULATION_EXCEEDS_ORIGINAL',
  SLASH_RECALCULATED_AMOUNT_INVALID = 'SLASH_RECALCULATED_AMOUNT_INVALID',
  SLASH_TIMELOCK_NOT_ELAPSED = 'SLASH_TIMELOCK_NOT_ELAPSED',
  SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK = 'SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK',
  SLASH_EXTENSION_WHILE_PROPOSING = 'SLASH_EXTENSION_WHILE_PROPOSING',
  SLASH_ALREADY_REVERSED = 'SLASH_ALREADY_REVERSED',
  SLASH_NOT_EXECUTED = 'SLASH_NOT_EXECUTED',
  SLASH_NO_BENEFICIARY = 'SLASH_NO_BENEFICIARY',
  SLASH_SWEEP_OUTCOME_NOT_SWEEPABLE = 'SLASH_SWEEP_OUTCOME_NOT_SWEEPABLE',
  SLASH_BENEFICIARY_IS_TREASURY = 'SLASH_BENEFICIARY_IS_TREASURY',
  /** A route needed the settlement program and this deployment has none. */
  SLASH_CHAIN_UNAVAILABLE = 'SLASH_CHAIN_UNAVAILABLE',
  /** The signature offered as a compensation does not show the deposit it claims. */
  SLASH_COMPENSATION_NOT_CONFIRMED = 'SLASH_COMPENSATION_NOT_CONFIRMED',
  SLASH_COMPENSATION_ALREADY_USED = 'SLASH_COMPENSATION_ALREADY_USED',
  SLASH_PLAN_EVIDENCE_MISMATCH = 'SLASH_PLAN_EVIDENCE_MISMATCH',
  SLASH_SWEEP_DEFECT_KEY_MISMATCH = 'SLASH_SWEEP_DEFECT_KEY_MISMATCH',
  /** A pro-rata window case found no agent with a priced DATA_FAIL call to compensate. */
  SLASH_NO_HARMED_AGENTS = 'SLASH_NO_HARMED_AGENTS',
  /** A case whose beneficiary cannot be named on this chain (e.g. the EVM vault). */
  SLASH_BENEFICIARY_UNSUPPORTED = 'SLASH_BENEFICIARY_UNSUPPORTED',
  /** A dispute-upgrade batch (D-19) the chain would revert: one entry per refused id. */
  SLASH_CHAIN_BATCH_REFUSED = 'SLASH_CHAIN_BATCH_REFUSED',
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
  /**
   * One proposal per finding, forever — `uq_slash_proposals_strike` and
   * `uq_slash_proposals_verdict`. A second one is a double penalty for a single
   * finding, and it is the shape a retried opener takes.
   */
  proposalAlreadyExists: {
    code: SlashErrorCode.SLASH_PROPOSAL_ALREADY_EXISTS,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `A slash proposal already exists for this finding` +
      `${context?.verdictId ? ` (verdict ${context.verdictId})` : ''}` +
      `${context?.strikeId ? ` (strike ${context.strikeId})` : ''}`,
  },
  /** The case has moved past the point where an objection can be filed. */
  notDisputable: {
    code: SlashErrorCode.SLASH_PROPOSAL_NOT_DISPUTABLE,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This proposal cannot be disputed from its current state` +
      `${context?.status ? `: ${context.status}` : ''}`,
  },
  /**
   * The provider's window elapsed.
   *
   * Distinct from `notDisputable` because it is the one refusal a provider can
   * do something about next time, and telling them "wrong state" when the truth
   * is "you were three hours late" is the kind of message that produces a
   * support ticket instead of an understanding.
   */
  responseWindowClosed: {
    code: SlashErrorCode.SLASH_PROPOSAL_RESPONSE_WINDOW_CLOSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `The window to object closed` +
      `${context?.respondByAt ? ` at ${context.respondByAt}` : ''}` +
      `. Contact support if you believe the notification never reached you.`,
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
  /** A reason code that is not in the closed list for the chosen outcome. */
  invalidReasonCode: {
    code: SlashErrorCode.SLASH_INVALID_REASON_CODE,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `Reason code${context?.code ? ` ${context.code}` : ''} is not valid for outcome ` +
      `${context?.outcome ?? 'the chosen outcome'}`,
  },
  secondSignatureRequired: {
    code: SlashErrorCode.SLASH_SECOND_SIGNATURE_REQUIRED,
    statusCode: 409,
    message: () => 'This decision needs a second signature before it binds',
  },
  /**
   * One person cannot hold both seats of a two-person case. Refused up front so
   * `chk_slash_proposals_second_is_a_different_person` never has to.
   */
  secondReaderMustDiffer: {
    code: SlashErrorCode.SLASH_SECOND_READER_MUST_DIFFER,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      context?.role === 'objector'
        ? 'You objected to the earlier decision on this case, so you cannot decide it yourself; ' +
          'it needs a different reader'
        : 'You made this decision, so you cannot countersign it; a different operator must sign or object',
  },
  secondSignatureNotPending: {
    code: SlashErrorCode.SLASH_SECOND_SIGNATURE_NOT_PENDING,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `No decision is awaiting a second signature on this case` +
      `${context?.status ? ` (${context.status})` : ''}`,
  },
  /**
   * An adjudicator may **reduce** a penalty and may never raise one.
   *
   * The provider was told a number and given a window to object to it. Raising
   * it on review would mean the thing they had a chance to answer was not the
   * thing that happens to them — which is the definition of the process this
   * goal exists to replace.
   */
  recalculationExceedsOriginal: {
    code: SlashErrorCode.SLASH_RECALCULATION_EXCEEDS_ORIGINAL,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `A recalculated penalty may not exceed the proposed one` +
      `${context?.original ? ` (${context.original})` : ''}`,
  },
  /**
   * `UPHELD_RECALCULATED` with no amount, or one that is not a positive whole
   * number of minor units.
   *
   * The request DTO refuses the same thing first with a `400`; this is the
   * service's own refusal, raised before `BigInt()` sees the value and before
   * anything is written, so a second caller cannot record a penalty of `''`.
   */
  recalculatedAmountInvalid: {
    code: SlashErrorCode.SLASH_RECALCULATED_AMOUNT_INVALID,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `UPHELD_RECALCULATED needs a recalculated penalty: a positive whole number of minor units` +
      `${context?.original ? `, no more than the proposed ${context.original}` : ''}`,
  },
  /** The case screen promises nothing executes before the deadline. This enforces it. */
  timelockNotElapsed: {
    code: SlashErrorCode.SLASH_TIMELOCK_NOT_ELAPSED,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Nothing executes before ${context?.earliestExecutionAt ?? 'the stated deadline'}`,
  },
  /**
   * The requested extension would put the provider's deadline **after** the
   * moment the chain lets anybody take their money.
   *
   * `execute_slash` takes one signer, `payer`, and consults it about nothing.
   * So once `SlashRecord.executable_at` passes, any stranger on the internet
   * may spend a standing judgement — no backend guard reaches them. That
   * deadline is frozen at `chain_proposed_at + slash_delay_seconds` when the
   * record is written, and nothing this process does moves it.
   *
   * The off-chain windows are sized so the dispute always closes first, but an
   * `S-8` extension is the one operator action that can push the case screen's
   * promise past the chain's door. Refused rather than clamped: an operator who
   * asked for five days and silently got three has been told the promise holds when
   * it does not, and would go on to tell the provider the same thing.
   *
   * The way out is `S-1` (suspend) then a fresh proposal, which restarts the
   * on-chain clock — the extension itself cannot be made safe.
   */
  extensionExceedsChainTimelock: {
    code: SlashErrorCode.SLASH_EXTENSION_EXCEEDS_CHAIN_TIMELOCK,
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `This case already has a live on-chain proposal, and its penalty becomes executable by ` +
      `anyone at ${context?.chainExecutableAt ?? 'a fixed moment'} — a deadline frozen on chain ` +
      `that no extension here can move. The requested extension would run to ` +
      `${context?.requestedExecutionAt ?? 'a later moment'}, so the provider would be promised ` +
      `time they do not have. Suspend the case (S-1) and re-propose instead, which restarts the ` +
      `on-chain clock.`,
  },
  /**
   * A proposal is being sent to the chain **right now**, so the deadline the
   * extension has to respect is not knowable yet.
   *
   * `PROPOSING` is not a millisecond of transit. `proposeDue`'s non-void catch
   * deliberately leaves the row claimed and `PROPOSING` on any failure the
   * program did not name — an RPC error, an expired blockhash, a confirmation
   * timeout — precisely because the transaction may already have landed. So the
   * record's `executable_at` may exist while `chain_executable_at` is still
   * null, and the stale-claim sweep only reaps the claim after
   * `CHAIN_CLAIM_STALE_MS` (ten minutes), longer if the RPC outage persists.
   *
   * Granting an extension against an unknown deadline is the same defect as
   * granting one past a known deadline, minus the ability to name the number.
   * Refused, and retryable: once the send settles the row learns the chain's
   * clock and {@link extensionExceedsChainTimelock} can give a real answer.
   *
   * Distinct from that error because the remedy is different — this one says
   * "try again shortly", that one says "this can never be granted".
   */
  extensionWhileProposing: {
    code: SlashErrorCode.SLASH_EXTENSION_WHILE_PROPOSING,
    statusCode: 409,
    // Takes the context it will never interpolate, so the proposal id lands in
    // the error for the log line rather than only in the operator's message.
    message: (_context?: Record<string, any>) =>
      'A proposal for this case is being sent to the chain right now, so the moment its ' +
      'penalty becomes executable by anyone is not known yet and an extension cannot be ' +
      'checked against it. Try again once the send settles; if it stays in this state, the ' +
      'send is failing and needs looking at.',
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
   * Only the two outcomes that are findings about **us** may open a sweep.
   *
   * Refused at the database too (`chk_fleet_sweeps_outcome`). Sweeping a
   * griefing or insufficient-evidence finding would cancel penalties on
   * providers whose facts were never in question — the same defect as levying
   * them, pointed the other way.
   */
  /**
   * A sweep matches cases by `root_cause_key`, so the key it uses must be the
   * source case's own (review M-2). Before, any free-text key was accepted and
   * the source case only had to have a sweepable outcome.
   */
  sweepDefectKeyMismatch: {
    code: SlashErrorCode.SLASH_SWEEP_DEFECT_KEY_MISMATCH,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      context?.rootCauseKey
        ? `The sweep's defect key must be the source case's root cause (${String(context.rootCauseKey)}), not ${String(context?.defectKey ?? '')}.`
        : `The source case has no root cause key, so it cannot open a fleet sweep.`,
  },
  outcomeNotSweepable: {
    code: SlashErrorCode.SLASH_SWEEP_OUTCOME_NOT_SWEEPABLE,
    statusCode: 422,
    message: (context?: Record<string, any>) =>
      `${context?.outcome ?? 'This outcome'} is a finding about one provider, one agent or one ` +
      `window. Only a platform or policy defect generalises to bindings that never complained.`,
  },
  /**
   * The resolved collection account is the settlement treasury.
   *
   * `slash` cannot execute such a judgement: `beneficiary_token_account` and
   * `treasury_token_account` would derive to one address and Anchor rejects a
   * duplicate mutable account (`ConstraintDuplicateMutableAccount`, 2040)
   * before the handler runs — so the on-chain failure has no name and no
   * explanation. The program's own comment asks the off-chain issuer to refuse
   * instead, which is what this is.
   *
   * 500 rather than 409: nothing a caller did causes it. It means the vault and
   * the treasury have been configured to the same key, which is an operator
   * error that must be fixed before any slash can pay out.
   */
  beneficiaryIsTreasury: {
    code: SlashErrorCode.SLASH_BENEFICIARY_IS_TREASURY,
    statusCode: 500,
    message: (context?: Record<string, any>) =>
      'The settlement vault and the economics treasury are the same account ' +
      `${context?.address ? `(${context.address}) ` : ''}` +
      'so no penalty can be paid: the slash instruction would be given one account twice.',
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
   * On EVM the "vault" is the `X402Escrow` contract, and an ERC-20 transfer
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
   * `ArbiterIsVerifier`, `DisputeTimedOut`, `NoSuchRecord`, `DuplicateId`).
   */
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
