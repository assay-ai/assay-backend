import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  OperatorDebtFilter,
  PaymentIntentRepository,
} from '@database/postgres/repositories/payment-intent.repository';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import {
  OPERATOR_DEBT_VOID_OUTCOME,
  UNCOLLECTED_PREFIX,
} from '@modules/payment/constants/voucher-redemption.constants';
import {
  FEE_SPIKE_DEFERRED,
  RedeemVoucherRequest,
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { applyTimeWindow, asInstant, ListSpec, paginate } from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  BuyerDebtVoidItemDto,
  BuyerDebtVoidResultDto,
  DEBT_VOID_MAX_IDS,
  DebtVoidSkipReason,
  ListOperatorBuyerDebtsQueryDto,
  OperatorBuyerDebtPageDto,
  OperatorBuyerDebtRowDto,
} from '../dto/operator-buyer-debts.dto';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorApprover, OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from './operator-approval.service';
import { OverrideLogService } from './override-log.service';

export const DEBT_VOID_APPROVAL_ACTION = 'buyer_debt.bulk_void';
export const DEBT_VOID_OVERRIDE_CODE = 'M-1';
export const DEBT_VOID_TARGET = 'buyer_debt_void';
/** The register's reason code for `M-1`; the operator's own words go in `reason`. */
export const DEBT_VOID_REASON_CODE = 'PLATFORM_FAULT';

/** What the approval pins: exactly this list, this asset, this total. */
export interface DebtVoidPayload {
  readonly intentIds: string[];
  readonly assetId: string;
  readonly decimals: number;
  readonly count: number;
  readonly totalAmount: string;
  readonly reason: string;
  readonly ticketRef: string | null;
}

export interface DebtVoidRequest {
  readonly operator: OperatorSession;
  readonly intentIds: readonly string[];
  readonly reason: string;
  readonly ticketRef?: string | null;
}

/**
 * The cause recorded on a debt suggests the PLATFORM failed to redeem it —
 * the same test as `OPERATOR_SUGGESTED_PLATFORM_CAUSE_SQL`. A label for the
 * operator, never a decision.
 */
export function suggestsPlatformCause(lastError: string | null): boolean {
  if (lastError === null) return false;
  const cause = lastError.startsWith(UNCOLLECTED_PREFIX)
    ? lastError.slice(UNCOLLECTED_PREFIX.length)
    : lastError;
  return (
    cause === 'VoucherExpired' ||
    cause === FEE_SPIKE_DEFERRED ||
    cause.startsWith('UNKNOWN_REVERT:')
  );
}

/**
 * Open buyer debts for the operator console, and their bulk void (`M-1`).
 *
 * Owner decision 2026-10-30: a lapsed voucher is ALWAYS buyer debt; nothing
 * voids automatically. When an operator judges that the platform caused a set
 * of debts (an unfunded redeemer, an RPC outage), they request a void of those
 * ids with a reason, and a SECOND operator approves exactly that list — every
 * request is queued, whatever the amount.
 *
 * On approval the register entry (operator, approver, reason, ids, asset and
 * total) is committed with the approval FIRST, then each id is voided on its
 * own: re-checked as an open debt, its chain record read on eip155
 * (`held(payer, seq)` through the redeemer's `usedSeqRecord`, voided only on
 * `NONE`), then `PaymentIntentService.voidDebt` — hold released in one ledger
 * transaction, nobody credited. So no void ever happens without its entry; a
 * crash part-way leaves the rest open, and asking again reports the ones done
 * as `NOT_A_DEBT`.
 */
@Injectable()
export class OperatorBuyerDebtService {
  private readonly logger = new Logger(OperatorBuyerDebtService.name);

  constructor(
    private readonly payments: PaymentIntentRepository,
    private readonly intents: PaymentIntentService,
    @Inject(VOUCHER_REDEEMER) private readonly redeemer: VoucherRedeemerPort,
    private readonly overrides: OverrideLogService,
    private readonly approvals: OperatorApprovalService,
  ) {
    approvals.register(DEBT_VOID_APPROVAL_ACTION, {
      code: DEBT_VOID_OVERRIDE_CODE,
      run: (requester, approver, payload, requestId) =>
        this.execute(requester, approver, payload as unknown as DebtVoidPayload, requestId),
    });
  }

  async list(query: ListOperatorBuyerDebtsQueryDto): Promise<OperatorBuyerDebtPageDto> {
    const filter: OperatorDebtFilter = {
      chainId: query.chainId,
      assetId: query.assetId,
      payerAccount: query.payerAccount,
      buyerOrganizationId: query.buyerOrganizationId,
      providerId: query.providerId,
      lastError: query.lastError,
      suggestedOnly: query.suggestedOnly,
    };
    const pageQuery = this.payments.operatorDebtsQuery(filter);
    applyTimeWindow(pageQuery, query, BUYER_DEBT_LIST);
    const totalsQuery = this.payments.operatorDebtsQuery(filter);
    applyTimeWindow(totalsQuery, query, BUYER_DEBT_LIST);

    const [page, byAsset] = await Promise.all([
      paginate(pageQuery, query, BUYER_DEBT_LIST),
      this.payments.operatorDebtTotals(totalsQuery),
    ]);
    return {
      items: page.items.map(toRow),
      pageInfo: page.pageInfo,
      totals: {
        count: byAsset.reduce((sum, total) => sum + total.count, 0),
        byAsset,
      },
    };
  }

  /**
   * Queues a bulk void for a second operator. Refused at once when an id is
   * not an open debt now or the ids span more than one asset; otherwise the
   * exact id list, asset and total are pinned in the approval's payload.
   */
  async requestVoid(request: DebtVoidRequest): Promise<ApprovalQueuedDto> {
    const ids = [...new Set(request.intentIds)].sort();
    if (ids.length === 0 || ids.length > DEBT_VOID_MAX_IDS) {
      throw OperatorErrors.debtVoidInvalid({
        detail: `between 1 and ${DEBT_VOID_MAX_IDS} intent ids per request`,
      });
    }
    const rows = await this.payments.findOperatorDebts(ids);
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw OperatorErrors.debtVoidInvalid({
        detail: `${missing.length} id(s) are not open buyer debts`,
        intentIds: missing,
      });
    }
    const assets = new Set(rows.map((row) => `${row.assetId}|${row.decimals}`));
    if (assets.size !== 1) {
      throw OperatorErrors.debtVoidInvalid({
        detail: 'one request voids debts of one asset; split it by asset',
      });
    }

    const payload: DebtVoidPayload = {
      intentIds: ids,
      assetId: rows[0].assetId,
      decimals: rows[0].decimals,
      count: ids.length,
      totalAmount: rows.reduce((sum, row) => sum + BigInt(row.priceAmount), 0n).toString(),
      reason: request.reason,
      ticketRef: request.ticketRef ?? null,
    };

    const queued = await this.approvals.orQueue(
      {
        action: DEBT_VOID_APPROVAL_ACTION,
        target: `${DEBT_VOID_TARGET}:${batchKey(ids)}`,
        payload: payload as unknown as Record<string, unknown>,
        requester: request.operator,
      },
      // Without an approver the register refuses before anything runs
      // (`M-1` is TWO_PERSON), having checked the requester's roles and
      // limit first; `orQueue` turns that refusal into the queued request.
      () => this.execute(request.operator, null, payload, null),
    );
    if (!(queued instanceof ApprovalQueuedDto)) {
      // Unreachable while `M-1` is TWO_PERSON: kept loud rather than silent.
      throw new Error('a bulk debt void ran without a second operator');
    }
    return queued;
  }

  /**
   * The approved request: the register entry and the approval commit first,
   * then each pinned id is voided or skipped with its reason.
   */
  private async execute(
    requester: OperatorSession,
    approver: OperatorApprover | null,
    payload: DebtVoidPayload,
    requestId: string | null,
  ): Promise<BuyerDebtVoidResultDto> {
    const ids = [...payload.intentIds];
    const pinned = {
      intentIds: ids,
      assetId: payload.assetId,
      decimals: payload.decimals,
      count: payload.count,
      totalAmount: payload.totalAmount,
    };
    await this.overrides.perform(
      {
        code: DEBT_VOID_OVERRIDE_CODE,
        actor: requester,
        approver,
        targetType: DEBT_VOID_TARGET,
        targetId: batchKey(ids),
        organizationId: null,
        reasonCode: DEBT_VOID_REASON_CODE,
        reason: payload.reason,
        ticketRef: payload.ticketRef,
        requestId,
        amountMinor: payload.totalAmount,
      },
      async () => ({
        value: null,
        before: { ...pinned, state: 'OPEN_BUYER_DEBT' },
        after: { ...pinned, state: 'APPROVED_FOR_VOID', outcome: OPERATOR_DEBT_VOID_OUTCOME },
      }),
    );

    // `approver` is set here: `perform` refuses a TWO_PERSON row without one.
    const approvalId = (approver as OperatorApprover).approvalId;
    const items: BuyerDebtVoidItemDto[] = [];
    let voidedAmount = 0n;
    for (const id of ids) {
      const { skipReason, amount } = await this.voidOne(id, payload.assetId);
      items.push({ intentId: id, result: skipReason ? 'SKIPPED' : 'VOIDED', skipReason });
      if (!skipReason) voidedAmount += amount;
    }
    const voidedCount = items.filter((item) => item.result === 'VOIDED').length;
    this.logger.warn(
      `M-1 approval ${approvalId}: voided ${voidedCount} of ${ids.length} buyer debts of ` +
        `${payload.assetId} (${voidedAmount} of ${payload.totalAmount} atomic); requested by ` +
        `${requester.subject}, approved by ${approver?.subject ?? 'unknown'}`,
    );
    return {
      approvalId,
      assetId: payload.assetId,
      decimals: payload.decimals,
      requestedCount: ids.length,
      requestedAmount: payload.totalAmount,
      voidedCount,
      voidedAmount: voidedAmount.toString(),
      items,
    };
  }

  /** One id: `null` skip reason when voided. Never throws. */
  private async voidOne(
    id: string,
    assetId: string,
  ): Promise<{ skipReason: DebtVoidSkipReason | null; amount: bigint }> {
    let row: PaymentIntentEntity | undefined;
    try {
      [row] = await this.payments.findOperatorDebts([id]);
    } catch (error) {
      this.logger.error(`M-1: intent ${id} could not be re-read: ${describe(error)}`);
      return { skipReason: 'CHANGED_UNDERNEATH', amount: 0n };
    }
    if (!row) return { skipReason: 'NOT_A_DEBT', amount: 0n };
    if (row.assetId !== assetId) return { skipReason: 'CHANGED_UNDERNEATH', amount: 0n };

    // A void RELEASES the hold, so the chain must not have taken this seq:
    // eip155 keeps a per-seq record (D-23) and only `NONE` is voidable.
    if (row.chainId.startsWith('eip155:')) {
      const request = toRedeemRequest(row);
      if (!request || !this.redeemer.usedSeqRecord) {
        return { skipReason: 'CHAIN_UNREADABLE', amount: 0n };
      }
      try {
        const record = await this.redeemer.usedSeqRecord(request);
        if (record !== 'NONE') {
          this.logger.warn(
            `M-1: intent ${id} (seq ${row.voucherSeq}) not voided: held(payer, seq) is ${record}`,
          );
          return { skipReason: 'SEQ_USED_ON_CHAIN', amount: 0n };
        }
      } catch (error) {
        this.logger.warn(`M-1: intent ${id}: held(payer, seq) unreadable: ${describe(error)}`);
        return { skipReason: 'CHAIN_UNREADABLE', amount: 0n };
      }
    }

    try {
      const voided = await this.intents.voidDebt(
        row.organizationId,
        id,
        OPERATOR_DEBT_VOID_OUTCOME,
      );
      return voided
        ? { skipReason: null, amount: BigInt(row.priceAmount) }
        : { skipReason: 'CHANGED_UNDERNEATH', amount: 0n };
    } catch (error) {
      this.logger.error(`M-1: intent ${id} could not be voided: ${describe(error)}`);
      return { skipReason: 'CHANGED_UNDERNEATH', amount: 0n };
    }
  }
}

/** Lapse time, newest first. `createdAt` also sortable. */
const BUYER_DEBT_LIST: ListSpec = {
  alias: 'intent',
  defaultSort: 'lapsedAt',
  sortable: {
    // Never null here: the list's own predicate requires a lapse.
    lapsedAt: {
      column: 'intent.redemption_lapsed_at',
      type: 'timestamptz',
      valueOf: asInstant((row: PaymentIntentEntity) => row.redemptionLapsedAt as Date),
    },
    createdAt: {
      column: 'intent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: PaymentIntentEntity) => row.createdAt),
    },
  },
  timeColumn: 'intent.redemption_lapsed_at',
};

function toRow(row: PaymentIntentEntity): OperatorBuyerDebtRowDto {
  const raw = row.redemptionLastError;
  const writtenOff = raw?.startsWith(UNCOLLECTED_PREFIX) ?? false;
  return {
    intentId: row.id,
    buyerOrganizationId: row.organizationId,
    payerAccount: row.agentAccount,
    providerId: row.providerId,
    providerAccount: row.providerAccount,
    chainId: row.chainId,
    assetId: row.assetId,
    decimals: row.decimals,
    amount: row.priceAmount,
    voucherSeq: row.voucherSeq,
    createdAt: row.createdAt,
    lapsedAt: row.redemptionLapsedAt as Date,
    lastError: raw && writtenOff ? raw.slice(UNCOLLECTED_PREFIX.length) : raw,
    writtenOff,
    suggestedPlatformCause: suggestsPlatformCause(raw),
  };
}

/** The voucher as the redeemer port reads it, or `null` when the row cannot name one. */
function toRedeemRequest(row: PaymentIntentEntity): RedeemVoucherRequest | null {
  if (
    !row.providerAccount ||
    !row.voucherResourceHash ||
    row.voucherSeq === null ||
    row.voucherIssuedAt === null ||
    !row.voucherSignature
  ) {
    return null;
  }
  return {
    payer: row.agentAccount as AccountId,
    provider: row.providerAccount as AccountId,
    amount: MoneyUtil.of(row.priceAmount, row.assetId as AssetId, row.decimals),
    asset: row.assetId as AssetId,
    resourceHash: row.voucherResourceHash,
    requestHash: row.requestHash,
    seq: row.voucherSeq,
    issuedAt: Number(row.voucherIssuedAt),
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    signature: row.voucherSignature,
    delegate: (row.voucherDelegate as AccountId | null) ?? null,
  };
}

/** A short, stable name for one exact id list (the approval's target). */
function batchKey(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join(','), 'utf8').digest('hex').slice(0, 32);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
