import {
  CHAIN_STATE_GATE,
  ChainDoor,
  ChainStateGatePort,
} from '@modules/chains/ports/chain-state-gate.port';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import {
  OpenVoucherTotals,
  PaymentIntentRepository,
  VoucherAdmissionScope,
} from '@database/postgres/repositories/payment-intent.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { LedgerAccountId, LEGACY_POOLED_VAULT_TX_REF } from '@modules/ledger/ports/ledger.types';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  PAYMENT_INTENT_FUNDS_SECURED_REASON,
  PAYMENT_INTENT_HOLD_TTL_MS,
  PAYMENT_INTENT_TTL_MS,
} from '../constants/payment-intent.constants';
import { HoldEffect, requirePaymentIntentTransition } from '../domain/payment-intent-transitions';
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
      voucherIssuedAt: input.voucherIssuedAt === undefined ? null : String(input.voucherIssuedAt),
      voucherDelegate: input.voucherDelegate ?? null,
      credentialId: input.credentialId ?? null,
      holdId: null,
      holdReleasedAt: null,
      classification: null,
      verificationVerdict: null,
    };

    try {
      if (admission) {
        await this.intents.insertAdmittedVoucherIntent(row, admission.scope, admission.admit);
      } else {
        await this.intents.insert(row);
      }
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
      if (!row.idempotencyKey) {
        throw error;
      }
      return this.resolveReplay(input, row.idempotencyKey);
    }

    return this.findById(input.organizationId, row.id as string);
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

    const intent = await this.transition(organizationId, intentId, from, to, context);

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

  private async resolveReplay(
    input: CreatePaymentIntentInput,
    idempotencyKey: string,
  ): Promise<PaymentIntent> {
    const existing = await this.intents.findOneBy({
      organizationId: input.organizationId,
      agentId: input.agentId,
      idempotencyKey,
    });

    if (!existing) {
      // The unique violation came from some other index. Do not pretend the
      // request was a replay of something we cannot find.
      throw PaymentErrors.idempotencyKeyReused({ idempotencyKey });
    }

    if (existing.requestHash !== input.requestHash) {
      throw PaymentErrors.idempotencyKeyReused({
        idempotencyKey,
        expected: existing.requestHash,
        actual: input.requestHash,
      });
    }

    return toPaymentIntent(existing);
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
    classification: row.classification,
    verificationVerdict: row.verificationVerdict,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
