import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, AssetId, ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { FACILITATOR_PORT, FacilitatorPort } from '@modules/chains/ports/facilitator.port';
import { Money } from '@modules/chains/ports/money.types';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { AuditActor, AuditLogWriter } from '@shared/audit';
import { DepositOwnerScope } from '@shared/auth/deposit-owner-scope';
import {
  CHAIN_STATE_GATE,
  ChainDoor,
  ChainStateGatePort,
} from '@modules/chains/ports/chain-state-gate.port';
import {
  ObservedTransfer,
  PaymentIntent as ChainPaymentIntent,
  PaymentPayload,
  PaymentRequirements,
  TxRef,
} from '@modules/chains/ports/x402.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import {
  DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT,
  DEPOSIT_OBSERVE_POLL_MS,
  DEPOSIT_OBSERVE_TIMEOUT_MS,
  DEPOSIT_SETTLING_GIVE_UP_MS,
  DEPOSIT_SETTLING_RESUME_BUDGET_MS,
  DEPOSIT_SETTLING_STALE_MS,
  DEPOSIT_UNCOVERED_ALERT_AFTER_MS,
  DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS,
  DEPOSIT_TX_BOUND_LOOKBACK_MS,
  DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS,
  depositResource,
} from '../constants/deposit-intent.constants';
import { assertDepositAssetIsSettlementAsset } from '../domain/deposit-asset';
import { assertDepositScheme } from '../domain/deposit-wire';
import { throwForX402InvalidReason } from '../domain/x402-error-mapping';
import { PaymentErrors } from '../errors/payment.errors';
import { DEPOSIT_MINIMUM_USD } from '../constants/deposit-intent.constants';
import {
  CreateDepositIntentInput,
  DepositIntent,
  DepositIntentStatus,
} from '../ports/deposit.types';
import { ESCROW_OPENER, EscrowOpenerPort } from '../ports/escrow-opener.port';
import { DepositIntentService } from './deposit-intent.service';

/**
 * The two remote reads `buildRequirements` needs, resolved once per request —
 * the buyer's own escrow token account in place of the pooled
 * vault's, and the facilitator's fee payer.
 */
interface RequirementDeps {
  readonly escrowTokenAccount: AccountId;
  /**
   * `null` on a chain that does not separate the payer from the fee payer —
   * `ChainAdapter.requiresFeePayer`. Not "unknown": the chain has no such
   * account, and the adapter that needs one refuses a `null`.
   */
  readonly feePayer: AccountId | null;
}

export interface CreateDepositResult {
  readonly intent: DepositIntent;
  readonly requirements: PaymentRequirements;
}

/** `createDeposit`'s input — `amount` in place of `CreateDepositIntentInput.requestedAmount`. */
export type CreateDepositInput = Omit<CreateDepositIntentInput, 'expiresAt' | 'requestedAmount'> & {
  readonly amount: Money;
  /** Who asked, when it is an agent credential: audited (`deposit.intent_created`). */
  readonly caller?: DepositCaller | null;
};

/**
 * An agent credential acting on a deposit: the audit actor and the credential
 * it presented. An agent can hold several keys and an OAuth grant, and
 * `deposit_intents` records only the agent, so the audit row is what names
 * the key after an incident. `null` for a person's session.
 */
export interface DepositCaller {
  readonly actor: AuditActor;
  readonly credentialId: string | null;
}

/** What the chain said about a reported transaction, as the deposit path reads it. */
type Landed =
  | { readonly kind: 'pending' }
  | { readonly kind: 'no_credit' }
  | {
      readonly kind: 'credited';
      readonly transfer: ObservedTransfer;
      /** `null` where the adapter cannot tell (no `observeDeposit`). */
      readonly blockTime: Date | null;
    }
  /** Every read failed or hung until the deadline: unknown, never "not there". */
  | { readonly kind: 'unavailable'; readonly error: unknown };

/**
 * The x402 `exact` gasless deposit path.
 *
 * ```text
 * create deposit intent (id -> memo)
 *   -> ensure the buyer's escrow is OPEN (opens it, fee payer advances rent, if absent)
 *   -> build PaymentRequirements  (payTo = the buyer's own escrow ATA, extra.feePayer = facilitator, extra.memo = intent id)
 *   -> client returns a partially-signed base64 VersionedTransaction
 *   -> assertPayloadBoundToIntent  (memo === deposit intent id)
 *   -> FacilitatorPort.verify
 *   -> FacilitatorPort.settle          <- facilitator signs as feePayer and pays gas
 *   -> observe on-chain amount, credit the LEDGER
 * ```
 *
 * Per-buyer escrows move the destination from the pooled Squads vault to the
 * buyer's own `["escrow", buyer]` ATA. The wire shape a client builds against does
 * not change at all — `payTo` was always "the address the facilitator checks
 * the `TransferChecked` destination against"; only where that address points
 * changes.
 *
 * Every chain-shaped step goes through `ChainAdapterRegistry` and the ports
 * — this class never imports `@solana/*` and never will, even though today
 * there is exactly one chain behind those ports.
 */
@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private readonly deposits: DepositIntentService,
    private readonly registry: ChainAdapterRegistry,
    @Inject(FACILITATOR_PORT) private readonly facilitator: FacilitatorPort,
    @Inject(ESCROW_OPENER) private readonly opener: EscrowOpenerPort,
    @Inject(ESCROW_BALANCE_READER) private readonly escrowReader: EscrowBalanceReaderPort,
    private readonly escrows: BuyerEscrowRepository,
    private readonly ledger: LedgerService,
    // The ON-CHAIN pause and blocklist (D-19), asked before the escrow mirror
    // row and the intent row are written: a refused deposit leaves neither.
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
    // Bookkeeping only (`recordAfterCommit` never throws): which key opened or
    // reported a deposit.
    @Optional() private readonly audit: AuditLogWriter | null = null,
    // Optional for the same reason: the "stuck SETTLING needs review" alert.
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /** In-process guard: one `resumeStuckSettling` pass at a time (M-1, round 3). */
  private resuming = false;

  /** When this process last alerted each stuck `SETTLING` intent with no transaction. */
  private readonly reviewAlertedAt = new Map<string, number>();

  /**
   * Creates the intent and the `402` requirements a client builds a payload
   * against. The chain's settlement asset only, refused before the intent row
   * is even written.
   *
   * ## Why both remote reads happen before the row is written
   *
   * A `CREATED` deposit intent is not an inert draft: the funding
   * screen lists it as "Awaiting transfer" until the expiry sweep moves it.
   * Writing it first and then failing on `ensureEscrow` or `getFeePayer`
   * answers the caller `503` (or `409`) while leaving a deposit the buyer
   * never started — the request errors and the screen changes anyway.
   *
   * So every call that can fail for a reason outside this request runs first,
   * and the write is last. What remains after it — `buildPaymentRequirements`
   * — is local computation over values already in hand (the escrow ATA is a
   * PDA derivation, not an RPC read), so it cannot fail for a transient
   * reason.
   *
   * The controller's blockhash read is still after this and still leaves a row
   * behind on failure.
   */
  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    assertDepositAssetIsSettlementAsset(input.chainId, input.amount.asset);
    const minimum = 10n ** BigInt(input.amount.decimals) * BigInt(DEPOSIT_MINIMUM_USD);
    if (BigInt(input.amount.amount) < minimum) {
      throw PaymentErrors.depositBelowMinimum({
        minimumUsd: DEPOSIT_MINIMUM_USD,
        minimum: minimum.toString(),
      });
    }

    // Before any chain read or write: an agent at its cap costs nothing more.
    const open = await this.deposits.countOpenForAgent(input.organizationId, input.agentId);
    if (open >= DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT) {
      throw PaymentErrors.depositOpenLimit({ limit: DEPOSIT_MAX_OPEN_INTENTS_PER_AGENT });
    }

    // H-1 pre-flight (round 3): this account already has a deposit held
    // pending because its escrow holds less than the ledger claims. Every new
    // deposit would be held pending too (the coverage check is the whole
    // claim), so tell the buyer now, before they send money. New intents
    // only: reporting a transaction for an existing intent is never refused
    // here.
    if (
      await this.deposits.hasUncoveredPendingSince(
        input.agentAccount,
        new Date(Date.now() - DEPOSIT_UNCOVERED_ALERT_AFTER_MS),
      )
    ) {
      throw PaymentErrors.depositEscrowShortfall();
    }

    const deps = await this.resolveRequirementDeps(
      input.organizationId,
      input.agentAccount,
      input.chainId,
      input.amount.asset,
    );

    const intent = await this.deposits.create({
      organizationId: input.organizationId,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      requestedAmount: input.amount,
      chainId: input.chainId,
    });

    const requirements = await this.buildRequirements(intent, deps);

    if (input.caller) {
      await this.recordCallerAudit(intent, input.caller, 'deposit.intent_created', {
        requestedAmount: intent.requestedAmount.amount,
      });
    }

    return { intent, requirements };
  }

  /**
   * Verifies and settles the client's payload, then credits the ledger for
   * the amount actually observed on chain.
   *
   * Idempotent: an intent already `SETTLED` is returned as-is, with no second
   * call to the facilitator and no second ledger credit — the deposit intent
   * row is the durable guard against a double credit. A `SETTLING` intent (a
   * concurrent call already in flight, or a genuinely wedged one) is a
   * conflict, not silently retried, because retrying here would mean calling
   * `/settle` a second time for a payload that may already have landed.
   */
  async settleDeposit(
    scope: DepositOwnerScope,
    intentId: string,
    payload: PaymentPayload,
  ): Promise<DepositIntent> {
    const { organizationId } = scope;
    const intent = await this.deposits.findById(scope, intentId);

    if (intent.status === DepositIntentStatus.SETTLED) {
      return intent;
    }
    if (intent.status !== DepositIntentStatus.CREATED) {
      throw PaymentErrors.depositInvalidStateTransition({
        intentId,
        from: DepositIntentStatus.CREATED,
        to: DepositIntentStatus.SETTLING,
        actual: intent.status,
      });
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      throw PaymentErrors.depositIntentExpired({
        id: intentId,
        expiresAt: intent.expiresAt.toISOString(),
      });
    }

    // Scheme, then network (inside `assertPayloadBoundToIntent`), then the
    // payload: a wrong scheme is named as such, not as undecodable bytes.
    assertDepositScheme(payload.scheme);

    const adapter = this.registry.resolve(intent.chainId);
    // Pure PDA derivation — no RPC, and by settle time the escrow already
    // exists (`createDeposit` opened it). `escrowPda` is the OWNER `toChainIntent`
    // needs (matched against the observed transfer's token-account owner);
    // `escrowTokenAccount` is the ATA `buildRequirements` needs.
    const { escrowPda, escrowTokenAccount } = await this.escrowReader.escrowAddresses(
      intent.agentAccount,
      intent.requestedAmount.asset,
    );
    const asChainIntent = this.toChainIntent(intent, escrowPda);

    // Binding before anything else reaches the facilitator — an unbound
    // payload proves nothing about *this* intent. This is also what rejects
    // "memo missing", "memo belongs to a different intent", "two memos" and
    // "wrong network" without a single extra line here: the adapter already
    // enforces all four.
    adapter.assertPayloadBoundToIntent(payload, asChainIntent);

    const requirements = await this.buildRequirements(intent, {
      escrowTokenAccount,
      feePayer: adapter.requiresFeePayer
        ? await this.facilitator.getFeePayer(intent.chainId)
        : null,
    });

    const verifyResult = await this.facilitator.verify(payload, requirements);
    if (!verifyResult.isValid) {
      throwForX402InvalidReason(verifyResult.invalidReason);
    }

    await this.deposits.transition(
      organizationId,
      intentId,
      DepositIntentStatus.CREATED,
      DepositIntentStatus.SETTLING,
      { reason: 'facilitator verify passed' },
    );

    const settleResult = await this.facilitator.settle(payload, requirements);
    if (!settleResult.success || !settleResult.transaction) {
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        { reason: settleResult.errorReason ?? 'facilitator settle reported failure' },
      );
      throwForX402InvalidReason(settleResult.errorReason);
    }

    return this.recordFacilitatorSettlement(
      organizationId,
      intent,
      adapter,
      asChainIntent,
      canonicalTxRef(adapter, settleResult.transaction),
      settleResult.payer ?? intent.agentAccount,
    );
  }

  /**
   * Settles a deposit the BUYER broadcast, given only its transaction hash
   * ("option B").
   *
   * Injected wallets — MetaMask, Rabby and nearly every other — implement
   * `eth_sendTransaction` and NOT `eth_signTransaction`, so the signed-unsent
   * payload `settleDeposit` needs can never come from them. They send
   * `depositFor` themselves and hand the platform the hash.
   *
   * Nothing the client says is trusted. The hash is only a pointer, and every
   * check below runs BEFORE the intent moves or anything is recorded, so a
   * refused claim (wrong hash, someone else's hash, not mined yet, an RPC
   * failure) reserves nothing and burns nothing: the intent stays `CREATED`
   * and can be reported again, and the hash stays claimable by its buyer.
   *
   * 1. Single use, per (transaction, buyer), across the whole platform
   *    (`findClaimOfTxRef`; `uq_ledger_entries_deposit_pending_account` closes
   *    the race behind it).
   * 2. The chain is read (`observeDeposit`): only escrow `Deposited` events
   *    crediting THIS intent's buyer count, summed; a mined transaction that
   *    credits nobody is refused at once, without polling.
   * 3. Bound in time: a transaction mined before the earliest unsettled
   *    intent of this buyer in the last day (beyond
   *    {@link DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS}) is a deposit made outside
   *    every intent, whose money may have been withdrawn since.
   * 4. At least the requested amount (`extractSettledAmount`).
   *
   * Whether the money is STILL in the escrow is not asked here. The credit is
   * written as `DEPOSIT_PENDING`, which is never spendable, and only
   * `DepositFinalityService` makes it spendable, after checking that the
   * buyer's escrow covers it (H-1). Refusing an uncovered claim here instead
   * lost real deposits: the buyer's money had moved, the intent expired while
   * every report answered "not covered", and the hash could then never be
   * claimed. Recording it binds the hash to this intent; finality holds it
   * and alerts until the escrow covers it.
   * Refused on a chain that needs the platform as fee payer (Solana): no buyer
   * can broadcast there alone, so a hash-only claim has no honest producer.
   */
  async settleDepositByBroadcast(
    scope: DepositOwnerScope,
    intentId: string,
    transaction: TxRef,
    caller: DepositCaller | null = null,
  ): Promise<DepositIntent> {
    const { organizationId } = scope;
    // Scope the read before the settled fast path: completed intents must
    // not disclose another agent's deposit either.
    const intent = await this.deposits.findById(scope, intentId);
    const adapter = this.registry.resolve(intent.chainId);
    // One transaction, one spelling. An EVM hash is case-insensitive hex — the
    // node returns the same receipt for `0xabc…` and `0xABC…` — but the claim
    // lookup and both single-use indexes compare `chain_tx_ref` byte for byte.
    // Left raw, every case variant of one real deposit passed all three and was
    // credited again. Canonicalize before anything reads or writes the hash.
    // Only EVM: a Solana signature is base58, where case is significant.
    transaction = canonicalTxRef(adapter, transaction);

    if (intent.status === DepositIntentStatus.SETTLED) {
      // Idempotent for the hash that settled it; a different one would be
      // told "settled" while its own deposit stays uncredited.
      if (intent.chainTxRef === transaction) {
        return intent;
      }
      throw PaymentErrors.depositAlreadySettled({ id: intentId });
    }
    if (intent.status !== DepositIntentStatus.CREATED) {
      throw PaymentErrors.depositInvalidStateTransition({
        intentId,
        from: DepositIntentStatus.CREATED,
        to: DepositIntentStatus.SETTLING,
        actual: intent.status,
      });
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      throw PaymentErrors.depositIntentExpired({
        id: intentId,
        expiresAt: intent.expiresAt.toISOString(),
      });
    }

    if (adapter.requiresFeePayer || !adapter.observeDeposit) {
      throw PaymentErrors.depositBroadcastUnsupported({ chainId: intent.chainId });
    }

    // A hash that cannot exist is the caller's mistake, refused before the
    // chain is read: `0xdeadbeef` was polled for the whole observation window
    // and then failed the intent (BUG-PROD-BUY-MONEY-02).
    assertWellFormedTxRef(adapter, transaction);

    await this.assertTxUnclaimed(intent, transaction);

    const { escrowPda } = await this.escrowReader.escrowAddresses(
      intent.agentAccount,
      intent.requestedAmount.asset,
    );
    const asChainIntent = this.toChainIntent(intent, escrowPda);

    const landed = await this.observeOnceLanded(adapter, asChainIntent, transaction);
    switch (landed.kind) {
      case 'unavailable':
        // Unknown is not "not there": nothing is failed or burned, retry.
        throw landed.error;
      case 'pending':
        throw PaymentErrors.depositTransferNotObserved({ transaction, failed: false });
      case 'no_credit':
        throw PaymentErrors.depositTransactionCreditsNothing({ transaction });
    }

    const minedAt = landed.blockTime;
    const bound = await this.txTimeBound(intent);
    if (!minedAt || minedAt.getTime() < bound.getTime()) {
      this.logger.warn(
        `Deposit ${intent.id}: transaction ${transaction} mined at ` +
          `${minedAt?.toISOString() ?? 'an unknown time'}, before ${bound.toISOString()} ` +
          `(the buyer's earliest unsettled intent, less the clock skew) — refused`,
      );
      throw PaymentErrors.depositTransactionPredatesIntent({ transaction });
    }

    // Throws on an underpayment, a wrong asset or network: refused, the intent
    // stays open for the right transaction.
    const settledMoney = adapter.extractSettledAmount(asChainIntent, {
      transaction,
      network: intent.chainId,
      payer: intent.agentAccount,
      observed: landed.transfer,
    });

    await this.deposits.transition(
      organizationId,
      intentId,
      DepositIntentStatus.CREATED,
      DepositIntentStatus.SETTLING,
      { reason: 'buyer broadcast; observed on chain', submittedTxRef: transaction },
    );

    const settled = await this.creditAndSettle(organizationId, intent, settledMoney, transaction);
    if (caller) {
      await this.recordCallerAudit(settled, caller, 'deposit.reported', {
        transactionHash: transaction,
        settledAmount: settledMoney.amount,
      });
    }
    return settled;
  }

  /**
   * The earliest a reported transaction may have been mined: the creation of
   * this buyer's earliest intent that never settled (`CREATED`, `EXPIRED`,
   * `FAILED`) in the last {@link DEPOSIT_TX_BOUND_LOOKBACK_MS}, less
   * {@link DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS}. Not just this intent's: the
   * portal re-reports a hash on a fresh intent after the first one expired,
   * and that deposit was made inside the first one (M-2). `intent` itself is
   * `CREATED`, so the bound is never later than its own.
   */
  private async txTimeBound(intent: DepositIntent): Promise<Date> {
    const earliest = await this.deposits.earliestUnsettledCreatedAt(
      intent.agentAccount,
      new Date(Date.now() - DEPOSIT_TX_BOUND_LOOKBACK_MS),
    );
    const anchor = Math.min(earliest?.getTime() ?? Infinity, intent.createdAt.getTime());
    return new Date(anchor - DEPOSIT_TX_MAX_AGE_BEFORE_INTENT_MS);
  }

  /**
   * Refuses a transaction that already credited this intent's buyer, through
   * any deposit of any organization. The answer names no other intent; the id
   * goes to the server log only.
   */
  private async assertTxUnclaimed(intent: DepositIntent, transaction: TxRef): Promise<void> {
    const claimed = await this.deposits.findClaimOfTxRef(transaction, intent.agentAccount);
    if (claimed && claimed.intentId !== intent.id) {
      this.logger.warn(
        `Deposit ${intent.id}: transaction ${transaction} already credited ` +
          `${intent.agentAccount} through ${claimed.intentId ?? 'a ledger entry with no intent'}`,
      );
      throw PaymentErrors.depositTransactionAlreadyClaimed({ transaction });
    }
  }

  /**
   * SETTLING → SETTLED (or FAILED) after the facilitator broadcast: observe the
   * transfer, take the amount the chain moved, and credit `DEPOSIT_PENDING`.
   *
   * The intent is already `SETTLING` here (the payload went to the facilitator
   * and may have landed), so the outcomes are:
   * - not observed in the window, or observed crediting nobody: `FAILED`;
   * - the chain could not be read: left `SETTLING` (with the transaction
   *   recorded) and answered `503` — the transaction may well have landed,
   *   and failing the intent on an RPC blip is what M-2 forbids. The finality
   *   job resumes it (`resumeStuckSettling`);
   * - observed: credited `DEPOSIT_PENDING`, then `SETTLED`. Pending is never
   *   spendable; `DepositFinalityService` makes it spendable only once the
   *   buyer's escrow covers it (H-1).
   */
  private async recordFacilitatorSettlement(
    organizationId: string,
    intent: DepositIntent,
    adapter: ChainAdapter,
    asChainIntent: ChainPaymentIntent,
    transaction: TxRef,
    payer: AccountId,
  ): Promise<DepositIntent> {
    const intentId = intent.id;
    // Before anything can fail: a request that dies past this point leaves a
    // SETTLING intent the finality job can still resume. Never fatal (L-3,
    // round 3): the facilitator already moved the money, and this request can
    // still credit it; aborting here is what used to strand it. Retried
    // briefly; if the store still fails, the intent goes on without it, and a
    // SETTLING intent with no recorded transaction is never failed by the
    // resume job (it is left for operator review).
    await this.recordSubmittedTxBestEffort(organizationId, intentId, transaction);
    const fail = (reason: string) =>
      this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        // The signature goes in the REASON, not in `chainTxRef`.
        // `chk_deposit_intents_settlement_pair` is
        // `(settled_amount IS NULL) = (chain_tx_ref IS NULL)` — the two
        // columns are one fact, "this is the transaction that settled it, and
        // this is what it moved". A failed intent settled nothing. (Found
        // live: setting one without the other threw the CHECK violation
        // instead of the real error and left the intent SETTLING forever.)
        { reason },
      );

    // Never trust the requested amount — the SVM `exact` scheme tolerates
    // overpayment, and only the chain says what actually moved.
    const landed = await this.observeOnceLanded(adapter, asChainIntent, transaction);
    switch (landed.kind) {
      case 'unavailable':
        this.logger.error(
          `Deposit ${intentId}: chain unreadable after the facilitator settled ${transaction}; ` +
            `left SETTLING for the finality job — ${describe(landed.error)}`,
        );
        throw landed.error;
      case 'pending':
        await fail(`settlement reported success but no transfer was observed on ${transaction}`);
        throw PaymentErrors.depositTransferNotObserved({ transaction, failed: true });
      case 'no_credit':
        await fail(`transaction ${transaction} credits this buyer nothing`);
        throw PaymentErrors.depositTransactionCreditsNothing({ transaction });
    }

    let settledMoney: Money;
    try {
      settledMoney = adapter.extractSettledAmount(asChainIntent, {
        transaction,
        network: intent.chainId,
        payer,
        observed: landed.transfer,
      });
    } catch (error) {
      await fail(`settled amount rejected on ${transaction}: ${describe(error)}`);
      throw error;
    }

    return this.creditAndSettle(organizationId, intent, settledMoney, transaction);
  }

  /**
   * Resumes `SETTLING` intents no live request owns any more (untouched for
   * {@link DEPOSIT_SETTLING_STALE_MS}), from the finality job. Without it, a
   * chain read that failed after the facilitator settled (M-1), or a request
   * that died between the credit and `SETTLED` (L-7), left the intent
   * `SETTLING` forever, the money in the escrow and nothing credited.
   *
   * Per intent, one chain read, never a wait:
   * - its `DEPOSIT_PENDING` is already written: finish `SETTLED`;
   * - the transaction credits the buyer: credit and settle, through the same
   *   `creditAndSettle` (the claim index still applies);
   * - it credits nobody: `FAILED`;
   * - no receipt yet: wait, and fail after {@link DEPOSIT_SETTLING_GIVE_UP_MS};
   * - no transaction recorded: wait; past the give-up delay, never failed but
   *   alerted for operator review (`flagForReview`);
   * - the chain cannot be read: skipped, retried next pass.
   *
   * Batch rows with a recorded transaction first, and the pass stops at
   * {@link DEPOSIT_SETTLING_RESUME_BUDGET_MS}.
   */
  async resumeStuckSettling(limit: number): Promise<{ checked: number; resolved: number }> {
    // One pass at a time in this process (M-1, round 3): during an RPC outage
    // a pass lasts up to the budget, and a second one would only read the same
    // intents again against the failing endpoint.
    if (this.resuming) return { checked: 0, resolved: 0 };
    this.resuming = true;
    try {
      const now = Date.now();
      const stuck = await this.deposits.findStaleSettling(
        new Date(now - DEPOSIT_SETTLING_STALE_MS),
        limit,
      );
      let resolved = 0;
      let checked = 0;
      for (const intent of stuck) {
        if (Date.now() - now >= DEPOSIT_SETTLING_RESUME_BUDGET_MS) break;
        checked += 1;
        try {
          if (await this.resumeOne(intent, now)) resolved += 1;
        } catch (error) {
          this.logger.warn(
            `Deposit ${intent.id}: resuming SETTLING failed, retried next pass — ${describe(error)}`,
          );
        }
      }
      return { checked, resolved };
    } finally {
      this.resuming = false;
    }
  }

  /**
   * A stuck `SETTLING` intent with no recorded transaction and no credit,
   * past the give-up delay (L-2 / L-3, round 3). Never failed automatically:
   * with no hash nothing can tell "never landed" from "landed and the request
   * died before recording it" (every intent stuck before this code shipped
   * looks like this, and an embedded-wallet buyer cannot re-report a hash it
   * never saw), and failing one strands a possibly real deposit. Left
   * `SETTLING` for an operator, alerted once a day per intent.
   */
  private async flagForReview(intent: DepositIntent, now: number): Promise<void> {
    const last = this.reviewAlertedAt.get(intent.id);
    if (last !== undefined && now - last < DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS * 1000) return;
    this.reviewAlertedAt.set(intent.id, now);
    this.logger.warn(
      `Deposit ${intent.id}: SETTLING since ${intent.updatedAt.toISOString()} with no recorded ` +
        `transaction and no credit — left for operator review, not failed`,
    );
    await this.alerts
      ?.emit({
        severity: AlertSeverity.WARN,
        name: 'deposit_settling_needs_review',
        summary:
          `Deposit ${intent.id} for ${intent.agentAccount} has been SETTLING since ` +
          `${intent.updatedAt.toISOString()} with no recorded transaction and no ledger credit. ` +
          `It is not failed automatically: find the facilitator transaction (or confirm none ` +
          `landed) before crediting or failing it.`,
        details: {
          organizationId: intent.organizationId,
          intentId: intent.id,
          account: intent.agentAccount,
          requestedAmount: intent.requestedAmount.amount,
          settlingSince: intent.updatedAt.toISOString(),
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: intent.id,
        suppressionWindowSeconds: DEPOSIT_UNCOVERED_ALERT_WINDOW_SECONDS,
      })
      .catch((error) =>
        this.logger.warn(`deposit_settling_needs_review alert failed: ${describe(error)}`),
      );
  }

  /** `recordSubmittedTx`, retried, never throwing (see `recordFacilitatorSettlement`). */
  private async recordSubmittedTxBestEffort(
    organizationId: string,
    intentId: string,
    transaction: TxRef,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.deposits.recordSubmittedTx(organizationId, intentId, transaction);
        return;
      } catch (error) {
        if (attempt >= SUBMITTED_TX_STORE_ATTEMPTS) {
          this.logger.error(
            `Deposit ${intentId}: could not record submitted transaction ${transaction} ` +
              `(${describe(error)}); continuing to credit it`,
          );
          return;
        }
        await sleep(SUBMITTED_TX_STORE_RETRY_MS * attempt);
      }
    }
  }

  /** One stuck intent; `true` when it left `SETTLING`. Throws on an unreadable chain. */
  private async resumeOne(intent: DepositIntent, now: number): Promise<boolean> {
    const { organizationId, id: intentId } = intent;
    const fail = async (reason: string) => {
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        { reason },
      );
      this.logger.warn(`Deposit ${intentId}: stuck SETTLING failed — ${reason}`);
      return true;
    };
    const givenUp = now - intent.updatedAt.getTime() >= DEPOSIT_SETTLING_GIVE_UP_MS;

    const entries = await this.ledger.readJournal(organizationId, { intentId });
    const pending = entries.find((entry) => entry.entryType === LedgerEntryType.DEPOSIT_PENDING);
    if (pending) {
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.SETTLED,
        {
          reason: 'resumed: credit already written',
          settledAmount: pending.money,
          chainTxRef: pending.chainTxRef ?? intent.submittedTxRef ?? undefined,
        },
      );
      return true;
    }

    const transaction = intent.submittedTxRef as TxRef | null;
    if (!transaction) {
      if (givenUp) await this.flagForReview(intent, now);
      return false;
    }

    const adapter = this.registry.resolve(intent.chainId);
    const { escrowPda } = await this.escrowReader.escrowAddresses(
      intent.agentAccount,
      intent.requestedAmount.asset,
    );
    const asChainIntent = this.toChainIntent(intent, escrowPda);
    const landed = await withinDeadline(
      readLanded(adapter, asChainIntent, transaction),
      Date.now() + DEPOSIT_OBSERVE_TIMEOUT_MS,
    );
    if (landed === TIMED_OUT) {
      throw ChainErrors.rpcReadFailed({ method: 'observe deposit (timed out)' });
    }
    switch (landed.kind) {
      case 'unavailable':
        throw landed.error;
      case 'pending':
        return givenUp ? fail(`resumed: no receipt for ${transaction}`) : false;
      case 'no_credit':
        return fail(`resumed: transaction ${transaction} credits this buyer nothing`);
    }

    let settledMoney: Money;
    try {
      settledMoney = adapter.extractSettledAmount(asChainIntent, {
        transaction,
        network: intent.chainId,
        payer: intent.agentAccount,
        observed: landed.transfer,
      });
    } catch (error) {
      return fail(`resumed: settled amount rejected on ${transaction}: ${describe(error)}`);
    }
    await this.creditAndSettle(organizationId, intent, settledMoney, transaction);
    return true;
  }

  /**
   * `DEPOSIT_PENDING` for the observed amount, then SETTLING → SETTLED. Shared
   * by both paths, so the two cannot credit the same transaction differently.
   */
  private async creditAndSettle(
    organizationId: string,
    intent: DepositIntent,
    settledMoney: Money,
    transaction: TxRef,
  ): Promise<DepositIntent> {
    const intentId = intent.id;
    // Credited before the intent is marked SETTLED, not after: an intent
    // that says SETTLED with no matching ledger entry is a worse failure than
    // the reverse (the chain-side reconciler repairs an orphaned deposit; there
    // is no repair for a credited balance nobody can find the intent for).
    // Written now, not through the buffered writer, although
    // `LEDGER_ENTRY_EFFECTS[DEPOSIT_PENDING]` would allow batching: the console
    // refetches `GET /balances` the moment this response lands, and a buffered
    // entry was still unflushed then — the buyer read an empty ledger beside a
    // deposit already marked SETTLED. One write per deposit; nothing to batch.
    try {
      await this.ledger.appendNow({
        organizationId,
        accountId: intent.agentAccount,
        entryType: LedgerEntryType.DEPOSIT_PENDING,
        money: settledMoney,
        intentId: intent.id,
        chainTxRef: transaction,
      });
    } catch (error) {
      // `uq_ledger_entries_deposit_pending_account` makes the pending credit
      // single-use per (transaction, buyer). Losing it means another intent
      // claimed this buyer's share of the same transfer between the claim
      // check and this write — the read-then-write race that check cannot
      // close. This intent can never settle on a transfer another intent owns,
      // so fail it cleanly and report the same 409 the check would have.
      if (!isUniqueViolation(error)) throw error;
      // This intent's own credit (the finality job resuming it raced a live
      // request): it is credited, and whoever wrote it finishes SETTLED.
      const own = await this.ledger.readJournal(organizationId, { intentId });
      if (own.some((entry) => entry.entryType === LedgerEntryType.DEPOSIT_PENDING)) {
        throw PaymentErrors.depositTransactionAlreadyClaimed({ transaction });
      }
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        { reason: `transaction ${transaction} already claimed by a concurrent deposit` },
      );
      throw PaymentErrors.depositTransactionAlreadyClaimed({ transaction });
    }

    this.logger.log(
      `Deposit ${intent.id} settled: ${settledMoney.amount} ${settledMoney.asset} observed on ${transaction}`,
    );

    return this.deposits.transition(
      organizationId,
      intentId,
      DepositIntentStatus.SETTLING,
      DepositIntentStatus.SETTLED,
      {
        reason: 'settlement observed on-chain',
        settledAmount: settledMoney,
        chainTxRef: transaction,
      },
    );
  }

  /** The audit row naming the agent credential behind a deposit action (M-2). Never throws. */
  private async recordCallerAudit(
    intent: DepositIntent,
    caller: DepositCaller,
    action: 'deposit.intent_created' | 'deposit.reported',
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit?.recordAfterCommit({
      organizationId: intent.organizationId,
      actor: caller.actor,
      action,
      resourceType: 'deposit',
      resourceId: intent.id,
      before: null,
      after: {
        credentialId: caller.credentialId,
        agentId: intent.agentId,
        account: intent.agentAccount,
        chainId: intent.chainId,
        ...after,
      },
    });
  }

  /**
   * `observeTransfer` right after `settle` is a **race**, and losing it costs
   * real money.
   *
   * The facilitator returns as soon as the RPC accepts the transaction. At
   * that moment it has not been confirmed, so the first read almost always
   * answers "not found". Measured live on devnet: the transfer moved 25 USDC
   * into the vault and the immediate read still returned `null`, so the
   * deposit was marked FAILED while the money was already gone. So "not there
   * yet" is asked again until the window ends.
   *
   * Only that answer is polled. A mined transaction that credits nobody is
   * final and returned at once (no 20 s of reads for a wrong hash). A read
   * that fails or hangs is retried within the window too, and if the window
   * ends on failures the answer is `unavailable`, never "not there" (M-2).
   *
   * Bounded, not open-ended: each read is cut at the window's end, and the
   * pause between reads never runs past it.
   */
  private async observeOnceLanded(
    adapter: ChainAdapter,
    intent: ChainPaymentIntent,
    transaction: TxRef,
  ): Promise<Landed> {
    const deadline = Date.now() + DEPOSIT_OBSERVE_TIMEOUT_MS;
    let attempt = 0;

    for (;;) {
      let failure: unknown = null;
      let landed: Landed | null = null;
      try {
        const read = await withinDeadline(readLanded(adapter, intent, transaction), deadline);
        if (read === TIMED_OUT) {
          failure = ChainErrors.rpcReadFailed({ method: 'observe deposit (timed out)' });
        } else {
          landed = read;
        }
      } catch (error) {
        failure = error;
      }
      if (landed && landed.kind !== 'pending') {
        return landed;
      }
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Deposit settlement ${transaction} still unobservable after ` +
            `${DEPOSIT_OBSERVE_TIMEOUT_MS}ms and ${attempt + 1} reads` +
            (failure ? ` (last read failed: ${describe(failure)})` : ''),
        );
        return failure ? { kind: 'unavailable', error: failure } : { kind: 'pending' };
      }
      attempt += 1;
      // Never pause past the deadline: the window is the request's whole wait.
      await sleep(Math.min(DEPOSIT_OBSERVE_POLL_MS, deadline - Date.now()));
    }
  }

  /**
   * The two remote reads `buildRequirements` needs — with the destination
   * changed from the pooled treasury vault to **this buyer's own escrow**.
   *
   * Nothing in the x402 wire format changes. `payTo` was always the address
   * the facilitator checks the `TransferChecked` destination against
   * (`transfer-correctness.rule.ts`); it is now derived from the buyer's own
   * pubkey rather than from a multisig the platform controls. Funding an
   * escrow is a plain SPL transfer with no instruction of ours, which is
   * exactly why the escrow's balance can be the buyer's balance.
   *
   * The escrow is opened here rather than lazily on the first call, and the
   * ordering matters: an escrow that does not exist has no associated token
   * account, so a deposit aimed at its derived ATA would land in an account
   * nobody has created and be unrecoverable without a second transaction.
   *
   * Separated from `buildRequirements` so that `createDeposit` can run it
   * *before* it writes the intent row — see that method's comment for why
   * the order is load-bearing.
   */
  private async resolveRequirementDeps(
    organizationId: string,
    account: AccountId,
    chainId: ChainId,
    asset: AssetId,
  ): Promise<RequirementDeps> {
    // Resolved FIRST, so a chain this deployment does not enable is refused
    // with `CHAIN_UNSUPPORTED` before anything touches it. `ESCROW_OPENER`
    // dispatches on the namespace alone, so opening the escrow first would
    // submit `open_escrow` to a disabled chain and only then refuse.
    const adapter = this.registry.resolve(chainId);
    // The deposit door (paused, buyer blocked on chain) before anything is
    // written: refusing after the intent row left a CREATED row behind until
    // the expiry sweep.
    await this.chainState?.assertActive(ChainDoor.DEPOSIT, [{ role: 'BUYER', account }]);
    const escrow = await this.ensureEscrow(organizationId, account, asset);
    // Asked of the adapter, never branched on the namespace here — the whole
    // point of `ChainAdapter` is that this service does not know what a chain
    // is. On a chain with no fee-payer separation the read is SKIPPED rather
    // than attempted-and-tolerated: an unreachable facilitator must still be a
    // 503 on Solana, and a `try/catch` here would have swallowed that.
    const feePayer = adapter.requiresFeePayer ? await this.facilitator.getFeePayer(chainId) : null;
    return { escrowTokenAccount: escrow.escrowTokenAccount, feePayer };
  }

  /**
   * The mirror row for this buyer's escrow, opening one on chain when there is
   * none.
   *
   * Checked against the **mirror**, not the chain: `BuyerEscrowRepository` is
   * the durable record of what this platform has already opened, and a row
   * present here means an `open_escrow` transaction landed at some point —
   * asking the chain again on every deposit would be a redundant read on the
   * common path, where almost every deposit is a buyer's second, third or
   * hundredth. `SolanaEscrowOpener.open` still checks the chain itself before
   * it submits, which is what protects a genuinely new buyer against two
   * concurrent deposits both finding no mirror row.
   */
  private async ensureEscrow(
    organizationId: string,
    account: AccountId,
    asset: AssetId,
  ): Promise<{ escrowPda: AccountId; escrowTokenAccount: AccountId }> {
    const existing = await this.escrows.findByAccount(organizationId, account);
    if (existing) {
      return {
        escrowPda: existing.escrowAccountId as AccountId,
        escrowTokenAccount: existing.escrowAssetAccountId as AccountId,
      };
    }

    let opened;
    try {
      // Opens DISARMED (both limits zero): the program will not let this
      // unsigned path choose the buyer's limits, so the buyer arms the escrow
      // with `POST /escrow/limits-intent` before their first paid call.
      opened = await this.opener.open(account, asset);
    } catch (error) {
      // Refuse the deposit rather than record an escrow the chain never
      // confirmed — a mirror row with no matching on-chain account would
      // report an escrow that cannot receive a redemption, and the failure
      // would surface much later, on the paying path, as `EscrowInsufficient`.
      throw PaymentErrors.escrowNotOpen({ account, reason: describe(error) });
    }

    const row = await this.escrows.upsertOpened({
      organizationId,
      accountId: account,
      assetId: asset,
      escrowAccountId: opened.escrowPda,
      escrowAssetAccountId: opened.escrowTokenAccount,
      openedTxRef: opened.signature,
    });
    // Another organization's row for this account: not written, not adopted.
    // Refused before the intent row exists — `createDeposit` runs this first.
    if (row === null) {
      throw PaymentErrors.escrowAccountClaimed({ account });
    }

    return {
      escrowPda: row.escrowAccountId as AccountId,
      escrowTokenAccount: row.escrowAssetAccountId as AccountId,
    };
  }

  /** Local computation only: every value that needed a network read is passed in. */
  private async buildRequirements(
    intent: DepositIntent,
    deps: RequirementDeps,
  ): Promise<PaymentRequirements> {
    const adapter = this.registry.resolve(intent.chainId);

    return adapter.buildPaymentRequirements({
      chainId: intent.chainId,
      intentId: intent.id,
      resource: depositResource(intent.id),
      amount: intent.requestedAmount,
      payTo: deps.escrowTokenAccount,
      // The escrow ATA is already a token account — deriving an ATA of it
      // would compute an address nothing owns. See `BuildRequirementsInput`.
      payToIsTokenAccount: true,
      // Where the tokens land and whose balance grows are the same escrow on
      // Solana and two different accounts on EVM, where the escrow is pooled.
      // Passed unconditionally, with no namespace branch here: the adapter
      // reads whichever of the two its chain actually needs.
      payer: intent.agentAccount,
      feePayer: deps.feePayer,
      description: 'Deposit to platform balance',
    });
  }

  /**
   * `payTo` here is the escrow **PDA**, not its ATA — `observeTransfer`
   * matches it against the observed transfer's token-account *owner*, and the
   * owner of an ATA is the PDA that holds it, never the ATA's own address.
   *
   * `payer` is the buyer, passed unconditionally for the same reason
   * `buildRequirements` passes it: on EVM `escrowPda` is the pooled contract,
   * and the account a deposit credits is a different one. Each adapter reads
   * whichever its chain needs, so this service still branches on nothing.
   */
  private toChainIntent(intent: DepositIntent, escrowPda: AccountId): ChainPaymentIntent {
    return {
      id: intent.id,
      resource: depositResource(intent.id),
      amount: intent.requestedAmount,
      payTo: escrowPda,
      payer: intent.agentAccount,
      chainId: intent.chainId as ChainId,
      expiresAt: intent.expiresAt,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bounded wait between chain reads. Local so this file adds no dependency. */
const EVM_TX_HASH = /^0x[0-9a-f]{64}$/;

/** Runs after `canonicalTxRef`, so an EVM hash is already lowercase here. */
function assertWellFormedTxRef(adapter: ChainAdapter, transaction: TxRef): void {
  if (adapter.namespace === ChainNamespace.EIP155 && !EVM_TX_HASH.test(transaction)) {
    // The `message` array is what `AllExceptionsFilter` answers as
    // `400 VALIDATION_FAILED`, the same as a DTO refusal.
    throw new BadRequestException([
      'transactionHash must be a 0x-prefixed 32-byte hex transaction hash',
    ]);
  }
}

/** What {@link withinDeadline} answers when the deadline passed first. */
const TIMED_OUT = Symbol('timed out');

/** `recordSubmittedTx` on the facilitator path: attempts, and the pause step between them. */
const SUBMITTED_TX_STORE_ATTEMPTS = 3;
const SUBMITTED_TX_STORE_RETRY_MS = 200;

/**
 * `work`, or {@link TIMED_OUT} once `deadline` passes. The read left behind is
 * not cancelled, only no longer awaited; its late rejection is swallowed. A
 * rejection of `work` before the deadline is passed through.
 */
async function withinDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One read, through `observeDeposit` where the adapter has it. Otherwise
 * `observeTransfer`, whose `null` cannot tell "not yet" from "never", so it is
 * read as "not yet" (polled) and no block time is known.
 */
async function readLanded(
  adapter: ChainAdapter,
  intent: ChainPaymentIntent,
  transaction: TxRef,
): Promise<Landed> {
  if (adapter.observeDeposit) {
    return adapter.observeDeposit(intent, transaction);
  }
  const transfer = await adapter.observeTransfer(intent, transaction, { commitment: 'confirmed' });
  return transfer ? { kind: 'credited', transfer, blockTime: null } : { kind: 'pending' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The single stored form of a transaction reference: lowercase hex on EVM, untouched elsewhere. */
function canonicalTxRef(adapter: ChainAdapter, transaction: TxRef): TxRef {
  return adapter.namespace === ChainNamespace.EIP155
    ? (transaction.toLowerCase() as TxRef)
    : transaction;
}

/** Postgres `23505`, whatever driver wrapper it arrives inside — same check the rest of the codebase uses. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}
