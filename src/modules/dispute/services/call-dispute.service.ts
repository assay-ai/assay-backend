import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, QueryRunner, SelectQueryBuilder } from 'typeorm';

import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { VerificationRecordEntity } from '@database/postgres/entities/verification-record.entity';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { collectionStateOf } from '@modules/payment/domain/collection';
import { HELD_PAYMENTS, HeldPaymentsPort } from '@modules/payment/ports/held-payments.port';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { EvidencePackService } from '@modules/verification/services/evidence-pack.service';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';
import { AuditLogWriter, auditActorOf } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { DISPUTE_FILING_GUARD_SECONDS } from '@modules/payment/constants/collection-hold.constants';

import {
  CALL_DISPUTE_CONFIG,
  CallDisputeConfig,
  DEFAULT_CALL_DISPUTE_CONFIG,
} from '../constants/call-dispute.config';
import {
  CALL_DISPUTE_HOLD_TIMEOUT_MS,
  CALL_DISPUTE_SLA,
  PROVIDER_REPLY_HOURS,
} from '../constants/call-dispute-sla.constants';
import {
  BuyerDisputeHistory,
  CALL_DISPUTE_REASON_LABEL,
  CallDisputeDecision,
  CallDisputeReason,
  DISPUTE_UPHELD_VOID_OUTCOME,
  RefundPlanKind,
  RefundSource,
  RefundState,
  UNDISPUTABLE_CALL_CLASSES,
  boundedBody,
  filingLimitFor,
  needsSecondOperator,
  planRefund,
  refundColumnsFor,
  withinFilingWindow,
} from '../domain/call-dispute';
import {
  BuyerDisputeHistoryDto,
  CallDisputeDetailDto,
  CallDisputeDto,
  CallDisputeSubjectType,
  CreateCallDisputeBodyDto,
  ListCallDisputesQueryDto,
  ListOperatorCallDisputesQueryDto,
  OperatorCallDisputeIntentDto,
  OperatorCallDisputeRowDto,
} from '../dto/call-dispute.dto';
import { DisputeState } from '../dto/dispute.dto';
import { DisputeErrors } from '../errors/dispute.errors';

const CALL_DISPUTE_LIST: ListSpec = {
  alias: 'dispute',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'dispute.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: DisputeEntity) => row.createdAt),
    },
  },
};

/** The target type a call dispute is logged under, in the audit and override logs. */
export const CALL_DISPUTE_TARGET = 'call_dispute';

/** Call classes a buyer pays for; the rest are never charged. */
const UNPAID_CALL_CLASSES = UNDISPUTABLE_CALL_CLASSES;

const DAY_MS = 24 * 60 * 60 * 1000;

export { PROVIDER_REPLY_HOURS };

/** Which side of a call dispute a notice is for: an organization may be both. */
export type CallDisputeRole = 'buyer' | 'provider';

/** What a dispute view needs beyond its row: the dials, and the call's hold. */
export interface CallDisputeViewContext {
  readonly filingWindowMs: number;
  readonly twoPersonThresholdUnits: string;
  /** The escrow hold's timeout, when the call's payment is held on chain. */
  readonly holdEndsAt: Date | null;
}

const DEFAULT_VIEW_CONTEXT: CallDisputeViewContext = Object.freeze({
  filingWindowMs: DEFAULT_CALL_DISPUTE_CONFIG.filingWindowMs,
  twoPersonThresholdUnits: DEFAULT_CALL_DISPUTE_CONFIG.twoPersonThresholdUnits,
  holdEndsAt: null,
});

/** What a decision needs from its caller — the operator side owns who may decide. */
export interface CallDisputeDecisionInput {
  readonly disputeId: string;
  readonly decision: CallDisputeDecision;
  readonly note: string;
  readonly operatorId: string;
  /** The second operator, on a two-person decision. */
  readonly approverOperatorId?: string | null;
  /** `AUTO_PLATFORM_MISS` for the SLA's auto-uphold; an operator's otherwise. */
  readonly resolutionKind?: 'ADJUDICATOR' | 'AUTO_PLATFORM_MISS';
}

/** What the operator side needs to route a decision before taking it. */
export interface CallDisputeDecisionContext {
  readonly dispute: DisputeEntity;
  /** The amount an upheld decision would owe, minor units. */
  readonly amountMinor: string;
  readonly needsSecondOperator: boolean;
}

export interface CallDisputeDecisionResult {
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/**
 * Buyer disputes over one paid call (G3.B1): filing, the provider's one reply,
 * the operator's decision and the refund. See `../domain/call-dispute.ts` for
 * where an upheld refund's money comes from.
 *
 * ## Idempotency of the money step
 *
 * A decision is a compare-and-swap of the dispute from `OPEN`, inside the
 * operator's override transaction. An upheld decision that voids a debt is
 * written as `refund_state = PENDING` there, and the ledger step runs after the
 * commit ({@link settleRefund}) through `PaymentIntentService.voidDebt`, which
 * is itself conditional on the row still being that debt, under the payer's
 * lock. A crash in between leaves a `PENDING` row; deciding it again (same
 * decision) runs only the money step, and a second run releases nothing twice
 * — the ledger refuses a second release of one hold, and `voidDebt` matches
 * nothing once the mark is written.
 */
@Injectable()
export class CallDisputeService {
  private readonly logger = new Logger(CallDisputeService.name);

  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly disputes: DisputeRepository,
    private readonly paymentIntents: PaymentIntentRepository,
    private readonly verificationRecords: VerificationRecordRepository,
    private readonly intents: PaymentIntentService,
    private readonly evidence: EvidencePackService,
    private readonly audit: AuditLogWriter,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(CALL_DISPUTE_CONFIG) private readonly config: CallDisputeConfig,
    // Whether the escrow hold is live on the call's chain (review P2-1).
    // Required: an absent port would quietly file every rail-B report unheld.
    @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort,
  ) {}

  // ── Buyer ───────────────────────────────────────────────────────────────

  async file(
    session: McpSession,
    body: CreateCallDisputeBodyDto,
    now: Date = new Date(),
  ): Promise<CallDisputeDetailDto> {
    const organizationId = session.organizationId;
    const { intent, record } = await this.resolveCall(organizationId, body);

    if (intent.status !== 'SETTLED') {
      throw DisputeErrors.callNotDisputable({ reason: 'the call was not charged' });
    }
    if (UNPAID_CALL_CLASSES.has(intent.callClass) || BigInt(intent.priceAmount) === 0n) {
      throw DisputeErrors.callNotDisputable({ reason: 'the call was free' });
    }
    if (!intent.providerId || intent.providerId === organizationId) {
      throw DisputeErrors.callNotDisputable({ reason: 'the call has no other provider' });
    }

    const settledAt = record?.settledAt ?? intent.updatedAt;
    if (!withinFilingWindow(settledAt, now, this.config.filingWindowMs)) {
      throw DisputeErrors.filingWindowClosed({
        closedAt: new Date(settledAt.getTime() + this.config.filingWindowMs).toISOString(),
      });
    }

    // One dispute per call, ever decided (review P2-2): a second could flip a
    // decided outcome or restore its amount twice.
    const decided = await this.disputes.findOneBy({
      organizationId,
      intentId: intent.id,
      state: In([DisputeState.UPHELD, DisputeState.REJECTED]),
    });
    if (decided) throw DisputeErrors.alreadyDecided({ id: decided.id });

    const snapshot = await this.snapshot(organizationId, intent, record, now, settledAt);
    const actor = auditActorOf(session);

    const entity = new DisputeEntity();
    Object.assign(entity, {
      organizationId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      providerId: null,
      state: DisputeState.OPEN,
      claimType: body.reason,
      reason: body.note?.trim() ?? '',
      evidence: [],
      openedBy: session.agentId,
      intentId: intent.id,
      verdictId: record?.id ?? null,
      bindingId: intent.bindingId,
      toolId: intent.toolId,
      respondentProviderId: intent.providerId,
      evidenceSnapshot: snapshot,
      assetId: intent.assetId,
      decimals: intent.decimals,
      // The SLA's first step: the provider's 24 hours to reply.
      slaDueAt: new Date(now.getTime() + PROVIDER_REPLY_HOURS * 3_600_000),
    });

    try {
      await this.dataSource.transaction(async (manager) => {
        // One filer at a time per buyer, so the daily limit is exact.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `call-dispute:${organizationId}`,
        ]);
        const history = await this.history(manager, organizationId, now);
        const limit = filingLimitFor(history, this.config);
        if (history.filedLastDay >= limit.limit) {
          throw DisputeErrors.rateLimited({ limit: limit.limit, flagged: limit.flagged });
        }
        // Inside the dispute hold, the voucher is set aside before anything can
        // reach the chain: a refund is then guaranteed. After it, the dispute is
        // a quality signal (see `../domain/call-dispute.ts`).
        // Per (buyer, provider), under the buyer's lock above (review P2-1 of
        // the second pass): no buyer can fill another buyer's allowance.
        const [against] = (await manager.query(
          `SELECT count(*)::int AS "filed" FROM "disputes"
            WHERE "organization_id" = $1 AND "respondent_provider_id" = $2
              AND "intent_id" IS NOT NULL AND "created_at" > $3`,
          [organizationId, intent.providerId, new Date(now.getTime() - DAY_MS)],
        )) as { filed: number }[];
        if (Number(against?.filed ?? 0) >= this.config.maxPerProviderPerDay) {
          throw DisputeErrors.rateLimited({
            limit: this.config.maxPerProviderPerDay,
            scope: 'provider',
          });
        }
        // Guaranteed only where the hold is real (review P2-1): rail B needs the
        // escrow hold live on the call's chain; rail A's hold is the ledger's.
        const holdIsLive =
          intent.rail !== 'RAIL_B_VOUCHER' || (await this.held.holdLive(intent.assetId as AssetId));
        entity.refundGuaranteed =
          holdIsLive &&
          (await this.paymentIntents.holdForDispute(
            manager,
            { organizationId, id: intent.id, payer: intent.agentAccount },
            DISPUTE_FILING_GUARD_SECONDS,
          ));
        await manager.save(entity);
        await this.audit.record(manager, {
          organizationId,
          actor,
          action: 'call_dispute.filed',
          resourceType: CALL_DISPUTE_TARGET,
          resourceId: entity.id,
          after: {
            intentId: intent.id,
            reason: body.reason,
            refundGuaranteed: entity.refundGuaranteed,
          },
        });
      });
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        const open = await this.disputes.findOneBy({
          organizationId,
          intentId: intent.id,
          state: DisputeState.OPEN,
        });
        throw DisputeErrors.alreadyOpen({ id: open?.id });
      }
      throw error;
    }

    await this.notify(
      intent.providerId,
      'provider',
      NotificationEvent.CALL_DISPUTE_OPENED,
      entity,
      providerOpenedNotice(entity, CALL_DISPUTE_REASON_LABEL[body.reason], this.viewContext(null)),
    );

    return this.detailOf(entity);
  }

  async listForBuyer(
    organizationId: string,
    query: ListCallDisputesQueryDto,
  ): Promise<CursorPageDto<CallDisputeDto>> {
    const qb = this.disputes
      .createQueryBuilder('dispute')
      .where('dispute.organizationId = :organizationId', { organizationId })
      .andWhere('dispute.intentId IS NOT NULL');
    this.applyFilters(qb, query);
    return this.pageOf(await paginate(qb, query, CALL_DISPUTE_LIST));
  }

  async getForBuyer(organizationId: string, id: string): Promise<CallDisputeDetailDto> {
    return this.detailOf(await this.requireForBuyer(organizationId, id));
  }

  async withdraw(session: McpSession, id: string): Promise<CallDisputeDto> {
    const organizationId = session.organizationId;
    const dispute = await this.requireForBuyer(organizationId, id);
    await this.dataSource.transaction(async (manager) => {
      const rows = returned(
        await manager.query(
          `UPDATE "disputes" SET "state" = 'WITHDRAWN', "updated_at" = now()
            WHERE "organization_id" = $1 AND "id" = $2 AND "state" = 'OPEN'
            RETURNING "id"`,
          [organizationId, id],
        ),
      );
      if (rows.length === 0) throw DisputeErrors.notWithdrawable({ state: dispute.state });
      // A voucher the dispute held goes back to the redemption queue.
      await this.paymentIntents.setDisputeOutcome(
        manager,
        organizationId,
        dispute.intentId as string,
        null,
        true,
      );
      await this.audit.record(manager, {
        organizationId,
        actor: auditActorOf(session),
        action: 'call_dispute.withdrawn',
        resourceType: CALL_DISPUTE_TARGET,
        resourceId: id,
        before: { state: dispute.state },
        after: { state: DisputeState.WITHDRAWN },
      });
    });
    return this.viewOf(await this.requireForBuyer(organizationId, id));
  }

  // ── Provider ────────────────────────────────────────────────────────────

  /** `providerId == organizationId` for a provider session. Cross-tenant on purpose. */
  async listForProvider(
    providerId: string,
    query: ListCallDisputesQueryDto,
  ): Promise<CursorPageDto<CallDisputeDto>> {
    const qb = this.crossTenant().andWhere('dispute.respondentProviderId = :providerId', {
      providerId,
    });
    this.applyFilters(qb, query);
    return this.pageOf(await paginate(qb, query, CALL_DISPUTE_LIST));
  }

  async getForProvider(providerId: string, id: string): Promise<CallDisputeDetailDto> {
    return this.detailOf(await this.requireForProvider(providerId, id));
  }

  /** The provider's one reply. Refused once it has replied, or once the dispute is closed. */
  async respond(session: McpSession, id: string, response: string): Promise<CallDisputeDetailDto> {
    const providerId = session.organizationId;
    const dispute = await this.requireForProvider(providerId, id);
    await this.dataSource.transaction(async (manager) => {
      const rows = returned(
        await manager.query(
          `UPDATE "disputes"
              SET "provider_response" = $3, "provider_responded_at" = now(), "updated_at" = now()
            WHERE "id" = $1 AND "respondent_provider_id" = $2 AND "state" = 'OPEN'
              AND "provider_response" IS NULL
              AND "created_at" > now() - interval '${PROVIDER_REPLY_HOURS} hours'
            RETURNING "id"`,
          [id, providerId, response.trim()],
        ),
      );
      if (rows.length === 0) throw DisputeErrors.alreadyResponded({ id });
      await this.audit.record(manager, {
        organizationId: providerId,
        actor: { type: 'provider', id: providerId },
        action: 'call_dispute.responded',
        resourceType: CALL_DISPUTE_TARGET,
        resourceId: id,
      });
    });
    await this.notify(
      dispute.organizationId,
      'buyer',
      NotificationEvent.CALL_DISPUTE_RESPONDED,
      dispute,
      {
        title: 'The provider replied to your dispute',
        body: 'The provider of a call you disputed has replied. An operator will decide.',
      },
    );
    return this.detailOf(await this.requireForProvider(providerId, id));
  }

  // ── Operator ────────────────────────────────────────────────────────────

  async listForOperator(
    query: ListOperatorCallDisputesQueryDto,
    now: Date = new Date(),
  ): Promise<CursorPageDto<OperatorCallDisputeRowDto>> {
    const qb = this.crossTenant();
    this.applyFilters(qb, query);
    if (query.buyerOrganizationId) {
      qb.andWhere('dispute.organizationId = :buyer', { buyer: query.buyerOrganizationId });
    }
    if (query.providerId) {
      qb.andWhere('dispute.respondentProviderId = :provider', { provider: query.providerId });
    }
    if (query.refundState) {
      qb.andWhere('dispute.refundState = :refundState', { refundState: query.refundState });
    }
    if (query.flaggedOnly) {
      qb.andWhere(
        `(SELECT count(*) FROM disputes h
           WHERE h.organization_id = dispute.organization_id AND h.intent_id IS NOT NULL
             AND h.state = 'REJECTED' AND h.resolved_at > :since30) >= :threshold
         AND (SELECT count(*) FROM disputes h
               WHERE h.organization_id = dispute.organization_id AND h.intent_id IS NOT NULL
                 AND h.state = 'REJECTED' AND h.resolved_at > :since30)
           > (SELECT count(*) FROM disputes h
               WHERE h.organization_id = dispute.organization_id AND h.intent_id IS NOT NULL
                 AND h.state = 'UPHELD' AND h.resolved_at > :since30)`,
        {
          since30: new Date(now.getTime() - 30 * DAY_MS),
          threshold: this.config.abuseRejectedThreshold,
        },
      );
    }
    const page = await paginate(qb, query, CALL_DISPUTE_LIST);
    const buyers = [...new Set(page.items.map((row) => row.organizationId))];
    const histories = new Map<string, BuyerDisputeHistoryDto>();
    for (const buyer of buyers) {
      histories.set(buyer, await this.buyerHistory(buyer, now));
    }
    const holds = await this.holdEndsOf(page.items);
    return page.map((row) =>
      this.toOperatorRow(row, histories.get(row.organizationId)!, holds.get(row.id) ?? null),
    );
  }

  async buyerHistory(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<BuyerDisputeHistoryDto> {
    const history = await this.history(this.dataSource.manager, organizationId, now);
    const limit = filingLimitFor(history, this.config);
    return { ...history, flagged: limit.flagged, dailyLimit: limit.limit };
  }

  /** The raw row, any tenant — the operator console reads across buyers. */
  async requireAny(id: string): Promise<DisputeEntity> {
    const dispute = await this.crossTenant().andWhere('dispute.id = :id', { id }).getOne();
    if (!dispute) throw DisputeErrors.disputeNotFound({ id });
    return dispute;
  }

  async operatorRow(dispute: DisputeEntity): Promise<OperatorCallDisputeRowDto> {
    const holds = await this.holdEndsOf([dispute]);
    return this.toOperatorRow(
      dispute,
      await this.buyerHistory(dispute.organizationId),
      holds.get(dispute.id) ?? null,
    );
  }

  /** The call as it stands now, and what an upheld decision would do to it. */
  async intentSummary(dispute: DisputeEntity): Promise<OperatorCallDisputeIntentDto | null> {
    const intent = await this.paymentIntents.findOneBy({
      organizationId: dispute.organizationId,
      id: dispute.intentId as string,
    });
    if (!intent) return null;
    return {
      status: intent.status,
      rail: intent.rail,
      callClass: intent.callClass,
      price: money(intent.priceAmount, intent.assetId, intent.decimals) as MoneyDto,
      collectionState: collectionStateOf(intent),
      refundPlan: planRefund(intent),
    };
  }

  /** Read before routing a decision: the amount at stake and whether two people are needed. */
  async decisionContext(
    disputeId: string,
    decision: CallDisputeDecision,
  ): Promise<CallDisputeDecisionContext> {
    const dispute = await this.requireAny(disputeId);
    const amountMinor = disputedAmountOf(dispute);
    return {
      dispute,
      amountMinor,
      needsSecondOperator:
        decision === CallDisputeDecision.UPHOLD &&
        needsSecondOperator(
          amountMinor,
          dispute.decimals ?? 6,
          this.config.twoPersonThresholdUnits,
        ),
    };
  }

  /**
   * The decision, inside the caller's transaction (the operator override
   * log's). A compare-and-swap from `OPEN`: a second decision, or one racing a
   * withdrawal, matches nothing and is refused. Marks the call and its verdict
   * with the outcome in the same transaction.
   */
  async decideWithin(
    queryRunner: QueryRunner,
    input: CallDisputeDecisionInput,
  ): Promise<CallDisputeDecisionResult> {
    const manager = queryRunner.manager;
    const [locked] = (await manager.query(
      `SELECT "id", "organization_id", "state", "intent_id", "verdict_id"
         FROM "disputes" WHERE "id" = $1 AND "intent_id" IS NOT NULL FOR UPDATE`,
      [input.disputeId],
    )) as Array<{
      id: string;
      organization_id: string;
      state: string;
      intent_id: string;
      verdict_id: string | null;
    }>;
    if (!locked) throw DisputeErrors.disputeNotFound({ id: input.disputeId });
    if (locked.state !== DisputeState.OPEN) {
      throw DisputeErrors.notDecidable({ state: locked.state });
    }

    const intent = await manager.findOneBy(PaymentIntentEntity, {
      organizationId: locked.organization_id,
      id: locked.intent_id,
    });
    if (!intent) throw DisputeErrors.disputeNotFound({ id: input.disputeId });
    const amount = intent.settledAmount ?? intent.priceAmount;

    let state: DisputeState;
    let refund: { source: RefundSource; state: RefundState } | null = null;
    if (input.decision === CallDisputeDecision.UPHOLD) {
      state = DisputeState.UPHELD;
      refund = refundColumnsFor(planRefund(intent));
      if (!refund) throw DisputeErrors.collectionInProgress({});
    } else {
      state = DisputeState.REJECTED;
      // Refunded already (a blocked provider's held payment): rejecting the
      // dispute does not un-refund it, and the dispute keeps saying so.
      if (planRefund(intent) === RefundPlanKind.ALREADY_REFUNDED) {
        refund = refundColumnsFor(RefundPlanKind.ALREADY_REFUNDED);
      }
    }
    const owes = refund !== null && refund.source !== RefundSource.NONE;
    const restored = refund?.state === RefundState.REFUNDED ? amount : null;
    const outcome = state === DisputeState.UPHELD ? 'UPHELD' : 'REJECTED';
    const seconded = input.approverOperatorId ?? null;

    await manager.query(
      `UPDATE "disputes"
          SET "state" = $2, "resolved_at" = now(), "resolved_by" = $3, "resolution_note" = $4,
              "resolution_kind" = $10, "refund_source" = $5, "refund_state" = $6,
              "refund_amount" = $7, "restored_amount" = $8,
              "seconded_by_operator_id" = $9::uuid,
              "seconded_at" = CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END,
              "second_kind" = CASE WHEN $9::uuid IS NULL THEN NULL ELSE 'SIGNED' END,
              "updated_at" = now()
        WHERE "id" = $1 AND "state" = 'OPEN'`,
      [
        input.disputeId,
        state,
        input.operatorId,
        input.note,
        refund?.source ?? null,
        refund?.state ?? null,
        owes ? amount : null,
        restored,
        seconded,
        input.resolutionKind ?? 'ADJUDICATOR',
      ],
    );
    await manager.query(
      `UPDATE "payment_intents" SET "dispute_outcome" = $3
        WHERE "organization_id" = $1 AND "id" = $2
          AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'OPEN')`,
      [locked.organization_id, locked.intent_id, outcome],
    );
    if (locked.verdict_id) {
      await manager.query(
        `UPDATE "verification_records" SET "dispute_outcome" = $3
          WHERE "organization_id" = $1 AND "id" = $2
            AND ("dispute_outcome" IS NULL OR "dispute_outcome" = 'OPEN')`,
        [locked.organization_id, locked.verdict_id, outcome],
      );
    }

    return {
      before: { state: locked.state },
      after: {
        state,
        refundSource: refund?.source ?? null,
        refundState: refund?.state ?? null,
        refundAmount: owes ? amount : null,
      },
    };
  }

  /**
   * The money step of an upheld decision, after its transaction committed.
   * Idempotent: see the class comment. Returns the dispute as it now stands.
   */
  async settleRefund(
    disputeId: string,
    options: { readonly chain?: boolean } = {},
  ): Promise<DisputeEntity> {
    const dispute = await this.requireAny(disputeId);
    // Rejected: `dispute_outcome = 'REJECTED'` puts the held payment back in
    // the collection job's queue; it is collected on its next pass.
    if (dispute.state !== DisputeState.UPHELD || dispute.refundState !== RefundState.PENDING) {
      return dispute;
    }
    const intentId = dispute.intentId as string;
    let intent = await this.mustFindIntent(dispute.organizationId, intentId);

    const first = planRefund(intent);
    if (first === RefundPlanKind.RELEASE_HELD) {
      // Rail B is `refundHeld` on chain, which only the REDEEMER may send — the
      // scheduler's key (review P1-2). The API leaves it PENDING and the
      // scheduler's refund job sends it, retried with back-off. Rail A is the
      // withheld credit released, in the ledger, anywhere.
      if (intent.rail === 'RAIL_B_VOUCHER' && !options.chain) return dispute;
      try {
        const result = await this.intents.refundHeldForDispute(
          dispute.organizationId,
          intentId,
          DISPUTE_UPHELD_VOID_OUTCOME,
        );
        if (result === 'TIMED_OUT') {
          // `refundHeld` is closed; nothing to send until someone collects it.
          await this.paymentIntents.recordHeldFailure(
            dispute.organizationId,
            intentId,
            'refund closed: past the chain timeout',
          );
          return dispute;
        }
      } catch (error) {
        await this.paymentIntents.recordHeldFailure(
          dispute.organizationId,
          intentId,
          (error as Error).message,
        );
        this.logger.warn(
          `Call dispute ${disputeId}: refund failed, retried: ${(error as Error).message}`,
        );
        return dispute;
      }
      intent = await this.mustFindIntent(dispute.organizationId, intentId);
    } else if (first === RefundPlanKind.VOID_DEBT) {
      await this.intents.voidDebt(dispute.organizationId, intentId, DISPUTE_UPHELD_VOID_OUTCOME);
      intent = await this.mustFindIntent(dispute.organizationId, intentId);
    }

    const plan = planRefund(intent);
    const columns = refundColumnsFor(plan);
    if (!columns || columns.state === RefundState.PENDING) {
      // The debt changed under us (a replacement voucher in flight): stays
      // PENDING, and deciding again finishes it once collection has settled.
      this.logger.warn(`Call dispute ${disputeId}: refund still pending (${plan})`);
      return dispute;
    }

    const amount = dispute.refundAmount ?? intent.settledAmount ?? intent.priceAmount;
    await this.dataSource.query(
      `UPDATE "disputes"
          SET "refund_source" = $2, "refund_state" = $3,
              "refund_amount" = $4, "restored_amount" = $5, "updated_at" = now()
        WHERE "id" = $1 AND "refund_state" = 'PENDING'`,
      [
        disputeId,
        columns.source,
        columns.state,
        columns.source === RefundSource.NONE ? null : amount,
        columns.state === RefundState.REFUNDED ? amount : null,
      ],
    );
    return this.requireAny(disputeId);
  }

  /** Tell both sides. Best-effort: the decision stands whether or not this lands. */
  async announceDecision(dispute: DisputeEntity): Promise<void> {
    const upheld = dispute.state === DisputeState.UPHELD;
    const refund = describeRefund(dispute.refundState);
    await this.notify(
      dispute.organizationId,
      'buyer',
      NotificationEvent.CALL_DISPUTE_DECIDED,
      dispute,
      {
        title: upheld ? 'Your dispute was upheld' : 'Your dispute was rejected',
        body: upheld
          ? `Your dispute over a call was upheld. ${refund}`
          : `Your dispute over a call was rejected.${
              dispute.refundState === RefundState.REFUNDED
                ? ' The call was refunded anyway: its provider was blocked.'
                : ''
            }`,
      },
    );
    await this.notify(
      dispute.respondentProviderId as string,
      'provider',
      NotificationEvent.CALL_DISPUTE_DECIDED,
      dispute,
      {
        title: upheld
          ? 'A dispute over your call was upheld'
          : 'A dispute over your call was rejected',
        body: upheld
          ? 'A buyer’s dispute over a call you served was upheld; it counts against the ' +
            `tool’s quality. ${refund}`
          : 'A buyer’s dispute over a call you served was rejected.',
      },
    );
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async resolveCall(
    organizationId: string,
    body: CreateCallDisputeBodyDto,
  ): Promise<{ intent: PaymentIntentEntity; record: VerificationRecordEntity | null }> {
    const notFound = () =>
      DisputeErrors.subjectNotFound({ subjectType: body.subjectType, subjectId: body.subjectId });

    let intentId = body.subjectId;
    if (body.subjectType === CallDisputeSubjectType.VERDICT) {
      const record = await this.verificationRecords.findOneBy({
        organizationId,
        id: body.subjectId,
      });
      if (!record) throw notFound();
      intentId = record.intentId;
    }
    const intent = await this.paymentIntents.findOneBy({ organizationId, id: intentId });
    if (!intent) throw notFound();
    const record = await this.verificationRecords.findByIntentId(organizationId, intent.id);
    return { intent, record };
  }

  /**
   * What the decision rests on, frozen now: the call, its verdict, and its
   * input and output from the sealed evidence pack — or from the verdict
   * record when there is no pack — while retention still keeps them.
   */
  private async snapshot(
    organizationId: string,
    intent: PaymentIntentEntity,
    record: VerificationRecordEntity | null,
    now: Date,
    settledAt: Date,
  ): Promise<Record<string, unknown>> {
    const max = this.config.snapshotMaxBytes;
    let request: unknown = record?.request ?? null;
    let response: unknown = record?.response ?? null;
    let pack: Record<string, unknown> | null = null;
    if (record) {
      try {
        const view = await this.evidence.forBuyer(organizationId, record.id);
        if (view) {
          request = view.request ?? request;
          response = view.response ?? response;
          pack = {
            contentHash: view.integrity.contentHash,
            sealedAt: view.integrity.sealedAt,
            bodyState: view.integrity.bodyState,
            bodyDigests: view.bodyDigests,
          };
        }
      } catch (error) {
        // A pack that fails its hash is not evidence; the record still is.
        this.logger.error(
          `Call dispute on intent ${intent.id}: evidence pack unreadable: ${(error as Error).message}`,
        );
        pack = { unreadable: true };
      }
    }
    return {
      capturedAt: now.toISOString(),
      call: {
        intentId: intent.id,
        toolId: intent.toolId,
        bindingId: intent.bindingId,
        providerId: intent.providerId,
        status: intent.status,
        rail: intent.rail,
        callClass: intent.callClass,
        amount: intent.settledAmount ?? intent.priceAmount,
        assetId: intent.assetId,
        decimals: intent.decimals,
        createdAt: intent.createdAt.toISOString(),
        // The instant the filing window was measured from (`file`), kept so
        // every view states the same `filingClosesAt` the filing checked.
        settledAt: settledAt.toISOString(),
      },
      verdict: record
        ? {
            id: record.id,
            status: record.verdictStatus,
            reasonCode: record.reasonCode,
            reason: record.reason,
            score: record.score,
            settlementOutcome: record.settlementOutcome,
            evaluatedAt: record.evaluatedAt?.toISOString() ?? null,
            settledAt: record.settledAt?.toISOString() ?? null,
          }
        : null,
      request: boundedBody(request, max),
      response: boundedBody(response, max),
      evidencePack: pack,
    };
  }

  private async history(
    manager: EntityManager,
    organizationId: string,
    now: Date,
  ): Promise<BuyerDisputeHistory> {
    const [row] = (await manager.query(
      `SELECT count(*) FILTER (WHERE "created_at" > $2)::int AS "filedLastDay",
              count(*) FILTER (WHERE "state" = 'UPHELD' AND "resolved_at" > $3)::int
                AS "upheldLast30Days",
              count(*) FILTER (WHERE "state" = 'REJECTED' AND "resolved_at" > $3)::int
                AS "rejectedLast30Days"
         FROM "disputes"
        WHERE "organization_id" = $1 AND "intent_id" IS NOT NULL`,
      [organizationId, new Date(now.getTime() - DAY_MS), new Date(now.getTime() - 30 * DAY_MS)],
    )) as BuyerDisputeHistory[];
    return {
      filedLastDay: Number(row?.filedLastDay ?? 0),
      upheldLast30Days: Number(row?.upheldLast30Days ?? 0),
      rejectedLast30Days: Number(row?.rejectedLast30Days ?? 0),
    };
  }

  private applyFilters(
    qb: SelectQueryBuilder<DisputeEntity>,
    query: ListCallDisputesQueryDto,
  ): void {
    applyTimeWindow(qb, query, CALL_DISPUTE_LIST);
    if (query.state?.length) qb.andWhere('dispute.state IN (:...states)', { states: query.state });
    if (query.reason) qb.andWhere('dispute.claimType = :reason', { reason: query.reason });
    if (query.intentId) qb.andWhere('dispute.intentId = :intentId', { intentId: query.intentId });
  }

  /**
   * Deliberately cross-organization: the provider and the operator read rows
   * that belong to the buying tenant. `organizationId IS NOT NULL` satisfies
   * the scoped repository's guard and scopes nothing — the caller's own
   * predicate does, as in `ProviderTrafficService`.
   */
  private crossTenant(): SelectQueryBuilder<DisputeEntity> {
    return this.disputes
      .createQueryBuilder('dispute')
      .where('dispute.organizationId IS NOT NULL')
      .andWhere('dispute.intentId IS NOT NULL');
  }

  private async requireForBuyer(organizationId: string, id: string): Promise<DisputeEntity> {
    const dispute = await this.disputes.findOneBy({ organizationId, id });
    if (!dispute || !dispute.intentId) throw DisputeErrors.disputeNotFound({ id });
    return dispute;
  }

  private async requireForProvider(providerId: string, id: string): Promise<DisputeEntity> {
    const dispute = await this.crossTenant()
      .andWhere('dispute.id = :id', { id })
      .andWhere('dispute.respondentProviderId = :providerId', { providerId })
      .getOne();
    if (!dispute) throw DisputeErrors.disputeNotFound({ id });
    return dispute;
  }

  private async mustFindIntent(organizationId: string, id: string): Promise<PaymentIntentEntity> {
    const intent = await this.paymentIntents.findOneBy({ organizationId, id });
    if (!intent) throw DisputeErrors.disputeNotFound({ id });
    return intent;
  }

  private toOperatorRow(
    dispute: DisputeEntity,
    history: BuyerDisputeHistoryDto,
    holdEndsAt: Date | null,
  ): OperatorCallDisputeRowDto {
    return {
      ...toDto(dispute, this.viewContext(holdEndsAt)),
      buyerOrganizationId: dispute.organizationId,
      buyerHistory: history,
      needsSecondOperator: needsSecondOperator(
        disputedAmountOf(dispute),
        dispute.decimals ?? 6,
        this.config.twoPersonThresholdUnits,
      ),
    };
  }

  // ── Views ──────────────────────────────────────────────────────────────

  private viewContext(holdEndsAt: Date | null): CallDisputeViewContext {
    return {
      filingWindowMs: this.config.filingWindowMs,
      twoPersonThresholdUnits: this.config.twoPersonThresholdUnits,
      holdEndsAt,
    };
  }

  private async viewOf(row: DisputeEntity): Promise<CallDisputeDto> {
    const holds = await this.holdEndsOf([row]);
    return toDto(row, this.viewContext(holds.get(row.id) ?? null));
  }

  private async detailOf(row: DisputeEntity): Promise<CallDisputeDetailDto> {
    const holds = await this.holdEndsOf([row]);
    return toDetail(row, this.viewContext(holds.get(row.id) ?? null));
  }

  private async pageOf(page: CursorPageDto<DisputeEntity>): Promise<CursorPageDto<CallDisputeDto>> {
    const holds = await this.holdEndsOf(page.items);
    return page.map((row) => toDto(row, this.viewContext(holds.get(row.id) ?? null)));
  }

  /**
   * Per dispute, when its call's escrow hold times out — only while a rail-B
   * payment is still HELD on chain (`collectable_at + HELD_TIMEOUT_SECONDS`).
   * Rail A's withheld credit has no chain timeout. One query per page.
   */
  private async holdEndsOf(rows: readonly DisputeEntity[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    const wanted = rows.filter((row) => row.intentId);
    if (wanted.length === 0) return out;
    const held = (await this.dataSource.query(
      `SELECT "id", "organization_id" AS "organizationId", "collectable_at" AS "collectableAt"
         FROM "payment_intents"
        WHERE "id" = ANY($1::uuid[]) AND "rail" = 'RAIL_B_VOUCHER'
          AND "held_status" = 'HELD' AND "collectable_at" IS NOT NULL`,
      [wanted.map((row) => row.intentId)],
    )) as { id: string; organizationId: string; collectableAt: Date }[];
    const byIntent = new Map(held.map((row) => [`${row.organizationId}:${row.id}`, row]));
    for (const row of wanted) {
      const intent = byIntent.get(`${row.organizationId}:${row.intentId}`);
      if (intent) {
        out.set(
          row.id,
          new Date(new Date(intent.collectableAt).getTime() + CALL_DISPUTE_HOLD_TIMEOUT_MS),
        );
      }
    }
    return out;
  }

  private async notify(
    organizationId: string,
    role: CallDisputeRole,
    event: NotificationEvent,
    dispute: DisputeEntity,
    message: { title: string; body: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.notifications.notify({
        organizationId,
        event,
        title: message.title,
        body: message.body,
        subjectType: CALL_DISPUTE_TARGET,
        subjectId: dispute.id,
        dedupeKey: `${event}:${dispute.id}:${organizationId}:${role}`,
        payload: {
          disputeId: dispute.id,
          intentId: dispute.intentId,
          state: dispute.state,
          refundState: dispute.refundState,
          role,
          ...message.payload,
        },
      });
    } catch (error) {
      this.logger.error(
        `Call dispute ${dispute.id}: could not notify ${organizationId}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * The provider's notice for a new report. The reply has a deadline, and
 * silence has a consequence, so both are in the sentence: "You may reply once"
 * read as optional while a silent provider loses the report.
 */
export function providerOpenedNotice(
  dispute: DisputeEntity,
  reasonLabel: string,
  context: CallDisputeViewContext = DEFAULT_VIEW_CONTEXT,
): { title: string; body: string; payload: Record<string, unknown> } {
  const { replyDueAt, autoUpholdAt } = slaTimesOf(dispute, context);
  // Never a promised outcome: the daily auto-uphold cap can hand the report
  // to an operator, who may reject it.
  const consequence = autoUpholdAt
    ? `If you stay silent, it can be upheld automatically from ${utcMinute(autoUpholdAt)}.`
    : 'If you stay silent, an operator decides it without your side.';
  return {
    title: `A buyer reported a bad result on a call you served`,
    body: `The buyer says: "${reasonLabel}". Reply by ${utcMinute(replyDueAt)}. ${consequence}`,
    payload: {
      reasonLabel,
      replyDueAt: replyDueAt.toISOString(),
      autoUpholdAt: autoUpholdAt?.toISOString() ?? null,
    },
  };
}

/** "2026-10-20 17:14 UTC": a time in a notice, without the ISO noise. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The disputed amount, from the snapshot taken at filing. */
export function disputedAmountOf(dispute: DisputeEntity): string {
  const call = (dispute.evidenceSnapshot?.call ?? {}) as { amount?: unknown };
  return typeof call.amount === 'string' && /^\d+$/.test(call.amount) ? call.amount : '0';
}

/**
 * The SLA instants of one dispute, from the constants the SLA sweep acts on
 * (`CALL_DISPUTE_SLA`) and the configured dials. Pure.
 */
export function slaTimesOf(
  row: DisputeEntity,
  context: CallDisputeViewContext = DEFAULT_VIEW_CONTEXT,
): Pick<
  CallDisputeDto,
  'replyDueAt' | 'pageAt' | 'decisionDueAt' | 'autoUpholdAt' | 'holdEndsAt' | 'filingClosesAt'
> {
  const filed = row.createdAt.getTime();
  const open = row.state === DisputeState.OPEN;
  const autoUpholdable =
    open &&
    row.providerResponse === null &&
    (row.refundGuaranteed ?? false) &&
    row.refundState !== RefundState.REFUNDED &&
    !needsSecondOperator(disputedAmountOf(row), row.decimals ?? 6, context.twoPersonThresholdUnits);
  const settledAt = settledAtOf(row);
  const holdMatters =
    open || (row.state === DisputeState.UPHELD && row.refundState === RefundState.PENDING);
  return {
    replyDueAt: new Date(filed + CALL_DISPUTE_SLA.providerReplyMs),
    pageAt: new Date(filed + CALL_DISPUTE_SLA.pageMs),
    decisionDueAt: new Date(filed + CALL_DISPUTE_SLA.decideMs),
    autoUpholdAt: autoUpholdable ? new Date(filed + CALL_DISPUTE_SLA.decideMs) : null,
    holdEndsAt: holdMatters ? context.holdEndsAt : null,
    filingClosesAt: settledAt ? new Date(settledAt.getTime() + context.filingWindowMs) : null,
  };
}

/**
 * When the disputed call settled, as `file` measured it: the snapshot's
 * `call.settledAt`. Snapshots taken before it was stored fall back to the
 * verdict's settlement, then the call's creation.
 */
function settledAtOf(row: DisputeEntity): Date | null {
  const snapshot = row.evidenceSnapshot ?? {};
  const verdict = (snapshot.verdict ?? null) as { settledAt?: unknown } | null;
  const call = (snapshot.call ?? {}) as { createdAt?: unknown; settledAt?: unknown };
  const text =
    typeof call.settledAt === 'string'
      ? call.settledAt
      : typeof verdict?.settledAt === 'string'
        ? verdict.settledAt
        : typeof call.createdAt === 'string'
          ? call.createdAt
          : null;
  if (!text) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function toDto(
  row: DisputeEntity,
  context: CallDisputeViewContext = DEFAULT_VIEW_CONTEXT,
): CallDisputeDto {
  return {
    id: row.id,
    state: row.state as DisputeState,
    reason: row.claimType as CallDisputeReason,
    reasonLabel: CALL_DISPUTE_REASON_LABEL[row.claimType as CallDisputeReason] ?? row.claimType,
    note: row.reason ? row.reason : null,
    intentId: row.intentId as string,
    verdictId: row.verdictId,
    toolId: row.toolId,
    bindingId: row.bindingId,
    providerId: row.respondentProviderId as string,
    amount: money(disputedAmountOf(row), row.assetId, row.decimals),
    providerResponse: row.providerResponse,
    providerRespondedAt: row.providerRespondedAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    refundSource: row.refundSource as RefundSource | null,
    refundState: row.refundState as RefundState | null,
    refundAmount: money(row.refundAmount, row.assetId, row.decimals),
    restoredAmount: money(row.restoredAmount, row.assetId, row.decimals),
    canRespond:
      row.state === DisputeState.OPEN &&
      row.providerResponse === null &&
      Date.now() - row.createdAt.getTime() < CALL_DISPUTE_SLA.providerReplyMs,
    refundGuaranteed: row.refundGuaranteed ?? false,
    refundNotice: refundNoticeOf(row.refundGuaranteed ?? false),
    ...slaTimesOf(row, context),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDetail(
  row: DisputeEntity,
  context: CallDisputeViewContext = DEFAULT_VIEW_CONTEXT,
): CallDisputeDetailDto {
  return { ...toDto(row, context), evidence: row.evidenceSnapshot ?? {} };
}

function money(
  amount: string | null,
  assetId: string | null,
  decimals: number | null,
): MoneyDto | null {
  if (amount === null || assetId === null || decimals === null) return null;
  const value = MoneyUtil.of(amount, assetId as AssetId, decimals);
  return { amount: value.amount, asset: value.asset, decimals: value.decimals };
}

/** What the buyer is told at filing about whether an upheld decision refunds. */
export function refundNoticeOf(guaranteed: boolean): string {
  return guaranteed
    ? 'Filed inside the dispute window: the payment is held, and if the dispute is upheld ' +
        'you are refunded in full.'
    : 'Filed after the dispute window: the dispute counts toward the provider’s quality; a ' +
        'refund is made only if the payment has not been collected.';
}

function describeRefund(state: string | null): string {
  switch (state) {
    case RefundState.REFUNDED:
      return 'The buyer is not charged for the call.';
    case RefundState.NOT_CHARGED:
      return 'The call was not charged, so there is nothing to refund.';
    case RefundState.NOT_REFUNDABLE:
      return (
        'It was filed after the dispute window and the provider was already paid, so it ' +
        'counts against the provider’s quality but is not refunded.'
      );
    case RefundState.PENDING:
      return 'The refund is being applied.';
    default:
      return '';
  }
}

/** Rows of an `UPDATE … RETURNING`, whichever shape the driver handed back. */
function returned(result: unknown): unknown[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as unknown[];
  }
  return Array.isArray(result) ? result : [];
}
