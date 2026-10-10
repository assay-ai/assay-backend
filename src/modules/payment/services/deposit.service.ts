import { Inject, Injectable, Logger } from '@nestjs/common';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { FACILITATOR_PORT, FacilitatorPort } from '@modules/chains/ports/facilitator.port';
import { Money } from '@modules/chains/ports/money.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
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

import {
  DEPOSIT_OBSERVE_POLL_MS,
  DEPOSIT_OBSERVE_TIMEOUT_MS,
  depositResource,
} from '../constants/deposit-intent.constants';
import { assertDepositAssetIsSettlementAsset } from '../domain/deposit-asset';
import { throwForX402InvalidReason } from '../domain/x402-error-mapping';
import { PaymentErrors } from '../errors/payment.errors';
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
};

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
  ) {}

  /**
   * Creates the intent and the `402` requirements a client builds a payload
   * against. The chain's settlement asset only, refused before the intent row
   * is even written.
   *
   * ## Why both remote reads happen before the row is written
   *
   * A `CREATED` deposit intent is not an inert draft. `BalancesService.
   * pendingDepositsByAsset` sums `requestedAmount` over exactly this status,
   * so the row *is* the `pendingDeposits` figure the funding screen renders,
   * and it stays that until the expiry sweep moves it. Writing it first and
   * then failing on `ensureEscrow` or `getFeePayer` answers the caller `502`
   * (or `409`) while leaving money the buyer never sent counted as in flight —
   * the request errors and the balance changes anyway.
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
    organizationId: string,
    intentId: string,
    payload: PaymentPayload,
  ): Promise<DepositIntent> {
    const intent = await this.deposits.findById(organizationId, intentId);

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

    return this.recordObservedSettlement(
      organizationId,
      intent,
      adapter,
      asChainIntent,
      settleResult.transaction,
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
   * Nothing the client says is trusted. The hash is only a pointer: the chain
   * is read (`observeTransfer`), and only an escrow `Deposited` event crediting
   * THIS intent's buyer, for at least the requested amount
   * (`extractSettledAmount`), credits anything — exactly the two reads the
   * facilitator path makes after its own broadcast. What the facilitator path
   * also had and this one must supply itself is single use: there, the hash is
   * minted by our own settle; here, the client could offer one transaction for
   * two intents. `findByChainTxRef` refuses that before anything moves, and
   * `uq_ledger_entries_deposit_resolution` refuses a second credit at finality
   * if two claims race past it.
   *
   * Refused on a chain that needs the platform as fee payer (Solana): no buyer
   * can broadcast there alone, so a hash-only claim has no honest producer.
   */
  async settleDepositByBroadcast(
    organizationId: string,
    intentId: string,
    transaction: TxRef,
  ): Promise<DepositIntent> {
    const intent = await this.deposits.findById(organizationId, intentId);

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

    const adapter = this.registry.resolve(intent.chainId);
    if (adapter.requiresFeePayer) {
      throw PaymentErrors.depositBroadcastUnsupported({ chainId: intent.chainId });
    }

    const claimed = await this.deposits.findByChainTxRef(organizationId, transaction);
    if (claimed && claimed.id !== intent.id) {
      throw PaymentErrors.depositTransactionAlreadyClaimed({ transaction, claimedBy: claimed.id });
    }

    const { escrowPda } = await this.escrowReader.escrowAddresses(
      intent.agentAccount,
      intent.requestedAmount.asset,
    );
    const asChainIntent = this.toChainIntent(intent, escrowPda);

    await this.deposits.transition(
      organizationId,
      intentId,
      DepositIntentStatus.CREATED,
      DepositIntentStatus.SETTLING,
      { reason: 'buyer broadcast; reading the transaction on chain' },
    );

    return this.recordObservedSettlement(
      organizationId,
      intent,
      adapter,
      asChainIntent,
      transaction,
      intent.agentAccount,
    );
  }

  /**
   * SETTLING → SETTLED (or FAILED): observe the transfer, take the amount the
   * chain moved, and credit `DEPOSIT_PENDING`. Shared by the facilitator path
   * and the buyer-broadcast path, so the two cannot judge the same transaction
   * differently.
   */
  private async recordObservedSettlement(
    organizationId: string,
    intent: DepositIntent,
    adapter: ChainAdapter,
    asChainIntent: ChainPaymentIntent,
    transaction: TxRef,
    payer: AccountId,
  ): Promise<DepositIntent> {
    const intentId = intent.id;

    // Never trust the requested amount — the SVM `exact` scheme tolerates
    // overpayment, and only the chain says what actually moved.
    const observed = await this.observeOnceLanded(adapter, asChainIntent, transaction);

    if (!observed) {
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        {
          // The signature goes in the REASON, not in `chainTxRef`.
          // `chk_deposit_intents_settlement_pair` is
          // `(settled_amount IS NULL) = (chain_tx_ref IS NULL)` — the two
          // columns are one fact, "this is the transaction that settled it,
          // and this is what it moved". A failed intent settled nothing, so
          // setting one without the other is not a typo, it is a claim the
          // schema refuses.
          //
          // Found live: this path threw the CHECK violation *instead of* the
          // real error, so the intent stuck in SETTLING forever and the
          // operator was shown a Postgres constraint name rather than the
          // reason the deposit failed. A unit test over an in-memory
          // repository cannot see a constraint.
          reason: `settlement reported success but no transfer was observed on ${transaction}`,
        },
      );
      throw PaymentErrors.settlementFailed({
        reason: `no observable transfer for transaction ${transaction}`,
      });
    }

    let settledMoney: Money;
    try {
      settledMoney = adapter.extractSettledAmount(asChainIntent, {
        transaction,
        network: intent.chainId,
        payer,
        observed,
      });
    } catch (error) {
      await this.deposits.transition(
        organizationId,
        intentId,
        DepositIntentStatus.SETTLING,
        DepositIntentStatus.FAILED,
        // Same `chk_deposit_intents_settlement_pair` reasoning as above — the
        // signature belongs in the reason on a path that settles nothing.
        { reason: `settled amount rejected on ${transaction}: ${describe(error)}` },
      );
      throw error;
    }

    // Credited before the intent is marked SETTLED, not after: an intent
    // that says SETTLED with no matching ledger entry is a worse failure than
    // the reverse (the chain-side reconciler repairs an orphaned deposit; there
    // is no repair for a credited balance nobody can find the intent for).
    // Bufferable per `LEDGER_ENTRY_EFFECTS[DEPOSIT_PENDING]` — only `pending`
    // moves, so this can never overdraw anything and is safe to batch.
    this.ledger.append({
      organizationId,
      accountId: intent.agentAccount,
      entryType: LedgerEntryType.DEPOSIT_PENDING,
      money: settledMoney,
      intentId: intent.id,
      chainTxRef: transaction,
    });

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

  /**
   * `observeTransfer` right after `settle` is a **race**, and losing it costs
   * real money.
   *
   * The facilitator returns as soon as the RPC accepts the transaction. At
   * that moment it has not been confirmed, so `getTransaction` at
   * `commitment: 'confirmed'` answers "not found" — which
   * `observeTransfer` correctly reports as `null`, because from the adapter a
   * reorg and "not landed yet" are indistinguishable and the caller owns that
   * decision. This method is that decision.
   *
   * Measured live on devnet: the transfer moved 25 USDC into the vault and the
   * immediate read still returned `null`, so the deposit was marked FAILED
   * while the money was already gone. Treating one unconfirmed read as failure
   * is the difference between a deposit and a loss.
   *
   * Bounded, not open-ended: a transaction that has genuinely not landed must
   * still fail rather than hang a request forever. `expiresAt` is not the
   * bound to use — the intent's TTL outlives the blockhash by a wide margin on
   * a fast cluster.
   */
  private async observeOnceLanded(
    adapter: ChainAdapter,
    intent: ChainPaymentIntent,
    transaction: TxRef,
  ): Promise<ObservedTransfer | null> {
    const deadline = Date.now() + DEPOSIT_OBSERVE_TIMEOUT_MS;
    let attempt = 0;

    for (;;) {
      const observed = await adapter.observeTransfer(intent, transaction, {
        commitment: 'confirmed',
      });
      if (observed) {
        return observed;
      }
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Deposit settlement ${transaction} still unobservable after ` +
            `${DEPOSIT_OBSERVE_TIMEOUT_MS}ms and ${attempt + 1} reads`,
        );
        return null;
      }
      attempt += 1;
      await sleep(DEPOSIT_OBSERVE_POLL_MS);
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
    const escrow = await this.ensureEscrow(organizationId, account, asset);
    // Asked of the adapter, never branched on the namespace here — the whole
    // point of `ChainAdapter` is that this service does not know what a chain
    // is. On a chain with no fee-payer separation the read is SKIPPED rather
    // than attempted-and-tolerated: an unreachable facilitator must still be a
    // 502 on Solana, and a `try/catch` here would have swallowed that.
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
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
