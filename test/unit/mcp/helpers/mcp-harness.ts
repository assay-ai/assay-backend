import { OutstandingDebt } from '@database/postgres/repositories/payment-intent.repository';
import { DEFAULT_FREE_QUOTA_CONFIG } from '@modules/free-tier/config/free-quota.config';
import { FreeBindingDials, freeCallsPerDay } from '@modules/free-tier/domain/free-calls-per-day';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  FreeQuotaCheckInput,
  FreeQuotaLimitKind,
  FreeQuotaRemaining,
  FreeQuotaDecision,
  FreeQuotaService,
} from '@modules/free-tier/services/free-quota.service';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { LedgerErrors } from '@modules/ledger/errors/ledger.errors';
import {
  EscrowBalanceReaderPort,
  EscrowChainBalance,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import { McpToolCallService } from '@modules/mcp/services/mcp-tool-call.service';
import { DEFAULT_PLATFORM_FEE_BPS } from '@modules/mcp/services/mcp-pricing.config';
import { McpServerFactory } from '@modules/mcp/services/mcp-server.factory';
import {
  DEFAULT_MCP_IDEMPOTENCY_CONFIG,
  McpIdempotencyConfig,
  McpIdempotencyStore,
} from '@modules/mcp/services/mcp-idempotency.store';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { IDEMPOTENCY_RELEASED_STATUSES } from '@modules/payment/services/payment-intent.service';
import {
  PaymentIntent,
  PaymentIntentStatus,
  PaymentIntentTransitionContext,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import {
  PaymentIntentService,
  VoucherAdmission,
} from '@modules/payment/services/payment-intent.service';
import { CreatePaymentIntentInput } from '@modules/payment/ports/payment.types';
import {
  ToolCallRecordInput,
  ToolCallRecordWriter,
} from '@modules/free-tier/services/tool-call-record-writer.service';
import { ProviderRoutingState } from '@modules/provider/ports/provider.types';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import { Tool, ToolBinding } from '@modules/tool/ports/tool.types';
import {
  EnqueueVerificationInput,
  VerificationSettlementService,
} from '@modules/verification/services/verification-settlement.service';
import { MoneyUtil } from '@utils/money.util';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { NextSeq, EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { VoucherService } from '@modules/payment/services/voucher.service';

import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ProviderRouterService } from '@modules/tool/services/provider-router.service';

import { STAKE_ASSET, buildRouter, buildTool, usdc } from '../../tool/helpers/routing-fixtures';
import { noBlocks } from '../../helpers/blocklist';
import { FakeIdempotencyRedis } from './fake-idempotency-redis';

/**
 * The MCP loop, assembled from the real services and two fakes.
 *
 * The router, the catalogue service, the call service and the server factory
 * are all the production classes — the only things replaced are the two that
 * would need a database and a socket: the payment intent store and the ledger.
 *
 * That split is the point. Every claim the MCP server makes is about **ordering**
 * against those two — the hold is opened before the router is asked, the hold
 * is committed only on a `DATA_RESULT`, an unaffordable call never reaches a
 * provider — and an in-memory pair records the order of operations exactly,
 * which a database cannot be asked about after the fact.
 */

export const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
export const AGENT_ID = '22222222-2222-4222-8222-222222222222';
export const AGENT_ACCOUNT = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1' as AccountId;
export const CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId;

export const SESSION: McpSession = Object.freeze({
  credentialId: 'cred-1',
  organizationId: ORGANIZATION_ID,
  agentId: AGENT_ID,
  agentAccount: AGENT_ACCOUNT,
  chainId: CHAIN_ID,
  label: 'test agent',
  callerKind: McpCallerKind.CONFIG,
  paymentsAllowed: true,
});

// ---------------------------------------------------------------------------
// The two fakes
// ---------------------------------------------------------------------------

/** One thing that happened, in order. The assertions are mostly about this list. */
export type LedgerEvent =
  | { readonly kind: 'HOLD_CREATE'; readonly intentId: string; readonly money: Money }
  | { readonly kind: 'HOLD_COMMIT'; readonly holdId: string }
  | { readonly kind: 'HOLD_RELEASE'; readonly holdId: string };

export class FakeLedger {
  readonly events: LedgerEvent[] = [];
  private sequence = 0;

  constructor(private available: Money) {}

  createHold(input: { intentId: string; money: Money }): Promise<{ id: string }> {
    // The real `LedgerHoldService.createHold` refuses a zero amount — *"a hold
    // must reserve a non-zero amount"* — and this fake must too, or the free
    // path's whole reason for existing (a FREE binding used to 409
    // right here) would be untestable: a test would pass whether or not the
    // relay path skipped the hold.
    if (MoneyUtil.isZero(input.money)) {
      throw LedgerErrors.insufficientAvailableBalance({
        accountId: AGENT_ACCOUNT,
        required: input.money.amount,
        available: 'a hold must reserve a non-zero amount',
      });
    }

    if (MoneyUtil.compare(input.money, this.available) === 1) {
      throw LedgerErrors.insufficientAvailableBalance({
        accountId: AGENT_ACCOUNT,
        required: input.money.amount,
        available: this.available.amount,
      });
    }

    this.available = MoneyUtil.subtract(this.available, input.money);
    const id = `hold-${++this.sequence}`;
    this.events.push({ kind: 'HOLD_CREATE', intentId: input.intentId, money: input.money });
    return Promise.resolve({ id });
  }

  commitHold(_organizationId: string, holdId: string): Promise<{ applied: boolean }> {
    this.events.push({ kind: 'HOLD_COMMIT', holdId });
    return Promise.resolve({ applied: true });
  }

  releaseHold(_organizationId: string, holdId: string): Promise<{ applied: boolean }> {
    this.events.push({ kind: 'HOLD_RELEASE', holdId });
    return Promise.resolve({ applied: true });
  }

  getBalance(): Promise<{ available: Money }> {
    return Promise.resolve({ available: this.available });
  }

  get kinds(): string[] {
    return this.events.map((event) => event.kind);
  }
}

/**
 * `PaymentIntentService` over a `Map`, with the real transition table.
 *
 * It applies `requirePaymentIntentTransition` and the rule's `holdEffect`
 * exactly as the real service does — an in-memory store that accepted any edge
 * would make every ordering assertion below vacuous.
 */
export class FakeIntents {
  readonly rows = new Map<string, PaymentIntent>();
  readonly transitions: string[] = [];
  /**
   * Every transition's target and the context it carried, in order.
   *
   * `transitions` above answers "which edges were taken"; this answers "what
   * was written while taking them", which is the only way to assert that two
   * fields were written by the *same* transition rather than by two.
   */
  readonly contexts: Array<{
    readonly to: PaymentIntentStatus;
    readonly context: PaymentIntentTransitionContext;
  }> = [];
  private sequence = 0;

  constructor(private readonly ledger: FakeLedger) {}

  /** Intents `VoucherService` took out of the window count (funds not secured). */
  readonly abandoned: string[] = [];

  /** `PaymentIntentService.abandonUnsecuredVoucher`. */
  async abandonUnsecuredVoucher(_organizationId: string, intentId: string): Promise<void> {
    this.abandoned.push(intentId);
  }

  /** `PaymentIntentService.isVoucherSeqUsed` — the up-front replay read. */
  async isVoucherSeqUsed(organizationId: string, account: string, seq: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (row) =>
        row.organizationId === organizationId &&
        row.agentAccount === account &&
        row.voucherSeq === seq,
    );
  }

  /**
   * Set by a test: the payer's open buyer debts (lapsed vouchers), as
   * `PaymentIntentService.findOutstandingDebts` returns them.
   */
  debts: OutstandingDebt[] = [];

  /** `PaymentIntentService.findOutstandingDebts`. */
  async findOutstandingDebts(organizationId: string, payer: string): Promise<OutstandingDebt[]> {
    return this.debts.filter(
      (debt) => debt.organizationId === organizationId || debt.agentAccount === payer,
    );
  }

  /** Set by a test: the payer's voucher admission is paused for that many seconds (BUG-D1-07). */
  pausedFor: number | null = null;

  create(input: CreatePaymentIntentInput, admission?: VoucherAdmission): Promise<PaymentIntent> {
    // `idx_payment_intents_idempotency_key`, in the fake: one LIVE intent per
    // (organization, agent, key), and a replay with another request hash is
    // a collision — `PaymentIntentService.resolveReplay`'s two answers.
    if (input.idempotencyKey) {
      const live = this.liveByKey(input.organizationId, input.agentId, input.idempotencyKey);
      if (live) {
        if (live.requestHash !== input.requestHash) {
          return Promise.reject(
            PaymentErrors.idempotencyKeyReused({ idempotencyKey: input.idempotencyKey }),
          );
        }
        return Promise.resolve(live);
      }
    }
    if (admission) {
      // The highest seq of the payer already admitted, as the locked read sees it.
      const seqs = [...this.rows.values()]
        .filter((row) => row.agentAccount === input.agentAccount && row.voucherSeq)
        .filter((row) => !this.abandoned.includes(row.id))
        .map((row) => BigInt(row.voucherSeq as string));
      const maxSeq = seqs.length > 0 ? seqs.reduce((a, b) => (a > b ? a : b)) : null;
      admission.admit({ escrow: 0n, delegate: 0n, pausedFor: this.pausedFor, maxSeq });
    }
    const id = `intent-${++this.sequence}`;
    const intent: PaymentIntent = {
      id,
      organizationId: input.organizationId,
      status: PaymentIntentStatus.CREATED,
      statusReason: null,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      providerId: input.providerId ?? null,
      providerAccount: input.providerAccount ?? null,
      toolId: input.toolId,
      // No binding at creation time, for the same reason as `providerId`: the
      // router has not run yet, and on the failover path the answer changes.
      bindingId: null,
      rail: input.rail,
      callId: input.callId,
      callClass: input.callClass,
      price: input.price,
      providerAmount: MoneyUtil.subtract(input.price, input.platformFee),
      platformFee: input.platformFee,
      settledAmount: null,
      requestHash: input.requestHash,
      chainId: input.chainId,
      expiresAt: new Date(Date.now() + 300_000),
      idempotencyKey: input.idempotencyKey ?? null,
      voucherSeq: input.voucherSeq ?? null,
      voucherSignature: input.voucherSignature ?? null,
      voucherResourceHash: input.voucherResourceHash ?? null,
      voucherIssuedAt: input.voucherIssuedAt ?? null,
      voucherDelegate: input.voucherDelegate ?? null,
      credentialId: input.credentialId ?? null,
      holdId: null,
      holdReleasedAt: null,
      classification: null,
      verificationVerdict: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.rows.set(id, intent);
    this.transitions.push(`→ ${PaymentIntentStatus.CREATED}`);
    return Promise.resolve(intent);
  }

  /** `PaymentIntentService.findLiveByIdempotencyKey`. */
  readonly keyLookups: string[] = [];
  findLiveByIdempotencyKey(
    organizationId: string,
    agentId: string,
    key: string,
  ): Promise<PaymentIntent | null> {
    this.keyLookups.push(key);
    return Promise.resolve(this.liveByKey(organizationId, agentId, key));
  }

  private liveByKey(organizationId: string, agentId: string, key: string): PaymentIntent | null {
    return (
      [...this.rows.values()].find(
        (row) =>
          row.organizationId === organizationId &&
          row.agentId === agentId &&
          row.idempotencyKey === key &&
          !IDEMPOTENCY_RELEASED_STATUSES.includes(row.status),
      ) ?? null
    );
  }

  /** Set by a test: an intent's age, as `createdAt` would show it. */
  age(intentId: string, ms: number): void {
    const row = this.rows.get(intentId) as PaymentIntent;
    this.rows.set(intentId, { ...row, createdAt: new Date(Date.now() - ms) });
  }

  findById(_organizationId: string, intentId: string): Promise<PaymentIntent> {
    return Promise.resolve(this.rows.get(intentId) as PaymentIntent);
  }

  async secureFunds(organizationId: string, intentId: string): Promise<PaymentIntent> {
    const intent = this.rows.get(intentId) as PaymentIntent;
    const hold = await this.ledger.createHold({ intentId, money: intent.price });
    return this.write(intentId, {
      status: PaymentIntentStatus.FUNDS_SECURED,
      holdId: hold.id,
    });
  }

  transition(
    _organizationId: string,
    intentId: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    context: PaymentIntentTransitionContext = {},
  ): Promise<PaymentIntent> {
    const intent = this.rows.get(intentId) as PaymentIntent;
    if (intent.status !== from) {
      throw new Error(`intent ${intentId} is ${intent.status}, not ${from}`);
    }

    this.contexts.push({ to, context });

    // **The database CHECK, in the fake.**
    //
    // `chk_payment_intents_settled_names_payee` refuses `VERIFYING` and
    // `SETTLED` without a payout account. A `Map` that accepted such a
    // row would let every test here pass against a state Postgres rejects — and
    // that is not hypothetical: the first draft of the payee fix wrote
    // `providerAccount ?? undefined`, `transition()` reads `undefined` as
    // "leave the column alone", and the resulting `23514` escaped an un-caught
    // `await` and destroyed the agent's result. Nothing in this file could see
    // it, because a fake that only stores what it is given cannot refuse.
    //
    // Shaped like the driver's error, `code` and `constraint` included, so a
    // caller that branches on either behaves here as it does in production.
    const payee = context.providerAccount ?? intent.providerAccount;
    if (!payee && (to === PaymentIntentStatus.VERIFYING || to === PaymentIntentStatus.SETTLED)) {
      const violation = new Error(
        `new row for relation "payment_intents" violates check constraint ` +
          `"chk_payment_intents_settled_names_payee"`,
      ) as Error & { code: string; constraint: string };
      violation.code = '23514';
      violation.constraint = 'chk_payment_intents_settled_names_payee';
      throw violation;
    }

    return Promise.resolve(
      this.write(intentId, {
        status: to,
        statusReason: context.reason ?? null,
        providerId: context.providerId ?? intent.providerId,
        bindingId: context.bindingId ?? intent.bindingId,
        providerAccount: context.providerAccount ?? intent.providerAccount,
        classification: context.classification ?? intent.classification,
        verificationVerdict: context.verificationVerdict ?? intent.verificationVerdict,
        ...(context.charge
          ? {
              price: context.charge.price,
              platformFee: context.charge.platformFee,
              providerAmount: MoneyUtil.subtract(context.charge.price, context.charge.platformFee),
            }
          : {}),
      }),
    );
  }

  async resolve(
    organizationId: string,
    intentId: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    context: PaymentIntentTransitionContext = {},
  ): Promise<PaymentIntent> {
    const intent = await this.transition(organizationId, intentId, from, to, context);

    if (to === PaymentIntentStatus.SETTLED) {
      await this.ledger.commitHold(organizationId, intent.holdId as string);
    }
    if (to === PaymentIntentStatus.VOIDED || to === PaymentIntentStatus.REFUNDED) {
      await this.ledger.releaseHold(organizationId, intent.holdId as string);
    }

    return intent;
  }

  private write(intentId: string, patch: Partial<PaymentIntent>): PaymentIntent {
    const updated = { ...(this.rows.get(intentId) as PaymentIntent), ...patch } as PaymentIntent;
    this.rows.set(intentId, updated);
    if (patch.status) this.transitions.push(`→ ${patch.status}`);
    return updated;
  }

  /** The one intent a single-call test created. */
  get only(): PaymentIntent {
    return [...this.rows.values()][0];
  }
}

/**
 * `VerificationSettlementService`, recording every `enqueue()` call rather
 * than doing anything with it.
 *
 * Settlement is off this path entirely — `McpToolCallService` no
 * longer decides `SETTLED` vs `REFUNDED` for a `DATA_RESULT`, it hands the
 * call to this and stops. So the assertions this fake exists for are about
 * *what got enqueued*, not about any ledger effect: the ledger effects that
 * used to happen synchronously now belong to `VerificationSettlementService`
 * itself, tested in `test/unit/verification/verification-settlement.service.spec.ts`.
 */
export class FakeSettlement {
  readonly calls: EnqueueVerificationInput[] = [];
  /** Set by a test: the retention sweep scrubbed the recorded bodies. */
  scrubbed = false;

  /**
   * Overridable per test, so "the enqueue fails" is a one-line harness option
   * rather than reaching past the class's public shape to break it.
   */
  constructor(
    private readonly behaviour: (input: EnqueueVerificationInput) => Promise<void> = () =>
      Promise.resolve(),
  ) {}

  enqueue(input: EnqueueVerificationInput): Promise<void> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

/**
 * `BindingCallCounterService`, recording which bindings were counted.
 *
 * The counter's own correctness — hydration off `payment_intents`, and which
 * direction a lost key errs in — is
 * `test/unit/tool/binding-call-counter.spec.ts`'s subject. What this fake is
 * for is the property that only the MCP loop can prove: that the increment
 * happens for the binding that **served**, once, at the point the row records
 * it, and not for the binding the router first drew and then abandoned.
 */
export class FakeBindingCallCounter {
  readonly recorded: string[] = [];

  record(bindingId: string): Promise<void> {
    this.recorded.push(bindingId);
    return Promise.resolve();
  }

  observedCalls(bindingId: string): Promise<number | null> {
    return Promise.resolve(this.recorded.filter((id) => id === bindingId).length);
  }
}

/**
 * `FreeQuotaService`, reduced to the reads `McpCatalogueService.listTools`
 * calls: `remainingForTool` and `dailyAllowance`. Set per tool with
 * `setRemaining`; unset tools answer `null`, matching the
 * "omit rather than publish a number that is nobody's" rule.
 */
export class FakeFreeQuota {
  private readonly remaining = new Map<string, FreeQuotaRemaining>();

  /** Set by a test that wants the relay path refused. Default: everything allowed. */
  decision: FreeQuotaDecision = { kind: 'ALLOWED' };
  /** Every `check` this run, so a test can assert the pricing mode it was asked about. */
  readonly checked: FreeQuotaCheckInput[] = [];
  /**
   * Bindings whose quota place was taken and KEPT this run (a binding place
   * given back on failover or on a refusal is not here), so a test can assert
   * the binding that was charged.
   */
  get consumed(): string[] {
    return this.places.filter((place) => !place.released).map((place) => place.bindingId);
  }
  /** Every binding place taken, released or not, in order. */
  readonly places: { bindingId: string; released: boolean }[] = [];
  /** Platform places taken; `released` once given back. */
  readonly platformPlaces: { released: boolean }[] = [];
  /** Bindings whose own quota has no room left (`reserveBinding` answers null). */
  readonly noRoomFor = new Set<string>();
  /** Set to refuse the platform reservation (e.g. the last place was taken in parallel). */
  platformRefusal: FreeQuotaDecision | null = null;

  setRemaining(toolId: string, value: FreeQuotaRemaining): void {
    this.remaining.set(toolId, value);
  }

  /** The real arithmetic, over the quote's bindings, with the platform defaults. */
  dailyAllowance(bindings: readonly FreeBindingDials[]): number | null {
    return freeCallsPerDay(bindings, DEFAULT_FREE_QUOTA_CONFIG);
  }

  remainingForTool(
    _organizationId: string,
    _agentId: string,
    toolId: string,
  ): Promise<FreeQuotaRemaining | null> {
    return Promise.resolve(this.remaining.get(toolId) ?? null);
  }

  check(input: FreeQuotaCheckInput): Promise<FreeQuotaDecision> {
    this.checked.push(input);
    return Promise.resolve(this.decision);
  }

  async reservePlatform(_input: FreeQuotaCheckInput) {
    if (this.platformRefusal) return this.platformRefusal;
    const place = { released: false };
    this.platformPlaces.push(place);
    return {
      kind: 'RESERVED' as const,
      release: async () => {
        place.released = true;
      },
    };
  }

  /** Which dial each `noRoomFor` binding is full on (default: the per-agent quota). */
  readonly fullOn = new Map<string, FreeQuotaLimitKind>();
  /** Every refusal built for a call whose free bindings were all shed. */
  readonly bindingRefusals: FreeQuotaLimitKind[] = [];

  bindingQuotaRefusal(input: FreeQuotaCheckInput, limit: FreeQuotaLimitKind) {
    this.bindingRefusals.push(limit);
    return {
      kind: 'REFUSED' as const,
      limit,
      resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)),
      fallThroughToPaid: input.pricingMode === PricingMode.FREEMIUM,
    };
  }

  async reserveBinding(input: {
    binding: { id: string };
    onFull?: (limit: FreeQuotaLimitKind) => void;
  }) {
    if (this.noRoomFor.has(input.binding.id)) {
      input.onFull?.(
        this.fullOn.get(input.binding.id) ?? FreeQuotaLimitKind.PROVIDER_PER_AGENT_DAILY,
      );
      return null;
    }
    const place = { bindingId: input.binding.id, released: false };
    this.places.push(place);
    return {
      kind: 'RESERVED' as const,
      release: async () => {
        place.released = true;
      },
    };
  }
}

/**
 * `ToolCallRecordWriter`, collecting instead of inserting.
 *
 * The relay path's only durable output, so a test asserting "a free call left
 * a trace and no payment intent" reads {@link written} and `FakeIntents`
 * together.
 */
export class FakeToolCallRecords {
  readonly written: ToolCallRecordInput[] = [];

  write(input: ToolCallRecordInput): Promise<void> {
    this.written.push(input);
    return Promise.resolve();
  }
}

/**
 * `SpendPolicyEnforcementService`, permitting by default.
 *
 * The gate has its own suite; here it exists so `tools/call` can be exercised
 * end to end. Set {@link refuseWith} to assert that a refusal happens before
 * any intent is created.
 */
export class FakeSpendPolicy {
  refuseWith: Error | null = null;
  /** Every call the gate saw, for asserting it ran before the money did. */
  readonly checked: { toolId: string; requestHash: string }[] = [];
  /**
   * Set by a test: a cap counted in holds. The check refuses once `held()`
   * holds exist — the real gate's "spend so far + this call > cap", reduced to
   * what the harness can see.
   */
  holdCap: { readonly max: number; readonly held: () => number } | null = null;
  /** Calls that ran the check outside {@link withAgentSpendLock}. */
  uncheckedOutsideLock = 0;
  /** Set by a test: the lock lapsed mid-section, so the ownership check refuses. */
  lockLost: Error | null = null;
  /** How many sections confirmed they still held the lock. */
  lockConfirmations = 0;

  private readonly locks = new Map<string, Promise<unknown>>();
  private depth = 0;

  /** The real lock's guarantee, in process: one critical section per agent at a time. */
  withAgentSpendLock<T>(
    agentId: string,
    section: (assertLockHeld: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const fn = () =>
      section(() => {
        this.lockConfirmations += 1;
        return this.lockLost ? Promise.reject(this.lockLost) : Promise.resolve();
      });
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const run = previous.then(
      async () => {
        this.depth += 1;
        try {
          return await fn();
        } finally {
          this.depth -= 1;
        }
      },
      async () => {
        this.depth += 1;
        try {
          return await fn();
        } finally {
          this.depth -= 1;
        }
      },
    );
    this.locks.set(
      agentId,
      run.catch(() => undefined),
    );
    return run;
  }

  assertCallAllowed(input: { toolId: string; requestHash: string }): Promise<number | null> {
    this.checked.push({ toolId: input.toolId, requestHash: input.requestHash });
    if (this.depth === 0) this.uncheckedOutsideLock += 1;
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    if (this.holdCap && this.holdCap.held() >= this.holdCap.max) {
      return Promise.reject(new Error('daily cap reached'));
    }
    return Promise.resolve(1);
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * An {@link EscrowBalanceReaderPort} whose one buyer's escrow the test declares.
 *
 * Real enough to exercise the gate it feeds: `withdrawRequested` is settable, so
 * `mcp-withdraw-gate` cases can put a standing request on the session's chain
 * and watch `tools/call` refuse. Defaults to **no escrow at all** (`null`),
 * which is the ordinary state of an MCP buyer — they spend the ledger mirror and
 * may never have opened one.
 *
 * `throws` makes the port's fail-closed contract reachable: `read` is the one
 * balance read in this codebase that never degrades to a stale mirror, and a
 * fake that always resolved would hide what an RPC outage now costs this path.
 */
export class FakeEscrowReader implements EscrowBalanceReaderPort {
  withdrawRequested: bigint | null = null;
  /** The chain's highest redeemed seq, when the escrow exists (`withdrawRequested !== null`). */
  seqHigh = 0n;
  /** The escrow's own limits (`setLimits`); 1 / 10 in the token's units by default. */
  maxVoucherAmount = 1_000_000n;
  maxPerWindow = 10_000_000n;
  throws: Error | null = null;
  readonly reads: AccountId[] = [];

  async read(account: AccountId, asset: AssetId): Promise<EscrowChainBalance | null> {
    this.reads.push(account);
    if (this.throws) throw this.throws;
    if (this.withdrawRequested === null) return null;
    return {
      balance: MoneyUtil.of('0', asset, 6),
      seqHigh: this.seqHigh,
      withdrawRequested: this.withdrawRequested,
      withdrawAvailableAt: 0,
      maxVoucherAmount: this.maxVoucherAmount,
      maxPerWindow: this.maxPerWindow,
      spentInWindow: 0n,
      windowStartedAt: 0,
      observedAt: new Date(),
    };
  }

  async readMany(): Promise<ReadonlyMap<AccountId, EscrowChainBalance>> {
    return new Map();
  }

  async escrowAddresses(
    account: AccountId,
  ): Promise<{ readonly escrowPda: AccountId; readonly escrowTokenAccount: AccountId }> {
    return { escrowPda: account, escrowTokenAccount: account };
  }
}

/**
 * `EscrowSeqService` over a counter — the `buyer_escrows.next_seq` it stands in
 * for is a Postgres column with its own integration suite.
 *
 * `bumpedTo` records the chain-driven realignment, so a test can assert that a
 * requirement never offers a seq the chain has already passed.
 */
export class FakeEscrowSeqs {
  next = 1n;
  readonly allocated: string[] = [];
  readonly bumpedTo: bigint[] = [];

  async allocate(
    _organizationId: string,
    account: AccountId,
    chainSeqHigh: bigint | null = null,
  ): Promise<NextSeq> {
    if (chainSeqHigh !== null && chainSeqHigh >= this.next) {
      this.next = chainSeqHigh + 1n;
      this.bumpedTo.push(this.next);
    }
    const seq = (this.next++).toString();
    this.allocated.push(seq);
    return { seq, escrowPda: account, escrowTokenAccount: account };
  }

  async wasIssued(_organizationId: string, _account: AccountId, seq: bigint): Promise<boolean> {
    return seq >= 1n && seq < this.next;
  }
}

/** What a voucher "signature" is in these specs: a statement of who signed. */
export function fakeVoucherSignature(signer: AccountId): string {
  return `signed-by:${signer}`;
}

/**
 * A chain adapter reduced to the two voucher methods `VoucherService` calls.
 *
 * `VoucherService` itself is the REAL class in this harness — every binding it
 * checks (payer, payTo, provider, resource, amount, requestHash, seq) runs as in
 * production. Only the cryptography is stood in for, and its own suites are
 * `evm-signing.spec.ts` and `voucher.service.spec.ts`.
 */
function voucherOnlyRegistry(chainId: ChainId): ChainAdapterRegistry {
  const adapter = {
    namespace: 'solana',
    supportedChains: [chainId],
    verifyVoucherSignature: (_voucher: unknown, signature: string, signer: AccountId) =>
      signature === fakeVoucherSignature(signer),
    voucherResourceHash: (resource: string) => `resource-hash:${resource}`,
  } as unknown as ChainAdapter;
  return new ChainAdapterRegistry([adapter], [chainId]);
}

export interface McpHarnessOptions {
  readonly tool?: Tool;
  readonly bindings: readonly ToolBinding[];
  readonly providers: readonly ProviderRoutingState[];
  readonly stakes?: Readonly<Record<string, Money>>;
  readonly invoker: BindingInvokerPort;
  readonly balance?: Money;
  readonly platformFeeBps?: number;
  readonly random?: () => number;
  /** What `FakeSettlement.enqueue` does after recording the call. Defaults to succeeding. */
  readonly settlementBehaviour?: (input: EnqueueVerificationInput) => Promise<void>;
  /** Pre-set `assay/freeQuota` figures, keyed by tool id. */
  readonly freeQuota?: FakeFreeQuota;
  /** The spend-policy gate. Permits everything unless a test says otherwise. */
  readonly spendPolicy?: FakeSpendPolicy;
  /**
   * The buyer's on-chain escrow, as the withdraw gate sees it.
   *
   * Defaults to a reader that answers `null` (no escrow), which is what an MCP
   * buyer who has only ever spent the ledger mirror actually has.
   */
  readonly escrow?: FakeEscrowReader;
  /**
   * The Redis behind `assay/idempotency-key`. Pass one to share it between two
   * harnesses — two tools, one agent, one Redis.
   */
  readonly idempotencyRedis?: FakeIdempotencyRedis;
  readonly idempotencyConfig?: Partial<McpIdempotencyConfig>;
}

export interface McpHarness {
  readonly router: ProviderRouterService;
  readonly catalogue: McpCatalogueService;
  readonly calls: McpToolCallService;
  readonly servers: McpServerFactory;
  readonly intents: FakeIntents;
  readonly ledger: FakeLedger;
  readonly settlement: FakeSettlement;
  readonly bindingCalls: FakeBindingCallCounter;
  readonly freeQuota: FakeFreeQuota;
  readonly spendPolicy: FakeSpendPolicy;
  readonly toolCallRecords: FakeToolCallRecords;
  readonly escrow: FakeEscrowReader;
  readonly seqs: FakeEscrowSeqs;
  /** The Redis behind `McpIdempotencyStore` (`assay/idempotency-key`). */
  readonly idempotencyRedis: FakeIdempotencyRedis;
}

export function buildMcpHarness(options: McpHarnessOptions): McpHarness {
  const tool = options.tool ?? buildTool();

  const { router } = buildRouter({
    tool,
    bindings: options.bindings,
    providers: options.providers,
    stakes: options.stakes ?? defaultStakes(options.providers),
    invoker: options.invoker,
    random: options.random,
  });

  // The same snapshot the router reads, behind the same class. The MCP
  // catalogue service takes the port directly rather than reaching through the
  // router: `tools/list` is a catalogue read, and routing is what prices it.
  const freeQuota = options.freeQuota ?? new FakeFreeQuota();
  const catalogue = new McpCatalogueService(
    new InMemoryToolCatalogue({ tools: [tool], bindings: options.bindings }),
    router,
    freeQuota as unknown as FreeQuotaService,
    // The one chain every fixture session, binding and stake lives on, so the
    // chain gate narrows nothing here and these specs stay about what they say
    // they are about. `routing-chains.spec.ts` is where the narrowing is the
    // subject.
    [CHAIN_ID],
  );

  const ledger = new FakeLedger(options.balance ?? usdc(100));
  const intents = new FakeIntents(ledger);
  const settlement = new FakeSettlement(options.settlementBehaviour);
  const bindingCalls = new FakeBindingCallCounter();

  const spendPolicy = options.spendPolicy ?? new FakeSpendPolicy();
  const toolCallRecords = new FakeToolCallRecords();
  const escrow = options.escrow ?? new FakeEscrowReader();
  const seqs = new FakeEscrowSeqs();
  const vouchers = new VoucherService(
    intents as unknown as PaymentIntentService,
    voucherOnlyRegistry(CHAIN_ID),
    seqs as unknown as EscrowSeqService,
    noBlocks(),
  );

  const idempotencyRedis = options.idempotencyRedis ?? new FakeIdempotencyRedis();
  const idempotencyConfig = { ...DEFAULT_MCP_IDEMPOTENCY_CONFIG, ...options.idempotencyConfig };
  const calls = new McpToolCallService(
    catalogue,
    router,
    intents as unknown as PaymentIntentService,
    ledger as unknown as LedgerService,
    settlement as unknown as VerificationSettlementService,
    bindingCalls as unknown as BindingCallCounterService,
    spendPolicy as unknown as SpendPolicyEnforcementService,
    freeQuota as unknown as FreeQuotaService,
    toolCallRecords as unknown as ToolCallRecordWriter,
    vouchers,
    seqs as unknown as EscrowSeqService,
    escrow,
    { platformFeeBps: options.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS },
    [CHAIN_ID],
    // The real store over a fake Redis: claim, replay and release run as in
    // production. Untouched by every call that carries no key.
    new McpIdempotencyStore(idempotencyRedis as never, idempotencyConfig),
    idempotencyConfig,
    // The verification record a served call's response is durably written to:
    // what `enqueue` was handed, unless a test scrubbed it.
    {
      findByIntentId: async (_organizationId: string, intentId: string) => {
        const handed = settlement.calls.find((call) => call.intentId === intentId);
        if (!handed) return null;
        return { intentId, response: settlement.scrubbed ? null : handed.response };
      },
    } as unknown as VerificationRecordRepository,
  );

  return {
    router,
    catalogue,
    calls,
    servers: new McpServerFactory(catalogue, calls),
    intents,
    ledger,
    settlement,
    bindingCalls,
    freeQuota,
    spendPolicy,
    toolCallRecords,
    escrow,
    seqs,
    idempotencyRedis,
  };
}

function defaultStakes(providers: readonly ProviderRoutingState[]): Record<string, Money> {
  return Object.fromEntries(providers.map((provider) => [provider.providerId, usdc(1000)]));
}

export { STAKE_ASSET, usdc };
export const USDC: AssetId = STAKE_ASSET;
export const RAIL = PaymentRail.RAIL_A_PER_CALL;
