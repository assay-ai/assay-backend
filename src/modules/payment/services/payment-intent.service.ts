import {
  CHAIN_STATE_GATE,
  ChainDoor,
  ChainStateGatePort,
} from '@modules/chains/ports/chain-state-gate.port';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { In, Not } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import {
  DebtCloseTarget,
  OpenVoucherTotals,
  OutstandingDebt,
  PaymentIntentRepository,
  VoucherAdmissionScope,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { LedgerAccountId, LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

/** A redemption its receipt and the logs cannot classify is paged after this many tries. */
const UNCLASSIFIED_PAGE_AFTER = 5;

import {
  LATE_VERDICT_LAPSE_CAUSE,
  PAYMENT_INTENT_FUNDS_SECURED_REASON,
  PAYMENT_INTENT_HOLD_TTL_MS,
  PAYMENT_INTENT_TTL_MS,
  PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS,
} from '../constants/payment-intent.constants';
import { DEBT_VOIDED_PREFIX } from '../constants/voucher-redemption.constants';
import { HoldEffect, requirePaymentIntentTransition } from '../domain/payment-intent-transitions';
import {
  COLLECTION_HOLD_WINDOW_SECONDS,
  HELD,
  HELD_COLLECTED,
  HELD_REFUNDED,
} from '../constants/collection-hold.constants';
import {
  HELD_PAYMENTS,
  HELD_TIMEOUT_SECONDS,
  HeldPaymentsPort,
  HeldStatus,
} from '../ports/held-payments.port';
import { PaymentErrors } from '../errors/payment.errors';
import {
  CreatePaymentIntentInput,
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentIntentStatus,
  PaymentIntentTransitionContext,
  PaymentRail,
} from '../ports/payment.types';

/**
 * The unique index on `payment_intents.voucher_nonce` (voucher v1).
 *
 * Matched by name because Postgres reports which constraint refused an insert,
 * and this table has three unique indexes whose violations mean different
 * things. No caller writes `voucherNonce` any more — `VoucherService` writes
 * {@link VOUCHER_SEQ_CONSTRAINT} instead — but the index and this branch stay
 * for rows written before the v2 cutover.
 */
const VOUCHER_NONCE_CONSTRAINT = 'idx_payment_intents_voucher_nonce';

/**
 * Voucher v2's replacement: unique on `(agent_account, voucher_seq)`, not global —
 * voucher v2's `seq` is per-buyer, so buyer A's seq 5 and buyer B's seq 5 are
 * different vouchers and must not collide.
 */
const VOUCHER_SEQ_CONSTRAINT = 'uq_payment_intents_account_voucher_seq';

/**
 * The partial unique index on `(organization_id, agent_id, idempotency_key)`,
 * and the name it is rebuilt under while migration 1761000000000 swaps it.
 */
const IDEMPOTENCY_KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'idx_payment_intents_idempotency_key',
  'idx_payment_intents_idempotency_key_staged',
]);

/**
 * The statuses whose intent no longer holds its idempotency key: the agent was
 * not charged (`VOIDED`, `EXPIRED`, `REFUNDED`), so a retry with the same key
 * is a fresh attempt. Mirrors the predicate of
 * `idx_payment_intents_idempotency_key` (migration 1761000000000) — the index
 * is the guarantee, and this list only lets {@link PaymentIntentService} read
 * back the one row the index still arbitrates.
 */
export const IDEMPOTENCY_RELEASED_STATUSES: readonly PaymentIntentStatus[] = [
  PaymentIntentStatus.VOIDED,
  PaymentIntentStatus.EXPIRED,
  PaymentIntentStatus.REFUNDED,
];

/**
 * What a rail-B voucher's intent must fit before it is written: the scope of
 * the vouchers the chain has not counted yet, and the check against them,
 * which throws to refuse. Run under the payer's lock, atomically with the
 * insert — see `PaymentIntentRepository.insertAdmittedVoucherIntent`.
 */
export interface VoucherAdmission {
  readonly scope: VoucherAdmissionScope;
  readonly admit: (open: OpenVoucherTotals) => void;
}

/**
 * The payment intent lifecycle.
 *
 * Two things are true of every method here and of nothing else in the domain:
 * the status only ever changes through `transition`, and `transition` only ever
 * takes an edge that `PAYMENT_INTENT_TRANSITIONS` lists. Everything else —
 * idempotency, holds, the expiry sweep — is built on top of those two.
 */
@Injectable()
export class PaymentIntentService {
  private readonly logger = new Logger(PaymentIntentService.name);

  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly ledger: LedgerService,
    private readonly escrowGate: EscrowSpendGateService,
    private readonly blocklist: AccountBlocklistService,
    // The ON-CHAIN pause and blocklist (D-19), refused here with a clear error
    // rather than at redemption. Optional: a composition without the chain
    // cache still creates intents, and the contract still enforces.
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
    // The per-chain slash holds: no new intent names a held provider there.
    @Optional() private readonly slashHolds: ProviderSlashHoldRepository | null = null,
    // The escrow's hold ("redeem into hold", G3.B1). Absent, or reading `null`
    // (an escrow before the upgrade): a redemption pays the provider at once.
    @Optional()
    @Inject(HELD_PAYMENTS)
    private readonly held: HeldPaymentsPort | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /**
   * Creates an intent, or returns the one an earlier copy of this request
   * already created.
   *
   * **Insert first, ask afterwards.** The obvious implementation — look the key
   * up, and insert if it is absent — has a window between the two in which a
   * second request finds nothing either, and two intents are created for one
   * payment. There is no way to close that window in application code, so the
   * insert goes first and the unique index arbitrates: exactly one INSERT
   * survives, and the loser reads the winner's row. Postgres makes the loser
   * *block* on the index entry until the winner commits, so the row it then
   * reads is always there.
   *
   * A key replayed against a *different* request is not a retry — it is a
   * collision, and it is refused rather than silently answered with the first
   * request's intent.
   *
   * A key is held only while its intent may still charge the agent: once the
   * intent is `VOIDED`, `EXPIRED` or `REFUNDED` the index releases it (see
   * {@link IDEMPOTENCY_RELEASED_STATUSES}), and the same key creates a new
   * intent. A failed call that cost nothing can therefore be retried.
   *
   * **No intent names a blocked party.** Every new payment, on every rail,
   * starts here, so this is the one place the account blocklist refuses the
   * payer's organization and account, the provider and its payout account, and
   * the voucher delegate. It is checked before the insert, so a refusal leaves
   * nothing behind — not even the idempotency key.
   */
  async create(
    input: CreatePaymentIntentInput,
    admission?: VoucherAdmission,
  ): Promise<PaymentIntent> {
    this.blocklist.assertNotBlocked([
      {
        role: BlockedRole.ORGANIZATION,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: input.organizationId,
      },
      { role: BlockedRole.PAYER, kind: BlockSubjectKind.WALLET, subject: input.agentAccount },
      {
        role: BlockedRole.PROVIDER,
        kind: BlockSubjectKind.ORGANIZATION,
        subject: input.providerId,
      },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: input.providerAccount },
      { role: BlockedRole.DELEGATE, kind: BlockSubjectKind.WALLET, subject: input.voucherDelegate },
    ]);
    await this.chainState?.assertActive(ChainDoor.REDEEM, [
      { role: 'PAYER', account: input.agentAccount },
      { role: 'PAYEE', account: input.providerAccount },
      { role: 'DELEGATE', account: input.voucherDelegate },
    ]);

    if (
      input.providerId &&
      this.slashHolds &&
      (await this.slashHolds.isHeld(input.providerId, input.chainId))
    ) {
      throw PaymentErrors.providerSlashHold({ chainId: input.chainId });
    }

    // At the quote on rail A, where routing has not run yet: the edge out of
    // `PROVIDER_EXECUTING` re-prices it to the binding that served
    // (`PaymentIntentTransitionContext.charge`). On rail B the price is
    // already the offered binding's own.
    const providerAmount = MoneyUtil.subtract(input.price, input.platformFee);

    const row: Partial<PaymentIntentEntity> = {
      id: randomUUID(),
      organizationId: input.organizationId,
      status: PaymentIntentStatus.CREATED,
      statusReason: null,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      // Null on the MCP path, where the router has not run yet. The database
      // refuses the halves separately and refuses a paying state without them.
      providerId: input.providerId ?? null,
      providerAccount: input.providerAccount ?? null,
      toolId: input.toolId,
      // Null for the same reason as `providerId`, and on both paths: the
      // quote-then-pay path knows the provider but not which binding will
      // serve, and the MCP path does not know either yet. Written by the
      // transition that leaves `PROVIDER_EXECUTING`.
      bindingId: null,
      rail: input.rail,
      callId: input.callId,
      callClass: input.callClass,
      assetId: input.price.asset,
      decimals: input.price.decimals,
      priceAmount: input.price.amount,
      providerAmount: providerAmount.amount,
      platformFee: input.platformFee.amount,
      settledAmount: null,
      requestHash: input.requestHash,
      // Null when the caller ran no spend-policy gate, which
      // is every path except `tools/call` today — see the column's own comment
      // for why that is not back-filled.
      spendPolicyVersion: input.spendPolicyVersion ?? null,
      chainId: input.chainId,
      expiresAt: input.expiresAt ?? new Date(Date.now() + PAYMENT_INTENT_TTL_MS),
      idempotencyKey: input.idempotencyKey ?? null,
      voucherNonce: input.voucherNonce ?? null,
      voucherSeq: input.voucherSeq ?? null,
      voucherSignature: input.voucherSignature ?? null,
      voucherResourceHash: input.voucherResourceHash ?? null,
      voucherResource: input.voucherResource ?? null,
      voucherIssuedAt: input.voucherIssuedAt === undefined ? null : String(input.voucherIssuedAt),
      voucherDelegate: input.voucherDelegate ?? null,
      credentialId: input.credentialId ?? null,
      holdId: null,
      holdReleasedAt: null,
      classification: null,
      verificationVerdict: null,
    };

    // Twice at most, and only for one race: see the end of the catch block.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.insertRow(row, admission);
        break;
      } catch (error) {
        const violation = error as { code?: string; constraint?: string };
        if (violation?.code !== UNIQUE_VIOLATION_CODE) {
          throw error;
        }

        // Two unique indexes can refuse this insert and they mean opposite
        // things, so the constraint name decides rather than the presence of a
        // key. A voucher nonce collision is a **replay** — the authorization has
        // already been spent and there is nothing to return — while an
        // idempotency collision is a **retry**, and the caller wants the intent
        // the first copy created. Inferring one from the other would answer a
        // replayed voucher with someone's earlier intent.
        if (violation.constraint === VOUCHER_NONCE_CONSTRAINT) {
          throw PaymentErrors.voucherNonceReplayed({ nonce: row.voucherNonce });
        }
        // Voucher v2's replay guard: `VoucherService.assertIssuedSeq` already
        // confirmed the seq was issued to this account and not yet used before
        // this insert ran, so a collision here means a second call reached the
        // insert for the same `(account, seq)` first — a genuine concurrent
        // replay. The seq WAS issued, so this is "already used", never
        // "not issued".
        if (violation.constraint === VOUCHER_SEQ_CONSTRAINT) {
          throw PaymentErrors.voucherSeqAlreadyUsed({
            account: row.agentAccount,
            actual: row.voucherSeq,
          });
        }
        // Any other unique index (or no key at all) is not a retry, and is
        // not answered as one.
        if (
          !row.idempotencyKey ||
          (violation.constraint && !IDEMPOTENCY_KEY_CONSTRAINTS.has(violation.constraint))
        ) {
          throw error;
        }
        const live = await this.findLiveByIdempotencyKey(
          input.organizationId,
          input.agentId,
          row.idempotencyKey,
        );
        if (live) return this.resolveReplay(input, row.idempotencyKey, live);
        // The row that refused this insert left the index — voided, expired or
        // refunded — before it could be read back, so the key is free now and
        // the insert is tried once more. A second refusal with nothing live to
        // read is not a race any longer.
        if (attempt >= 1) {
          throw PaymentErrors.idempotencyKeyReused({ idempotencyKey: row.idempotencyKey });
        }
      }
    }

    return this.findById(input.organizationId, row.id as string);
  }

  private async insertRow(
    row: Partial<PaymentIntentEntity>,
    admission: VoucherAdmission | undefined,
  ): Promise<void> {
    if (admission) {
      await this.intents.insertAdmittedVoucherIntent(row, admission.scope, admission.admit);
    } else {
      await this.intents.insert(row);
    }
  }

  /**
   * The intent that holds this idempotency key — the one live row the partial
   * unique index arbitrates (`VOIDED`, `EXPIRED` and `REFUNDED` rows have
   * released it) — or null when the key is free.
   */
  async findLiveByIdempotencyKey(
    organizationId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntent | null> {
    const row = await this.intents.findOneBy({
      organizationId,
      agentId,
      idempotencyKey,
      status: Not(In([...IDEMPOTENCY_RELEASED_STATUSES])),
    });
    return row ? toPaymentIntent(row) : null;
  }

  /**
   * Whether an intent already spent this voucher `seq` for `account` — the
   * up-front replay read. `uq_payment_intents_account_voucher_seq` in
   * {@link create} stays the guarantee; this only lets a sequential replay be
   * refused with the right reason before anything is written.
   */
  async isVoucherSeqUsed(organizationId: string, account: string, seq: string): Promise<boolean> {
    return this.intents.existsBy({ organizationId, agentAccount: account, voucherSeq: seq });
  }

  /**
   * A rail-B intent whose funds could not be secured stops reserving its place
   * in the payer's windows (see `PaymentIntentRepository.insertAdmittedVoucherIntent`).
   */
  /**
   * The payer's open buyer debts (lapsed vouchers, hold still open), oldest
   * first — see `PaymentIntentRepository.findOutstandingDebts`.
   */
  async findOutstandingDebts(
    organizationId: string,
    payer: string,
    limit?: number,
  ): Promise<OutstandingDebt[]> {
    return this.intents.findOutstandingDebts(organizationId, payer, limit);
  }

  async abandonUnsecuredVoucher(organizationId: string, intentId: string): Promise<void> {
    await this.intents.abandonUnsecuredVoucherIntent(organizationId, intentId);
  }

  async findById(organizationId: string, intentId: string): Promise<PaymentIntent> {
    const row = await this.intents.findOneBy({ organizationId, id: intentId });
    if (!row) {
      throw PaymentErrors.paymentIntentNotFound({ id: intentId });
    }
    return toPaymentIntent(row);
  }

  /**
   * Takes one edge of the state machine, atomically.
   *
   * The table is consulted first, so an edge that does not exist never reaches
   * Postgres. The compare-and-swap then decides who takes an edge that does:
   * a zero-row update means the intent is no longer in `from`, which is either
   * a caller working from a stale read or a concurrent worker that got there
   * first. Both are `PAYMENT_INVALID_STATE_TRANSITION`, and the error names the
   * status the intent is actually in.
   */
  async transition(
    organizationId: string,
    intentId: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    context: PaymentIntentTransitionContext = {},
  ): Promise<PaymentIntent> {
    requirePaymentIntentTransition(from, to, { intentId });

    const affected = await this.intents.transitionIfInStatus(organizationId, intentId, from, to, {
      statusReason: context.reason ?? null,
      ...(context.holdId !== undefined ? { holdId: context.holdId } : {}),
      ...(context.providerId !== undefined ? { providerId: context.providerId } : {}),
      ...(context.bindingId !== undefined ? { bindingId: context.bindingId } : {}),
      ...(context.providerAccount !== undefined
        ? { providerAccount: context.providerAccount }
        : {}),
      ...(context.settledAmount !== undefined
        ? { settledAmount: context.settledAmount.amount }
        : {}),
      ...(context.charge !== undefined
        ? {
            priceAmount: context.charge.price.amount,
            providerAmount: MoneyUtil.subtract(context.charge.price, context.charge.platformFee)
              .amount,
            platformFee: context.charge.platformFee.amount,
          }
        : {}),
      ...(context.classification !== undefined ? { classification: context.classification } : {}),
      ...(context.verificationVerdict !== undefined
        ? { verificationVerdict: context.verificationVerdict }
        : {}),
      ...(context.lapseCause !== undefined
        ? { redemptionLapsedAt: new Date(), redemptionLastError: context.lapseCause }
        : {}),
      // Rail A's dispute hold (G3.B1): the provider's credit waits for the window.
      ...(context.holdForDispute
        ? {
            heldStatus: HELD,
            heldAt: () => 'now()',
            collectableAt: () => `now() + interval '${COLLECTION_HOLD_WINDOW_SECONDS} seconds'`,
          }
        : {}),
    });

    if (affected !== 1) {
      const current = await this.intents.findOneBy({ organizationId, id: intentId });
      if (!current) {
        throw PaymentErrors.paymentIntentNotFound({ id: intentId });
      }
      throw PaymentErrors.invalidStateTransition({
        intentId,
        from,
        to,
        actual: current.status,
      });
    }

    return this.findById(organizationId, intentId);
  }

  /**
   * Reserves the price against the agent's balance and moves the intent to
   * `FUNDS_SECURED` — the one edge whose `holdEffect` is `CREATE`.
   *
   * The hold is opened before the status moves, and released again if the move
   * is lost to a concurrent worker. The other order would publish
   * `FUNDS_SECURED` for funds that are not yet secured, which is the exact
   * claim the state is there to make.
   */
  async secureFunds(organizationId: string, intentId: string): Promise<PaymentIntent> {
    const intent = await this.findById(organizationId, intentId);

    const rule = requirePaymentIntentTransition(intent.status, PaymentIntentStatus.FUNDS_SECURED, {
      intentId,
    });

    // The chain decides whether this is affordable; the ledger's own
    // CHECK stays underneath as a backstop, not a replacement. Order matters:
    // this throws before any row is written, so an unaffordable call never
    // opens a hold it then has to release — the same argument
    // `McpToolCallService` makes for running the spend policy before this
    // method at all. Rail B is always priced against the chain; the
    // `ESCROW_SPEND_GATE_ENABLED` flag governs only the rail-A refusal — see
    // `EscrowSpendGateService`'s class comment.
    await this.escrowGate.assertAffordable(organizationId, intent.agentAccount, intent.price, {
      rail: intent.rail,
    });

    const hold = await this.ledger.createHold({
      organizationId,
      accountId: intent.agentAccount,
      money: intent.price,
      intentId,
      // Stamped, and **read by nothing** — see `PAYMENT_INTENT_HOLD_TTL_MS`.
      // It is the deadline a sweeper will use when one exists; it is not one
      // today, so nothing here may be written on the assumption that a hold
      // this call opens will come back on its own.
      expiresAt: new Date(Date.now() + PAYMENT_INTENT_HOLD_TTL_MS),
    });

    try {
      return await this.transition(organizationId, intentId, rule.from, rule.to, {
        holdId: hold.id,
        reason: PAYMENT_INTENT_FUNDS_SECURED_REASON,
      });
    } catch (error) {
      // The intent moved without us. Give the money back now — there is no
      // second chance to. `ledger_holds.expires_at` is written here and read by
      // nothing, so a hold that survives this line stays open until a
      // human closes it.
      await this.ledger.releaseHold(organizationId, hold.id).catch((releaseError: unknown) => {
        this.logger.error(
          `Intent ${intentId}: lost the FUNDS_SECURED race and could not release hold ${hold.id}; ` +
            `NOTHING will return it automatically — the money is stranded until this hold is ` +
            `released by hand. ${describe(releaseError)}`,
        );
      });
      throw error;
    }
  }

  /**
   * Takes an edge **and applies the money it moves.**
   *
   * `transition` deliberately does not: it moves the status and writes context,
   * and every rule carries a `holdEffect` that nothing reads. That was the
   * shape the transition table first shipped with, and it is the one thing
   * about the transition table most likely to mislead — the table *looks* like
   * it moves money because every rule names an effect. This is where the effect
   * is honoured, so that "settle this intent" is one call rather than a status
   * change plus a ledger call the caller has to remember, in the right order,
   * every time.
   *
   * `CREATE` is refused here on purpose. That edge is `secureFunds`, and it is
   * the one effect that must happen *before* the status moves — the hold is
   * what makes `FUNDS_SECURED` true, so opening it afterwards would publish the
   * claim before it held. Every other effect must happen after: the
   * compare-and-swap is what decides whether this caller owns the intent at
   * all, and money returned or taken before winning it is money moved for
   * somebody else's transition.
   *
   * ## What a failure leaves behind
   *
   * If the status moves and the ledger call then fails, the intent is terminal
   * with its hold still open, and this method throws so the caller knows the
   * money did not move.
   *
   * **Nothing repairs that, and there is no backstop underneath it.** This
   * comment used to say the hold's own 24-hour expiry would release it in the
   * agent's favour. It does not: `ledger_holds.expires_at` is written by
   * `LedgerHoldService.createHold` and mapped into a DTO, and no sweeper, cron
   * or query anywhere reads it. The expiry
   * sweep's repair pass is gated on `status = EXPIRED`, so it never sees a
   * terminal intent either. Money left here is stranded until somebody closes
   * the hold by hand.
   *
   * The one partial repair that does exist is
   * `VerificationSettlementService.repairHoldEffect`, and only for an intent
   * that reached a terminal state off `VERIFYING` while a worker was running.
   * A general repair pass over terminal intents with an unresolved hold —
   * and a sweeper that honours `expires_at` at all — remains unwritten.
   */
  async resolve(
    organizationId: string,
    intentId: string,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    context: PaymentIntentTransitionContext = {},
  ): Promise<PaymentIntent> {
    const rule = requirePaymentIntentTransition(from, to, { intentId });

    if (rule.holdEffect === HoldEffect.CREATE) {
      throw PaymentErrors.invalidStateTransition({
        intentId,
        from,
        to,
        actual: `${from} — this edge opens a hold and belongs to secureFunds()`,
      });
    }

    // A rail-B verdict too late for its voucher settles AS DEBT, in the same
    // statement as the status move (review-buyer-debt L3): written as two, a
    // redemption pass reading the row in between broadcast a voucher that was
    // then lapsed with a transaction in flight. Read first — the decision
    // needs the voucher's `expiresAt` — which costs one read per settle.
    let lapseCause: string | undefined;
    let holdForDispute = false;
    if (rule.holdEffect === HoldEffect.COMMIT && to === PaymentIntentStatus.SETTLED) {
      const current = await this.findById(organizationId, intentId);
      if (current.rail === PaymentRail.RAIL_B_VOUCHER && this.pastRedemptionLatest(current)) {
        lapseCause = LATE_VERDICT_LAPSE_CAUSE;
      }
      // Rail A settles through the facilitator at call time, so its dispute hold
      // (G3.B1) is the provider's ledger credit — and so its payout — withheld
      // for the window. Rail B's hold is on chain, at redemption.
      if (current.rail === PaymentRail.RAIL_A_PER_CALL) holdForDispute = true;
    }

    const intent = await this.transition(organizationId, intentId, from, to, {
      ...context,
      ...(lapseCause ? { lapseCause } : {}),
      ...(holdForDispute ? { holdForDispute } : {}),
    });

    if (rule.holdEffect === HoldEffect.NONE || !intent.holdId) {
      return intent;
    }

    if (rule.holdEffect === HoldEffect.RELEASE) {
      await this.releaseHold({ organizationId, id: intentId, holdId: intent.holdId });
      return this.findById(organizationId, intentId);
    }

    if (intent.rail === PaymentRail.RAIL_B_VOUCHER) {
      // The hold stays OPEN. On rail B the money is in the
      // buyer's escrow and it does not move until `redeem_voucher` lands, so
      // committing here would credit a provider out of a balance that is still
      // the buyer's — and put the mirror ahead of the chain in exactly the
      // direction `EscrowBalanceReader` refuses to spend against.
      //
      // `VoucherRedemptionService` is the only caller that retires it, through
      // `commitRedeemedHold` below, and it supplies the signature. Until then
      // `hold_released_at` stays null, which `repairHoldEffect` must read as
      // *awaiting redemption* rather than as a lost commit — see its own guard.
      //
      // Not when the verdict came too late for the voucher (review #2, M3;
      // review-buyer-debt M2): past `expiresAt +
      // PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS` — one redemption pass
      // before the chain's own deadline — no pass can collect it. The call was
      // served, so it is still SETTLED, as buyer debt at once (the lapse was
      // written with the status above): the hold stays open, nobody is
      // credited, and the buyer re-signs (never a platform payment). Earlier
      // than that the redemption job gets its chance, and lapses it itself if
      // the chain refuses.
      if (lapseCause) {
        this.logger.warn(
          `Intent ${intentId}: settled ${Math.floor(
            (Date.now() - intent.expiresAt.getTime()) / 1000,
          )}s after its voucher expired — too late to redeem; it is buyer debt`,
        );
      }
      return intent;
    }

    if (!intent.providerId || !intent.providerAccount) {
      // Two database CHECKs refuse this state —
      // `chk_payment_intents_paying_states_name_payee` for `provider_id` and
      // `chk_payment_intents_settled_names_payee` for `provider_account` — so
      // this is a defect somewhere upstream of the transition table, not a
      // condition a caller can hit through it.
      //
      // The second of those was added later. Before it existed the state was
      // reachable on every single rail-A call, and the throw landed *after* the
      // status had already moved — leaving the intent terminal with the agent's
      // money still held. Kept as a guard, not softened: it is now genuinely
      // unreachable, and if it ever fires again refusing to credit an unnamed
      // payee is right.
      throw PaymentErrors.providerNotAssigned({ intentId });
    }

    if (intent.heldStatus === HELD) {
      // Rail A, held for the dispute window (G3.B1): `HeldCollectionService`
      // credits the provider once it has passed, unless an upheld dispute
      // refunds the buyer from the uncredited amount.
      return intent;
    }

    await this.ledger.commitHoldAndCredit(organizationId, intent.holdId, {
      providerOrganizationId: intent.providerId,
      providerAccountId: intent.providerAccount as LedgerAccountId,
      providerAmount: intent.providerAmount,
      platformFee: intent.platformFee,
      intentId,
      chainTxRef: LEGACY_POOLED_VAULT_TX_REF,
    });
    await this.intents.update({ organizationId, id: intentId }, { holdReleasedAt: new Date() });

    return this.findById(organizationId, intentId);
  }

  /** Whether a rail-B voucher is past the latest it may settle and still be redeemed. */
  private pastRedemptionLatest(intent: PaymentIntent): boolean {
    return (
      Date.now() >
      intent.expiresAt.getTime() + PAYMENT_INTENT_VERDICT_DEADLINE_LATEST_SECONDS * 1000
    );
  }

  /**
   * Retires a rail-B hold because `redeem_voucher` landed.
   *
   * This is the **only** path that retires a rail-B hold. `resolve()` moves
   * such an intent to `SETTLED` and deliberately leaves the hold open, because
   * on rail B the buyer's money is in their own escrow until the redemption
   * confirms on chain.
   *
   * The signature is not decoration: it is what makes the `HOLD_COMMIT` a
   * statement about a transaction rather than about an intention, and it is
   * what the reconciler joins on when a buyer's escrow and the mirror
   * disagree.
   *
   * Idempotent twice over — once here, on `holdReleasedAt`, and once inside
   * the ledger, whose own `applied: false` refuses a second commit of the same
   * hold. A redemption pass that retries after a confirmation it did not
   * observe must not credit the provider twice.
   */
  async commitRedeemedHold(
    organizationId: string,
    intentId: string,
    chainTxRef: string,
  ): Promise<PaymentIntent> {
    const intent = await this.findById(organizationId, intentId);

    if (intent.rail !== PaymentRail.RAIL_B_VOUCHER) {
      // A rail-A hold was retired inline by `resolve()`. Committing it again
      // here would be a second credit for one call, and the ledger's own
      // idempotency would mask it as a no-op rather than reporting the defect.
      throw PaymentErrors.invalidStateTransition({
        intentId,
        from: intent.status,
        to: PaymentIntentStatus.SETTLED,
        actual: `${intent.rail} — only a rail-B hold is retired by a redemption`,
      });
    }

    if (intent.status !== PaymentIntentStatus.SETTLED) {
      // The verdict decides whether the provider is paid; the redemption only
      // decides when. An intent that has not settled has not been decided, and
      // redeeming its voucher would take the buyer's money for a call nothing
      // has passed.
      throw PaymentErrors.invalidStateTransition({
        intentId,
        from: intent.status,
        to: PaymentIntentStatus.SETTLED,
        actual: `${intent.status} — a redemption may only retire a SETTLED hold`,
      });
    }

    if (!intent.holdId || intent.holdReleasedAt !== null) {
      return intent;
    }
    if (intent.heldStatus === HELD) return intent;

    // Redeemed INTO THE HOLD (G3.B1)? Decided from the redemption's RECEIPT
    // (review P0-1): a `PaymentHeld` log — the money is in `held[payer][seq]`,
    // the buyer's ledger hold stays open and the provider is credited on
    // `HeldCollected`, never here; a bare `VoucherRedeemed` — the escrow paid
    // the provider at once (a redemption before the upgrade). Anything else is
    // retried: on a chain whose hold is live, a missing answer is never a
    // reason to credit the provider while the chain may still hold the money.
    if (this.held && intent.rail === PaymentRail.RAIL_B_VOUCHER && intent.voucherSeq) {
      const asset = intent.price.asset as AssetId;
      const decided = await this.held.classifyRedemption(
        asset,
        /^0x[0-9a-fA-F]{64}$/.test(chainTxRef) ? chainTxRef : null,
        { payer: intent.agentAccount, seq: intent.voucherSeq },
      );
      if (decided.kind === 'HELD') {
        await this.intents.markHeld(organizationId, intentId, new Date(), decided.collectableAt);
        return this.findById(organizationId, intentId);
      }
      if (decided.kind === 'UNKNOWN' && (await this.held.holdLive(asset))) {
        // Counted, and paged after a few passes (review P2-6 of the second pass):
        // a no-hash landing the logs cannot place needs a human.
        await this.intents.recordHeldFailure(organizationId, intentId, 'redemption unclassified');
        if ((intent.heldAttempts ?? 0) + 1 >= UNCLASSIFIED_PAGE_AFTER) {
          await this.alerts?.emit({
            severity: AlertSeverity.CRITICAL,
            name: 'redemption_unclassified',
            summary:
              `Intent ${intentId}: redeemed, but neither its receipt nor the escrow's logs say ` +
              `whether it was held — not credited; look it up on chain`,
            details: { intentId, seq: intent.voucherSeq ?? 'none' },
            aggregation: AlertAggregation.ONCE_PER_INCIDENT,
            dedupeKey: intentId,
          });
        }
        throw PaymentErrors.invalidStateTransition({
          intentId,
          from: intent.status,
          to: PaymentIntentStatus.SETTLED,
          actual: 'redeemed, but the receipt does not say yet whether it was held — retried',
        });
      }
    }

    if (!intent.providerId || !intent.providerAccount) {
      throw PaymentErrors.providerNotAssigned({ intentId });
    }

    await this.ledger.commitHoldAndCredit(organizationId, intent.holdId, {
      providerOrganizationId: intent.providerId,
      providerAccountId: intent.providerAccount as LedgerAccountId,
      providerAmount: intent.providerAmount,
      platformFee: intent.platformFee,
      intentId,
      chainTxRef,
    });
    await this.intents.update({ organizationId, id: intentId }, { holdReleasedAt: new Date() });

    return this.findById(organizationId, intentId);
  }

  /**
   * Releases the intent's hold and records that it happened.
   *
   * `releaseHold` is idempotent in the ledger, so a repeated call returns
   * `applied: false` rather than the money twice — which is what lets the
   * expiry sweep retry its own unfinished work without checking first.
   */
  async releaseHold(intent: {
    readonly organizationId: string;
    readonly id: string;
    readonly holdId: string;
  }): Promise<boolean> {
    const resolution = await this.ledger.releaseHold(intent.organizationId, intent.holdId);

    await this.intents.update(
      { organizationId: intent.organizationId, id: intent.id },
      { holdReleasedAt: new Date() },
    );

    return resolution.applied;
  }

  /**
   * Writes off one buyer debt (review-buyer-debt M1): the `uncollected:` mark
   * and the hold release commit together, in one ledger transaction under the
   * payer's admission lock, and only while the row is still exactly that debt
   * (`PaymentIntentRepository.markWrittenOff`). `false` — nothing marked,
   * nothing released — when it changed underneath: settled, replaced, or
   * written off already.
   *
   * The write-off ends the hold and the provider's wait. It does NOT end the
   * payer's refusal while the contract change is not shipped (H1 interim): see
   * `DEBT_REFUSING_SQL`.
   */
  async writeOffDebt(target: DebtCloseTarget, reason: string, before: Date): Promise<boolean> {
    const resolution = await this.ledger.releaseHoldIf(
      target.organizationId,
      target.holdId,
      (runner) => this.intents.markWrittenOff(runner, target, reason, before),
    );
    return resolution !== null;
  }

  /**
   * Voids a buyer debt whose verdict came back FAIL / REFUND / VOID after the
   * call had been settled as served and unverified (review-buyer-debt M2): the
   * hold is released (no-op if it was written off already), nobody is
   * credited, the buyer is not charged and its refusal ends. In one ledger
   * transaction under the payer's lock. `false` when the intent is not such a
   * debt — awaiting redemption normally, or its replacement is in flight.
   */
  async voidDebt(organizationId: string, intentId: string, outcome: string): Promise<boolean> {
    const intent = await this.findById(organizationId, intentId);
    if (
      intent.rail !== PaymentRail.RAIL_B_VOUCHER ||
      intent.status !== PaymentIntentStatus.SETTLED ||
      !intent.holdId
    ) {
      return false;
    }
    const target: DebtCloseTarget = {
      organizationId,
      id: intentId,
      payer: intent.agentAccount,
      holdId: intent.holdId,
    };
    const resolution = await this.ledger.releaseHoldIf(organizationId, intent.holdId, (runner) =>
      this.intents.markDebtVoided(runner, target, `${DEBT_VOIDED_PREFIX}${outcome}`),
    );
    if (resolution === null) return false;
    this.logger.warn(
      `Intent ${intentId}: judged ${outcome} after it had become buyer debt — the debt is ` +
        `voided: the hold is released, nobody is credited, the buyer is not charged`,
    );
    return true;
  }

  /** `held(payer, seq)` for a rail-B intent, or `null` when there is no chain hold. */
  async readHeldRecord(intent: PaymentIntent) {
    if (!this.held || intent.rail !== PaymentRail.RAIL_B_VOUCHER || !intent.voucherSeq) {
      return null;
    }
    return this.held.readHeld(intent.price.asset as AssetId, {
      payer: intent.agentAccount,
      seq: intent.voucherSeq,
    });
  }

  /**
   * Books a collected hold (G3.B1): `HOLD_COMMIT + PROVIDER_CREDIT +
   * PLATFORM_FEE` — the provider is credited now, on `HeldCollected` — then the
   * row (`held_status = 'COLLECTED'`). Both idempotent: a repeat writes nothing
   * twice. `txRef` is the collect transaction; rail A has none.
   */
  async bookHeldCollected(
    organizationId: string,
    intentId: string,
    txRef: string | null,
  ): Promise<PaymentIntent> {
    const intent = await this.findById(organizationId, intentId);
    if (!intent.holdId || intent.heldStatus !== HELD) return intent;
    if (!intent.providerId || !intent.providerAccount) {
      throw PaymentErrors.providerNotAssigned({ intentId });
    }
    await this.ledger.commitHoldAndCredit(organizationId, intent.holdId, {
      providerOrganizationId: intent.providerId,
      providerAccountId: intent.providerAccount as LedgerAccountId,
      providerAmount: intent.providerAmount,
      platformFee: intent.platformFee,
      intentId,
      chainTxRef:
        intent.rail === PaymentRail.RAIL_A_PER_CALL
          ? LEGACY_POOLED_VAULT_TX_REF
          : (txRef ?? `held_collected:seq=${intent.voucherSeq}`),
    });
    await this.intents.manager.transaction((manager) =>
      this.intents.markHeldCollected(
        manager,
        { organizationId, id: intentId, payer: intent.agentAccount },
        txRef,
      ),
    );
    return this.findById(organizationId, intentId);
  }

  /**
   * Refunds a call an upheld dispute holds (G3.B1). Rail B: reads the escrow's
   * record first — the job may have collected it in a race — then
   * `refundHeld`, and books the release only once the chain says `REFUNDED`.
   * Rail A: the provider was never credited, so the buyer's hold is released.
   * One `HOLD_RELEASE`, nobody credited. Returns what the money did.
   */
  async refundHeldForDispute(
    organizationId: string,
    intentId: string,
    outcome: string,
  ): Promise<'REFUNDED' | 'COLLECTED' | 'NOT_HELD' | 'TIMED_OUT'> {
    const intent = await this.findById(organizationId, intentId);
    if (!intent.holdId || intent.heldStatus !== HELD) {
      return intent.heldStatus === HELD_COLLECTED
        ? 'COLLECTED'
        : intent.heldStatus === HELD_REFUNDED
          ? 'REFUNDED'
          : 'NOT_HELD';
    }

    let txRef: string | null = null;
    if (intent.rail === PaymentRail.RAIL_B_VOUCHER) {
      const key = { payer: intent.agentAccount, seq: intent.voucherSeq as string };
      const asset = intent.price.asset as AssetId;
      let record = await this.readHeldRecord(intent);
      if (!record || !this.held) {
        throw PaymentErrors.invalidStateTransition({
          intentId,
          from: intent.status,
          to: PaymentIntentStatus.SETTLED,
          actual: 'held, but the escrow has no hold to refund',
        });
      }
      if (record.status === HeldStatus.COLLECTED) {
        await this.bookHeldCollected(organizationId, intentId, null);
        return 'COLLECTED';
      }
      if (
        record.status === HeldStatus.HELD &&
        Date.now() >= record.collectableAt.getTime() + HELD_TIMEOUT_SECONDS * 1000
      ) {
        // Past the chain's timeout `refundHeld` is closed and anyone may
        // collect, in the provider's favour. Nothing to send: the collection
        // job books the collect once it lands, and the SLA job pages.
        return 'TIMED_OUT';
      }
      if (record.status === HeldStatus.HELD) {
        txRef = (await this.held.refund(asset, [key])).txRef;
        record = await this.held.readHeld(asset, key);
      }
      if (record?.status !== HeldStatus.REFUNDED) {
        if (record?.status === HeldStatus.COLLECTED) {
          await this.bookHeldCollected(organizationId, intentId, null);
          return 'COLLECTED';
        }
        throw PaymentErrors.invalidStateTransition({
          intentId,
          from: intent.status,
          to: PaymentIntentStatus.SETTLED,
          actual: `refundHeld did not refund (${record?.status ?? 'unknown'}) — retried`,
        });
      }
    }

    const target: DebtCloseTarget = {
      organizationId,
      id: intentId,
      payer: intent.agentAccount,
      holdId: intent.holdId,
    };
    await this.ledger.releaseHoldIf(organizationId, intent.holdId, (runner) =>
      this.intents.markHeldRefunded(runner, target, `${DEBT_VOIDED_PREFIX}${outcome}`, txRef),
    );
    return 'REFUNDED';
  }

  /**
   * Opens a NEW hold for a written-off debt the buyer is re-signing (H1
   * interim): the write-off released the old one, and the redemption commits a
   * hold. Priced against the chain like any rail-B hold (`secureFunds`).
   * Returns its id; the caller hands it to `replaceLapsedVoucher` and releases
   * it again if the replacement is refused.
   */
  async reopenDebtHold(debt: OutstandingDebt): Promise<string> {
    const price = MoneyUtil.of(debt.priceAmount, debt.assetId as AssetId, debt.decimals);
    await this.escrowGate.assertAffordable(
      debt.organizationId,
      debt.agentAccount as AccountId,
      price,
      {
        rail: PaymentRail.RAIL_B_VOUCHER,
      },
    );
    const hold = await this.ledger.createHold({
      organizationId: debt.organizationId,
      accountId: debt.agentAccount as AccountId,
      money: price,
      intentId: debt.id,
      expiresAt: new Date(Date.now() + PAYMENT_INTENT_HOLD_TTL_MS),
    });
    return hold.id;
  }

  /** Releases a hold {@link reopenDebtHold} opened that no row took. */
  async releaseUnusedHold(organizationId: string, holdId: string): Promise<void> {
    await this.ledger.releaseHold(organizationId, holdId);
  }

  /**
   * The live row that refused the insert: the same request is a retry and
   * gets that intent back; another request under the same key is a collision.
   */
  private resolveReplay(
    input: CreatePaymentIntentInput,
    idempotencyKey: string,
    existing: PaymentIntent,
  ): PaymentIntent {
    if (existing.requestHash !== input.requestHash) {
      throw PaymentErrors.idempotencyKeyReused({
        idempotencyKey,
        expected: existing.requestHash,
        actual: input.requestHash,
      });
    }

    return existing;
  }
}

export function toPaymentIntent(row: PaymentIntentEntity): PaymentIntent {
  const asset = row.assetId as AssetId;
  const money = (amount: string) => MoneyUtil.of(amount, asset, row.decimals);

  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as PaymentIntentStatus,
    statusReason: row.statusReason,
    agentId: row.agentId,
    agentAccount: row.agentAccount as AccountId,
    providerId: row.providerId,
    providerAccount: row.providerAccount as AccountId | null,
    toolId: row.toolId,
    bindingId: row.bindingId,
    rail: row.rail as PaymentRail,
    callId: row.callId,
    callClass: row.callClass as PaymentIntentCallClass,
    price: money(row.priceAmount),
    providerAmount: money(row.providerAmount),
    platformFee: money(row.platformFee),
    settledAmount: row.settledAmount === null ? null : money(row.settledAmount),
    requestHash: row.requestHash,
    chainId: row.chainId as ChainId,
    expiresAt: row.expiresAt,
    idempotencyKey: row.idempotencyKey,
    voucherNonce: row.voucherNonce,
    voucherSeq: row.voucherSeq,
    voucherSignature: row.voucherSignature ?? null,
    voucherResourceHash: row.voucherResourceHash ?? null,
    voucherIssuedAt: row.voucherIssuedAt === null ? null : Number(row.voucherIssuedAt),
    voucherDelegate: row.voucherDelegate ?? null,
    credentialId: row.credentialId ?? null,
    holdId: row.holdId,
    holdReleasedAt: row.holdReleasedAt,
    collectableAt: row.collectableAt ?? null,
    disputeOutcome: row.disputeOutcome ?? null,
    heldStatus: row.heldStatus ?? null,
    heldAt: row.heldAt ?? null,
    heldAttempts: row.heldAttempts ?? 0,
    classification: row.classification,
    verificationVerdict: row.verificationVerdict,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
