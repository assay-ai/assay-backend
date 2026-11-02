import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { debtReplaceableAfterExpirySeconds } from '../constants/voucher-redemption.constants';
import { VOUCHER_MAX_TTL_SECONDS } from '../constants/voucher.constants';
import { ChannelErrors } from '../errors/channel.errors';
import { CHANNEL_DOOR, ChannelDoorPort } from '../ports/channel-door.port';
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
  /**
   * `CHANNEL`: paid on a payment channel — settled by a RENEW of the exact
   * pair (`channelVoucher` on `POST /escrow/debts/:id/voucher`), never by a
   * voucher-intent (W2, review 2026-10-31 H6). `PER_CALL` otherwise.
   */
  readonly voucherFormat?: 'PER_CALL' | 'CHANNEL';
  /** A CHANNEL debt: the pair to renew. */
  readonly channel?: {
    readonly cumulative: string;
    readonly calls: number;
    /** The lane's on-chain channel id: a client renews on this lane only. */
    readonly channelId: string | null;
  } | null;
  /**
   * A CHANNEL debt (client review M-2): `true` once no voucher of its lane can
   * still settle it on chain, so the payer may settle it like a per-call debt
   * (voucher-intent + a signed per-call replacement of the same amount to the
   * same provider). Before that, only the agent's renew clears it.
   * `settleInPortalFrom` is that instant. Absent on a PER_CALL debt.
   */
  readonly settleInPortal?: boolean;
  readonly settleInPortalFrom?: string | null;
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
    // The lane's on-chain books and clock, read before a CHANNEL debt moves
    // to the per-call door (rev3 L-1/L-2). Without it, the move is refused.
    @Optional() @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort | null = null,
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
    // A CHANNEL debt (past its lane's on-chain deadline, `ownDebt`) moves to
    // the per-call door with this voucher: never a seq onto a channel row.
    const channel = debt.voucherFormat === 'CHANNEL';
    const asset = debt.assetId as AssetId;
    const chainId = debt.chainId as ChainId;
    const laneSettled = channel ? await this.assertLaneCannotSettle(debt) : null;
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
    let replaced: boolean | 'LANE_MOVED';
    const replacement = {
      seq: voucher.seq,
      signature,
      issuedAt: voucher.issuedAt,
      delegate,
      expiresAt: new Date(voucher.expiresAt * 1000),
      resource,
      resourceHash: this.chains.resolve(chainId).voucherResourceHash(voucher.resource),
    };
    try {
      replaced = channel
        ? await this.payments.replaceChannelDebtPerCall(
            debt.organizationId,
            debt.id,
            session.agentAccount,
            replacement,
            admission,
            reopenedHold,
            laneSettled,
          )
        : await this.payments.replaceLapsedVoucher(
            debt.organizationId,
            debt.id,
            session.agentAccount,
            replacement,
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
        if (channel) await this.refuseChannelMove(session, debt);
        throw PaymentErrors.debtReplacementRefused({ intentId });
      }
      throw error;
    }
    if (replaced === 'LANE_MOVED') {
      await this.giveBack(debt, reopenedHold);
      if (channel) await this.refuseChannelMove(session, debt, false);
      throw laneNotReady(debt, 'its payment channel settled or is settling meanwhile');
    }
    if (!replaced) {
      await this.giveBack(debt, reopenedHold);
      if (channel) await this.refuseChannelMove(session, debt);
      throw PaymentErrors.debtNotFound({ intentId });
    }

    this.logger.log(
      `Debt ${intentId} of ${session.agentAccount}${debt.writtenOff ? ' (written off)' : ''}` +
        `${channel ? ' (a channel debt, now settled per call)' : ''}: ` +
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

  /**
   * Before a CHANNEL debt moves to the per-call door: the lane's on-chain
   * books must agree with the DB (chain `settled` == DB settled, nothing of a
   * settle unbooked) and stop below the call's cumulative, and the CHAIN's
   * clock — not only the DB's — must be past the latest covering voucher's
   * deadline (`expiresAt` + 7,320 s on eip155). Otherwise refused with the
   * retryable `PAYMENT_DEBT_NOT_YET_REPLACEABLE`, nothing changed (rev3
   * L-1/L-2). Returns the settled value to hold the move to.
   */
  private async assertLaneCannotSettle(debt: OutstandingDebt): Promise<string> {
    const asset = debt.assetId as AssetId;
    if (
      !this.door ||
      !debt.channelKey ||
      debt.channelSettledCumulative == null ||
      debt.channelCumulative == null
    ) {
      throw laneNotReady(debt, 'its payment channel could not be read');
    }
    let chainNow: number;
    let books: Awaited<ReturnType<ChannelDoorPort['readBooks']>>;
    const key = debt.channelKey.trim() as `0x${string}`;
    try {
      if (this.door.chainHead) {
        // One block for both reads: a books node lagging behind the clock node
        // could otherwise miss a settle that already charged this call (rev4).
        const head = await this.door.chainHead(asset);
        chainNow = head.timestamp;
        books = await this.door.readBooks(asset, key, undefined, head.number);
      } else {
        [chainNow, books] = await Promise.all([
          this.door.chainNow(asset),
          this.door.readBooks(asset, key),
        ]);
      }
    } catch (error) {
      this.logger.warn(
        `Debt ${debt.id}: the channel books could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw laneNotReady(debt, 'its payment channel could not be read');
    }
    const deadline = Math.floor(replaceableAtOf(debt).getTime() / 1000);
    if (!Number.isFinite(chainNow) || chainNow <= deadline) {
      throw laneNotReady(debt, 'the chain has not yet passed its channel voucher deadline');
    }
    const settled = BigInt(debt.channelSettledCumulative);
    if (
      !books ||
      books.slot.settled !== settled ||
      books.slot.settled >= BigInt(debt.channelCumulative)
    ) {
      throw laneNotReady(debt, 'its payment channel is being reconciled with the chain');
    }
    return debt.channelSettledCumulative;
  }

  /**
   * A CHANNEL debt's move to the per-call door changed nothing (R-7): read the
   * debt again and answer what it is now. Replaced meanwhile (a concurrent,
   * identical submit won): `PAYMENT_DEBT_REPLACEMENT_PENDING`. Still a CHANNEL
   * debt: the move's own deadline check (and the voucher_seq trigger) runs on
   * the DATABASE clock, which may be a few seconds behind the app clock
   * `ownDebt` passed — the retryable `PAYMENT_DEBT_NOT_YET_REPLACEABLE`, never
   * a 404/409 (only with `stillChannel`; a lane that moved keeps its own
   * retryable answer). Anything else: returns, and the caller's refusal stands.
   */
  private async refuseChannelMove(
    session: McpSession,
    debt: OutstandingDebt,
    stillChannel = true,
  ): Promise<void> {
    const now = await this.payments
      .findOutstandingDebt(session.agentAccount, debt.id)
      .catch(() => null);
    if (!now) return;
    if (now.replacedAt !== null) throw PaymentErrors.debtReplacementPending({ intentId: debt.id });
    if (!stillChannel || now.voucherFormat !== 'CHANNEL') return;
    const retryAt = Math.max(
      replaceableAtOf(now).getTime(),
      Date.now() + DB_CLOCK_RETRY_SECONDS * 1000,
    );
    throw PaymentErrors.debtNotYetReplaceable({
      intentId: debt.id,
      replaceableAt: new Date(retryAt).toISOString(),
      reason: 'its channel voucher deadline has not passed by the database clock yet',
    });
  }

  /** A channel renew where this process serves none: refused, nothing changed. */
  refuseChannelRenew(): never {
    throw ChannelErrors.notOffered({ reason: 'channel renews are not served here' });
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
    // A CHANNEL debt is renewed by the agent until no voucher of its lane can
    // settle it on chain; only then may a per-call replacement take its place.
    if (debt.voucherFormat === 'CHANNEL' && Date.now() <= replaceableAt.getTime()) {
      refuseChannelDebt(replaceableAt);
    }
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
 * redeemGraceSeconds` of the debt's chain, plus clock skew), so it can never be
 * redeemed and a replacement at a higher seq cannot charge the buyer twice. A
 * debt lapsed on `VoucherExpired` is past it already; one lapsed earlier (a
 * permanent refusal, a buyer tightening at the margin) waits for it. The
 * voucher_seq trigger (migrations 1762400000070, 1793404800030) enforces the
 * same per-chain bound.
 *
 * For a CHANNEL debt, the latest of its own voucher and every stored lane
 * voucher covering it (`channelVoucherExpiresAt`): a later voucher of the
 * lane carries this call's value too (client review M-2).
 */
/**
 * How long after now a CHANNEL debt's per-call move is retried when the
 * database clock has not passed its deadline yet (R-7): app and DB clocks
 * differ by seconds.
 */
const DB_CLOCK_RETRY_SECONDS = 30;

function replaceableAtOf(debt: OutstandingDebt): Date {
  let expiry = new Date(debt.expiresAt).getTime();
  if (debt.voucherFormat === 'CHANNEL' && debt.channelVoucherExpiresAt) {
    expiry = Math.max(expiry, new Date(debt.channelVoucherExpiresAt).getTime());
  }
  return new Date(expiry + debtReplaceableAfterExpirySeconds(debt.chainId) * 1000);
}

/**
 * A CHANNEL debt whose lane can still settle it on chain is renewed on its
 * lane (`ChannelAdmissionService.renew`), never replaced with a per-call seq:
 * refused cleanly, nothing changed. From `from` on, the per-call replacement
 * is offered (client review M-2).
 */
function refuseChannelDebt(from: Date): never {
  throw ChannelErrors.notOffered({
    reason:
      'this debt was paid on a payment channel: renew it with `channelVoucher` (the exact ' +
      'stored cumulative and calls, fresh times) on POST /escrow/debts/{intentId}/voucher, or ' +
      `settle it with a per-call voucher from ${from.toISOString()}`,
  });
}

function laneNotReady(debt: OutstandingDebt, reason: string): Error {
  return PaymentErrors.debtNotYetReplaceable({
    intentId: debt.id,
    replaceableAt: replaceableAtOf(debt).toISOString(),
    reason,
  });
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
    voucherFormat: debt.voucherFormat === 'CHANNEL' ? 'CHANNEL' : 'PER_CALL',
    channel:
      debt.voucherFormat === 'CHANNEL' && debt.channelCumulative
        ? {
            cumulative: debt.channelCumulative,
            calls: Number(debt.channelCalls ?? 0),
            channelId: debt.channelId ?? null,
          }
        : null,
    ...(debt.voucherFormat === 'CHANNEL'
      ? {
          settleInPortal: Date.now() > replaceableAtOf(debt).getTime(),
          settleInPortalFrom: replaceableAtOf(debt).toISOString(),
        }
      : {}),
  };
}
