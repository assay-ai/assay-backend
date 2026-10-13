/**
 * The only way this codebase may take a provider's stake, or give it back.
 *
 * ## The principle this port exists to keep
 *
 * The fourth of the four rules the product may not violate: *the verifier
 * decides the outcome, settlement enforces the economic consequence*, and its
 * consequence — **the platform must have no path that calls slash on its own.**
 * Every judgement goes through an attestation signed by a registered verifier,
 * and the on-chain program checks that signature itself.
 *
 * A port cannot enforce that; the program does, through its attestation check
 * and verifier registry. What the port enforces is the *shape* of the
 * dependency, and that matters for one specific reason: it keeps the
 * arbitration domain unable to express "slash without an attestation".
 * {@link SlashExecutorPort.propose} takes the fields an attestation is built from and
 * returns a signature. There is no method that takes a penalty and a provider.
 *
 * ## Why there are four doors and not one
 *
 * The program splits slashing into a lifecycle rather than one instruction. A
 * judgement is **proposed**, waits out `SLASH_DELAY_SECONDS` (72h, a program
 * constant), and is only then **executed**; in between it can be **cancelled**
 * by the program's admin, and after a 7-day grace it can be **expired** by
 * anybody at all.
 *
 * Three of those four this backend submits itself. The fourth it cannot:
 * `cancel_slash` is signed by `Config.admin`, a person's hardware key that
 * this codebase does not hold, so {@link SlashExecutorPort.buildCancel} returns
 * an unsigned transaction and an operator carries it to the admin. A
 * cancellation therefore ends with a case waiting on a human.
 *
 * That waiting room is the whole point: it is what makes `revoke_verifier` a
 * remedy rather than a post-mortem. Revoking a compromised key while its
 * judgements are still pending voids every one of them, because `execute_slash`
 * re-checks the key at execution rather than trusting the signature it took at
 * proposal time.
 *
 * The port mirrors the lifecycle rather than hiding it behind a single call,
 * because the 72 hours are not something a method can wait out: the proposal and
 * the execution are separate transactions, separated by days, and — crucially —
 * a process crash between them is normal rather than exceptional.
 * {@link SlashExecutorPort.readRecord} exists for exactly that: it is how a
 * restarted process learns what the chain already did.
 *
 * ## Why the return types say `applied` and not `penalty`
 *
 * The program may take less than asked. The 10%-of-stake-per-24h cap and a
 * provider holding less than the judgement both reduce it, and the shortfall is
 * *discharged, not carried*: the remainder needs a fresh judgement under a
 * fresh request id, because a debt record that outlives the stake would end
 * "one slash per request id, ever", which is the replay lock.
 *
 * So the caller must write back what actually happened rather than what it
 * asked for, and these types make forgetting to do that a compile error.
 */

import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';

/** What `propose_slash` needs, minus the parts only the signer knows. */
export interface SlashProposalRequest {
  /**
   * The chain the judgement is made on — CAIP-2, from the proposal's own
   * `asset_id`. Required because the port is multiplexed by namespace and an
   * EVM address names an account on every EVM chain at once: without it a
   * judgement for 46630 could be submitted to 4663.
   */
  readonly chainId: ChainId;
  /** 32 bytes, lower-case hex. The chain's replay lock, and ours. */
  readonly requestId: string;
  /** The provider's stake authority, as the chain's bare address. */
  readonly provider: string;
  /** Who receives the 60%. The chain's bare address. */
  readonly beneficiary: string;
  /** Minor units of the staked asset. Uncapped; the program applies the caps. */
  readonly penaltyMinor: string;
  /** The verification policy the judgement was made under. */
  readonly policy: string;
  /**
   * The response class, from the on-chain table. Only `dataFail` may slash;
   * `systemError` and `requestError` leave stake untouched — an upstream outage
   * is not the provider's fault and a malformed agent request is not either.
   */
  readonly responseClass: 'dataFail';
}

/**
 * The states a `SlashRecord` can be in, named rather than numbered.
 *
 * `DISPUTED` is EVM only (assay-evm D-19): the provider called `disputeSlash`
 * inside the delay. The reservation stands, `executeSlash` refuses the record,
 * and it leaves the state by the arbiter's `upholdSlash` (back to `PENDING`,
 * executable from that moment), by `cancelSlash` (admin or arbiter) or by
 * `expireSlash` once `disputedAt + 30 d` has passed. Solana never reports it.
 *
 * `CANCELLED` covers both doors that end a judgement without paying it —
 * `cancel_slash` (a verifier withdrew it) and `expire_slash` (it outlived its
 * grace period). The program stores one status for both, so this does too; the
 * record's `cancelled_at` is written by either and the distinction, where it
 * matters, is in the platform's own audit trail rather than on chain.
 */
export type SlashRecordStatus = 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'DISPUTED';

export interface SlashProposalResult {
  /** Empty when {@link adopted} — nothing was submitted, so there is no signature. */
  readonly signature: string;
  /**
   * The record's status **as the chain reports it**, which on an
   * {@link adopted} result is not necessarily `PENDING`.
   *
   * Neither `cancel_slash` nor `expire_slash` closes the account, so a record
   * that was withdrawn or reaped is still sitting at the PDA a second proposal
   * for the same request id collides with. Adoption therefore hands back
   * whatever is actually there, and this field is how the caller tells the two
   * apart.
   *
   * **A non-`PENDING` adopted result is terminal: the request id is spent.**
   * `propose_slash` can never write over it (the seeds admit one record per
   * request id and `init` refuses a second), and `execute_slash` will refuse a
   * record that is not `Pending` — so scheduling an execution against one buys
   * a failure 72 hours later instead of now. The caller must close the case out
   * rather than queue it. That policy lives with the caller and not in the
   * adapter deliberately: this class reports what the chain says and decides
   * nothing.
   *
   * On a freshly written proposal it is always `PENDING`; it is read off the
   * record either way rather than assumed.
   */
  readonly status: SlashRecordStatus;
  /** The chain's `proposed_at`, never this process's clock. */
  readonly proposedAt: Date;
  /**
   * `proposed_at + config.slash_delay_seconds`, **frozen on the record** rather
   * than recomputed here. A delay read live would let one `update_config`
   * transaction pull every pending judgement forward, which is the thing the
   * delay exists to deny, reached through the parameter door.
   */
  readonly executableAt: Date;
  /**
   * The stake the proposal set aside, in minor units. It is also the ceiling on
   * what this judgement may ever be paid — see `SlashRecord.reserved`.
   */
  readonly reservedMinor: string;
  /** True when the record already existed and was adopted rather than written. */
  readonly adopted: boolean;
}

/**
 * What `execute_slash` needs.
 *
 * Three fields, and no attestation: the judgement was proved at proposal time
 * and the on-chain record is the evidence. Everything about *what* to execute —
 * the penalty, the split, the policy, the verifier — is read off the record by
 * the program itself, so there is nothing here for a submitter to influence.
 * `beneficiary` is passed only so it cannot be substituted; the program checks
 * it against the record's own field.
 */
export interface SlashExecutionRequest {
  readonly chainId: ChainId;
  readonly requestId: string;
  /**
   * Requests sharing a group (one case) execute together or not at all when
   * the chain's remaining windows would take less than reserved from any of
   * them — see `EvmSlashExecutor.executeBatch`. Absent: its own group.
   */
  readonly atomicGroup?: string;
  readonly provider: string;
  readonly beneficiary: string;
}

export interface SlashExecutionResult {
  readonly signature: string;
  /**
   * What the chain actually took, in minor units. May be less than the penalty
   * proposed; never more.
   */
  readonly appliedMinor: string;
  /**
   * The share that reached the `beneficiary`, in minor units, **read off the
   * chain's own `SlashRecord`**.
   *
   * Never recomputed from a percentage off-chain. `execute_slash` reads
   * `slash_agent_bps` from `Config`, which an admin `update_config` can move,
   * and the program freezes the split it actually used onto the record — so a
   * finished judgement says what it paid rather than what today's parameters
   * would pay.
   *
   * This is what the ledger distributes. `applied` is not — a provider judged
   * $10 loses $9, because the remaining share is never taken from the stake.
   */
  readonly agentAmountMinor: string;
  /**
   * The platform's share, paid to `Config.treasury` — **outside the vault**,
   * so it is recorded on the proposal row and never booked to the ledger.
   * Booking it would add a liability no vault balance covers.
   */
  readonly platformAmountMinor: string;
  readonly executedAt: Date;
}

/**
 * What `cancel_slash` and `expire_slash` need.
 *
 * The same two fields for both, because both do the same thing to the record —
 * move it out of `Pending` and release the reservation — and differ only in who
 * may ask and why. A cancellation is a *withdrawal of the judgement* by the
 * program's admin; an expiry is the permissionless reaping of one that can no
 * longer execute.
 */
export interface SlashCancelRequest {
  readonly chainId: ChainId;
  readonly requestId: string;
  readonly provider: string;
}

export interface SlashCancelResult {
  readonly signature: string;
  /** The chain's `cancelled_at`. Both doors write the same field. */
  readonly cancelledAt: Date;
  /**
   * `SlashCancelled.reason`, when the chain says it (EVM): `EXPIRED`,
   * `VERIFIER_UNAVAILABLE`, or — for a `Disputed` record nobody ruled on within
   * 30 days (D-19) — `DISPUTE_UNRESOLVED`.
   */
  readonly reason?: 'WITHDRAWN' | 'EXPIRED' | 'VERIFIER_UNAVAILABLE' | 'DISPUTE_UNRESOLVED';
}

/**
 * An unsigned `cancel_slash`, addressed to the admin.
 *
 * The backend has no path that produces this signature — that is the point of
 * putting the cancellation on the admin key. The transaction is
 * compiled with one empty signature slot and handed to an operator, whose
 * wallet signs it; the case moves to `CANCELLED` when the reconcile sweep sees
 * the record leave `Pending`, never on the strength of having built this.
 */
export interface SlashCancelIntent {
  /**
   * **Unsigned.** Solana: base64 wire bytes. EVM: the `cancelSlash(requestId)`
   * calldata, `0x`-hex, for the admin's wallet to send to {@link to}.
   */
  readonly transaction: string;
  /** EVM only: the contract the calldata is addressed to (the `X402Stake` proxy). */
  readonly to?: string;
  /**
   * The only account that may sign it, and its fee payer: `Config.admin`, or
   * — on EVM once the dispute upgrade has appointed one — `X402Config.arbiter()`.
   * The field keeps its name for the clients that read it; {@link signerRole}
   * says which of the two it is.
   */
  readonly admin: string;
  /** `ADMIN` (Solana, and EVM without an arbiter) or `ARBITER` (D-19). */
  readonly signerRole?: 'ADMIN' | 'ARBITER';
  readonly requestId: string;
  readonly provider: string;
  /** The blockhash the transaction is bound to — a wallet showing an expiry needs it. Empty on EVM. */
  readonly blockhash: string;
  /** Decimal string: `lastValidBlockHeight` is a `u64` and JSON has no such number. */
  readonly lastValidBlockHeight: string;
}

/**
 * What the chain says about a judgement, for the paths that have to ask.
 *
 * A restarted process cannot infer this. `propose_slash` may have landed with
 * nobody left to read the confirmation; `execute_slash` may have been submitted
 * by a stranger (its only signer is a fee payer, consulted about nothing). The
 * record is the authority in both directions, so the recovery paths read it
 * rather than reasoning from local state.
 */
export interface SlashRecordSnapshot {
  readonly status: SlashRecordStatus;
  readonly penaltyMinor: string;
  readonly appliedMinor: string;
  readonly agentAmountMinor: string;
  readonly platformAmountMinor: string;
  readonly reservedMinor: string;
  readonly proposedAt: Date;
  readonly executableAt: Date;
  /** `null` until the judgement executes — never `new Date(0)`. */
  readonly executedAt: Date | null;
  /** `null` unless the judgement was cancelled or expired. */
  readonly cancelledAt: Date | null;
  /**
   * EVM only (D-19): when the provider called `disputeSlash`, or `null`. A
   * `DISPUTED` record becomes expirable at `disputedAt + 30 d`, not on the
   * seven-day grace.
   */
  readonly disputedAt?: Date | null;
  /**
   * The signed terms, where the chain's record keeps them (EVM does; the
   * Solana snapshot leaves them absent). What `slashRecordMismatch` judges.
   */
  readonly beneficiary?: string;
  /** 32-byte hex of the signed policy. */
  readonly policy?: string;
  readonly verifier?: string;
  /** Whether `CONFIG.canSign(verifier)` holds now — the expiry door and rotation both read it. */
  readonly verifierCanSign?: boolean;
  /** This platform's own key, or one the chain still allows to sign. */
  readonly verifierAccepted?: boolean;
}

/**
 * `S-5`'s replacement for a reversal: an unsigned `deposit_stake` from the
 * treasury into the provider's own stake.
 *
 * Not on this port — it is built by `StakeIntentBuilderPort`, which already
 * builds unsigned stake instructions and needed only a `funder`. It is declared
 * here because it is the shape the operator route returns and the slash domain
 * is where that route lives.
 */
export interface SlashCompensationIntent {
  /** Base64 wire bytes, **unsigned**. The treasury's multisig signs it. */
  readonly transaction: string;
  /** The provider's stake authority, as a base58 address. */
  readonly provider: string;
  /** `applied_amount` — what the chain actually took, in minor units. */
  readonly amountMinor: string;
  /** `Config.treasury`, as a base58 address. The funder, and the fee payer. */
  readonly depositor: string;
}

/**
 * One request's outcome inside a batch: what the single door would have
 * returned, or what it would have thrown. Never dropped — a batch of N answers
 * with N outcomes, in request order.
 */
export type SlashBatchOutcome<T> =
  | { readonly ok: true; readonly result: T; readonly error?: undefined }
  | { readonly ok: false; readonly error: unknown; readonly result?: undefined };

/**
 * The batch doors for a namespace that has no batching: each request through
 * the single door, in order, each failure captured rather than thrown. Strictly
 * sequential — a fee payer's transactions are not to be raced.
 */
export async function oneByOne<Request, Result>(
  requests: readonly Request[],
  door: (request: Request) => Promise<Result>,
): Promise<SlashBatchOutcome<Result>[]> {
  const outcomes: SlashBatchOutcome<Result>[] = [];
  for (const request of requests) {
    try {
      outcomes.push({ ok: true, result: await door(request) });
    } catch (error) {
      outcomes.push({ ok: false, error });
    }
  }
  return outcomes;
}

export interface SlashExecutorPort {
  /**
   * {@link propose} for many judgements, in as few transactions as the chain
   * allows. Outcome `i` is what `propose(requests[i])` would have returned or
   * thrown — including adoption of a record already on chain.
   *
   * On EVM this is one `Multicall3.aggregate3` per chunk (`proposeSlash` is
   * authorised by the verifier's signature, not by `msg.sender`, so the
   * multicall contract may carry it). A namespace that cannot batch answers by
   * calling the single door once per request.
   */
  proposeBatch(
    requests: readonly SlashProposalRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashProposalResult>[]>;

  /** {@link executeProposal} for many judgements — the same contract as {@link proposeBatch}. */
  executeBatch(
    requests: readonly SlashExecutionRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashExecutionResult>[]>;

  /**
   * Phase one: build the attestation, have a registered verifier sign it,
   * submit `propose_slash`, and report the clock the chain started.
   *
   * Moves no money. There is no token account in the instruction's accounts
   * struct at all, and that absence is the control — this call cannot pay
   * anybody however it is driven. What it *can* do is reserve stake, which is
   * bounded by the contract's own `penalty_amount` ceiling and costs the
   * submitter a record's rent.
   *
   * Throws rather than returning a failure, with one exception: a proposal that
   * finds a record already on chain for the same request id returns
   * `adopted: true` instead. That is the crash-between-send-and-confirm path,
   * and adopting is the only answer that cannot mint a second judgement for one
   * finding — `init` on `["slash", request_id]` guarantees there is at most one.
   *
   * Adoption is decided by **reading the record**, not by parsing the failure:
   * when the submission is refused, the implementation asks whether a record
   * exists at the request id's PDA and adopts only if one does. The system
   * program's "already in use" is not an Anchor error and renders in the
   * transaction *logs* rather than in the RPC's message, so a text match would
   * have been a coin flip — and losing it would strand the request id forever.
   * Check {@link SlashProposalResult.status} on an adopted result: it is not
   * necessarily `PENDING`.
   */
  propose(request: SlashProposalRequest): Promise<SlashProposalResult>;

  /**
   * Phase two: submit `execute_slash` and report what the chain took.
   *
   * Signs no attestation. Fails on chain — loudly and by name — if the delay has
   * not elapsed, if the record is not `Pending`, or if the verifier key that
   * proposed has since been revoked or expired.
   *
   * Reads the record before building, because three of the instruction's
   * accounts are seeded from fields on it. Throws
   * {@link ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND} — **terminal, retrying
   * cannot help** — when no record exists at the request id's PDA, before any
   * transaction is built. See {@link expire} for why that is a distinct code.
   */
  executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult>;

  /**
   * **Build**, and never sign, the `cancel_slash` that withdraws a pending
   * judgement.
   *
   * The platform cannot cancel on its own any more than it can slash on its
   * own — the asymmetry would be just as exploitable in this direction, by
   * anyone who wanted a judgement to disappear. The program enforces that by making
   * `Config.admin` the instruction's only signer, and the admin key is a
   * person's.
   *
   * So this returns wire bytes with an empty signature slot. Nothing about the
   * case changes because it was called: the record leaves `Pending` when the
   * admin's transaction lands, and the reconcile sweep is what notices.
   */
  buildCancel(request: SlashCancelRequest): Promise<SlashCancelIntent>;

  /**
   * Reap a pending judgement that can no longer execute — its verifier key was
   * revoked, or the 7-day grace after `executable_at` has run out.
   *
   * **Permissionless.** No attestation and no privilege: the program checks the
   * record's own clock and the verifier key's own status, and anybody may call
   * it. The backend calling it is a courtesy to the provider whose stake is
   * held, not a control.
   *
   * Like {@link executeProposal}, reads the record first and throws
   * {@link ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND} when there is none.
   *
   * **That code is terminal and must be classified as such.** A `SlashRecord`
   * lives at exactly one PDA per request id, and both doors that end a
   * judgement close the account — so an absent record means the judgement is
   * over (or never began), and no amount of retrying will make it executable. It
   * is deliberately not folded into
   * {@link ChainErrorCode.CHAIN_TRANSACTION_FAILED}, whose `customErrorCode:
   * null` case means "the chain never answered" and is retryable by
   * construction.
   */
  expire(request: SlashCancelRequest): Promise<SlashCancelResult>;

  /**
   * What the chain says about one judgement, or `null` when no record exists.
   *
   * `null` is a normal answer, not an error: the recovery paths ask this
   * *before* they decide anything, and "we never proposed" and "the proposal
   * failed" are the same observation from here.
   */
  readRecord(
    requestId: string,
    provider: string,
    chainId: ChainId,
  ): Promise<SlashRecordSnapshot | null>;

  /**
   * `Config.treasury`, as CAIP-10 — the address the program pays the
   * platform's share of every penalty into.
   *
   * Exposed because one caller must know it in order to **refuse**: a judgement
   * whose `beneficiary` equals the treasury cannot execute, and it fails
   * without a named error because Anchor rejects the duplicate mutable account
   * before the handler runs. `SlashBeneficiaryService` compares against this
   * so the refusal happens off-chain, where it can say why.
   *
   * A read, not a second copy: the implementation returns the same value it
   * already caches for building the instruction, so the check and the
   * instruction can never disagree about which account the treasury is.
   *
   * Takes `asset` for the chain id alone — the same shape every `VaultPort`
   * method uses — because the treasury is one key and CAIP-10 needs a chain to
   * name it on.
   */
  settlementTreasury(asset: AssetId): Promise<AccountId>;

  /**
   * The delay a record proposed NOW would freeze into its `executableAt`, in
   * seconds, read from the chain (EVM: `X402Config.slashDelaySeconds()` since
   * the dispute upgrade, the old contract's constant before it). Optional, and
   * `null` when the namespace cannot say: the caller then falls back to the
   * Solana program's floor, `MIN_SLASH_DELAY_SECONDS` (72 h).
   */
  slashDelaySeconds?(chainId: ChainId): Promise<number | null>;
}

export const SLASH_EXECUTOR = 'SLASH_EXECUTOR';
