import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { assertRailOffered, chainMetadata } from '@modules/chains/chain-metadata';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { VOUCHER_MAX_TTL_SECONDS } from '@modules/payment/constants/voucher.constants';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
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
  PaymentRail,
  railName,
} from '@modules/payment/ports/payment.types';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { ResponseClass, isRetryable } from '@modules/tool/domain/classification';
import { RoutingContext } from '@modules/tool/domain/routing';
import {
  JsonObject,
  JsonValue,
  MappingDirection,
  MappingFault,
  validateAgainstSchema,
} from '@modules/tool/domain/mapping';
import { buildFreeQuotaErrorContext } from '@modules/free-tier/services/free-quota-refusal.util';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { ToolErrorCode, ToolErrors } from '@modules/tool/errors/tool.errors';
import { PricingMode, Tool } from '@modules/tool/ports/tool.types';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import {
  ProviderRouterService,
  RoutedCall,
  ToolQuote,
} from '@modules/tool/services/provider-router.service';
import { VerificationSettlementService } from '@modules/verification/services/verification-settlement.service';
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
  MCP_VOIDED_REASON,
} from '../constants/mcp.constants';
import { McpErrors } from '../errors/mcp.errors';
import { McpSession } from '../ports/mcp-session.port';
import { McpCatalogueService } from './mcp-catalogue.service';
import { MCP_PRICING, McpPricingConfig } from './mcp-pricing.config';

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
  ) {}

  async call(
    session: McpSession,
    name: string,
    args: JsonObject,
    payment: McpPayment = NO_PAYMENT,
  ): Promise<McpCallOutcome> {
    const tool = await this.catalogue.findByName(name);
    const quote = await this.requireQuote(tool, session);

    this.requireValidArguments(tool, args);

    // Minted once, here, for the whole call — not per attempt. Failover
    // excludes the whole provider (`ProviderRouterService`'s own doc comment),
    // so a given provider sees at most one request per call, and this is the
    // id that request carries as `X-X402-Call-Id`. Threaded through
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
    if (freeMode) {
      const decision = await this.freeQuota.check({
        organizationId: session.organizationId,
        agentId: session.agentId,
        toolId: tool.id,
        pricingMode: freeMode,
      });

      if (decision.kind === 'ALLOWED') {
        return this.relay(session, tool, freeMode, price, args, callId);
      }

      // `FREE` exhausted. There is no paid binding behind this tool to fall
      // through to, so the agent gets the error and the reset time — and the
      // refusal costs nothing, because nothing was created to unwind.
      if (!decision.fallThroughToPaid) {
        throw McpErrors.quotaExceeded(
          buildFreeQuotaErrorContext({ refusal: decision, toolId: tool.id, paidPrice: null }),
        );
      }

      // `FREEMIUM` exhausted — *"fall through to the paid path"*, which is the
      // entire commercial point of the mode and must require no
      // reconfiguration from the agent. Execution simply continues below.
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
      return this.callOnRailB(session, tool, price, args, callId, payment.voucher);
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
      // information available at creation time, same as `price` itself.
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
    });

    const unaffordable = await this.secureFunds(session, intent, price);
    if (unaffordable) return unaffordable;

    const executing = await this.intents.transition(
      session.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      { reason: MCP_FORWARDED_REASON },
    );

    return this.route(session, tool, executing, args, callId);
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
    price: Money,
    args: JsonObject,
    callId: string,
    payment: McpVoucherPayment | null,
  ): Promise<McpCallOutcome> {
    assertRailOffered(session.chainId, railName(PaymentRail.RAIL_B_VOUCHER));

    const asset = chainMetadata(session.chainId).settlementAsset as AssetId;
    // One read of the buyer's escrow serves the withdraw gate AND the seq
    // floor, and it throws rather than degrading — see `withdrawingChains`.
    const reading = await this.escrow.read(session.agentAccount, asset);
    const withdrawing = reading && reading.withdrawRequested > 0n ? [session.chainId] : [];
    const context: RoutingContext = {
      ...routingContextOf(session, this.enabledChains, withdrawing),
      onlyProviderId: payment?.providerId,
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
    await this.spendPolicy.assertCallAllowed({
      organizationId: session.organizationId,
      agentId: session.agentId,
      toolId: tool.id,
      price,
      requestHash,
    });

    let intent: PaymentIntent;
    try {
      intent = await this.vouchers.redeem({
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
      });
    } catch (error) {
      if (!isInsufficientBalance(error)) throw error;
      // The intent exists in `CREATED` with nothing reserved; the expiry sweep
      // closes it, exactly as on rail A. Its id is not surfaced by `redeem`.
      return this.insufficientFunds(session, null, price);
    }

    const executing = await this.intents.transition(
      session.organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      { reason: MCP_FORWARDED_REASON },
    );

    return this.route(session, tool, executing, args, callId, offer.providerId);
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

  private async requireQuote(tool: Tool, session: McpSession): Promise<ToolQuote> {
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
    });

    // `findByName` resolved it a moment ago, so a null quote means the
    // catalogue changed underneath this call rather than that the agent asked
    // for something that never existed.
    if (!quote) throw McpErrors.toolNotFound({ name: tool.name });

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
   */
  private async relay(
    session: McpSession,
    tool: Tool,
    pricingMode: PricingMode.FREE | PricingMode.FREEMIUM,
    quoted: Money,
    args: JsonObject,
    callId: string,
  ): Promise<McpCallOutcome> {
    const startedAt = Date.now();
    const routed = await this.router
      .route({
        toolId: tool.id,
        input: args,
        callId,
        // A FREE call collects nothing, so a standing withdrawal cannot leave the
        // platform short on it: `withdrawingChains` is empty here on purpose, and
        // this path deliberately does not read the escrow.
        context: routingContextOf(session, this.enabledChains, []),
      })
      .catch((error: unknown) => {
        throw agentFacing(error, null);
      });
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
    });

    // Against the binding that actually served, not the one first drawn:
    // failover abandons the first, and charging its quota for a call it never
    // answered would exhaust a provider's goodwill on somebody else's outage.
    await this.freeQuota.consume({
      organizationId: session.organizationId,
      agentId: session.agentId,
      bindingId: routed.binding.id,
    });

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
    };

    if (classification.responseClass !== ResponseClass.DATA_RESULT) {
      return {
        kind: 'ERROR',
        code:
          classification.responseClass === ResponseClass.REQUEST_ERROR
            ? McpFailureCode.PROVIDER_REQUEST_ERROR
            : McpFailureCode.PROVIDER_SYSTEM_ERROR,
        retryable: isRetryable(classification.responseClass),
        message: `${tool.name} was not served: ${classification.reason}`,
        intentId: null,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
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
        message: `${tool.name}: the provider's response did not honour the tool's contract`,
        intentId: null,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
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
          ...routingContextOf(session, this.enabledChains, await this.withdrawingChains(session)),
          onlyProviderId,
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
        message: `${tool.name} was not served: ${classification.reason}`,
        intentId: voided.id,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
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
      // What is reserved against the agent's balance pending the verdict.
      held: isAwaitingVerdict(resolved.status) ? resolved.price : zero,
      status: resolved.status,
      toolId: tool.id,
      // Read back off the row rather than off `routed`, so the receipt cannot
      // claim a payee the payment record does not. The binding deliberately
      // does NOT join it — see `McpReceipt`.
      providerId: resolved.providerId,
      classification: classification.responseClass,
      attempts: routed.attempts.length,
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
        message: `${tool.name}: the provider's response did not honour the tool's contract`,
        intentId: resolved.id,
        detail: {
          classification: classification.responseClass,
          reason: classification.reason,
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
   *   fails, the agent still gets its data back — that is the safe direction
   *   to fail in — but the intent then stays in `VERIFYING` with the agent's
   *   money held and **nothing returns it**: `ledger_holds.expires_at` has no
   *   reader anywhere, so the "24-hour hold expiry" this comment used to
   *   name as the backstop does not exist. A bookkeeping failure must still
   *   never replace the agent's successful result with an error; it must be
   *   found in the log below and retried by hand.
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

    try {
      await this.settlement.enqueue({
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
      });
    } catch (error) {
      this.logger.error(
        `Intent ${verifying.id}: data returned but verification could not be durably enqueued — ` +
          `the intent is stuck in VERIFYING and its hold will NOT be returned automatically. ` +
          `${describe(error)}`,
      );
    }

    return verifying;
  }

  /**
   * A call that was served correctly by somebody the platform cannot pay.
   *
   * ## When this is reachable
   *
   * `evaluatePayoutGate` refuses any candidate whose provider has proved no
   * payout address on the chain the call settles on — except a
   * `FREE` binding, which is exempt because the relay
   * path creates no payment intent. But a tool with *both* free and paid
   * bindings quotes as paid (`quotedPricingMode`), takes the paid path, and can
   * then draw the free binding. That call is charged, and its provider was
   * never checked. It is the one hole the gate leaves open, it is real — a
   * devnet run was observed charging $0.088 for a call a $0 binding served —
   * and this is where it lands.
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
   *
   * This is a mitigation, not the fix. The fix is for a paid call's payee
   * eligibility to be decided from the tool's supply rather than the binding's,
   * which is a routing change; until then this bounds the damage to "the
   * platform served one call for free".
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
  /** The provider rejected the request. Another provider would too. */
  PROVIDER_REQUEST_ERROR = 'PROVIDER_REQUEST_ERROR',
  /** The provider's infrastructure failed. Retrying may reach a different one. */
  PROVIDER_SYSTEM_ERROR = 'PROVIDER_SYSTEM_ERROR',
  /**
   * The provider answered, and the answer did not fit the tool's
   * `outputSchema`. Not retryable: the same provider would serve the same
   * shape, and a different one is not what failed.
   */
  PROVIDER_CONTRACT_VIOLATION = 'PROVIDER_CONTRACT_VIOLATION',
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
  readonly resource: string;
  readonly requestHash: string;
  readonly seq: string;
  readonly maxTimeoutSeconds: number;
  /**
   * eip155 only (agent payment delegation, x402-aligned): who may sign the
   * voucher. `payer` — the payer's own key; `delegate` — a key the payer
   * authorised on chain, within its own caps (`X402Escrow.authorizeDelegate`).
   * Absent on Solana, where only the payer's key signs. `erc1271` (the payer's
   * smart wallet) is accepted by the chain but not offered here: the platform
   * does not serve a call on a wallet's answer (`VoucherService`).
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
 * the chain offers it — so every existing agent on Solana is unchanged — and
 * rail B where it is all there is.
 */
export function chooseRail(
  chainId: ChainId,
  requested: PaymentRail | null,
  hasVoucher: boolean,
): PaymentRail {
  if (hasVoucher) return PaymentRail.RAIL_B_VOUCHER;
  if (requested) return requested;
  return chainMetadata(chainId).rails.includes(railName(PaymentRail.RAIL_A_PER_CALL))
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
}

export type McpCallOutcome =
  | {
      readonly kind: 'RESULT';
      /** The provider's response, mapped into the tool's `outputSchema`. */
      readonly output: JsonValue | null;
      readonly receipt: McpReceipt;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): RoutingContext {
  return {
    payerChains: [session.chainId],
    defaultChainId: session.chainId,
    enabledChains,
    // Passed in rather than read here, because this function is pure and the
    // answer is a chain read. Both callers say what they mean: the FREE relay
    // path passes `[]` (a free call collects nothing), the paid path passes
    // `McpToolCallService.withdrawingChains`.
    withdrawingChains,
  };
}

/**
 * The delegation half of a rail-B requirement on eip155: the voucher may be
 * signed by the payer's key, by a delegate the payer authorised on chain, or by
 * the payer's EIP-1271 wallet — and, when this credential has a bound delegate,
 * which key that is. Nothing on Solana, whose escrow has no delegation.
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

function namespaceOf(chainId: ChainId): string {
  return chainId.split(':')[0];
}
