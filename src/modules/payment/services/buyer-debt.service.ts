import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import {
  OutstandingDebt,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  ESCROW_BALANCE_READER,
  EscrowBalanceReaderPort,
} from '@modules/ledger/ports/escrow-balance-reader.port';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { RedisDemoRateLimiter } from '@modules/mcp/services/redis-demo-rate-limiter.service';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { NEXT_SEQ_RATE_LIMITER, NEXT_SEQ_RATE_LIMITS } from '../constants/escrow-seq.constants';
import { DEBT_REPLACEABLE_AFTER_EXPIRY_SECONDS } from '../constants/voucher-redemption.constants';
import { VOUCHER_MAX_TTL_SECONDS } from '../constants/voucher.constants';
import { PaymentErrors } from '../errors/payment.errors';
import { SignedVoucher } from '../ports/voucher.types';
import { EscrowSeqService } from './escrow-seq.service';
import { PaymentIntentService } from './payment-intent.service';
import { VoucherService, writeOffAt } from './voucher.service';

/**
 * Where a debt stands:
 *
 * - `OPEN`: nothing signed yet; the buyer's hold is open.
 * - `REPLACING`: a replacement voucher was accepted and the redemption job is
 *   collecting it. Paid calls stay refused until it lands.
 * - `WRITTEN_OFF`: not settled within 30 days; the hold was released and the
 *   provider was not paid. Paid calls STAY refused (until the contract change
 *   ships), and the buyer can still settle it by re-signing.
 */
export type BuyerDebtState = 'OPEN' | 'REPLACING' | 'WRITTEN_OFF';

/** One debt that refuses the payer's paid calls, as the routes report it. */
export interface BuyerDebtView {
  readonly intentId: string;
  readonly payer: string;
  readonly amount: { readonly amount: string; readonly asset: string; readonly decimals: number };
  readonly providerId: string | null;
  readonly toolId: string;
  readonly cause: string | null;
  readonly state: BuyerDebtState;
  readonly lapsedAt: string;
  readonly writeOffAt: string;
  /** From when it can be settled: its voucher is past its on-chain deadline. */
  readonly replaceableAt: string;
  /** When the replacement being collected was accepted (`REPLACING` only). */
  readonly replacedAt: string | null;
  readonly createdAt: string;
}

/** The replacement voucher for one debt, unsigned, every field chosen. */
export interface DebtVoucherIntent {
  readonly debt: BuyerDebtView;
  readonly voucher: Voucher;
  readonly signers?: readonly string[];
  readonly delegate?: string | null;
  readonly typedData: Record<string, unknown> | null;
}

/** What `POST /escrow/debts/:intentId/voucher` answers. */
export interface SettledDebt {
  readonly intentId: string;
  readonly seq: string;
  /** Debts of the payer still to sign (`OPEN` or `WRITTEN_OFF`), this one excluded. */
  readonly remainingDebts: number;
}

/**
 * Settling buyer debt (no-platform-debt design, step 10).
 *
 * A debt is a served paid call whose voucher lapsed for a reason that is not
 * the provider's (`VoucherRedemptionService.lapse`): the buyer's hold is still
 * open and nobody is paid. The buyer settles it the way it pays any call — by
 * signing a voucher — so there is nothing new to learn and nothing new on
 * chain:
 *
 * 1. `GET /escrow/debts` lists the debts that refuse paid calls.
 * 2. `POST /escrow/debts/:id/voucher-intent` allocates a fresh `seq` and
 *    answers the replacement voucher: the SAME payer, escrow, provider,
 *    amount, resource and `requestHash` as the served call, every field chosen
 *    (plus the EIP-712 request for a wallet on eip155). Throttled with the
 *    `GET /escrow/next-seq` budget (review-buyer-debt L7).
 * 3. `POST /escrow/debts/:id/voucher` takes it back signed — by the payer's
 *    own key (the console's wallet) or by the delegate bound to the calling
 *    agent credential, for that agent's own call — checks it with the
 *    admission rules (`VoucherService.verifyReplacement`, and the agent's spend
 *    policy for a delegate), and swaps it onto the intent under the payer's
 *    lock with the same window, pause and seq checks as a new voucher
 *    (`PaymentIntentRepository.replaceLapsedVoucher`, review-buyer-debt M4).
 *    The debt is then `REPLACING`: the redemption job collects it from the
 *    buyer's escrow like any other voucher and the provider is credited out of
 *    it. Paid calls resume only once it is collected.
 *
 * A WRITTEN-OFF debt is settled the same way (H1 interim): its hold was
 * released at the write-off, so a new one is opened first.
 *
 * Nothing here credits anyone. A debt not settled within
 * `BUYER_DEBT_WRITE_OFF_DAYS` is written off by the expiry sweep.
 */
@Injectable()
export class BuyerDebtService {
  private readonly logger = new Logger(BuyerDebtService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    private readonly vouchers: VoucherService,
    private readonly seqs: EscrowSeqService,
    private readonly chains: ChainAdapterRegistry,
    @Inject(ESCROW_BALANCE_READER) private readonly escrow: EscrowBalanceReaderPort,
    @Inject(TOOL_CATALOGUE) private readonly tools: ToolCataloguePort,
    private readonly spendPolicy: SpendPolicyEnforcementService,
    @Inject(NEXT_SEQ_RATE_LIMITER) private readonly rateLimiter: RedisDemoRateLimiter,
  ) {}

  /** The debts that refuse the session payer's (or organization's) paid calls, oldest first. */
  async list(session: McpSession): Promise<BuyerDebtView[]> {
    const debts = await this.payments.findOutstandingDebts(
      session.organizationId,
      session.agentAccount,
      200,
    );
    return debts.map(toView);
  }

  /**
   * Step 2: the replacement voucher to sign for `intentId`, with a fresh seq.
   * `resource` is asked for only for a debt older than the column that stores
   * it whose tool is gone: it must hash to the resource the call's voucher
   * signed.
   */
  async voucherIntent(
    session: McpSession,
    intentId: string,
    resourceHint?: string | null,
  ): Promise<DebtVoucherIntent> {
    await this.throttle(session);
    const debt = await this.ownDebt(session, intentId);
    const resource = await this.resourceOf(debt, resourceHint ?? null);
    const asset = debt.assetId as AssetId;
    const reading = await this.escrow.read(session.agentAccount, asset);
    const { seq } = await this.seqs.allocate(
      session.organizationId,
      session.agentAccount,
      reading ? reading.seqHigh : null,
    );
    const { escrowPda } = await this.escrow.escrowAddresses(session.agentAccount, asset);
    const now = Math.floor(Date.now() / 1000);
    const voucher: Voucher = {
      payer: session.agentAccount,
      payTo: escrowPda,
      provider: debt.providerAccount as AccountId,
      amount: MoneyUtil.of(debt.priceAmount, asset, debt.decimals),
      resource,
      requestHash: debt.requestHash,
      seq,
      issuedAt: now,
      expiresAt: now + VOUCHER_MAX_TTL_SECONDS,
    };
    const adapter = this.chains.resolve(debt.chainId as ChainId);
    const eip155 = (debt.chainId as string).startsWith('eip155:');
    return {
      debt: toView(debt),
      voucher,
      ...(eip155
        ? { signers: ['payer', 'delegate'], delegate: session.delegateAccount ?? null }
        : {}),
      typedData: adapter.voucherTypedData
        ? (adapter.voucherTypedData(voucher) as unknown as Record<string, unknown>)
        : null,
    };
  }

  /**
   * Step 3: accepts the signed replacement for `intentId` and puts the call
   * back in the redemption queue as `REPLACING`. Refused, with nothing
   * changed, unless it is exactly the voucher step 2 described (a fresh,
   * issued seq above every live one, fitting the payer's windows), signed by
   * the payer or by this agent's live delegate within its spend policy.
   */
  async settle(session: McpSession, intentId: string, signed: SignedVoucher): Promise<SettledDebt> {
    const debt = await this.ownDebt(session, intentId);
    const asset = debt.assetId as AssetId;
    const chainId = debt.chainId as ChainId;
    const resource = await this.resourceOf(debt, signed.voucher?.resource ?? null);
    const reading = await this.escrow.read(session.agentAccount, asset);
    const { escrowPda } = await this.escrow.escrowAddresses(session.agentAccount, asset);
    const price = MoneyUtil.of(debt.priceAmount, asset, debt.decimals);

    const { delegate, admission } = await this.vouchers.verifyReplacement({
      organizationId: session.organizationId,
      signed,
      chainId,
      payer: session.agentAccount,
      escrowPda,
      providerAccount: debt.providerAccount as AccountId,
      resource,
      price,
      requestHash: debt.requestHash,
      boundDelegate: session.delegateAccount ?? null,
      escrow: reading,
    });

    // An agent's delegate spends that agent's budget, so it pays for that
    // agent's own calls only, within its spend policy. The payer's own wallet
    // is the owner paying, for any agent of its own (review-buyer-debt M4).
    if (delegate !== null) {
      if (debt.agentId !== session.agentId) {
        throw PaymentErrors.debtNotFound({ intentId });
      }
      await this.spendPolicy.assertReplacementAllowed({
        organizationId: session.organizationId,
        agentId: session.agentId,
        price,
      });
    }

    // A written-off debt has no hold any more: open a new one, priced
    // against the chain, for the redemption to commit (H1 interim).
    const reopenedHold = debt.writtenOff ? await this.intents.reopenDebtHold(debt) : null;

    const { voucher, signature } = signed;
    let replaced: boolean;
    try {
      replaced = await this.payments.replaceLapsedVoucher(
        debt.organizationId,
        debt.id,
        session.agentAccount,
        {
          seq: voucher.seq,
          signature,
          issuedAt: voucher.issuedAt,
          delegate,
          expiresAt: new Date(voucher.expiresAt * 1000),
          resource,
          resourceHash: this.chains.resolve(chainId).voucherResourceHash(voucher.resource),
        },
        admission,
        reopenedHold,
      );
    } catch (error) {
      await this.giveBack(debt, reopenedHold);
      // The seq is held by another row of this payer — one the organization-
      // scoped `isVoucherSeqUsed` cannot see, or one re-issued after a rewind:
      // a replay, not a server fault (review-buyer-debt L6).
      if ((error as { code?: string } | null)?.code === UNIQUE_VIOLATION_CODE) {
        throw PaymentErrors.voucherSeqAlreadyUsed({
          account: session.agentAccount,
          actual: voucher.seq,
        });
      }
      // Any other refusal by the database — the voucher_seq trigger (the row
      // changed since `ownDebt` read it), a constraint — changed nothing: a
      // 409 the buyer can act on, not a 500 (BUG-R17f-01).
      if (error instanceof QueryFailedError) {
        this.logger.warn(
          `Debt ${intentId}: the replacement seq ${voucher.seq} was refused by the database: ` +
            `${error.message}`,
        );
        throw PaymentErrors.debtReplacementRefused({ intentId });
      }
      throw error;
    }
    if (!replaced) {
      await this.giveBack(debt, reopenedHold);
      throw PaymentErrors.debtNotFound({ intentId });
    }

    this.logger.log(
      `Debt ${intentId} of ${session.agentAccount}${debt.writtenOff ? ' (written off)' : ''}: ` +
        `replacement voucher seq ${voucher.seq} accepted; the redemption job collects it from ` +
        `the buyer's escrow, and paid calls resume once it lands.`,
    );
    const remaining = await this.payments.findOutstandingDebts(
      session.organizationId,
      session.agentAccount,
      200,
    );
    return {
      intentId,
      seq: voucher.seq,
      remainingDebts: remaining.filter(
        (other) => other.replacedAt === null && other.id !== intentId,
      ).length,
    };
  }

  /** `GET /escrow/next-seq`'s per-credential budget: each voucher-intent allocates a seq. */
  private async throttle(session: McpSession): Promise<void> {
    const rate = await this.rateLimiter.take(`credential:${session.credentialId}`);
    if (!rate.allowed) {
      throw PaymentErrors.nextSeqRateLimited({
        reason: rate.reason,
        limit: NEXT_SEQ_RATE_LIMITS.perAddressPerWindow,
        windowSeconds: NEXT_SEQ_RATE_LIMITS.windowMs / 1000,
      });
    }
  }

  /**
   * The session payer's own debt — read by id, whatever its age or how many
   * others it has (review-buyer-debt L5) — or `PAYMENT_DEBT_NOT_FOUND`;
   * `PAYMENT_DEBT_REPLACEMENT_PENDING` while a replacement is being collected;
   * `PAYMENT_DEBT_NOT_YET_REPLACEABLE` while its voucher could still be
   * redeemed on chain (before any seq is allocated or a hold reopened).
   */
  private async ownDebt(session: McpSession, intentId: string): Promise<OutstandingDebt> {
    const debt = await this.payments.findOutstandingDebt(session.agentAccount, intentId);
    // Only the payer account's own escrow can pay it: a debt of another wallet
    // of the organization is listed, but settled from that wallet's session.
    if (
      !debt ||
      debt.agentAccount !== session.agentAccount ||
      !debt.providerAccount ||
      chainIdOf(debt.agentAccount as AccountId) !== session.chainId
    ) {
      throw PaymentErrors.debtNotFound({ intentId });
    }
    if (debt.replacedAt !== null) {
      throw PaymentErrors.debtReplacementPending({ intentId });
    }
    const replaceableAt = replaceableAtOf(debt);
    if (Date.now() <= replaceableAt.getTime()) {
      throw PaymentErrors.debtNotYetReplaceable({
        intentId,
        replaceableAt: replaceableAt.toISOString(),
      });
    }
    return debt;
  }

  /**
   * The `resource` the served call's voucher signed: stored on the intent, or
   * — for a row older than the column — the tool's current name. A tool that
   * is gone does not make the debt unsettleable (review-buyer-debt L5): the
   * caller's `hint` is taken when it hashes to the resource hash the call's
   * voucher signed.
   */
  private async resourceOf(debt: OutstandingDebt, hint: string | null): Promise<string> {
    if (debt.voucherResource) return debt.voucherResource;
    const tool = await this.tools.findTool(debt.toolId);
    if (tool) return `/mcp/tools/${tool.name}`;
    const adapter = this.chains.resolve(debt.chainId as ChainId);
    if (
      typeof hint === 'string' &&
      hint.length > 0 &&
      debt.voucherResourceHash !== null &&
      adapter.voucherResourceHash(hint) === debt.voucherResourceHash
    ) {
      return hint;
    }
    throw PaymentErrors.voucherBindingMismatch({
      field: 'resource',
      expected: `the resource the call's voucher signed (hash ${debt.voucherResourceHash ?? '?'})`,
      actual: hint ?? 'none',
    });
  }

  /** Releases a hold opened for a replacement that was then refused. Best effort. */
  private async giveBack(debt: OutstandingDebt, holdId: string | null): Promise<void> {
    if (!holdId) return;
    await this.intents.releaseUnusedHold(debt.organizationId, holdId).catch((error: unknown) => {
      this.logger.error(
        `Debt ${debt.id}: the hold ${holdId} opened for a refused replacement could not be ` +
          `released: ${error instanceof Error ? error.message : String(error)}. Release it by hand.`,
      );
    });
  }
}

/**
 * When the debt's current voucher is past its on-chain deadline (`expiresAt +
 * REDEEM_GRACE_SECONDS`, plus clock skew), so it can never be redeemed and a
 * replacement at a higher seq cannot charge the buyer twice. A debt lapsed on
 * `VoucherExpired` is past it already; one lapsed earlier (a permanent refusal,
 * a buyer tightening at the margin) waits for it. The voucher_seq trigger
 * (migration 1760900000000) enforces the same bound.
 */
function replaceableAtOf(debt: OutstandingDebt): Date {
  return new Date(
    new Date(debt.expiresAt).getTime() + DEBT_REPLACEABLE_AFTER_EXPIRY_SECONDS * 1000,
  );
}

function stateOf(debt: OutstandingDebt): BuyerDebtState {
  if (debt.replacedAt !== null) return 'REPLACING';
  return debt.writtenOff ? 'WRITTEN_OFF' : 'OPEN';
}

function toView(debt: OutstandingDebt): BuyerDebtView {
  return {
    intentId: debt.id,
    payer: debt.agentAccount,
    amount: { amount: debt.priceAmount, asset: debt.assetId, decimals: debt.decimals },
    providerId: debt.providerId,
    toolId: debt.toolId,
    cause: debt.cause,
    state: stateOf(debt),
    lapsedAt: new Date(debt.lapsedAt).toISOString(),
    writeOffAt: writeOffAt(debt.lapsedAt).toISOString(),
    replaceableAt: replaceableAtOf(debt).toISOString(),
    replacedAt: debt.replacedAt ? new Date(debt.replacedAt).toISOString() : null,
    createdAt: new Date(debt.createdAt).toISOString(),
  };
}
