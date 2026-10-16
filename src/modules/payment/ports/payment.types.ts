import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * The payment intent — the unit of accounting.
 *
 * One paid tool call produces exactly one intent, and every movement of money
 * in the platform references one. It binds five things that would otherwise
 * drift apart: who pays, who is paid, how much, for what exactly, and until
 * when. Without that binding an authorization for a $0.001 weather lookup can
 * be replayed against a $1.00 inference call.
 */
export enum PaymentIntentStatus {
  CREATED = 'CREATED',
  FUNDS_SECURED = 'FUNDS_SECURED',
  PROVIDER_EXECUTING = 'PROVIDER_EXECUTING',
  VERIFYING = 'VERIFYING',
  SETTLED = 'SETTLED',
  REFUNDED = 'REFUNDED',
  VOIDED = 'VOIDED',
  EXPIRED = 'EXPIRED',
}

/**
 * How the payment reaches the platform.
 *
 * Rail A settles per call through the facilitator; rail B is a signed off-chain
 * voucher redeemed against the agent's balance. The intent records which one
 * authorised it because the replay defenses differ.
 */
export enum PaymentRail {
  RAIL_A_PER_CALL = 'RAIL_A_PER_CALL',
  RAIL_B_VOUCHER = 'RAIL_B_VOUCHER',
}

/**
 * This enum's member, in `chain-metadata.ts`'s vocabulary.
 *
 * Two names for one thing, and the translation lives here rather than in
 * `chains/` for the direction of the dependency: `payment/` already imports
 * `ChainId` and `Money` from `chains/`, and nothing under `chains/` knows what
 * a payment rail is. Putting `PaymentRail` in `chain-metadata.ts` would invert
 * that for a two-member mapping.
 *
 * An exhaustive `switch` with no `default`, so a third rail is a compile error
 * here rather than an `undefined` that `rails.includes()` quietly refuses on
 * every chain.
 */
export function railName(rail: PaymentRail): 'A' | 'B' {
  switch (rail) {
    case PaymentRail.RAIL_A_PER_CALL:
      return 'A';
    case PaymentRail.RAIL_B_VOUCHER:
      return 'B';
  }
}

/**
 * What kind of call this is, fixed at the moment the intent is created.
 *
 * **Intrinsic, not derived** — the opposite of
 * `@modules/provider/domain/call-reconciliation`'s `CallReconciliationClass`,
 * which combines this with the intent's *outcome*. Two of these four members
 * have no producer yet and are declared anyway: `TEST` (the mapping tester's
 * sandbox) and `EXPLORATION` (the router's exploration floor, now part of sampling)
 * are both decided by information available only at call time — which policy
 * routed this call, whether the binding is under its exploration floor — and
 * a settlement outcome recorded later can never reconstruct that
 * retroactively. See the call-id migration's doc comment for the full
 * argument, including why there is deliberately no `CANARY` member here or
 * anywhere in the export vocabulary.
 */
export enum PaymentIntentCallClass {
  PAID = 'PAID',
  FREE = 'FREE',
  TEST = 'TEST',
  EXPLORATION = 'EXPLORATION',
}

/**
 * An intent as the rest of the platform sees it.
 *
 * `id` is a uuid, not a ULID (`pi_01J8XZ…`): `ledger_holds.intent_id` is a
 * `uuid` column, declared by the ledger before this table existed, and an
 * intent id that cannot be stored on the hold that reserves its money is not an
 * id.
 */
export interface PaymentIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly status: PaymentIntentStatus;
  /** Why the intent last moved — the audit trail for a sweep or a void. */
  readonly statusReason: string | null;

  readonly agentId: string;
  readonly agentAccount: AccountId;

  /**
   * Who is paid, or `null` while the platform has not decided yet.
   *
   * On the x402 quote-then-pay path the provider is known before the intent is:
   * a `402` names one, and the voucher is signed against it. On the MCP path
   * it is not. The agent calls a tool, the router picks a binding at
   * call time by weighted draw, and a `SYSTEM_ERROR` fails over to a second
   * operator — while the intent already exists, because it is what the ledger
   * hold reserving the agent's money points at.
   *
   * Written by the transition that leaves `PROVIDER_EXECUTING`, which is the
   * first moment the answer is known and final. A database CHECK refuses
   * `VERIFYING` / `SETTLED` / `REFUNDED` without it
   * (`chk_payment_intents_paying_states_name_payee`).
   */
  readonly providerId: string | null;
  /**
   * **Where** a settled call pays — CAIP-10, snapshotted from the provider's
   * ACTIVE enrolment on the chain this call settles on
   * (`provider_chain_enrolments.payout_account_id`) on the same
   * transition as {@link providerId} and by the same caller. Per chain, and
   * looked up under the chain of the money — never the provider's first
   * enrolment, which on a two-chain provider is a payee the settling chain
   * cannot see.
   *
   * Two fields, one observation, for the reason the whole pair exists: the
   * `COMMIT` edge credits this account
   * (`LedgerService.commitHoldAndCredit`), so an intent that names a provider
   * without an account is one the ledger cannot pay. A second CHECK,
   * `chk_payment_intents_settled_names_payee`, refuses `VERIFYING` and
   * `SETTLED` without it — a narrower list than `providerId`'s on purpose; see
   * that migration's JSDoc for the edge-by-edge enumeration.
   *
   * It is a **snapshot, not a lookup**. Verification is asynchronous, and a
   * provider who re-proves a different address between the call and its verdict
   * must still be paid at the address that was proved when they served it.
   * The consequence — credits accumulating under two ledger accounts for one
   * provider — is real and is `provider-payout-batch.service.ts`'s problem, not
   * this column's.
   */
  readonly providerAccount: AccountId | null;

  readonly toolId: string;
  /**
   * Which of the provider's bindings served the call, or `null` while the
   * platform has not decided yet — and `null` forever on every row written
   * before the column existed, which is deliberately not backfilled.
   *
   * Written by the same transition as {@link providerId}, because it is the
   * same observation seen at a finer grain: the provider is who gets paid, the
   * binding is which of their published implementations actually ran. The
   * exploration floor is defined as *"the first 1,000 calls of a binding"*, so
   * this column is what makes that number countable rather than inferred from
   * `(tool, provider)` through a uniqueness constraint that is true today and
   * is nobody's promise. See the entity for the full argument.
   */
  readonly bindingId: string | null;
  readonly rail: PaymentRail;

  /**
   * The value sent upstream as `X-Assay-Call-Id` on every attempt this intent
   * produced. Independent of `id` — see the call-id migration's doc
   * comment on `payment_intents.call_id` for why a call id must be able to
   * outlive, and exist without, a payment record.
   */
  readonly callId: string;
  /** What kind of call this is. See `PaymentIntentCallClass`. */
  readonly callClass: PaymentIntentCallClass;

  /** What the agent is charged. */
  readonly price: Money;
  /** `price − platformFee`. */
  readonly providerAmount: Money;
  readonly platformFee: Money;
  /**
   * What actually arrived on-chain. May exceed `price` on SVM, where the
   * `exact` scheme tolerates overpayment — use it for accounting once known.
   */
  readonly settledAmount: Money | null;

  readonly requestHash: string;
  readonly chainId: ChainId;

  readonly expiresAt: Date;
  readonly idempotencyKey: string | null;

  /**
   * The v1 voucher nonce. Null on every rail-B intent voucher v2 writes —
   * see {@link voucherSeq} — and carried only so a row written before this
   * platform's cutover to v2 still reads back its original replay key.
   */
  readonly voucherNonce: string | null;
  /**
   * The voucher v2 sequence number this intent was authorised by.
   * Always set on rail B under v2, always null on rail A. It is the durable
   * record that this `(account, seq)` pair is spent —
   * `uq_payment_intents_account_voucher_seq` is what makes that true across a
   * process restart or a Redis flush.
   */
  readonly voucherSeq: string | null;

  /** Rail B only — see `CreatePaymentIntentInput` for why all three are stored. */
  readonly voucherSignature: string | null;
  readonly voucherResourceHash: string | null;
  readonly voucherIssuedAt: number | null;
  /** Rail B on eip155: the delegate that signed, when it was not the payer. */
  readonly voucherDelegate?: string | null;
  /** The agent credential that made the call, when there was one. */
  readonly credentialId?: string | null;

  /** The ledger hold reserving `price`, opened at `FUNDS_SECURED`. */
  readonly holdId: string | null;
  /** When the sweep or the settlement path resolved that hold. */
  readonly holdReleasedAt: Date | null;

  /** Written by the response classifier; typed as a string until that vocabulary lands. */
  readonly classification: string | null;
  /** Written by verification (the verdict); likewise. */
  readonly verificationVerdict: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePaymentIntentInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: AccountId;
  /**
   * Omitted by a caller that has not routed yet (the MCP path). Both halves of the
   * payee are supplied together or not at all.
   */
  readonly providerId?: string | null;
  readonly providerAccount?: AccountId | null;
  readonly toolId: string;
  readonly rail: PaymentRail;
  /**
   * The value sent upstream as `X-Assay-Call-Id`. Minted once per
   * tool call by the caller — `EgressBindingInvoker` sets the header from
   * this value and refuses to let a binding's own `upstream.headers`
   * override it.
   */
  readonly callId: string;
  /** What kind of call this is. See `PaymentIntentCallClass`. */
  readonly callClass: PaymentIntentCallClass;
  /** What the agent pays. `providerAmount` is derived as `price − platformFee`. */
  readonly price: Money;
  readonly platformFee: Money;
  /** sha256 of the canonical request — what this payment is authorised for. */
  readonly requestHash: string;
  readonly chainId: ChainId;
  /**
   * Replayed by an agent that retried. The same key returns the same intent
   * rather than creating a second one.
   */
  readonly idempotencyKey?: string | null;
  /**
   * The v1 voucher nonce. No new caller sets this — `VoucherService`
   * writes {@link voucherSeq} instead — so it exists on this input only for the
   * rail-B insert trigger, which still accepts either field on a row written
   * before the v2 cutover.
   */
  readonly voucherNonce?: string | null;
  /**
   * The voucher v2 sequence number. Required on `RAIL_B_VOUCHER` — a
   * database CHECK enforces one of {@link voucherNonce} or this — and refused
   * on rail A, whose replay guard is on-chain. Recording it here is what makes
   * a voucher single-use durably: `uq_payment_intents_account_voucher_seq`
   * refuses the second intent for the same `(account, seq)`.
   */
  readonly voucherSeq?: string | null;
  /**
   * The buyer's base58 signature over the voucher's 239 bytes, and the two
   * voucher fields no other column carries.
   *
   * Rail B only. `VoucherRedemptionService` replays all three verbatim into
   * `redeem_voucher` minutes later, so the alternative to storing them is
   * building 239 bytes the buyer never signed.
   */
  readonly voucherSignature?: string | null;
  readonly voucherResourceHash?: string | null;
  /** The `resource` string the voucher signed, kept so a debt can be re-signed later. */
  readonly voucherResource?: string | null;
  readonly voucherIssuedAt?: number | null;
  /** The DELEGATE key that signed, when it was not the payer (CAIP-10). */
  readonly voucherDelegate?: string | null;
  /** The agent credential that made the call (the MCP session's), when there was one. */
  readonly credentialId?: string | null;
  /** Defaults to `PAYMENT_INTENT_TTL_MS` from now. */
  readonly expiresAt?: Date;
  /**
   * Which version of the agent's spend policy governed this call, as returned
   * by `SpendPolicyEnforcementService.assertCallAllowed`.
   *
   * Omitted, or `null`, when no policy governed it — a caller that does not
   * run the gate at all, or an organization whose policy could not be resolved.
   * Recording a version the call was not actually checked against would be a
   * fabricated audit trail, and this is the first field an auditor reads after
   * a spend spike.
   */
  readonly spendPolicyVersion?: number | null;
}

/**
 * What a transition may write alongside the status.
 *
 * Deliberately narrow: a transition is the only way a financial record changes,
 * so the set of fields it can touch is the set of fields that can change at
 * all.
 */
export interface PaymentIntentTransitionContext {
  /** Free text, stored on the row. The sweep writes why it swept. */
  readonly reason?: string;
  /** Set when the edge opens a hold. */
  readonly holdId?: string;
  /**
   * Who served the call, set on the edge that leaves `PROVIDER_EXECUTING`.
   *
   * The one field here that is not an *observation* about money but an
   * identification of the counterparty, and it is on this list for the same
   * reason as the others: on the MCP path the router chooses the provider after
   * the intent exists, so the alternative to writing it through a transition is
   * a bare `UPDATE` that no state check guards. Both halves move together.
   */
  readonly providerId?: string;
  readonly providerAccount?: AccountId;
  /**
   * Which binding served, set on the same edge as {@link providerId} and by
   * the same caller.
   *
   * Two fields rather than one because they answer different questions, but
   * **one transition**, because they are one observation and there is no state
   * in which one of them is known and the other is not. Writing the binding
   * separately would open a window in which the intent names a payee and no
   * binding — and the exploration count, which is read off the binding half,
   * would be counting a row that had not finished being written.
   *
   * Set only where a binding actually *answered*. A call whose providers were
   * all exhausted names neither, because nobody served it.
   */
  readonly bindingId?: string;
  /**
   * The price of the binding that served, and the platform's cut of it —
   * rail A only, on the edge out of `PROVIDER_EXECUTING`, with
   * {@link bindingId}.
   *
   * The intent is created and held at the quote (the dearest eligible binding)
   * because nobody has served yet; the buyer is charged what the serving
   * binding charges. Written as `price_amount`, `platform_fee` and
   * `provider_amount = price − fee`, so the fee-split CHECK holds, and never
   * above the hold: settlement commits this price and releases the rest of the
   * hold. Rail B never sets it — the voucher amount is already that price.
   */
  readonly charge?: { readonly price: Money; readonly platformFee: Money };
  /** Set when settlement observes what the chain actually moved. */
  readonly settledAmount?: Money;
  readonly classification?: string;
  readonly verificationVerdict?: string;
  /**
   * Makes the settled rail-B call BUYER DEBT in the same statement as the
   * status move (`redemption_lapsed_at`, `redemption_last_error` = this
   * cause): a verdict too late for its voucher (review-buyer-debt L3). Set by
   * `PaymentIntentService.resolve` only.
   */
  readonly lapseCause?: string;
}
