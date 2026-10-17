import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { assertRailOffered, chainMetadata, offersRail } from '@modules/chains/chain-metadata';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { PAYMENT_INTENT_UNFUNDED_KEY_RELEASE_REASON } from '@modules/payment/constants/payment-intent.constants';
import { VOUCHER_MAX_TTL_SECONDS } from '@modules/payment/constants/voucher.constants';
import { PaymentErrorCode, PaymentErrors } from '@modules/payment/errors/payment.errors';
import {
  RequestCall,
  computeRequestHash,
  computeRoutedCallHash,
} from '@modules/payment/domain/request-hash';
import { SignedVoucher } from '@modules/payment/ports/voucher.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentIntentTransitionContext,
  PaymentRail,
  railName,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import {
  ClassificationReason,
  ResponseClass,
  isRetryable,
} from '@modules/tool/domain/classification';
import { RoutingContext, RoutingRules } from '@modules/tool/domain/routing';
import { ToolAccessErrorCode, ToolAccessErrors } from '@modules/tool/errors/tool-access.errors';
import { CallAttribution } from '@modules/toolset/domain/attribution';
import {
  JsonObject,
  JsonValue,
  MappingDirection,
  MappingFault,
  validateAgainstSchema,
} from '@modules/tool/domain/mapping';
import { buildFreeQuotaErrorContext } from '@modules/free-tier/services/free-quota-refusal.util';
import {
  FreeQuotaDecision,
  FreeQuotaLimitKind,
  FreeQuotaReservation,
  FreeQuotaService,
} from '@modules/free-tier/services/free-quota.service';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { ToolErrorCode, ToolErrors } from '@modules/tool/errors/tool.errors';
import { PricingMode, Tool } from '@modules/tool/ports/tool.types';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import {
  ProviderRouterService,
  RoutedCall,
  ToolQuote,
  bindingPrice,
  contractRefused,
  ruleRefusal,
} from '@modules/tool/services/provider-router.service';
import {
  ContractRequest,
  NO_CONTRACT_REQUEST,
} from '@modules/tool/domain/contract/contract-versions';
import {
  EnqueueVerificationInput,
  VerificationSettlementService,
} from '@modules/verification/services/verification-settlement.service';
import { AppError } from '@shared/errors/app-errors';
import { BaseError } from '@shared/errors/base.error';
import { MoneyUtil } from '@utils/money.util';

import {
  MCP_ALL_PROVIDERS_FAILED_REASON,
  MCP_FORWARDED_REASON,
  MCP_FORWARDED_TO_VERIFICATION_REASON,
  MCP_SCHEMA_CONTRACT_VIOLATION_REASON,
  MCP_UNPAYABLE_PROVIDER_REASON,
  MCP_UNROUTABLE_REASON,
  MCP_VERIFICATION_ENQUEUE_FAILED_REASON,
  MCP_VOIDED_REASON,
} from '../constants/mcp.constants';
import { argumentsFingerprint } from '../domain/idempotency';
import { McpErrors } from '../errors/mcp.errors';
import { McpScope, contractFor, forcesFree, rulesFor } from '../ports/mcp-scope';
import { McpSession, storedCredentialIdOf } from '../ports/mcp-session.port';
import { CallAttributionWriter } from './call-attribution.writer';
import { McpCatalogueService } from './mcp-catalogue.service';
import { MCP_PRICING, McpPricingConfig } from './mcp-pricing.config';
import {
  MCP_IDEMPOTENCY_CONFIG,
  McpIdempotencyConfig,
  McpIdempotencyStore,
} from './mcp-idempotency.store';

/**
 * `tools/call` — one paid tool call, end to end.
 *
 * ```text
 *  resolve the tool by name          MCP_TOOL_NOT_FOUND
 *  quote it                          TOOL_NO_ELIGIBLE_BINDING
 *  validate the arguments            TOOL_MAPPING_*  (fault: AGENT)  ← before any money moves
 *  create the intent                 CREATED
 *  reserve the price                 FUNDS_SECURED   (ledger hold)
 *  hand it to the router             PROVIDER_EXECUTING
 *      │
 *      ├─ DATA_RESULT, schema-valid  VERIFYING          durably recorded, handed to the
 *      │                                                 asynchronous verification worker
 *      ├─ DATA_RESULT, schema-fail   VERIFYING → REFUNDED   the schema layer already decided
 *      ├─ SYSTEM/REQUEST_ERROR       VOIDED                  hold released
 *      └─ nothing was routable       VOIDED                  hold released
 * ```
 *
 * ## The order is the point
 *
 * Everything that can refuse the call for free happens before the intent
 * exists, and everything that costs a provider call happens after the hold is
 * open. A tool that does not exist, has no routable supply, or was called with
 * arguments its own schema rejects never reaches a payment record — three
 * outcomes that would otherwise each leave an intent to be swept and a hold to
 * be released, for a call that was never going to happen.
 *
 * Conversely the hold is opened **before** the router is asked for a binding,
 * not after it returns. A provider call is the expensive, irreversible half; a
 * balance checked after it has been spent is a balance checked too late.
 *
 * ## What this does not do
 *
 * **It does not verify anything itself.** A `DATA_RESULT` whose payload
 * passed the tool's `outputSchema` is durably recorded as a `PENDING`
 * `verification_records` row and handed to
 * `VerificationSettlementService`'s asynchronous worker via a BullMQ wakeup
 * that carries nothing but ids — `docs/adr/0001-bullmq-as-wakeup-mechanism.md`.
 * That worker is what decides `SETTLED` vs `REFUNDED`, once the cheap stages
 * — and, sampled, the semantic one — have actually run. This
 * method's job ends at `VERIFYING`, and the receipt now says so:
 * `status: VERIFYING` is the truth, not a placeholder for one, and an agent
 * that wants the verdict reads it off the receipt once the worker has run.
 *
 * The one branch that never needed the worker's opinion is
 * {@link McpToolCallService.resolveDataResult}'s schema-fail case: a
 * `DATA_RESULT` whose payload did **not** survive the tool's own
 * `outputSchema` is a provable contract violation the schema layer already
 * decided inside `mapResponse`, and refunding it synchronously is not
 * skipping verification — it is not re-asking a question that was already
 * answered.
 */
@Injectable()
export class McpToolCallService {
  private readonly logger = new Logger(McpToolCallService.name);

  constructor(
    private readonly catalogue: McpCatalogueService,
    private readonly router: ProviderRouterService,
    private readonly intents: PaymentIntentService,
    private readonly ledger: LedgerService,
    private readonly settlement: VerificationSettlementService,
    private readonly bindingCalls: BindingCallCounterService,
    private readonly spendPolicy: SpendPolicyEnforcementService,
    private readonly freeQuota: FreeQuotaService,
    private readonly records: ToolCallRecordWriter,
    // Rail B (`x402/voucher`). The voucher is verified, bound and recorded by
    // `VoucherService` — the same class, and the only one, that decides whether
    // a signed voucher pays for a call.
    private readonly vouchers: VoucherService,
    private readonly seqs: EscrowSeqService,
    @Inject(ESCROW_BALANCE_READER) private readonly escrow: EscrowBalanceReaderPort,
    @Inject(MCP_PRICING) private readonly pricing: McpPricingConfig,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    // `_meta["x402/idempotency-key"]`: the replay record of a keyed call.
    private readonly idempotency: McpIdempotencyStore,
    @Inject(MCP_IDEMPOTENCY_CONFIG) private readonly idempotencyConfig: McpIdempotencyConfig,
    // A served keyed call's mapped response, when the replay record is gone.
    private readonly verificationRecords: VerificationRecordRepository,
    // Stamps which MCP URL a paid call came through on its intent. Optional so
    // a hand-built harness needs none.
    @Optional() private readonly attribution?: CallAttributionWriter,
  ) {}

  /**
   * One `tools/call`. `idempotencyKey` is the validated
   * `_meta["x402/idempotency-key"]`, or `null` — and `null` runs the call
   * exactly as it ran before keys existed.
   *
   * `scope` is the URL's view and the caller's access (`McpScope`): the tool
   * must be in the view (`TOOL_NOT_IN_TOOLSET`) and allowed
   * (`TOOL_NOT_ALLOWED`), and it is quoted, offered and routed under the
   * entry's and the agent's rules. Absent only off the MCP host (the public
   * demo), where the whole catalogue is the view.
   */
  async call(
    session: McpSession,
    name: string,
    args: JsonObject,
    payment: McpPayment = NO_PAYMENT,
    scope?: McpScope,
    idempotencyKey: string | null = null,
  ): Promise<McpCallOutcome> {
    const tool = scope
      ? await this.catalogue.admit(name, scope)
      : await this.catalogue.findByName(name);
    if (idempotencyKey === null) return this.run(session, tool, args, payment, null, scope);
    return this.callKeyed(session, tool, args, payment, idempotencyKey, scope);
  }

  // ── Idempotency (G2.1) ────────────────────────────────────────────────────

  /**
   * A keyed call: at most one attempt runs, and at most one is charged.
   *
   * ```text
   *  claim the key (Redis)       other tool / other args → IDEMPOTENCY_KEY_REUSED
   *                              still running           → IDEMPOTENCY_IN_PROGRESS
   *                              returned a result       → that result, replayed
   *  ask the payment record      it holds the key        → in progress, stalled,
   *                                                         rebuilt, or unavailable
   *  run the call                the key reaches `intents.create` / `redeem`
   *    ├─ RESULT                 stored for the retry window
   *    └─ anything else          released: it charged nothing, so a retry is a
   *                              fresh attempt (a rail-B PAYMENT_REQUIRED too)
   * ```
   *
   * Both look-ups run before the free/paid fork and before the spend-policy
   * gate, so a replay or a poll takes no free-quota place, opens no hold,
   * redeems no voucher and never counts toward the agent's velocity limits.
   *
   * The Redis record is the fast path and the home of the stored result. The
   * guarantee against a second CHARGE is the payment record's partial unique
   * index on the same key (see {@link replayedIntent}), which still holds when
   * the record is gone. A free call has no payment record, so it has no such
   * backstop: see `X402_IDEMPOTENCY_KEY`.
   */
  private async callKeyed(
    session: McpSession,
    tool: Tool,
    args: JsonObject,
    payment: McpPayment,
    idempotencyKey: string,
    scope?: McpScope,
  ): Promise<McpCallOutcome> {
    const claim = await this.idempotency.claim<McpStoredResult>({
      organizationId: session.organizationId,
      agentId: session.agentId,
      key: idempotencyKey,
      toolId: tool.id,
      fingerprint: argumentsFingerprint(args),
    });

    if (claim.kind === 'CONFLICT') return keyReused(tool, claim.reason);
    if (claim.kind === 'IN_PROGRESS') return inProgress(claim.retryAfterSeconds, null);
    if (claim.kind === 'REPLAY') return this.replay(session, claim.result);

    // `UNAVAILABLE`: Redis did not answer. The call runs; the payment index
    // still refuses a second charge on the paid paths.
    const handle = claim.kind === 'CLAIMED' ? claim.handle : null;

    let outcome: McpCallOutcome;
    try {
      // The payment record next — a Redis record lost, or a lease that lapsed
      // while a call was running or after a process died, leaves the key held
      // there and only there.
      const held = await this.intents.findLiveByIdempotencyKey(
        session.organizationId,
        session.agentId,
        idempotencyKey,
      );
      outcome = held
        ? held.toolId === tool.id
          ? await this.replayedIntent(session, held)
          : keyReused(tool, 'TOOL')
        : await this.run(session, tool, args, payment, idempotencyKey, scope);
    } catch (error) {
      if (handle) {
        await this.releaseAbandonedKey(session, idempotencyKey);
        await this.idempotency.release(handle);
      }
      // The payment record holds this key for a different request (tool,
      // arguments or price) — the record that would have said so was lost.
      if (isPaymentKeyReused(error)) return keyReused(tool, 'REQUEST');
      throw error;
    }

    if (handle) {
      if (outcome.kind === 'RESULT' && !outcome.replayed) {
        await this.idempotency.complete<McpStoredResult>(handle, this.storable(outcome));
      } else {
        await this.idempotency.release(handle);
      }
    }
    return outcome;
  }

  /**
   * What is kept for a replay: the result as the agent got it, or — past
   * `maxResultBytes` — only a marker naming the intent, so a provider's large
   * response is not held in Redis for the retry window.
   */
  private storable(outcome: McpCallOutcome & { kind: 'RESULT' }): McpStoredResult {
    const bytes = Buffer.byteLength(JSON.stringify(outcome.output ?? null), 'utf8');
    if (bytes > this.idempotencyConfig.maxResultBytes) {
      return { kind: 'TOO_LARGE', intentId: outcome.receipt.intentId };
    }
    return { kind: 'RESULT', output: outcome.output, receipt: outcome.receipt };
  }

  /**
   * The stored result of an earlier attempt, with its receipt's status read
   * again — a call stored at `VERIFYING` may have `SETTLED` since, and the
   * receipt is the agent's record of what it paid. Read failures keep the
   * stored receipt: a stale status is better than losing the result.
   */
  private async replay(session: McpSession, stored: McpStoredResult): Promise<McpCallOutcome> {
    if (stored.kind === 'TOO_LARGE') {
      return resultUnavailable(stored.intentId, null, 'it was too large to keep for a replay');
    }
    const receipt = stored.receipt;
    if (!receipt.intentId) {
      return { kind: 'RESULT', output: stored.output, receipt, replayed: true };
    }

    try {
      const intent = await this.intents.findById(session.organizationId, receipt.intentId);
      const zero = MoneyUtil.zero(intent.price.asset, intent.price.decimals);
      const held = MoneyUtil.isZero(receipt.held) ? intent.price : receipt.held;
      return {
        kind: 'RESULT',
        output: stored.output,
        receipt: {
          ...receipt,
          status: intent.status,
          charged: intent.status === PaymentIntentStatus.SETTLED ? intent.price : zero,
          held: isAwaitingVerdict(intent.status) ? held : zero,
        },
        replayed: true,
      };
    } catch (error) {
      this.logger.warn(
        `Intent ${receipt.intentId}: replaying a stored result with its stored receipt; ` +
          `the intent could not be read. ${describe(error)}`,
      );
      return { kind: 'RESULT', output: stored.output, receipt, replayed: true };
    }
  }

  /**
   * The payment record holds this key: an EARLIER attempt of this call
   * created that intent and holds (or held) the money, so this one charges
   * nothing and routes nothing. Reached when the Redis record was lost or its
   * lease lapsed — from {@link callKeyed}'s look-up, or from `intents.create`
   * / `redeem` when two attempts raced past it.
   *
   * - **Not past its provider, and young**: the first attempt is still
   *   running — `IDEMPOTENCY_IN_PROGRESS`.
   * - **Not past its provider, and older than the in-flight lease**: no live
   *   call takes that long, so the attempt died (a crash, or a failure after
   *   the intent was written). Polling would answer "in progress" until the
   *   24-hour hold backstop, so the answer is terminal instead —
   *   `IDEMPOTENCY_ATTEMPT_STALLED`, with the intent id; the backstop still
   *   returns the money.
   * - **Served** (`VERIFYING`, `SETTLED`): the result is rebuilt from the
   *   verification record, which keeps the mapped response for its own
   *   retention window — while the call is inside the retry window and the
   *   body has not been scrubbed. Otherwise `IDEMPOTENCY_RESULT_UNAVAILABLE`.
   */
  private async replayedIntent(
    session: McpSession,
    intent: PaymentIntent,
  ): Promise<McpCallOutcome> {
    this.logger.log(
      `Intent ${intent.id}: a keyed retry matched this intent (${intent.status}); not charged again`,
    );
    const age = Date.now() - intent.createdAt.getTime();

    if (!isPastProvider(intent.status)) {
      if (age <= this.idempotencyConfig.inFlightLeaseMs) {
        return inProgress(this.idempotencyConfig.retryAfterSeconds, intent.id);
      }
      return {
        kind: 'ERROR',
        code: McpFailureCode.IDEMPOTENCY_ATTEMPT_STALLED,
        retryable: false,
        message:
          `This idempotency key's call stopped before it finished (intent ${intent.id}, ` +
          `${intent.status}). Anything it holds is released by the hold backstop; ` +
          `use a new key to call again.`,
        intentId: intent.id,
        detail: { status: intent.status },
      };
    }

    if (age <= this.idempotencyConfig.resultTtlSeconds * 1000) {
      const rebuilt = await this.rebuiltResult(session, intent);
      if (rebuilt) return rebuilt;
    }
    return resultUnavailable(intent.id, intent.status, 'it is no longer stored');
  }

  /**
   * A served call's result from its verification record, or null when there
   * is none or its body was scrubbed. The receipt is the intent's own; the
   * attempt count is not recorded there, so it reads 1.
   */
  private async rebuiltResult(
    session: McpSession,
    intent: PaymentIntent,
  ): Promise<McpCallOutcome | null> {
    const record = await this.verificationRecords
      .findByIntentId(session.organizationId, intent.id)
      .catch(() => null);
    if (!record || record.response === null || record.response === undefined) return null;

    const zero = MoneyUtil.zero(intent.price.asset, intent.price.decimals);
    return {
      kind: 'RESULT',
      output: record.response as JsonValue,
      receipt: {
        intentId: intent.id,
        charged: intent.status === PaymentIntentStatus.SETTLED ? intent.price : zero,
        held: isAwaitingVerdict(intent.status) ? intent.price : zero,
        status: intent.status,
        toolId: intent.toolId,
        providerId: intent.providerId,
        classification: ResponseClass.DATA_RESULT,
        attempts: 1,
      },
      replayed: true,
    };
  }

  /**
   * A keyed attempt that threw may leave its intent in `CREATED` — the spend
   * lock lost before the hold, or a failure securing funds that was not a
   * balance refusal. Nothing was reserved, so it is expired at once and the
   * key is free, instead of answering the retry as in progress until the
   * sweep. Only called by the attempt that holds the Redis claim, so the
   * intent found is its own. Best effort.
   */
  private async releaseAbandonedKey(session: McpSession, idempotencyKey: string): Promise<void> {
    const left = await this.intents
      .findLiveByIdempotencyKey(session.organizationId, session.agentId, idempotencyKey)
      .catch(() => null);
    if (left && left.status === PaymentIntentStatus.CREATED && !left.holdId) {
      await this.releaseUnfundedKey(session, left);
    }
  }

  /**
   * A keyed rail-A call whose funds could not be secured: its intent is moved
   * to `EXPIRED` at once, so the key is free for the retry the agent makes
   * after topping up rather than held until the expiry sweep. Best effort.
   */
  private async releaseUnfundedKey(session: McpSession, intent: PaymentIntent): Promise<void> {
    await this.intents
      .transition(
        session.organizationId,
        intent.id,
        PaymentIntentStatus.CREATED,
        PaymentIntentStatus.EXPIRED,
        { reason: PAYMENT_INTENT_UNFUNDED_KEY_RELEASE_REASON },
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `Intent ${intent.id}: funds not secured and its idempotency key could not be ` +
            `released; it frees at the expiry sweep. ${describe(error)}`,
        );
      });
  }

  // ── One attempt ───────────────────────────────────────────────────────────

  private async run(
    session: McpSession,
    tool: Tool,
    args: JsonObject,
    payment: McpPayment,
    idempotencyKey: string | null,
    scope?: McpScope,
  ): Promise<McpCallOutcome> {
    const scoped = planOf(scope, tool);
    // The call's argument names join its contract request: an optional input
    // they use routes only to providers that support it (§7.5), in the quote
    // that sets the hold and in every routing phase after it.
    const asked: CallPlan = {
      ...scoped,
      contract: { ...(scoped.contract ?? NO_CONTRACT_REQUEST), argumentNames: Object.keys(args) },
    };
    const quote = await this.requireQuote(tool, session, asked);
    // Not pinned to the quote's version: the quote sees every call class and
    // chain, and each phase below — the free relay, the paid route, the rail-B
    // offer — chooses its version among the bindings of its own class and the
    // buyer's chain, under the same hard constraints. A rail-B retry is held
    // to the version its offer named (`x402/voucher.contractVersion`).
    const plan: CallPlan = asked;

    this.requireValidArguments(quote.tool, args);

    // Minted once, here, for the whole call — not per attempt. Failover
    // excludes the whole provider (`ProviderRouterService`'s own doc comment),
    // so a given provider sees at most one request per call, and this is the
    // id that request carries as `X-Assay-Call-Id`. Threaded through
    // `intents.create` (so it lands on the payment record the export reads)
    // and through `router.route` (so it reaches `EgressBindingInvoker`) —
    // both from this one value, which is what guarantees the header on the
    // wire and the id in the export are byte-identical.
    const callId = randomUUID();
    const price = quote.price as Money;

    // ── The free/paid fork ────────────────────────────────────────────────
    //
    // Relay mode. A free call takes a different path entirely rather than the
    // paid one with zero amounts: running holds, ledger entries and settlement
    // over `$0.00` costs the same as running them over `$1.00` and buys nothing.
    //
    // It is also the fix for a live defect. Until this fork existed every
    // call class including `FREE` went through `secureFunds`, and
    // `LedgerHoldService.createHold` refuses a zero amount — so the first
    // genuinely free binding answered `409`. No demo binding was free, which
    // is the only reason nobody had hit it.
    const freeMode = freePricingMode(quote.pricingMode);
    // `?free=1` serves only what can be free, and a paid tool is not in its
    // view (FR-2).
    if (plan.forceFree && !freeMode) {
      throw ToolAccessErrors.notInToolset({ details: { name: tool.name } });
    }
    if (freeMode) {
      const quotaInput = {
        organizationId: session.organizationId,
        agentId: session.agentId,
        toolId: tool.id,
        pricingMode: freeMode,
      };
      let decision: FreeQuotaDecision = await this.freeQuota.check(quotaInput);

      // The check is a read; the platform places are TAKEN here, atomically,
      // before anything is routed, so parallel calls cannot all fit into the
      // last one (review 2026-10-15, M5). Given back below if nothing served.
      let platformPlaces: FreeQuotaReservation | null = null;
      if (decision.kind === 'ALLOWED') {
        const reserved = await this.freeQuota.reservePlatform(quotaInput);
        if (reserved.kind === 'RESERVED') platformPlaces = reserved;
        else decision = reserved;
      }

      // Free first. Inside the quota the call is relayed among the
      // free-capable bindings only (`callClass: 'FREE'`), whether or not the
      // tool also has `PAID` providers — `quotedPricingMode` quotes such a tool
      // `FREEMIUM` precisely so that their presence cannot switch the free tier
      // off. `null` means no free-capable binding could take it and the tool
      // has paid supply: fall through below.
      if (platformPlaces) {
        const served = await this.relay(session, tool, freeMode, price, args, callId, plan).catch(
          async (error: unknown) => {
            await platformPlaces.release();
            throw error;
          },
        );
        if (served) return served;
        await platformPlaces.release();
      }

      // `?free=1` forces the FREE call class: it never falls through to paid.
      // An exhausted quota is the ordinary quota refusal; no free-capable
      // provider is the ordinary supply refusal. Nothing is charged either way.
      if (plan.forceFree) {
        if (decision.kind === 'REFUSED') {
          throw McpErrors.quotaExceeded(
            buildFreeQuotaErrorContext({
              refusal: { ...decision, fallThroughToPaid: false },
              toolId: tool.id,
              paidPrice: null,
            }),
          );
        }
        throw ToolErrors.noEligibleBinding({
          toolId: tool.id,
          reason: 'no provider can serve this call free, and this URL serves free calls only',
        });
      }

      // `FREE` exhausted. There is no paid binding behind this tool to fall
      // through to, so the agent gets the error and the reset time — and the
      // refusal costs nothing, because nothing was created to unwind.
      if (decision.kind === 'REFUSED' && !decision.fallThroughToPaid) {
        throw McpErrors.quotaExceeded(
          buildFreeQuotaErrorContext({ refusal: decision, toolId: tool.id, paidPrice: null }),
        );
      }

      // `FREEMIUM` exhausted on a chain with no paid rail (Solana: `rails: []`):
      // there is nothing to fall through to, so the agent gets the quota
      // error and its reset time — not `CHAIN_RAIL_NOT_OFFERED`, which would
      // not tell it that free calls come back at midnight (review #2, L6).
      if (decision.kind === 'REFUSED' && !paidRailOffered(session.chainId)) {
        throw McpErrors.quotaExceeded(
          buildFreeQuotaErrorContext({
            refusal: { ...decision, fallThroughToPaid: false },
            toolId: tool.id,
            paidPrice: null,
          }),
        );
      }

      // `FREEMIUM` exhausted, or no free-capable binding could serve — *"fall
      // through to the paid path"*, which is the entire commercial point of the
      // mode and must require no reconfiguration from the agent. Execution
      // simply continues below, among `PAID` and `FREEMIUM` bindings only, and
      // on rail B nothing is charged without a voucher the buyer signs.
    }

    // ── The buyer's chain ─────────────────────────────────────────────────
    //
    // The quote is deliberately NOT narrowed to the buyer's chains (see
    // `requireQuote`), so its price may be in an asset no provider on the
    // buyer's chain charges. Funds are secured against that price before the
    // router runs, so a buyer whose chain no routable binding settles on would
    // otherwise be told `PAYMENT_INSUFFICIENT_FUNDS` (or fail on an asset
    // mismatch) for a call that was never payable from where they are. The
    // router would refuse it with `PAYMENT_NO_SETTLEABLE_CHAIN`; this says the
    // same thing before an intent or a hold exists.
    if (!quote.settlementChains.includes(session.chainId)) {
      throw PaymentErrors.noSettleableChain({
        tool: tool.id,
        buyerChains: [session.chainId],
        toolChains: [...quote.settlementChains],
        priceMinor: price.amount,
        decimals: price.decimals,
      });
    }

    // ── The rail fork ─────────────────────────────────────────────────────
    //
    // Rail B when a voucher is presented, when the agent asked for it, or when
    // the session's chain offers nothing else (`eip155:46630`). Everything
    // below this branch is rail A and is byte-for-byte what it always was.
    if (
      chooseRail(session.chainId, payment.rail, payment.voucher !== null) ===
      PaymentRail.RAIL_B_VOUCHER
    ) {
      return this.callOnRailB(session, tool, args, callId, payment.voucher, idempotencyKey, plan);
    }

    // Hoisted out of `intents.create` below, because two things now need the
    // same value and they must agree: the duplicate-request detector inside
    // the spend-policy gate, and the payment record it authorises. Computing
    // it twice would work today and would silently stop working the first time
    // either call site's inputs drifted.
    const requestHash = computeRoutedCallHash({
      method: MCP_CALL_METHOD,
      path: mcpResource(tool),
      query: null,
      body: args,
      toolId: tool.id,
      amount: price.amount,
      asset: price.asset,
    });

    // The last thing that can refuse the call for free. Deliberately
    // after the quote — a cap is compared against a price, so there has to be
    // one — and deliberately before `intents.create`, since a refusal placed
    // after it would strand a `CREATED` intent for the expiry sweep, and one
    // placed after `secureFunds` would take and release a hold for a call that
    // policy had already decided must not happen.
    //
    // This is a **gateway** check. Enforcing the same limits in a wallet
    // signer, where a platform bug could not exceed them, is not implemented,
    // so nothing here is entitled to that stronger claim.
    // This path settles on rail A and only rail A (see the `rail:` comment
    // on `intents.create` below). A chain whose `chain-metadata.ts` row does not
    // offer rail A must not reach an intent through it; `eip155:46630` is
    // exactly such a chain. Refused BEFORE the intent exists, so nothing has to
    // be swept.
    assertRailOffered(session.chainId, railName(PaymentRail.RAIL_A_PER_CALL));
    await this.vouchers.assertNoOutstandingDebt(session.organizationId, session.agentAccount);

    // The cap check and the hold it allows run under the agent's spend lock:
    // read and reserve as one step, so concurrent calls cannot all read the
    // same spend-so-far and all fit (review 2026-10-15 P-6).
    const admitted = await this.spendPolicy.withAgentSpendLock(session.agentId, async (held) => {
      const spendPolicyVersion = await this.spendPolicy.assertCallAllowed({
        organizationId: session.organizationId,
        agentId: session.agentId,
        toolId: tool.id,
        price,
        requestHash,
      });

      const intent = await this.intents.create({
        organizationId: session.organizationId,
        agentId: session.agentId,
        agentAccount: session.agentAccount,
        // Which of the agent's credentials paid — two credentials are two keys.
        credentialId: credentialOf(session),
        // No provider yet, and none can be named: the router picks one below and
        // failover may change it. Nor the payout account, nor the binding, for
        // exactly the same reason and at exactly the same grain. All three are
        // written by the transition out of `PROVIDER_EXECUTING`, which is the
        // first moment the answer is final — see `resolveDataResult`.
        toolId: tool.id,
        // Rail A, not rail B: rail B means a signed voucher and there is no
        // signature here — the MCP server spends the agent's ledger balance on the
        // strength of its bearer token. Recording it as rail B would claim a
        // voucher nonce was spent, and the database would refuse the row for the
        // good reason that no nonce exists.
        //
        // Rail A names no `payTo` and cannot: an escrow is debited only by
        // `redeem_voucher`, which needs the buyer's ed25519 signature over 239
        // bytes, and an MCP session has no key. "Rail A uses the same payTo"
        // describes the x402-over-HTTP rail, not this one. While
        // ESCROW_SPEND_GATE_ENABLED is on, `EscrowSpendGate` refuses a rail-A
        // intent outright rather than spending a mirror balance.
        //
        // `assertRailOffered` above is what makes "4663 ships rail B only" a
        // rule rather than a table nobody reads. It is asserted HERE, at the site
        // that CHOOSES the rail, not where `payment_intents.rail` is written: the
        // writer records a decision already made, and a check there would refuse a
        // row after the money path had committed to it.
        rail: PaymentRail.RAIL_A_PER_CALL,
        callId,
        // `quote.pricingMode` is the aggregate over every *eligible* binding at
        // quote time (`ProviderRouterService.quote`'s "dearest eligible
        // binding" reasoning) — routing has not run yet, so it is the best
        // information available at creation time. So is `price`, which is the
        // hold: `servedCharge` re-prices the intent once a binding has served.
        // `FREEMIUM` is folded into `PAID` here, matching the router's own
        // "gated like PAID" rule: the free quota has not been checked,
        // so this call may well be charged.
        callClass:
          quote.pricingMode === PricingMode.FREE
            ? PaymentIntentCallClass.FREE
            : PaymentIntentCallClass.PAID,
        price,
        platformFee: this.platformFee(price),
        requestHash,
        // The receipt's link to the policy that governed this call.
        spendPolicyVersion,
        chainId: session.chainId,
        // The agent's `x402/idempotency-key`, or null. The unique index on it
        // is what keeps one live intent per key — see `replayedIntent`.
        idempotencyKey,
      });

      // An earlier attempt of this keyed call created that intent (its call
      // id is not this attempt's): it holds the money, so nothing is held here.
      if (intent.callId !== callId) return { intent, unaffordable: null, replayed: true };

      // Still ours? Otherwise the next call of this agent may already have
      // summed its spend without this hold (round-two review N-4). The intent
      // stays in `CREATED` with nothing reserved, for the expiry sweep.
      await held();
      const unaffordable = await this.secureFunds(session, intent, price);
      return { intent, unaffordable, replayed: false };
    });
    if (admitted.replayed) return this.replayedIntent(session, admitted.intent);
    if (admitted.unaffordable) {
      if (idempotencyKey) await this.releaseUnfundedKey(session, admitted.intent);
      return admitted.unaffordable;
    }
    const intent = admitted.intent;
    await this.attribution?.stampIntent(session.organizationId, intent.id, plan.attribution);

    const executing = await this.intents.transition(
      session.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      { reason: MCP_FORWARDED_REASON },
    );

    return this.route(session, tool, executing, args, callId, plan);
  }

  // ── Rail B ────────────────────────────────────────────────────────────────

  /**
   * A paid call settled by a voucher the buyer signed (`x402/voucher`).
   *
   * Two requests, x402's 402 handshake carried in MCP `_meta`:
   *
   * 1. **No voucher.** The router OFFERS a provider without dialling it, a seq
   *    is allocated, and the call is refused with `PAYMENT_REQUIRED` carrying
   *    every field the voucher must bind. Nothing else happens — no intent, no
   *    hold, no provider call — so an agent that never pays costs nothing but a
   *    seq, and holes are free under `seq > seq_high`.
   * 2. **With the voucher.** The offer is re-drawn PINNED to the provider the
   *    requirement named, `VoucherService.redeem` checks every field against
   *    what this server computes itself and holds the price, and the call is
   *    routed to that provider and no other. From `PROVIDER_EXECUTING` on it is
   *    the same {@link route} rail A uses; `VoucherRedemptionService` redeems the
   *    voucher on chain once verification passes.
   *
   * The `providerId` the agent echoes back is not trusted for anything: it only
   * chooses which provider to re-draw, and `VoucherService` then requires that
   * provider's payout account to be the `provider` inside the signed bytes.
   */
  private async callOnRailB(
    session: McpSession,
    tool: Tool,
    args: JsonObject,
    callId: string,
    payment: McpVoucherPayment | null,
    idempotencyKey: string | null,
    plan: CallPlan = UNSCOPED_PLAN,
  ): Promise<McpCallOutcome> {
    assertRailOffered(session.chainId, railName(PaymentRail.RAIL_B_VOUCHER));
    // A payer that owes for served calls whose vouchers lapsed gets no paid
    // call — not even a requirement — until it signs the replacements
    // (`PAYMENT_DEBT_OUTSTANDING`, no-platform-debt design step 9). Free calls
    // never reach here.
    await this.vouchers.assertNoOutstandingDebt(session.organizationId, session.agentAccount);

    const asset = chainMetadata(session.chainId).settlementAsset as AssetId;
    // One read of the buyer's escrow serves the withdraw gate AND the seq
    // floor, and it throws rather than degrading — see `withdrawingChains`.
    const reading = await this.escrow.read(session.agentAccount, asset);
    const withdrawing = reading && reading.withdrawRequested > 0n ? [session.chainId] : [];
    // The offer and the voucher retry run under the same merged rules as the
    // call, so the buyer is only ever asked to sign for a provider the rules
    // allow; a pinned payee they now drop is `PAYEE_NO_LONGER_ELIGIBLE`.
    // The retry is held to the contract version its offer named, as it is to
    // the payee: the buyer signed for a call at that version. Echoed like
    // `providerId`, it proves nothing and only chooses the re-draw; a version
    // no longer servable refuses the retry before anything is charged.
    const contract =
      payment?.contractVersion !== undefined
        ? { ...(plan.contract ?? NO_CONTRACT_REQUEST), version: payment.contractVersion }
        : plan.contract;
    const context: RoutingContext = {
      ...routingContextOf(session, this.enabledChains, withdrawing, plan.rules, contract),
      onlyProviderId: payment?.providerId,
      callClass: 'PAID',
    };

    const offer = await this.router.offer(tool.id, context);
    if (!offer.providerAccount) {
      // The payout gate refuses an unpayable PAID candidate, so this is a
      // catalogue that changed between the gate and here. A voucher naming
      // nobody could never be redeemed.
      throw ToolErrors.noEligibleBinding({
        toolId: tool.id,
        reason: `provider ${offer.providerId} has no payout account on ${offer.settlementChain}`,
      });
    }

    // The offered provider's own price, not the quote. The voucher is signed
    // for an exact amount and pays this provider and no other, so the buyer
    // pays what the binding that serves charges — the rule rail A applies at
    // settlement. On the retry the re-drawn offer must name the same price, or
    // `VoucherService` refuses the signed amount.
    const price = offer.price;

    const call = voucherCallOf(tool, args);
    const requestHash = computeRequestHash({
      ...call,
      toolId: tool.id,
      providerId: offer.providerId,
      amount: price.amount,
      asset: price.asset,
    });
    const { escrowPda } = await this.escrow.escrowAddresses(session.agentAccount, asset);

    if (!payment) {
      const { seq } = await this.seqs.allocate(
        session.organizationId,
        session.agentAccount,
        reading ? reading.seqHigh : null,
      );
      const requirement: VoucherRequirement = {
        rail: 'B',
        scheme: 'voucher',
        network: session.chainId,
        payer: session.agentAccount,
        payTo: escrowPda,
        provider: offer.providerAccount,
        providerId: offer.providerId,
        amount: { amount: price.amount, asset: price.asset, decimals: price.decimals },
        ...(offer.contractVersion !== undefined ? { contractVersion: offer.contractVersion } : {}),
        resource: call.path,
        requestHash,
        seq,
        maxTimeoutSeconds: VOUCHER_MAX_TTL_SECONDS,
        ...delegationTerms(session),
      };
      return {
        kind: 'ERROR',
        code: McpFailureCode.PAYMENT_REQUIRED,
        retryable: true,
        message:
          `${tool.name} is paid on rail B: sign the voucher in x402/paymentRequired and ` +
          `call again with it in _meta["x402/voucher"]` +
          delegationHint(session),
        intentId: null,
        detail: { paymentRequired: requirement },
      };
    }

    // A charge like any other, so the same gate that caps rail A caps this —
    // against the hash the voucher signs, which is this call's identity here.
    // Checked and held under the agent's spend lock, as on rail A (P-6).
    const admitted = await this.spendPolicy.withAgentSpendLock(session.agentId, async (held) => {
      await this.spendPolicy.assertCallAllowed({
        organizationId: session.organizationId,
        agentId: session.agentId,
        toolId: tool.id,
        price,
        requestHash,
      });

      try {
        return {
          intent: await this.vouchers.redeem({
            organizationId: session.organizationId,
            signed: payment.signed,
            call,
            agentId: session.agentId,
            agentAccount: session.agentAccount,
            providerId: offer.providerId,
            providerAccount: offer.providerAccount,
            toolId: tool.id,
            resource: call.path,
            escrowPda,
            price,
            platformFee: this.platformFee(price),
            chainId: session.chainId,
            boundDelegate: session.delegateAccount ?? null,
            credentialId: credentialOf(session),
            // The same read as the withdraw gate above: the escrow's own limits
            // bind this voucher at redemption, so they are applied before serving.
            escrow: reading,
            // After the voucher's chain reads, before its intent and hold (N-4).
            beforeHold: held,
            // The CALL's key, beside the voucher's seq: a retry of this call
            // signs a new voucher, and the key is what says it is the same call.
            idempotencyKey,
          }),
          unaffordable: null,
        };
      } catch (error) {
        if (!isInsufficientBalance(error)) throw error;
        // The intent exists in `CREATED` with nothing reserved; the expiry sweep
        // closes it, exactly as on rail A. Its id is not surfaced by `redeem`.
        return { intent: null, unaffordable: await this.insufficientFunds(session, null, price) };
      }
    });
    if (admitted.intent === null) return admitted.unaffordable;
    const intent: PaymentIntent = admitted.intent;
    await this.attribution?.stampIntent(session.organizationId, intent.id, plan.attribution);

    // `redeem` answered with an earlier attempt's intent (another seq): this
    // voucher was neither held nor recorded, and will never be redeemed.
    if (idempotencyKey && intent.voucherSeq !== payment.signed.voucher.seq) {
      return this.replayedIntent(session, intent);
    }

    const executing = await this.intents.transition(
      session.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      { reason: MCP_FORWARDED_REASON },
    );

    return this.route(
      session,
      tool,
      executing,
      args,
      callId,
      {
        ...plan,
        contract: { ...(contract ?? NO_CONTRACT_REQUEST), version: offer.contractVersion },
      },
      offer.providerId,
    );
  }

  /**
   * The chains this buyer has a standing withdrawal request on (the EVM gas
   * model, `docs/gas.md` in assay-evm).
   *
   * One chain at most, because an MCP session names exactly one
   * (`session.chainId`) and `payerChains` is `[session.chainId]`.
   *
   * ## Why the paid path reads this and the free path does not
   *
   * A withdrawal makes a call uncollectable: `withdraw()` reads no
   * outstanding-voucher state and pays `min(requested, balance)`, so a call
   * served after the request matured can leave the platform short. A FREE call
   * collects nothing, so there is nothing to be short of — {@link relay} passes
   * `[]` and never makes this read.
   *
   * ## What an unreadable chain does
   *
   * It **throws**, and that is the port's own contract: `read` is the one
   * balance read in this codebase that never degrades to a mirror, because a
   * stale escrow reading is what an over-spend is made of. That is a real
   * change of availability on this path — before this method existed a paid MCP
   * call touched no chain at all, and an RPC outage now stops one. It is the
   * fail-closed direction and it is deliberate: swallowing the error would make
   * `withdrawingChains` default to `[]`, which is precisely the fail-open the
   * field's own doc comment forbids.
   *
   * `null` — no escrow account at all — is not a failure and is not a
   * withdrawal. It is the ordinary state of a buyer who has never used rail B.
   */
  private async withdrawingChains(session: McpSession): Promise<readonly ChainId[]> {
    const asset = chainMetadata(session.chainId).settlementAsset as AssetId;
    const reading = await this.escrow.read(session.agentAccount, asset);
    return reading && reading.withdrawRequested > 0n ? [session.chainId] : [];
  }

  // ── Before any money moves ────────────────────────────────────────────────

  private async requireQuote(
    tool: Tool,
    session: McpSession,
    plan: CallPlan = UNSCOPED_PLAN,
  ): Promise<ToolQuote> {
    const { rules, contract } = plan;
    // A quote is not narrowed to the buyer's chains, and a CALL is: the
    // catalogue must SHOW a tool that settles elsewhere rather than hide it, so
    // the quote asks about every chain this deployment offers and reports
    // `settlementChains` for the caller to compare. The refusal, when it comes,
    // comes from `route()` with `PAYMENT_NO_SETTLEABLE_CHAIN` — which names the
    // chain to fund, where a hidden tool names nothing.
    const quote = await this.router.quote(tool.id, {
      payerChains: this.enabledChains,
      // A quote is not an offer to be paid — see the comment above — and the
      // one that IS, `route()` below, reads the escrow for itself. Narrowing
      // here would hide a tool for a condition the buyer clears in one call.
      withdrawingChains: [],
      defaultChainId: session.chainId,
      enabledChains: this.enabledChains,
      // The hold is the dearest provider the rules leave, never one they drop.
      rules,
      // At the contract version the call may use, among the bindings that
      // serve it, support its optional inputs and return its required outputs
      // — chosen for the buyer's own chain, though priced and reported over
      // every chain (review P2-1).
      contract: { ...(contract ?? NO_CONTRACT_REQUEST), versionChains: [session.chainId] },
    });

    // `findByName` resolved it a moment ago, so a null quote means the
    // catalogue changed underneath this call rather than that the agent asked
    // for something that never existed.
    if (!quote) throw McpErrors.toolNotFound({ name: tool.name });

    // No contract version this call may use can serve it: retired (naming
    // the replacement) or never existed. Refused before any intent exists.
    if (!quote.price && quote.contractRefusal) {
      throw contractRefused(tool, quote.contractRefusal.refusal, {
        payerChains: [],
        withdrawingChains: [],
        enabledChains: [],
        defaultChainId: null,
        ...(contract ? { contract } : {}),
      });
    }

    // The rules left no provider: refused before any intent exists, with each
    // provider's reason and whose rule it was (FR-6) — or, when an optional
    // input the arguments use is what nobody supports, UNSUPPORTED_INPUT_FIELD.
    if (!quote.price && quote.ruleRejections && quote.ruleRejections.length > 0) {
      throw ruleRefusal(tool.id, quote.ruleRejections);
    }

    if (!quote.price) {
      throw ToolErrors.noEligibleBinding({
        toolId: tool.id,
        reason: quote.unroutableReason ?? 'no routable binding',
      });
    }

    return quote;
  }

  /**
   * The agent's arguments against the tool's own `inputSchema`, before the
   * intent exists.
   *
   * `mapRequest` validates the same schema inside the invoker, and that check
   * stays — it is the one that runs on the value actually sent upstream. This
   * one exists because by the time the invoker sees it the platform has already
   * created an intent, opened a hold and moved through three states, all to
   * arrive at a `REQUEST_ERROR` that was decidable from the arguments alone.
   * Nothing about a missing required field needs a provider to discover.
   */
  private requireValidArguments(tool: Tool, args: JsonObject): void {
    // The *same* `TOOL_MAPPING_*` error the invoker would raise, carrying
    // `fault: AGENT`, rather than a new MCP-level code. "The agent's arguments
    // are wrong" is one condition and must not have two names depending on how
    // early it was noticed.
    validateAgainstSchema(args, tool.inputSchema, {
      direction: MappingDirection.REQUEST,
      fault: MappingFault.AGENT,
      context: { toolId: tool.id },
    });
  }

  // ── Money ─────────────────────────────────────────────────────────────────

  /**
   * The platform's cut, floored.
   *
   * Floors against the platform by construction (`MoneyUtil` rounding): the
   * remainder of the division goes to the provider. At sub-cent prices that is
   * the difference between a fee that quietly rounds up on every call and one
   * that does not.
   *
   * A single rate, because a single rate is all that is fixed — `20%` for
   * the `guaranteed` tier and nothing anywhere for the other two. A
   * tier-dependent schedule needs a
   * decision nobody has taken; making it configurable does not pretend
   * otherwise, it just keeps the number out of a deploy.
   */
  private platformFee(price: Money): Money {
    const fee = (BigInt(price.amount) * BigInt(this.pricing.platformFeeBps)) / 10_000n;
    return MoneyUtil.of(fee, price.asset, price.decimals);
  }

  /**
   * Reserve the price, or tell the agent it cannot afford the call.
   *
   * An intent whose funds were never secured is left in `CREATED`. That is not
   * a leak: the `CREATED → EXPIRED` edge carries `HoldEffect.NONE` precisely
   * because nothing was ever reserved, so the five-minute sweep closes the row
   * and there is no money involved to strand. Rolling it back here would mean
   * deleting a payment record, which the platform never does.
   */
  private async secureFunds(
    session: McpSession,
    intent: PaymentIntent,
    price: Money,
  ): Promise<McpCallOutcome | null> {
    try {
      await this.intents.secureFunds(session.organizationId, intent.id);
      return null;
    } catch (error) {
      if (!isInsufficientBalance(error)) throw error;
      return this.insufficientFunds(session, intent.id, price);
    }
  }

  private async insufficientFunds(
    session: McpSession,
    intentId: string | null,
    price: Money,
  ): Promise<McpCallOutcome> {
    const balance = await this.ledger
      .getBalance(session.organizationId, session.agentAccount, price.asset)
      .catch(() => null);

    this.logger.log(
      `Intent ${intentId ?? '(rail B, not surfaced)'}: ${session.agentId} cannot afford ` +
        `${price.amount} of ${price.asset}`,
    );

    return {
      kind: 'ERROR',
      code: McpFailureCode.PAYMENT_INSUFFICIENT_FUNDS,
      retryable: false,
      message: `Insufficient balance: this call costs ${price.amount} of ${price.asset}`,
      intentId,
      detail: {
        price: price.amount,
        asset: price.asset,
        available: balance ? balance.available.amount : null,
      },
    };
  }

  // ── The relay path ────────────────────────────────────────────────────────

  /**
   * A free call: route, classify, return. No intent, no hold, no voucher, no
   * ledger write, no settlement (relay mode).
   *
   * ## Why this is not `route()` with the money bits skipped
   *
   * `route()` takes a `PaymentIntent` and every one of its branches is about
   * what happens to that intent's hold — void it, resolve it to `VERIFYING`,
   * refund it. A free call has no intent to do any of that to, and threading a
   * nullable one through would put `if (intent)` at each of those branches:
   * four places where the paid path's money handling could later be edited
   * while silently doing nothing on the free path, and no test would notice.
   * Two methods that share a router call is the smaller cost.
   *
   * ## What is deliberately still identical
   *
   * Classification, the egress controls, and the failover behaviour, because
   * they are the router's and this path calls the same router. *"A free call
   * is still our infrastructure fetching a third-party URL on behalf of an
   * authenticated user"* — every control in the security model applies
   * unchanged.
   *
   * ## The two things that are missing on purpose
   *
   * There is **no sampled verification** here, though a flat 1%
   * platform-funded sample is intended: `VerificationSettlementService.enqueue` is
   * keyed on a payment intent id and a free call has none.
   * `tool_call_records.verdict` therefore stays null, which reads as *not
   * checked* and never as *passed*.
   *
   * And a routing failure propagates rather than being converted into an
   * outcome. On the paid path the catch exists to release a hold; here there
   * is nothing to release, and `TOOL_ALL_BINDINGS_FAILED` reaching the agent
   * unchanged is the same answer with less machinery.
   *
   * ## `null`: free first, then paid
   *
   * On a `FREEMIUM` quote — free-capable supply beside paid supply — a refusal
   * the router makes **before dialling anyone** (no free-capable binding is
   * eligible) returns `null`, and the caller falls through to the paid path.
   * A failure after a free provider was dialled still propagates: re-running
   * the call as a paid one the agent never asked for would be a surprise
   * charge for somebody else's outage. On a `FREE` quote there is no paid
   * supply, so every refusal propagates.
   */
  private async relay(
    session: McpSession,
    tool: Tool,
    pricingMode: PricingMode.FREE | PricingMode.FREEMIUM,
    quoted: Money,
    args: JsonObject,
    callId: string,
    plan: CallPlan = UNSCOPED_PLAN,
  ): Promise<McpCallOutcome | null> {
    const startedAt = Date.now();
    // Each binding's own quota place is taken on the binding about to be
    // dialled (`RoutingContext.reserveFreeQuota`): a binding whose quota is
    // spent is never drawn (review M4), and parallel calls cannot overspend it
    // (M5). Only the binding that served keeps its place.
    const places = new Map<string, FreeQuotaReservation>();
    let quotaShed = 0;
    // Which dial shed a binding: the per-agent quota wins the answer when
    // any binding hit it, since it is the one this agent can do nothing
    // about but wait (both reset at the next UTC midnight).
    let shedLimit: FreeQuotaLimitKind | null = null;
    const releaseAllBut = async (keep: string | null) => {
      await Promise.all(
        [...places].filter(([id]) => id !== keep).map(([, place]) => place.release()),
      );
    };
    const routed = await this.router
      .route({
        toolId: tool.id,
        input: args,
        callId,
        // A FREE call collects nothing, so a standing withdrawal cannot leave the
        // platform short on it: `withdrawingChains` is empty here on purpose, and
        // this path deliberately does not read the escrow.
        // `FREE`: a call nobody is charged for never reaches a `PAID` binding.
        context: {
          ...routingContextOf(session, this.enabledChains, [], plan.rules, plan.contract),
          callClass: 'FREE',
          reserveFreeQuota: async (binding) => {
            const place = await this.freeQuota.reserveBinding({
              organizationId: session.organizationId,
              agentId: session.agentId,
              binding,
              onFull: (limit) => {
                if (shedLimit !== FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY) shedLimit = limit;
              },
            });
            if (place) places.set(binding.id, place);
            else quotaShed += 1;
            return place;
          },
        },
      })
      .catch(async (error: unknown) => {
        await releaseAllBut(null);
        if (isRefusedBeforeDialling(error)) {
          if (pricingMode === PricingMode.FREEMIUM) return null;
          // `FREE`, and the only supply left had no quota for this agent:
          // that is the quota answer, not a supply problem.
          // The dial that actually shed it, through the same refusal (and
          // notification) as the pre-flight check (review #2, L2).
          if (quotaShed > 0) {
            throw McpErrors.quotaExceeded(
              buildFreeQuotaErrorContext({
                refusal: this.freeQuota.bindingQuotaRefusal(
                  {
                    organizationId: session.organizationId,
                    agentId: session.agentId,
                    toolId: tool.id,
                    pricingMode: PricingMode.FREE,
                  },
                  shedLimit ?? FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
                ),
                toolId: tool.id,
                paidPrice: null,
              }),
            );
          }
        }
        throw agentFacing(error, null);
      });
    if (!routed) return null;
    // Failover abandoned the earlier bindings: their places go back.
    await releaseAllBut(routed.binding.id);
    const latencyMs = Date.now() - startedAt;

    // Written for every classified attempt, `REQUEST_ERROR` included: the
    // provider was dialled, it answered, and the platform paid for the call
    // whatever the answer was. Never throws — a bookkeeping failure must not
    // replace the agent's result.
    await this.records.write({
      organizationId: session.organizationId,
      agentId: session.agentId,
      callId,
      toolId: tool.id,
      bindingId: routed.binding.id,
      providerId: routed.providerId,
      pricingMode,
      classification: routed.classification.responseClass,
      latencyMs,
      requestHash: computeRoutedCallHash({
        method: MCP_CALL_METHOD,
        path: mcpResource(tool),
        query: null,
        body: args,
        toolId: tool.id,
        // Zero, not `quoted.amount`. On a `FREEMIUM` call within quota the
        // quote carries the *paid* price, and hashing the request against a
        // price nobody was charged would make this call's hash collide with
        // the same request made once the quota ran out — which is exactly the
        // pair the duplicate detector must be able to tell apart.
        amount: '0',
        asset: quoted.asset,
      }),
      attribution: plan.attribution,
    });

    // The quota was spent by the reservations above — the platform places in
    // `call`, this binding's place in the router — so nothing is counted here.

    // Counted on the free path too. The exploration floor measures what has
    // been *observed* of a binding, and a free call is an observation.
    await this.bindingCalls.record(routed.binding.id);

    const { classification } = routed;
    const receipt: McpReceipt = {
      // No intent exists and none should be invented. `null` here is the
      // honest answer to "which payment record is this", and the receipt's own
      // `charged` says zero for the same reason.
      intentId: null,
      // Zero in the asset the tool is denominated in, never the quote's paid
      // price: this call was not charged, and a receipt is the one document an
      // agent reads to find out what it paid.
      charged: MoneyUtil.of('0', quoted.asset, quoted.decimals),
      held: MoneyUtil.of('0', quoted.asset, quoted.decimals),
      status: null,
      toolId: tool.id,
      providerId: routed.providerId,
      classification: classification.responseClass,
      attempts: routed.attempts.length,
      ...(routed.fellBack ? { fellBack: true } : {}),
    };

    if (classification.responseClass !== ResponseClass.DATA_RESULT) {
      return {
        kind: 'ERROR',
        code:
          classification.responseClass === ResponseClass.REQUEST_ERROR
            ? McpFailureCode.PROVIDER_REQUEST_ERROR
            : McpFailureCode.PROVIDER_SYSTEM_ERROR,
        retryable: isRetryable(classification.responseClass),
        message: notServedMessage(tool.name, classification),
        intentId: null,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
          fault: faultOf(classification),
          attempts: routed.attempts.length,
          retryAfterMs: classification.retryAfterMs,
        },
      };
    }

    if (routed.output === null) {
      return {
        kind: 'ERROR',
        code: McpFailureCode.PROVIDER_CONTRACT_VIOLATION,
        retryable: false,
        message: contractViolationMessage(tool.name, classification),
        intentId: null,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
          fault: faultOf(classification),
          attempts: routed.attempts.length,
          // Nothing to refund — there was never a charge. Stated rather than
          // omitted, so a client reading this field does not read its absence
          // as "the refund failed".
          refunded: false,
        },
      };
    }

    return { kind: 'RESULT', output: routed.output, receipt };
  }

  // ── The call ──────────────────────────────────────────────────────────────

  private async route(
    session: McpSession,
    tool: Tool,
    intent: PaymentIntent,
    args: JsonObject,
    callId: string,
    plan: CallPlan = UNSCOPED_PLAN,
    /** Rail B: the provider the voucher pays. Nobody else may serve it. */
    onlyProviderId?: string,
  ): Promise<McpCallOutcome> {
    let routed: RoutedCall;

    try {
      routed = await this.router.route({
        toolId: tool.id,
        input: args,
        callId,
        context: {
          ...routingContextOf(
            session,
            this.enabledChains,
            await this.withdrawingChains(session),
            plan.rules,
            plan.contract,
          ),
          onlyProviderId,
          // A charged call is served only by a staked, payable paid binding.
          callClass: 'PAID',
        },
      });
    } catch (error) {
      // Everything routable was dialled and answered SYSTEM_ERROR. The agent
      // is charged nothing, and the void records what happened — the class and
      // the last binding and provider tried — rather than claiming the call
      // never reached one. The agent gets the intent id to open the receipt.
      const tried = lastAttemptOf(error);
      if (tried) {
        const voided = await this.void(session, intent, {
          reason: MCP_ALL_PROVIDERS_FAILED_REASON,
          providerId: tried.providerId,
          bindingId: tried.bindingId,
          classification: tried.responseClass,
        });
        throw agentFacing(error, voided.id);
      }

      // No provider outcome exists — nothing was routable, or the deadline ran
      // out before anything was dialled. The agent is charged nothing, and the
      // void names no provider because none of them produced this.
      const voided = await this.void(session, intent, { reason: MCP_UNROUTABLE_REASON });

      throw agentFacing(error, voided.id);
    }

    const { classification } = routed;

    // In practice this is `REQUEST_ERROR` and only that. `route()` resolves
    // only for a class `isRetryable()` says no to, and `SYSTEM_ERROR` is the
    // retryable one — it either fails over or exhausts its providers and throws
    // `TOOL_ALL_BINDINGS_FAILED`, which is handled above. The branch is written
    // for the class rather than for `REQUEST_ERROR` so that a fourth class
    // lands here voided rather than falling through to being charged.
    if (classification.responseClass !== ResponseClass.DATA_RESULT) {
      const voided = await this.void(session, intent, {
        reason: MCP_VOIDED_REASON,
        providerId: routed.providerId,
        // A `REQUEST_ERROR` is a *served* call: this binding answered, the
        // answer was its own, and the agent is charged nothing. The row records
        // which binding ran for the same reason the paid path does — the
        // exploration count measures what has been observed of a binding, not
        // what it earned.
        bindingId: routed.binding.id,
        classification: classification.responseClass,
      });

      return {
        kind: 'ERROR',
        code:
          classification.responseClass === ResponseClass.REQUEST_ERROR
            ? McpFailureCode.PROVIDER_REQUEST_ERROR
            : McpFailureCode.PROVIDER_SYSTEM_ERROR,
        // Straight from the classifier's vocabulary rather than re-derived here. The
        // router asks the same question to decide failover; an agent deciding
        // whether to retry deserves the same answer, not a second opinion.
        retryable: isRetryable(classification.responseClass),
        message: notServedMessage(tool.name, classification),
        intentId: voided.id,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
          fault: faultOf(classification),
          attempts: routed.attempts.length,
          retryAfterMs: classification.retryAfterMs,
        },
      };
    }

    const resolved = await this.resolveDataResult(session, intent, routed, args);
    const zero = MoneyUtil.zero(resolved.price.asset, resolved.price.decimals);
    const receipt: McpReceipt = {
      intentId: resolved.id,
      // What the agent was **charged**: the price only once the intent is
      // SETTLED. Before the verdict (`VERIFYING`) the price is only held, and a
      // DATA_FAIL refunds it; on `REFUNDED` and `VOIDED` it was released. A
      // receipt is the agent's record of a purchase; one that reports a charge
      // that has not happened, or never will, is wrong in the way that matters
      // most to the agent.
      charged: resolved.status === PaymentIntentStatus.SETTLED ? resolved.price : zero,
      // What is reserved against the agent's balance pending the verdict: the
      // hold, taken at the quote before the intent was re-priced to the
      // binding that served.
      held: isAwaitingVerdict(resolved.status) ? intent.price : zero,
      status: resolved.status,
      toolId: tool.id,
      // Read back off the row rather than off `routed`, so the receipt cannot
      // claim a payee the payment record does not. The binding deliberately
      // does NOT join it — see `McpReceipt`.
      providerId: resolved.providerId,
      classification: classification.responseClass,
      attempts: routed.attempts.length,
      ...(routed.fellBack ? { fellBack: true } : {}),
    };

    // A `DATA_RESULT` the mapping could not turn into the tool's contract. The
    // provider served *something* — which is why the class is what it is, and
    // why this is not a void — but there is nothing to hand the agent, so it
    // gets the failure rather than an empty success.
    if (routed.output === null) {
      return {
        kind: 'ERROR',
        code: McpFailureCode.PROVIDER_CONTRACT_VIOLATION,
        retryable: false,
        message: contractViolationMessage(tool.name, classification),
        intentId: resolved.id,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
          fault: faultOf(classification),
          attempts: routed.attempts.length,
          // Both terminal states here mean "you were not charged": `REFUNDED`
          // is the schema-contract path, and `VOIDED` is `voidUnpayable`'s
          // which releases the hold for the same money reason. Keyed on
          // only the first, this would report `false` to an agent whose money
          // had in fact been returned.
          refunded:
            resolved.status === PaymentIntentStatus.REFUNDED ||
            resolved.status === PaymentIntentStatus.VOIDED,
        },
      };
    }

    return { kind: 'RESULT', output: routed.output, receipt };
  }

  /**
   * `PROVIDER_EXECUTING → VERIFYING`, and — only for a payload the schema
   * layer already rejected — straight on to `REFUNDED`.
   *
   * Three branches, and only one of them waits for a worker:
   *
   * - **`routed.providerAccount` is null**: the call was served by somebody the
   *   platform cannot pay, so it is voided and the agent is not charged. See
   *   {@link voidUnpayable} for why that is the only outcome that is not worse.
   * - `routed.output === null` is a `DATA_RESULT` whose payload did not
   *   survive `mapResponse`'s validation against the tool's `outputSchema`.
   *   That check already ran — it is the schema layer, on the
   *   deterministic rules that run on every call — so refunding here is not
   *   skipping verification, it is not re-asking a question the platform
   *   already has the answer to.
   * - Everything else is durably recorded and handed to
   *   `VerificationSettlementService`'s worker via {@link
   *   VerificationSettlementService.enqueue}. If the record or the enqueue
   *   fails twice, the agent still gets its data back — a bookkeeping failure
   *   must never replace a successful result with an error — and the intent
   *   is settled as served, unverified, so the hold is committed rather than
   *   stranded. It is never voided: that made the call free, and a buyer could
   *   provoke the failure (final review N-3).
   */
  private async resolveDataResult(
    session: McpSession,
    intent: PaymentIntent,
    routed: RoutedCall,
    args: JsonObject,
  ): Promise<PaymentIntent> {
    if (!routed.providerAccount) {
      return this.voidUnpayable(session, intent, routed);
    }

    const verifying = await this.intents.resolve(
      session.organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VERIFYING,
      {
        providerId: routed.providerId,
        // **Who gets paid.** Written here and nowhere else on this path.
        //
        // Not at `intents.create`, because the router has not run and failover
        // can still change the answer — the same reason `providerId` and
        // `bindingId` are written here. Not at settle time either: verification
        // is asynchronous, `repairHoldEffect` reads this column off the row,
        // and resolving the address when the worker happens to run would pay
        // whichever wallet is proved *then* rather than the one that was proved
        // when this call was served.
        //
        // Without this line, every rail-A intent reaches `VERIFYING` with a
        // null payee, `resolve()`'s COMMIT branch throws
        // `PAYMENT_PROVIDER_NOT_ASSIGNED`, and the agent's money stays `held`
        // with the provider credited nothing.
        //
        // Never null by the time it is read: the branch above returned already.
        // Writing `?? undefined` here instead would be worse than useless —
        // `transition()` treats `undefined` as "leave the column alone", so a
        // null payee would silently produce the exact row
        // `chk_payment_intents_settled_names_payee` refuses, and the CHECK
        // would surface it as a raw `23514` out of `call()`.
        providerAccount: routed.providerAccount,
        // The binding that **served**, which on the failover path is not the
        // one the router drew first. `routed.binding` is the router's own
        // answer to that question — the last attempt, the one whose
        // classification this transition is recording — so there is nothing to
        // look up and nothing to re-derive.
        bindingId: routed.binding.id,
        // The price of that binding, on the same edge — see `servedCharge`.
        ...this.servedCharge(intent, routed),
        classification: routed.classification.responseClass,
        reason: MCP_FORWARDED_TO_VERIFICATION_REASON,
      },
    );

    // Counted here, from the transition that just recorded it, and not from
    // the router's selection: failover abandons the binding it drew first, and
    // counting at selection would charge that binding for a call it never
    // answered. Never throws — see `BindingCallCounterService.record`.
    await this.bindingCalls.record(routed.binding.id);

    // A response that provably did not honour the tool's contract. Already
    // decided, synchronously, by the schema layer inside `mapResponse` — see
    // the doc comment above.
    if (routed.output === null) {
      try {
        return await this.intents.resolve(
          session.organizationId,
          verifying.id,
          PaymentIntentStatus.VERIFYING,
          PaymentIntentStatus.REFUNDED,
          {
            reason: MCP_SCHEMA_CONTRACT_VIOLATION_REASON,
            verificationVerdict: 'SCHEMA_FAIL',
          },
        );
      } catch (error) {
        // The agent's failure response still goes back (`routed.output` is
        // `null`, so there was never a success to protect); the platform
        // failed to move the money, and no backstop returns it — see the doc
        // comment above on why the 24-hour hold expiry is not one.
        this.logger.error(
          `Intent ${verifying.id}: schema-contract refund did not land. ${describe(error)}`,
        );
        return verifying;
      }
    }

    const handoff: EnqueueVerificationInput = {
      organizationId: session.organizationId,
      intentId: verifying.id,
      toolId: routed.tool.id,
      // Verification judges a provider's answer against a tool's contract and
      // its consequences land on the provider's stake, so `providerId` is the
      // identity this payload needs. No binding: adding one would put a
      // second copy of the routing fact into a queue that outlives the call,
      // and the intent it names already carries the authoritative one.
      providerId: routed.providerId,
      request: args,
      response: routed.output,
      outputSchema: routed.tool.outputSchema,
    };

    // Once more on failure: `enqueue` is idempotent on the intent id, so a
    // retry after a write that did land is a no-op, not a second record.
    const enqueued = await this.settlement
      .enqueue(handoff)
      .catch(() => this.settlement.enqueue(handoff))
      .then(
        () => true,
        (error: unknown) => {
          this.logger.error(
            `Intent ${verifying.id}: data returned but verification could not be durably ` +
              `enqueued — settling the call as served, unverified. ${describe(error)}`,
          );
          return false;
        },
      );
    if (enqueued) return verifying;

    // Nothing will ever judge this intent. It is settled as served rather than
    // voided (final review N-3): the agent has the data, and a void here was a
    // free call any buyer could choose by making the write fail.
    try {
      return await this.intents.resolve(
        session.organizationId,
        verifying.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
        { reason: MCP_VERIFICATION_ENQUEUE_FAILED_REASON, settledAmount: verifying.price },
      );
    } catch (settleError) {
      // The hold stays open on a VERIFYING intent; only the 24-hour backstop
      // acts on it after this.
      this.logger.error(
        `Intent ${verifying.id}: settling after a failed enqueue did not land — the intent ` +
          `stays in VERIFYING with its hold open. ${describe(settleError)}`,
      );
    }

    return verifying;
  }

  /**
   * Rail A: what the buyer is charged — the price of the binding that served.
   *
   * The intent was created and held at the quote, the dearest eligible
   * binding, because routing had not run. Now it has, so the intent is
   * re-priced to `routed.binding`'s own price and fee, and settlement commits
   * that and releases the rest of the hold. Never above the hold: a binding
   * whose price rose between the quote and the call is charged at the hold,
   * because the quote is the most the agent agreed to pay.
   *
   * Nothing on rail B, whose voucher already signs the offered binding's own
   * price and pays exactly that on chain.
   */
  private servedCharge(
    intent: PaymentIntent,
    routed: RoutedCall,
  ): Pick<PaymentIntentTransitionContext, 'charge'> {
    if (intent.rail !== PaymentRail.RAIL_A_PER_CALL) return {};

    const served = bindingPrice(routed.binding);
    if (served.asset !== intent.price.asset || !MoneyUtil.lessThan(served, intent.price)) return {};

    return { charge: { price: served, platformFee: this.platformFee(served) } };
  }

  /**
   * A call that was served correctly by somebody the platform cannot pay.
   *
   * ## When this is reachable
   *
   * `evaluatePayoutGate` refuses any candidate whose provider has proved no
   * payout address on the chain the call settles on — except a
   * `FREE` binding, which is exempt because the relay
   * path creates no payment intent. A tool with *both* free and paid bindings
   * quotes as paid and takes the paid path, and the router used to be able to
   * draw the free binding — a devnet run was observed charging $0.088 for a
   * call a $0 binding served. A paid call is now routed with
   * `callClass: 'PAID'`, which leaves FREE bindings out of the pool, so this is
   * a guard for a catalogue that changed under the call rather than a path
   * routing takes.
   *
   * ## Why voiding, and not any of the alternatives
   *
   * Three outcomes were available and two of them are worse:
   *
   * - **Let it through.** The intent reaches `VERIFYING` with a null payee, so
   *   `chk_payment_intents_settled_names_payee` refuses the UPDATE with a raw
   *   `23514`. `resolveDataResult` is awaited un-caught, so that propagates out
   *   of `call()` and **the agent loses data a provider already served** — the
   *   invariant this file states three times. The hold is stranded either way;
   *   this version just also destroys the result.
   * - **Charge anyway and settle to nobody.** That is the null-payee defect, restored.
   * - **Void.** The agent keeps the data and is not charged; the hold is
   *   released, so nothing is stranded; the provider is paid nothing, which is
   *   what the binding they published advertises. Nobody is worse off than the
   *   terms they agreed to.
   *
   * `VOIDED` is also already the right word: the transition table gives that
   * edge `HoldEffect.RELEASE` and its own doc calls it *"no charge and no
   * strike"*. There is no strike to make here — the provider did nothing wrong,
   * they served the call their free binding offered.
   */
  private async voidUnpayable(
    session: McpSession,
    intent: PaymentIntent,
    routed: RoutedCall,
  ): Promise<PaymentIntent> {
    this.logger.warn(
      `Intent ${intent.id}: binding ${routed.binding.id} (provider ${routed.providerId}) served ` +
        `a charged call but has no proved payout address; voiding rather than charging for a ` +
        `call that can never settle. The agent keeps its result and pays nothing.`,
    );

    // The same `void()` every other unpayable outcome takes, so there is one
    // release path and one place that records the binding's call.
    return this.void(session, intent, {
      reason: MCP_UNPAYABLE_PROVIDER_REASON,
      providerId: routed.providerId,
      bindingId: routed.binding.id,
      classification: routed.classification.responseClass,
    });
  }

  /**
   * `PROVIDER_EXECUTING → VOIDED`, releasing the hold.
   *
   * Never throws. Voiding is the cleanup path of a call that has already
   * failed, and a failure here must not replace the agent's actual error with a
   * second one about bookkeeping. Note what that costs: there is **no** backstop
   * underneath a failed void. `ledger_holds.expires_at` is written and read by
   * nothing, so a hold that survives this stays open until somebody
   * releases it by hand, which is what the error below is for.
   */
  private async void(
    session: McpSession,
    intent: PaymentIntent,
    context: {
      reason: string;
      providerId?: string;
      bindingId?: string;
      classification?: string;
    },
  ): Promise<PaymentIntent> {
    try {
      const voided = await this.intents.resolve(
        session.organizationId,
        intent.id,
        PaymentIntentStatus.PROVIDER_EXECUTING,
        PaymentIntentStatus.VOIDED,
        context,
      );

      // Only when the row actually recorded a binding. The unroutable void
      // names none — nothing served that call — and a void whose transition
      // was lost recorded nothing either, so neither is counted.
      if (context.bindingId) {
        await this.bindingCalls.record(context.bindingId);
      }

      return voided;
    } catch (error) {
      this.logger.error(
        `Intent ${intent.id}: could not void after a failed call; its hold stays open ` +
          `indefinitely — nothing sweeps hold expiry. ${describe(error)}`,
      );
      return intent;
    }
  }
}

/** What `ProviderRouterService` attaches to `TOOL_ALL_BINDINGS_FAILED`. */
interface RouterLastAttempt {
  readonly bindingId: string;
  readonly providerId: string;
  readonly responseClass: ResponseClass;
}

function isAllBindingsFailed(error: unknown): error is AppError<[Record<string, any>?]> {
  return error instanceof AppError && error.errorCode === ToolErrorCode.TOOL_ALL_BINDINGS_FAILED;
}

/**
 * A routing refusal made before any provider was dialled — the router's
 * `unroutable` codes. Only these let a free call fall through to the paid
 * path: nothing happened yet, so nothing is repeated at the agent's expense.
 */
function isRefusedBeforeDialling(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.errorCode === ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING ||
      error.errorCode === ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES ||
      error.errorCode === ToolAccessErrorCode.UNSUPPORTED_INPUT_FIELD ||
      error.errorCode === ToolErrorCode.TOOL_PROVIDER_SLASH_HOLD ||
      error.errorCode === PaymentErrorCode.PAYMENT_NO_SETTLEABLE_CHAIN)
  );
}

function lastAttemptOf(error: unknown): RouterLastAttempt | null {
  if (!isAllBindingsFailed(error)) return null;
  const last = error.context?.lastAttempt as RouterLastAttempt | undefined;
  return last ?? null;
}

/**
 * The router's `TOOL_ALL_BINDINGS_FAILED` as the agent should see it: with the
 * intent id, so it can open the receipt, and without `lastAttempt`. The MCP
 * server spreads an error's context onto `x402/error`, and which binding was
 * tried is routing detail the receipt deliberately leaves out (see
 * `McpReceipt.providerId`). Any other error passes through untouched.
 */
function agentFacing(error: unknown, intentId: string | null): unknown {
  if (!isAllBindingsFailed(error)) return error;
  const context: Record<string, unknown> = { ...error.context };
  delete context.lastAttempt;
  return ToolErrors.allBindingsFailed({
    ...context,
    ...(intentId ? { intentId } : {}),
  });
}

/**
 * Why a call was not served, with the direction an agent needs: whose side
 * rejected it, that nothing was charged, and whether a retry can help. A 4xx
 * alone cannot say whether the arguments or the provider were wrong (see
 * `classify`), so the sentence says to check the arguments rather than assign
 * a fault nobody measured.
 */
function notServedMessage(
  toolName: string,
  classification: { responseClass: ResponseClass; reason: string; detail?: string },
): string {
  const evidence = classification.detail?.startsWith('status ')
    ? `${classification.reason}, ${classification.detail}`
    : classification.reason;

  if (classification.responseClass === ResponseClass.REQUEST_ERROR) {
    return (
      `${toolName} was not served: the provider rejected the request (${evidence}). ` +
      `Nothing was charged. The same call will be rejected again, so do not retry it ` +
      `unchanged: check the arguments.`
    );
  }
  return (
    `${toolName} was not served: the provider failed (${evidence}). ` +
    `Nothing was charged; a retry may succeed.`
  );
}

/**
 * Whose side a failed call is on, in the mapping engine's own vocabulary
 * (`AGENT` / `PROVIDER` / `PLATFORM`) so an agent reads one `fault` field on
 * every failure. A bare 4xx is `UNDETERMINED`: the status alone cannot say
 * whether the arguments or the provider were wrong (see `classify`).
 */
export function faultOf(classification: { reason: string }): string {
  switch (classification.reason) {
    case ClassificationReason.MAPPING_FAULT_AGENT:
      return 'AGENT';
    case ClassificationReason.MAPPING_FAULT_PLATFORM:
      return 'PLATFORM';
    case ClassificationReason.REQUEST_REJECTED:
      return 'UNDETERMINED';
    default:
      return 'PROVIDER';
  }
}

/** The answer came back in the wrong shape; the same call would get the same shape again. */
function contractViolationMessage(toolName: string, classification: { reason: string }): string {
  const whose =
    faultOf(classification) === 'PLATFORM'
      ? `This is the platform's fault`
      : `This is the provider's fault`;
  return (
    `${toolName}: the provider's response did not honour the tool's contract. ` +
    `${whose}, not your arguments; a retry will not help.`
  );
}

/** The price is reserved, not charged or released yet. */
function isAwaitingVerdict(status: PaymentIntentStatus): boolean {
  return (
    status === PaymentIntentStatus.FUNDS_SECURED ||
    status === PaymentIntentStatus.PROVIDER_EXECUTING ||
    status === PaymentIntentStatus.VERIFYING
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The x402 `resource` an MCP tool is published under.
 *
 * An MCP tool call has no HTTP method or path of its own, and
 * `computeRoutedCallHash` needs both. They are invented here, once, rather than
 * at each call site — the request-hash doc comment names this exact situation
 * as the way a mandatory field silently becomes `undefined`.
 */
export const MCP_CALL_METHOD = 'POST';

export function mcpResource(tool: Tool): string {
  return `/mcp/tools/${tool.name}`;
}

/**
 * The quote's pricing mode, narrowed to the two the relay path serves.
 *
 * A function rather than an inline `||` so the narrowing survives:
 * `ToolQuote.pricingMode` is `PricingMode | null`, and the relay path's inputs
 * are typed as exactly `FREE | FREEMIUM` — the split between the relay path
 * and the paid one. `null` (no routable binding priced
 * at all) is not free; it is unroutable, and `requireQuote` has already thrown.
 */
function freePricingMode(mode: PricingMode | null): PricingMode.FREE | PricingMode.FREEMIUM | null {
  if (mode === PricingMode.FREE) return PricingMode.FREE;
  if (mode === PricingMode.FREEMIUM) return PricingMode.FREEMIUM;
  return null;
}

/** Codes an agent branches on. */
export enum McpFailureCode {
  PAYMENT_INSUFFICIENT_FUNDS = 'PAYMENT_INSUFFICIENT_FUNDS',
  /**
   * Rail B: this call is paid by a voucher and none was presented. Retryable —
   * sign `x402/paymentRequired` and call again with `x402/voucher`.
   */
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  /**
   * The provider answered 4xx. Nothing charged, not retryable unchanged;
   * `fault` is `UNDETERMINED` (the arguments or the provider), or `AGENT`
   * when the mapping engine proved the arguments wrong.
   */
  PROVIDER_REQUEST_ERROR = 'PROVIDER_REQUEST_ERROR',
  /** The provider's infrastructure failed (`fault: PROVIDER`). Retryable: it may reach a different one. */
  PROVIDER_SYSTEM_ERROR = 'PROVIDER_SYSTEM_ERROR',
  /**
   * The provider answered, and the answer did not fit the tool's
   * `outputSchema`. Not retryable: the same provider would serve the same
   * shape, and a different one is not what failed.
   */
  PROVIDER_CONTRACT_VIOLATION = 'PROVIDER_CONTRACT_VIOLATION',
  /**
   * `x402/idempotency-key` already names a different call of this agent —
   * another tool, other arguments, or (once its replay record is gone) another
   * price. Nothing ran and nothing was charged; not retryable with this key.
   */
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  /**
   * An earlier attempt with this `x402/idempotency-key` is still running.
   * Nothing was charged for this one; retry after `retryAfter` seconds to get
   * the first attempt's result.
   */
  IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS',
  /**
   * The key's earlier attempt stopped before its provider answered and is
   * older than any live call (`intentId`). Nothing was charged for this one,
   * and the hold backstop releases whatever that attempt holds; not
   * retryable with this key.
   */
  IDEMPOTENCY_ATTEMPT_STALLED = 'IDEMPOTENCY_ATTEMPT_STALLED',
  /**
   * The key's call already completed (`intentId`), but its result cannot be
   * replayed: past the retry window, too large to keep, or lost with the
   * replay record and no longer in the verification record. Nothing was
   * charged again; not retryable with this key.
   */
  IDEMPOTENCY_RESULT_UNAVAILABLE = 'IDEMPOTENCY_RESULT_UNAVAILABLE',
}

/** What the agent said about paying, read off the request's `_meta`. */
export interface McpPayment {
  /** `x402/rail` — the rail asked for, or `null` to let the chain decide. */
  readonly rail: PaymentRail | null;
  /** `x402/voucher` — present only on the paid retry of rail B. */
  readonly voucher: McpVoucherPayment | null;
}

export interface McpVoucherPayment {
  readonly signed: SignedVoucher;
  /** The `providerId` the requirement named — picks the re-draw, proves nothing. */
  readonly providerId: string;
  /**
   * The `contractVersion` the requirement named (T3): the retry is served at
   * that contract version or refused. Absent from an older client: the
   * version is chosen again.
   */
  readonly contractVersion?: number;
}

export const NO_PAYMENT: McpPayment = Object.freeze({ rail: null, voucher: null });

/**
 * `x402/paymentRequired` on rail B — every field a voucher binds, as this
 * server will check it on the retry.
 *
 * `amount` is the EXACT price (voucher v2 has no ceiling), `requestHash` is
 * computed over this call and this provider, and `seq` is freshly allocated.
 * The client builds the voucher from these alone and adds `issuedAt` /
 * `expiresAt` (at most `maxTimeoutSeconds` apart).
 */
export interface VoucherRequirement {
  readonly rail: 'B';
  readonly scheme: 'voucher';
  readonly network: ChainId;
  readonly payer: AccountId;
  readonly payTo: AccountId;
  readonly provider: AccountId;
  readonly providerId: string;
  readonly amount: Money;
  /**
   * The contract version (`tool_versions.version`) the offer was drawn at
   * (T3). Echo it in `x402/voucher.contractVersion`: the retry is served at
   * this version or refused, never at another.
   */
  readonly contractVersion?: number;
  readonly resource: string;
  readonly requestHash: string;
  readonly seq: string;
  readonly maxTimeoutSeconds: number;
  /**
   * eip155 only (agent payment delegation, x402-aligned): who may sign the
   * voucher. `payer` — the payer's own key; `delegate` — a key the payer
   * authorised on chain, within its own caps (`X402Escrow.authorizeDelegate`).
   * Absent on Solana, where only the payer's key signs. There is no third
   * signer kind: the contract has no EIP-1271 branch (assay-evm D-18).
   */
  readonly signers?: readonly VoucherSigner[];
  /**
   * The delegate key bound to the calling agent credential (CAIP-10), or null
   * when none is bound. A delegate-signed voucher is accepted only from the
   * credential bound to that key.
   */
  readonly delegate?: AccountId | null;
}

export type VoucherSigner = 'payer' | 'delegate';

/**
 * Which rail a paid call takes.
 *
 * A presented voucher is rail B by definition, and an explicit `x402/rail`
 * wins next (a rail the chain does not offer is refused downstream by
 * `assertRailOffered`, naming the rails it does). With neither, rail A where
 * the chain offers it, and rail B otherwise — which on a chain with no paid
 * rail (Solana today) is refused with `CHAIN_RAIL_NOT_OFFERED` (4xx) before
 * anything is created.
 */
export function chooseRail(
  chainId: ChainId,
  requested: PaymentRail | null,
  hasVoucher: boolean,
): PaymentRail {
  if (hasVoucher) return PaymentRail.RAIL_B_VOUCHER;
  if (requested) return requested;
  return offersRail(chainId, railName(PaymentRail.RAIL_A_PER_CALL))
    ? PaymentRail.RAIL_A_PER_CALL
    : PaymentRail.RAIL_B_VOUCHER;
}

/**
 * The call a rail-B voucher's `requestHash` is computed over — the same
 * method and path rail A's routed hash uses, so one MCP call has one identity.
 */
function voucherCallOf(tool: Tool, args: JsonObject): RequestCall {
  return { method: MCP_CALL_METHOD, path: mcpResource(tool), query: null, body: args };
}

export interface McpReceipt {
  /**
   * `null` on the relay path, and only there — a free call creates no payment
   * intent at all (relay mode), so there is no payment
   * record to name. Widened rather than left `string`: this project compiles
   * with `strictNullChecks: false`, so `null` would have type-checked either
   * way, and a type that quietly permits what it does not declare is worse
   * than no type. Every consumer must handle the free case.
   */
  readonly intentId: string | null;
  /** The price once the intent is `SETTLED`; zero before the verdict and when refunded or voided. */
  readonly charged: Money;
  /**
   * The price while it is reserved and the verdict is still out (`VERIFYING`);
   * zero once it is charged or released. `charged + held` is never more than
   * the price.
   */
  readonly held: Money;
  /**
   * `VERIFYING` for the common case — a `DATA_RESULT` that passed the tool's
   * `outputSchema` has been handed to the asynchronous verification worker
   * and has no verdict yet. `SETTLED` and `REFUNDED` still occur
   * synchronously for outcomes the platform can decide without a worker: a
   * schema-contract violation refunds immediately, and a non-`DATA_RESULT`
   * classification never reaches this receipt at all (it is voided, and
   * returned as an `ERROR` outcome instead). An agent that wants the verdict
   * behind a `VERIFYING` receipt polls for it once the worker has run — this
   * receipt is not itself that answer.
   *
   * `null` on the relay path: a free call has no payment intent and therefore
   * no payment status. It is not `SETTLED` — nothing settled — and calling it
   * that would put a free call into every "what did I pay for" fold.
   */
  readonly status: PaymentIntentStatus | null;
  readonly toolId: string;
  /**
   * Who served the call, read back off the payment record.
   *
   * There is deliberately **no** `bindingId` beside it. The receipt is the
   * agent's document — what it was charged, by whom, and how far the call got —
   * and which of a provider's published bindings answered is a fact about the
   * platform's routing, not about the agent's purchase. An agent cannot act on
   * it, and every field here is one an agent branches on. The intent row
   * carries it for the platform's own use (`payment_intents.binding_id`); the
   * per-call export does not surface it either, and adding it there is
   * a decision about what a provider is owed, not about this receipt.
   */
  readonly providerId: string | null;
  readonly classification: ResponseClass;
  readonly attempts: number;
  /** FALLBACK_BEST dropped the toolset entry's provider preferences to serve this call. */
  readonly fellBack?: boolean;
}

export type McpCallOutcome =
  | {
      readonly kind: 'RESULT';
      /** The provider's response, mapped into the tool's `outputSchema`. */
      readonly output: JsonValue | null;
      readonly receipt: McpReceipt;
      /**
       * `true` when this is an earlier attempt's stored result, answered for a
       * retry with the same `x402/idempotency-key` (`_meta["x402/replayed"]`).
       */
      readonly replayed?: boolean;
    }
  | {
      readonly kind: 'ERROR';
      readonly code: McpFailureCode;
      readonly retryable: boolean;
      readonly message: string;
      /**
       * The intent that recorded the failure, so it is reconcilable — `null`
       * on the relay path, where the failure cost nobody anything and there is
       * no payment record to reconcile against. `tool_call_records` holds the
       * free call's own trace, keyed by `callId`.
       */
      readonly intentId: string | null;
      readonly detail: Record<string, unknown>;
    };

/**
 * What a keyed call keeps for its replay: the result as the agent got it, or
 * a marker when the output was larger than `maxResultBytes`.
 */
export type McpStoredResult =
  | { readonly kind: 'RESULT'; readonly output: JsonValue | null; readonly receipt: McpReceipt }
  | { readonly kind: 'TOO_LARGE'; readonly intentId: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The statuses an intent reaches only once a provider has answered. */
function isPastProvider(status: PaymentIntentStatus): boolean {
  return status === PaymentIntentStatus.VERIFYING || status === PaymentIntentStatus.SETTLED;
}

function isPaymentKeyReused(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.errorCode === PaymentErrorCode.PAYMENT_IDEMPOTENCY_KEY_REUSED
  );
}

function keyReused(tool: Tool, reason: 'TOOL' | 'ARGUMENTS' | 'REQUEST'): McpCallOutcome {
  const what =
    reason === 'TOOL'
      ? 'a call to another tool'
      : reason === 'ARGUMENTS'
        ? `a call to ${tool.name} with other arguments`
        : `a different request to ${tool.name}`;
  return {
    kind: 'ERROR',
    code: McpFailureCode.IDEMPOTENCY_KEY_REUSED,
    retryable: false,
    message:
      `This idempotency key was already used for ${what}. Nothing was run or charged; ` +
      `use a new key for a new call.`,
    intentId: null,
    detail: { reason },
  };
}

function inProgress(retryAfter: number, intentId: string | null): McpCallOutcome {
  return {
    kind: 'ERROR',
    code: McpFailureCode.IDEMPOTENCY_IN_PROGRESS,
    retryable: true,
    message:
      `An earlier call with this idempotency key is still running. Nothing was charged for ` +
      `this one; retry with the same key to get its result.`,
    intentId,
    // Whole seconds, the `retryAfter` of the platform's other refusals.
    detail: { retryAfter },
  };
}

function resultUnavailable(
  intentId: string | null,
  status: PaymentIntentStatus | null,
  why: string,
): McpCallOutcome {
  return {
    kind: 'ERROR',
    code: McpFailureCode.IDEMPOTENCY_RESULT_UNAVAILABLE,
    retryable: false,
    message:
      `This idempotency key's call already completed${intentId ? ` (intent ${intentId})` : ''}, ` +
      `but its result cannot be replayed: ${why}. Nothing was charged again; ` +
      `use a new key to call again.`,
    intentId,
    detail: { status },
  };
}

function isInsufficientBalance(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.errorCode === LedgerErrorCode.LEDGER_INSUFFICIENT_AVAILABLE_BALANCE
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The buyer's chain set for one call.
 *
 * **This is exactly `[session.chainId]`** — one linked account, one
 * chain. A session names the one chain its buyer can pay from, and the
 * session is where it comes from because the sets must be *supplied by the
 * payment module, never inferred by the router*.
 *
 * **It is deliberately NOT filtered by spendable balance.** A
 * `spendable(buyer, c) >= price` conjunct would relabel every insufficient-funds
 * refusal as `PAYMENT_NO_SETTLEABLE_CHAIN`, and that must not happen:
 * `PAYMENT_INSUFFICIENT_FUNDS` keeps its meaning — enough chain, not enough
 * balance. A buyer told to fund a different chain when they simply need more
 * money has been sent to the wrong place.
 */
function routingContextOf(
  session: McpSession,
  enabledChains: readonly ChainId[],
  withdrawingChains: readonly ChainId[],
  /** The merged entry and agent rules of a scoped call; absent off the MCP host. */
  rules?: RoutingRules,
  /** What the call asks of the contract (T3): range, required outputs, arguments, version. */
  contract?: ContractRequest,
): RoutingContext {
  return {
    ...(rules ? { rules } : {}),
    ...(contract ? { contract } : {}),
    payerChains: [session.chainId],
    defaultChainId: session.chainId,
    enabledChains,
    // Passed in rather than read here, because this function is pure and the
    // answer is a chain read. Both callers say what they mean: the FREE relay
    // path passes `[]` (a free call collects nothing), the paid path passes
    // `McpToolCallService.withdrawingChains`.
    withdrawingChains,
    // For the observed stats only: a self-call is left out of them.
    buyerOrganizationId: session.organizationId,
  };
}

/**
 * The delegation half of a rail-B requirement on eip155: the voucher may be
 * signed by the payer's key or by a delegate the payer authorised on chain —
 * and, when this credential has a bound delegate, which key that is. Nothing on Solana, whose escrow has no delegation.
 */
export function delegationTerms(
  session: McpSession,
): Pick<VoucherRequirement, 'signers' | 'delegate'> | Record<string, never> {
  if (namespaceOf(session.chainId) !== 'eip155') return {};
  return {
    signers: ['payer', 'delegate'],
    delegate: session.delegateAccount ?? null,
  };
}

export function delegationHint(session: McpSession): string {
  if (namespaceOf(session.chainId) !== 'eip155') return '';
  return session.delegateAccount
    ? `. The payer (${session.agentAccount}) or the delegate key bound to this credential ` +
        `(${session.delegateAccount}) may sign; a delegate signs within the caps the payer ` +
        `authorised on chain`
    : `. The payer (${session.agentAccount}) may sign, or a delegate key the payer authorised ` +
        `on chain once it is bound to this credential (POST /agents/me/delegate)`;
}

/** Whether `chainId` offers any paid rail (`chain-metadata.ts`'s `rails`). */
function paidRailOffered(chainId: ChainId): boolean {
  return offersRail(chainId, 'A') || offersRail(chainId, 'B');
}

function namespaceOf(chainId: ChainId): string {
  return chainId.split(':')[0];
}

/**
 * The agent credential behind the session (`agent_credentials.id`), or null
 * for a person's or a config session (machine ones included), whose
 * `credentialId` names no stored credential and is not a uuid (review N-1).
 */
function credentialOf(session: McpSession): string | null {
  return storedCredentialIdOf(session);
}

/**
 * What a scoped call carries through every phase: its rules, its contract
 * request (T3), `?free=1`, and its URL.
 */
interface CallPlan {
  readonly rules: RoutingRules | undefined;
  readonly contract?: ContractRequest;
  readonly forceFree: boolean;
  readonly attribution: CallAttribution | null;
}

const UNSCOPED_PLAN: CallPlan = Object.freeze({
  rules: undefined,
  forceFree: false,
  attribution: null,
});

function planOf(scope: McpScope | undefined, tool: Tool): CallPlan {
  if (!scope) return UNSCOPED_PLAN;
  return {
    rules: rulesFor(scope, tool.id),
    contract: contractFor(scope, tool),
    forceFree: forcesFree(scope),
    attribution: scope.attribution,
  };
}
