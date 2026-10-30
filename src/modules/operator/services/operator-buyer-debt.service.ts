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
  RedeemVoucherRequest,
  VOUCHER_REDEEMER,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { applyTimeWindow, asInstant, ListSpec, paginate } from '@shared/api';
import { MoneyUtil } from '@shared/utils/money.util';

import { BUYER_DEBT_BULK_VOID_ACTION } from '../domain/debt-void-visibility';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import {
  BuyerDebtVoidItemDto,
  BuyerDebtVoidOutcomeDto,
  BuyerDebtVoidRecordDto,
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

export const DEBT_VOID_APPROVAL_ACTION = BUYER_DEBT_BULK_VOID_ACTION;
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
 * `VoucherExpired` or `UNKNOWN_REVERT:*`, `uncollected:` looked through;
 * the same test as `OPERATOR_SUGGESTED_PLATFORM_CAUSE_SQL`. A label for the
 * operator, never a decision.
 */
export function suggestsPlatformCause(lastError: string | null): boolean {
  if (lastError === null) return false;
  const cause = lastError.startsWith(UNCOLLECTED_PREFIX)
    ? lastError.slice(UNCOLLECTED_PREFIX.length)
    : lastError;
  // Not `FeeSpikeDeferred`: a deferral is never written to a row (review
  // 2026-10-30 M-1), so a voucher that lapsed during a spike reads `VoucherExpired`.
  return cause === 'VoucherExpired' || cause.startsWith('UNKNOWN_REVERT:');
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
    // The raw list too, not only the distinct ids: the DTO's bound is on what
    // was sent, and a caller that skips the DTO must meet the same one.
    if (
      ids.length === 0 ||
      ids.length > DEBT_VOID_MAX_IDS ||
      request.intentIds.length > DEBT_VOID_MAX_IDS
    ) {
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
   *
   * The outcome is then kept WITH THE APPROVAL (`operator_approvals.result`,
   * review 2026-10-30 I-3), so it outlives the HTTP response: a console that
   * lost the response reads it back from `GET /operator/approvals/:id`, and the
   * activity feed shows its counts. Written AS IT GOES (review 2026-10-30
   * M-6): after every id, with `complete: false` and the ids not reached yet as
   * `NOT_ATTEMPTED`, so a process that dies mid-loop leaves the partial record
   * of what it did rather than `NULL`; and once more in the loop's `finally`,
   * `complete` once every id was reached. Nothing here depends on the client
   * still listening: the loop and the writes run to the end either way.
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
        // `approvalId` names the approval whose `result` holds what the void
        // did: the register is append-only, so the outcome cannot be added here.
        after: {
          ...pinned,
          state: 'APPROVED_FOR_VOID',
          outcome: OPERATOR_DEBT_VOID_OUTCOME,
          ...(approver ? { approvalId: approver.approvalId } : {}),
        },
      }),
    );

    // `approver` is set here: `perform` refuses a TWO_PERSON row without one.
    const approvalId = (approver as OperatorApprover).approvalId;
    const items: BuyerDebtVoidItemDto[] = [];
    let voidedAmount = 0n;
    let complete = false;
    try {
      for (const id of ids) {
        const { skipReason, amount } = await this.voidOne(id, payload.assetId);
        items.push({ intentId: id, result: skipReason ? 'SKIPPED' : 'VOIDED', skipReason });
        if (!skipReason) voidedAmount += amount;
        // Progress, kept as it goes (M-6); the last id is written by `finally`.
        if (items.length < ids.length) {
          await this.recordOutcome(approvalId, payload, items, voidedAmount, false, true);
        }
      }
      complete = true;
    } finally {
      await this.recordOutcome(approvalId, payload, items, voidedAmount, complete);
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

  /**
   * Keeps the outcome with the approval. Never throws: the voids are done, and
   * losing their summary must not hide the result the caller is about to get.
   * A `progress` write that fails is only logged at WARN: the next one, or the
   * final one, writes the whole record again.
   */
  private async recordOutcome(
    approvalId: string,
    payload: DebtVoidPayload,
    processed: readonly BuyerDebtVoidItemDto[],
    voidedAmount: bigint,
    complete: boolean,
    progress = false,
  ): Promise<void> {
    const reached = new Set(processed.map((item) => item.intentId));
    const items: BuyerDebtVoidItemDto[] = [
      ...processed,
      ...payload.intentIds
        .filter((id) => !reached.has(id))
        .map((id) => ({
          intentId: id,
          result: 'SKIPPED' as const,
          skipReason: 'NOT_ATTEMPTED' as const,
        })),
    ];
    const record = debtVoidRecord(approvalId, payload, items, voidedAmount, complete, new Date());
    const stored = await this.approvals.recordResult(
      approvalId,
      record as unknown as Record<string, unknown>,
    );
    if (!stored && progress) {
      this.logger.warn(
        `M-1 approval ${approvalId}: progress after ${processed.length} of ` +
          `${payload.intentIds.length} ids could not be kept; the next write retries`,
      );
    } else if (!stored) {
      this.logger.error(
        `M-1 approval ${approvalId}: the outcome (voided ${record.voidedCount}, skipped ` +
          `${record.skippedCount}${complete ? '' : ', incomplete'}) could not be kept with the approval`,
      );
    }
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

/** The persisted record of a bulk void: the approve result plus the skipped side. */
export function debtVoidRecord(
  approvalId: string,
  payload: DebtVoidPayload,
  items: readonly BuyerDebtVoidItemDto[],
  voidedAmount: bigint,
  complete: boolean,
  now: Date,
): BuyerDebtVoidRecordDto {
  const voidedCount = items.filter((item) => item.result === 'VOIDED').length;
  const requested = BigInt(payload.totalAmount);
  return {
    approvalId,
    assetId: payload.assetId,
    decimals: payload.decimals,
    requestedCount: payload.intentIds.length,
    requestedAmount: payload.totalAmount,
    voidedCount,
    voidedAmount: voidedAmount.toString(),
    skippedCount: payload.intentIds.length - voidedCount,
    skippedAmount: (requested > voidedAmount ? requested - voidedAmount : 0n).toString(),
    complete,
    recordedAt: now.toISOString(),
    items: [...items],
  };
}

/**
 * The counts and amounts of a persisted record, for the activity feed. `null`
 * when `result` is not one (still running, or another action's).
 */
export function debtVoidOutcome(result: unknown): BuyerDebtVoidOutcomeDto | null {
  const record = result as Partial<BuyerDebtVoidRecordDto> | null | undefined;
  if (
    !record ||
    typeof record.approvalId !== 'string' ||
    typeof record.voidedCount !== 'number' ||
    typeof record.skippedCount !== 'number'
  ) {
    return null;
  }
  return {
    approvalId: record.approvalId,
    assetId: String(record.assetId),
    decimals: Number(record.decimals),
    requestedCount: Number(record.requestedCount),
    requestedAmount: String(record.requestedAmount),
    voidedCount: record.voidedCount,
    voidedAmount: String(record.voidedAmount),
    skippedCount: record.skippedCount,
    skippedAmount: String(record.skippedAmount),
    complete: record.complete === true,
  };
}

/** A short, stable name for one exact id list (the approval's target). */
function batchKey(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join(','), 'utf8').digest('hex').slice(0, 32);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
