/**
 * Taking verification off the latency path, all the way through.
 *
 * `McpToolCallService` used to run `PROVIDER_EXECUTING → VERIFYING →
 * SETTLED` in one breath, committing the agent's hold on the strength of a
 * 2xx nobody had checked. This is what replaces the second half: the MCP
 * path now stops at `VERIFYING` and calls {@link enqueue}, which durably
 * records the call and wakes this service's worker entry point,
 * {@link judgeAndSettle}.
 *
 * ```text
 * enqueue(call)              PENDING row + BullMQ wakeup, before the agent's
 *                            response is returned
 *
 * judgeAndSettle(id)   ┌─ phase 1: judge ──▶ markJudgedIfPending  (CAS)
 *                      │        decide() the verdict, or — no policy —
 *                      │        an honest UNVERIFIED record that still settles
 *                      └─ phase 2: settle ─▶ apply the hold effect, then
 *                               markSettledIfJudged  (CAS)
 * ```
 *
 * ## The three independent guards against a double commit or a double release
 *
 * A worker can die between any two lines of this file, and BullMQ redelivers
 * at least once — so every method here has to be safe to run again from
 * scratch. Three mechanisms make that true, and each is sufficient on its
 * own:
 *
 * 1. `uq_verification_records_intent` — one verdict, ever, per intent
 *    (the migration).
 * 2. `markJudgedIfPending` / `markSettledIfJudged` are compare-and-swaps on
 *    `verification_records.state`: a zero-row result means somebody else
 *    already did that phase, which is read here as success, not an error.
 * 3. `PaymentIntentService.resolve` is itself a CAS on the intent's status,
 *    and `LedgerService.commitHold` / `releaseHold` are idempotent —
 *    `HoldResolution.applied === false` on a repeat.
 *
 * ## The gap those three do not close
 *
 * If the intent's status moves (`VERIFYING → SETTLED`) and the ledger call
 * that should follow it then never runs — the process dies in between — the
 * intent is terminal with `holdReleasedAt` still `null`, and nothing in
 * `PaymentIntentService` repairs that; its own doc comment on `resolve()`
 * names this exact repair pass as the worker's job. {@link settle} is where
 * it lives: when the record is `JUDGED` and the intent is *already*
 * terminal, it does not attempt `resolve()` again (the CAS would correctly
 * refuse it) — it applies the outstanding hold effect directly through
 * {@link repairHoldEffect}, using `holdReleasedAt === null` as the signal
 * that the effect never landed.
 */

import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { PaymentIntentRepository, VerificationRecordRepository } from '@database/postgres';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import {
  VerificationRecordState,
  VerificationRecordStateValue,
} from '@database/postgres/repositories/verification-record.repository';
import {
  HoldEffect,
  findPaymentIntentTransition,
  isTerminalPaymentIntentStatus,
} from '@modules/payment/domain/payment-intent-transitions';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  PaymentIntent,
  PaymentIntentStatus,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { JsonSchema } from '@modules/tool/domain/mapping/schema-validator';
import { BaseError } from '@shared/errors/base.error';
import { runInTransaction } from '@shared/database/transaction.util';

import {
  SampleRate,
  SamplingDecision,
  SemanticJudgement,
  SemanticOutcome,
  VerdictOutcome,
  decideSampling,
  deriveSampleRate,
  describeSampleRate,
  unrunStages,
  usdFromMoney,
} from '../domain';
import {
  VERIFICATION_SAMPLING_CONFIG,
  VerificationSamplingConfig,
} from '../config/verification-sampling.config';
import { EvidenceRecordSnapshot } from '../domain/evidence/pack.types';
import { SLA_WINDOW_POSTER, SlaWindowPoster } from '../ports/sla-window-poster.port';
import { VerificationJudgePublisher } from '../publishers/verification-judge.publisher';
import { EvidencePackSealerService } from './evidence-pack-sealer.service';
import {
  VerificationAggregatorService,
  VerificationOutcome,
} from './verification-aggregator.service';

/** The unique index a duplicate `enqueue()` collides with — see `enqueue()`. */
const VERIFICATION_RECORD_INTENT_CONSTRAINT = 'uq_verification_records_intent';

const VERIFICATION_SETTLED_REASON = 'verification: judged and settled by the worker';
const VERIFICATION_REFUNDED_REASON = 'verification: judged and refunded by the worker';
const VERIFICATION_VOIDED_REASON = 'verification: judged void by the worker — no charge, no strike';

/**
 * Written when `decide()` returned `null` — a tool with no decision policy at
 * all. Not a member of `VerdictStatus`: that vocabulary is for a policy that
 * actually ran, and this is the honest record of one that did not. Chosen to
 * match the exact string the earlier MCP stopgap used for the same fact,
 * so a query across the transition doesn't have to know which era wrote a row.
 */
const UNVERIFIED_VERDICT_STATUS = 'UNVERIFIED';
const NO_DECISION_POLICY_REASON_CODE = 'no_decision_policy';
const NO_DECISION_POLICY_REASON =
  'This check was not run: no policy is configured for this tool. The call settles unverified.';

/**
 * Sentinels for `decision_policy_id` / `decision_policy_version`.
 *
 * `chk_verification_records_judged_is_whole` requires both on every row that
 * leaves `PENDING` — a judged record without a policy version is not
 * evidence (a dispute cannot replay it) — and there is no real policy to name
 * when `decide()` found none at all. `'none'` / `0` are outside the id and
 * version space any real `DecisionPolicyService.register()` can produce
 * (versions start at 1), so they cannot collide with a real policy by
 * accident.
 */
const NO_DECISION_POLICY_ID = 'none';
const NO_DECISION_POLICY_VERSION = 0;

/**
 * A selector outside `[0, 1)` — `sampleSelector`'s actual range — so
 * `selector < rate.rate` is false for every possible rate, including a
 * `FLOOR` override's `1`. This is what makes "no sampling secret configured"
 * fail closed rather than drawing against a predictable key: see
 * `../config/verification-sampling.config.ts`.
 */
const NEVER_SAMPLED_SELECTOR = 1;

export interface EnqueueVerificationInput {
  readonly organizationId: string;
  readonly intentId: string;
  readonly toolId: string;
  readonly providerId: string;
  /** The agent's tool arguments. */
  readonly request: JsonValue;
  /** `routed.output` — the response after the binding's mapping. */
  readonly response: JsonValue;
  readonly outputSchema: JsonSchema;
}

@Injectable()
export class VerificationSettlementService {
  private readonly logger = new Logger(VerificationSettlementService.name);

  constructor(
    private readonly records: VerificationRecordRepository,
    private readonly paymentIntents: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    private readonly ledger: LedgerService,
    private readonly aggregator: VerificationAggregatorService,
    private readonly publisher: VerificationJudgePublisher,
    private readonly sealer: EvidencePackSealerService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(VERIFICATION_SAMPLING_CONFIG) private readonly sampling: VerificationSamplingConfig,
    @Inject(SLA_WINDOW_POSTER) private readonly slaWindowPoster: SlaWindowPoster,
  ) {}

  // ── The caller's half ────────────────────────────────────────────────────

  /**
   * Writes the durable record and wakes the worker.
   *
   * Called synchronously from `McpToolCallService.resolveDataResult`, so it
   * has to be fast and it has to be safe to call twice: the unique index on
   * `intent_id` is what turns a duplicate write — a retried enqueue for an
   * intent that already has a record — into a no-op rather than a thrown
   * error the agent's response would otherwise have to absorb.
   */
  async enqueue(input: EnqueueVerificationInput): Promise<void> {
    const id = randomUUID();

    try {
      await this.records.insert({
        id,
        organizationId: input.organizationId,
        intentId: input.intentId,
        toolId: input.toolId,
        providerId: input.providerId,
        state: VerificationRecordState.PENDING,
        request: input.request ?? null,
        response: input.response,
        outputSchema: input.outputSchema ?? null,
      });
    } catch (error) {
      if (!isDuplicateRecord(error)) throw error;
      this.logger.debug(
        `Verification record for intent ${input.intentId} already exists; not duplicating.`,
      );
    }

    const record = await this.records.findByIntentId(input.organizationId, input.intentId);
    if (!record) {
      // The insert above — ours or a racing one that won the unique index —
      // must have produced a row. This table is never deleted from, so a miss
      // here means something upstream is badly wrong rather than a race to
      // account for.
      throw new Error(`verification record for intent ${input.intentId} did not persist`);
    }

    await this.publisher.publishJudge({
      organizationId: input.organizationId,
      intentId: input.intentId,
      recordId: record.id,
    });
  }

  // ── The worker's half ────────────────────────────────────────────────────

  /**
   * The worker entry point. Re-entrant: safe to call any number of times for
   * the same intent, from a fresh process, in any order relative to another
   * call that is still in flight.
   */
  async judgeAndSettle(organizationId: string, intentId: string): Promise<void> {
    const record = await this.records.findByIntentId(organizationId, intentId);
    if (!record) {
      // `enqueue()` always writes the row before publishing, so a missing
      // record this deep means the wakeup outlived it somehow — a manual
      // queue poke, a test double, a bug elsewhere. There is nothing to judge
      // and nothing to repair, so this drops the wakeup rather than crashing
      // a worker that has no way to make the situation better.
      this.logger.error(`No verification record for intent ${intentId}; dropping the wakeup.`);
      return;
    }

    let current = record;
    if ((current.state as VerificationRecordStateValue) === VerificationRecordState.PENDING) {
      current = await this.judge(organizationId, current);
    }

    if ((current.state as VerificationRecordStateValue) === VerificationRecordState.JUDGED) {
      await this.settle(organizationId, current);
    }
    // Otherwise `SETTLED` — a previous run (or a concurrent one that beat
    // this one to both compare-and-swaps) already finished the job.
  }

  // ── Phase 1: judge ───────────────────────────────────────────────────────

  private async judge(
    organizationId: string,
    record: VerificationRecordEntity,
  ): Promise<VerificationRecordEntity> {
    const intent = await this.intents.findById(organizationId, record.intentId);

    const rate = deriveSampleRate({
      platformFeeUsd: usdFromMoney(intent.platformFee),
      budget: this.sampling.budget,
    });
    const sampling = this.draw(record.intentId, rate);
    const semantic = this.semanticJudgementFor(sampling);
    const evaluatedAt = new Date();

    const outcome = await this.aggregator.decide({
      intentId: record.intentId,
      toolId: record.toolId,
      response: record.response as JsonValue,
      request: (record.request ?? undefined) as JsonValue | undefined,
      outputSchema: (record.outputSchema ?? undefined) as JsonSchema | undefined,
      semantic,
      semanticCostUsd: semantic?.costUsd ?? 0,
      evaluatedAt,
    });

    const patch = outcome
      ? judgedPatch(outcome, rate, sampling)
      : unverifiedPatch(rate, sampling, evaluatedAt);

    // The verdict and its evidence commit together or not at all.
    //
    // `markJudgedIfPending` is the compare-and-swap that decides which worker
    // owns this judgement; the winner seals inside the same transaction, so
    // `state = JUDGED` can never be true with no pack behind it. The cost is
    // deliberate and worth saying twice: a sealer that throws rolls the verdict
    // back to `PENDING` and the worker retries, which stops judging rather than
    // letting it run without evidence.
    await runInTransaction(
      this.dataSource,
      async (queryRunner) => {
        const affected = await this.records.markJudgedIfPending(
          organizationId,
          record.id,
          patch,
          queryRunner,
        );

        if (affected === 0) {
          this.logger.debug(
            `Verification record ${record.id} (intent ${record.intentId}) was already judged ` +
              `by another worker; keeping its verdict rather than this one.`,
          );
          return;
        }

        await this.sealer.seal(queryRunner, {
          record: evidenceSnapshot(record, patch),
          request: record.request,
          response: record.response,
          sealedAt: new Date(),
        });
      },
      this.logger,
    );

    return this.mustFindByIntentId(organizationId, record.intentId);
  }

  /** The keyed draw, or a guaranteed miss when no sampling secret is configured. */
  private draw(intentId: string, rate: SampleRate): SamplingDecision {
    if (this.sampling.secret === null) {
      return { sampled: false, rate, selector: NEVER_SAMPLED_SELECTOR };
    }
    return decideSampling({ secret: this.sampling.secret, intentId, rate });
  }

  /**
   * The value `runSemanticStage` reads — never a fabricated pass.
   *
   * `undefined` on a hit is deliberate: no `SEMANTIC_JUDGE` is bound (there is
   * no model client yet), and passing no judgement at all
   * is what makes the stage record `NOT_IMPLEMENTED` — "nobody looked" —
   * rather than inventing a judgement nobody made.
   */
  private semanticJudgementFor(sampling: SamplingDecision): SemanticJudgement | undefined {
    if (!sampling.sampled) {
      return {
        outcome: SemanticOutcome.NOT_SAMPLED,
        sampling,
        scores: null,
        context: null,
        costUsd: 0,
        unavailableReason: null,
      };
    }
    return undefined;
  }

  // ── Phase 2: settle ──────────────────────────────────────────────────────

  private async settle(organizationId: string, record: VerificationRecordEntity): Promise<void> {
    const intent = await this.intents.findById(organizationId, record.intentId);
    const outcome = record.settlementOutcome as VerdictOutcome;

    if (!isTerminalPaymentIntentStatus(intent.status)) {
      await this.transitionIntent(organizationId, intent, record, outcome);
    } else {
      await this.voidLateRejectedDebt(organizationId, intent, outcome);
      if (intent.holdReleasedAt === null) {
        await this.repairHoldEffect(organizationId, intent);
      }
    }
    // Terminal and the hold is already resolved: nothing left to do but mark
    // the record, below.

    // The SLA window post. Before `markSettledIfJudged`, deliberately: if this
    // throws, the record stays `JUDGED` and a redelivery re-enters `settle()`
    // from the top, so the call gets posted on the retry — after
    // `markSettledIfJudged` succeeds there is no path back into this method
    // for this intent, ever. `uq_sla_window_calls_intent` is what makes the
    // retry's repeat post a no-op rather than a double count. `providerId` is
    // required on `POST /` per the schema's own CHECK for every non-void
    // outcome that reaches here, but this stays defensive rather than assumed.
    if (intent.providerId) {
      await this.slaWindowPoster.postCall({
        organizationId: intent.providerId,
        providerId: intent.providerId,
        bindingId: intent.bindingId,
        toolId: record.toolId,
        intentId: record.intentId,
        agentId: intent.agentId,
        verdictStatus: record.verdictStatus,
        reasonCode: record.reasonCode,
        priceAmount: intent.price.amount,
        assetId: intent.price.asset,
        postedAt: new Date(),
      });
    } else {
      this.logger.debug(
        `Intent ${record.intentId} has no providerId at settle; not posting an SLA window call.`,
      );
    }

    const affected = await this.records.markSettledIfJudged(organizationId, record.id, {
      settledAt: new Date(),
    });
    if (affected === 0) {
      this.logger.debug(
        `Verification record ${record.id} (intent ${record.intentId}) was already settled ` +
          `by another worker.`,
      );
    }
  }

  /** The normal path: the intent is still `VERIFYING`, so `resolve()` gets to do the work. */
  private async transitionIntent(
    organizationId: string,
    intent: PaymentIntent,
    record: VerificationRecordEntity,
    outcome: VerdictOutcome,
  ): Promise<void> {
    // VOID is not REFUND: same money back to the agent, but no provider fault,
    // so it lands on VOIDED and is bucketed as the platform's or nobody's.
    const to =
      outcome === VerdictOutcome.SETTLE
        ? PaymentIntentStatus.SETTLED
        : outcome === VerdictOutcome.VOID
          ? PaymentIntentStatus.VOIDED
          : PaymentIntentStatus.REFUNDED;

    try {
      await this.intents.resolve(
        organizationId,
        record.intentId,
        PaymentIntentStatus.VERIFYING,
        to,
        {
          reason:
            to === PaymentIntentStatus.SETTLED
              ? VERIFICATION_SETTLED_REASON
              : to === PaymentIntentStatus.VOIDED
                ? VERIFICATION_VOIDED_REASON
                : VERIFICATION_REFUNDED_REASON,
          verificationVerdict: record.verdictStatus ?? undefined,
          ...(to === PaymentIntentStatus.SETTLED ? { settledAmount: intent.price } : {}),
        },
      );
    } catch (error) {
      if (!isInvalidStateTransition(error)) throw error;

      // Lost the compare-and-swap — a concurrent delivery of this same
      // wakeup (BullMQ is at-least-once) or a worker that already finished
      // this record got there first. The intent is terminal now either way;
      // fall through to the same repair check a *pre-terminal* read of
      // `settle()` would have taken, so a hold that did not make it across
      // before the loser's own `resolve()` call still gets closed.
      const fresh = await this.intents.findById(organizationId, record.intentId);
      await this.voidLateRejectedDebt(organizationId, fresh, outcome);
      if (fresh.holdReleasedAt === null) {
        await this.repairHoldEffect(organizationId, fresh);
      }
    }
  }

  /**
   * A verdict that REJECTS the call (REFUND or VOID) arriving after the
   * verdict-deadline sweep settled it as served and unverified: if the call
   * has become buyer debt, the debt is VOIDED — the hold is released, nobody
   * is credited, the buyer is not charged and its paid calls are no longer
   * refused for it (review-buyer-debt M2). A row still awaiting redemption is
   * left as it is (the rule a failed verification enqueue already follows),
   * and so is a debt whose replacement is being collected.
   */
  private async voidLateRejectedDebt(
    organizationId: string,
    intent: PaymentIntent,
    outcome: VerdictOutcome,
  ): Promise<void> {
    if (
      outcome === VerdictOutcome.SETTLE ||
      intent.status !== PaymentIntentStatus.SETTLED ||
      intent.rail !== PaymentRail.RAIL_B_VOUCHER
    ) {
      return;
    }
    await this.intents.voidDebt(organizationId, intent.id, outcome);
  }

  /**
   * Closes a hold that the intent's own status says should already be
   * closed, without touching the intent's status again.
   *
   * The gap `payment-intent.service.ts`'s own doc comment on `resolve()`
   * names as the worker's: a crash between the status CAS and the ledger call
   * leaves a terminal intent with `holdReleasedAt: null`, and nothing
   * repairs it automatically. `resolve()` cannot be re-run to fix this — its
   * CAS would (correctly) refuse a `from` the intent has already left — so
   * this applies the exact same two effects `resolve()`'s `COMMIT` branch
   * applies internally: the ledger call (idempotent — `applied: false` on a
   * repeat, so calling this twice is harmless) and the `holdReleasedAt`
   * stamp.
   *
   * Reaches `PaymentIntentRepository` directly rather than through
   * `PaymentIntentService` for that stamp. `PaymentIntentService` has a
   * public `releaseHold()` — release, and only release — and no public
   * equivalent for `COMMIT` either, so this calls `LedgerService` directly for
   * both branches, performing the identical writes `resolve()` performs
   * internally. The `COMMIT` branch calls
   * `commitHoldAndCredit`, not `commitHold` — a repaired commit still owes the
   * provider and the platform their two entries, for the same conservation
   * reason `resolve()`'s own `COMMIT` branch does. Database CHECKs refuse this
   * status without `provider_id` (`chk_payment_intents_paying_states_name_payee`)
   * or `provider_account` (`chk_payment_intents_settled_names_payee` — before
   * it was added, the second of those was asserted here and nowhere
   * enforced).
   */
  private async repairHoldEffect(organizationId: string, intent: PaymentIntent): Promise<void> {
    if (intent.holdReleasedAt !== null || !intent.holdId) return;
    // Held for the dispute window (G3.B1): `HeldCollectionService` commits it,
    // or an upheld dispute releases it. Not a lost commit.
    if (intent.heldStatus === 'HELD') return;

    if (
      intent.rail === PaymentRail.RAIL_B_VOUCHER &&
      intent.status === PaymentIntentStatus.SETTLED
    ) {
      // Not a lost commit. `holdReleasedAt === null` on a SETTLED intent used
      // to mean exactly one thing — a worker died between the status change
      // and the ledger call — and on rail B it now means a second: the hold is
      // *awaiting redemption*, and `VoucherRedemptionJob` owns it.
      //
      // Only SETTLED (review 2026-10-15 P-8). A rail-B intent that ended
      // REFUNDED or VOIDED is never redeemed — the queue reads SETTLED only —
      // so its open hold is a lost RELEASE, and it falls through to be
      // repaired like rail A's.
      //
      // The two SETTLED cases are indistinguishable from here, so this refuses
      // rather than guesses. Committing would credit the provider out of money still
      // sitting in the buyer's escrow, and would make the earnings-vault
      // reconciliation check report a shortfall that is not real; releasing would hand the
      // buyer back a call that passed. Redemption reaches the same hold
      // through `PaymentIntentService.commitRedeemedHold`, with the signature
      // this path could never supply.
      return;
    }

    // **The intent's own status decides, not the verdict.** They agree on every
    // path that exists today — a record only exists once the intent reached
    // `VERIFYING`, and the edges out of it are the three this worker takes
    // plus the hold backstop — but "they agree" is a claim about the current call graph,
    // and this method runs precisely when the current call graph did not
    // finish. `payment_intents.status` is what the transition table binds a
    // `holdEffect` to, so reading the effect from anywhere else means the money
    // could move in a direction the payment record does not describe. Deriving
    // it from the table is also self-correcting: a future edge into a terminal
    // state arrives here with its effect already declared.
    const rule = findPaymentIntentTransition(PaymentIntentStatus.VERIFYING, intent.status);

    if (!rule) {
      // A terminal intent with an open hold that verification did not put
      // there. Refuse rather than guess: releasing would hand back money a
      // different edge may have meant to take, and committing would take money
      // nobody decided to take.
      this.logger.error(
        `Intent ${intent.id}: hold ${intent.holdId} is open on status ${intent.status}, which is ` +
          `not reachable from VERIFYING. Not repairing; the 24-hour hold backstop does not ` +
          `cover a terminal intent either. Release this hold by hand.`,
      );
      return;
    }

    if (rule.holdEffect === HoldEffect.COMMIT) {
      if (!intent.providerId || !intent.providerAccount) {
        this.logger.error(
          `Intent ${intent.id}: hold ${intent.holdId} needs a COMMIT repair but has no provider ` +
            `assigned. Not repairing — unreachable under the schema's own CHECKs, so this is a ` +
            `legacy row or a defect upstream of the transition table. Nothing else will return ` +
            `this money either; release the hold by hand.`,
        );
        return;
      }
      await this.ledger.commitHoldAndCredit(organizationId, intent.holdId, {
        providerOrganizationId: intent.providerId,
        providerAccountId: intent.providerAccount,
        providerAmount: intent.providerAmount,
        platformFee: intent.platformFee,
        intentId: intent.id,
        // Rail A only — the branch above returns before this for a SETTLED
        // rail-B intent, the only COMMIT edge — so there is no chain
        // transaction to name.
        chainTxRef: LEGACY_POOLED_VAULT_TX_REF,
      });
    } else if (rule.holdEffect === HoldEffect.RELEASE) {
      await this.ledger.releaseHold(organizationId, intent.holdId);
    } else {
      return;
    }

    await this.paymentIntents.update(
      { organizationId, id: intent.id },
      { holdReleasedAt: new Date() },
    );
  }

  private async mustFindByIntentId(
    organizationId: string,
    intentId: string,
  ): Promise<VerificationRecordEntity> {
    const record = await this.records.findByIntentId(organizationId, intentId);
    if (!record) {
      throw new Error(`verification record for intent ${intentId} vanished mid-judge`);
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The judged columns, as concrete values rather than TypeORM's deep partial.
 *
 * The same object is used twice — as the UPDATE's SET clause, and as the half
 * of the evidence snapshot that the pre-CAS record does not have. A
 * `QueryDeepPartialEntity` permits a function in every field, so spreading one
 * into a snapshot would type-check as `string | (() => string)` and force a
 * cast at exactly the place where a mistake would be invisible.
 */
type VerdictPatch = {
  [K in keyof EvidenceRecordSnapshot as K extends
    | 'id'
    | 'organizationId'
    | 'intentId'
    | 'toolId'
    | 'providerId'
    | 'createdAt'
    ? never
    : K]: EvidenceRecordSnapshot[K];
};

/**
 * The record as it is *after* the judging patch, which is what gets sealed.
 *
 * Built from the pre-CAS entity plus the patch rather than by re-reading the
 * row, because a re-read inside the transaction would see the same values and
 * cost a query, and a re-read outside it would race the next writer.
 */
function evidenceSnapshot(
  record: VerificationRecordEntity,
  patch: VerdictPatch,
): EvidenceRecordSnapshot {
  return {
    id: record.id,
    organizationId: record.organizationId,
    intentId: record.intentId,
    toolId: record.toolId,
    providerId: record.providerId,
    createdAt: record.createdAt,
    ...patch,
  };
}

function judgedPatch(
  outcome: VerificationOutcome,
  rate: SampleRate,
  sampling: SamplingDecision,
): VerdictPatch {
  return {
    verdictStatus: outcome.verdict.status,
    reasonCode: outcome.verdict.reasonCode,
    reason: outcome.verdict.reason,
    score: outcome.verdict.score,
    costUsd: outcome.verdict.costUsd,
    policyId: outcome.verdict.policyId,
    policyVersion: outcome.verdict.policyVersion,
    decisionPolicyId: outcome.verdict.decisionPolicyId,
    decisionPolicyVersion: outcome.verdict.decisionPolicyVersion,
    lifecycle: outcome.verdict.lifecycle,
    stages: outcome.stages,
    verifiers: outcome.verdict.verifiers,
    tally: outcome.verdict.tally,
    decidedBy: outcome.verdict.decidedBy,
    evaluatedAt: outcome.verdict.evaluatedAt,
    settlementOutcome: outcome.settlement.outcome,
    sampleRate: rate.rate,
    sampled: sampling.sampled,
    sampleSelector: sampling.selector,
    sampleDisplay: describeSampleRate(rate),
  };
}

/**
 * `decide()` returned `null` — no decision policy exists for this tool at
 * all. An honest, settling record: the four pipeline rows all say plainly
 * that nothing ran (`unrunStages`), and `settlementOutcome` is `SETTLE`
 * because a tool nobody wrote a policy for is the platform's gap, not the
 * provider's — the same reasoning `VerificationAggregatorService.decide`
 * gives for returning `null` in the first place. Never `VerdictStatus.PASS`:
 * that would claim a judgement was made, and none was.
 */
function unverifiedPatch(
  rate: SampleRate,
  sampling: SamplingDecision,
  evaluatedAt: Date,
): VerdictPatch {
  return {
    verdictStatus: UNVERIFIED_VERDICT_STATUS,
    reasonCode: NO_DECISION_POLICY_REASON_CODE,
    reason: NO_DECISION_POLICY_REASON,
    score: null,
    costUsd: 0,
    policyId: null,
    policyVersion: null,
    decisionPolicyId: NO_DECISION_POLICY_ID,
    decisionPolicyVersion: NO_DECISION_POLICY_VERSION,
    lifecycle: null,
    stages: unrunStages(NO_DECISION_POLICY_REASON_CODE, NO_DECISION_POLICY_REASON).map(
      (evaluation) => evaluation.result,
    ),
    verifiers: null,
    tally: null,
    decidedBy: null,
    evaluatedAt,
    settlementOutcome: VerdictOutcome.SETTLE,
    sampleRate: rate.rate,
    sampled: sampling.sampled,
    sampleSelector: sampling.selector,
    sampleDisplay: describeSampleRate(rate),
  };
}

function isDuplicateRecord(error: unknown): boolean {
  const violation = error as { code?: string; constraint?: string };
  return (
    violation?.code === UNIQUE_VIOLATION_CODE &&
    violation?.constraint === VERIFICATION_RECORD_INTENT_CONSTRAINT
  );
}

function isInvalidStateTransition(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.errorCode === PaymentErrorCode.PAYMENT_INVALID_STATE_TRANSITION
  );
}
