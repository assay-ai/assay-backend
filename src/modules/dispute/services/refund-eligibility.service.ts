import { Inject, Injectable, Logger } from '@nestjs/common';
import { In } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import { DisputeRepository } from '@database/postgres/repositories/dispute.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { DISPUTE_FILING_GUARD_SECONDS } from '@modules/payment/constants/collection-hold.constants';
import { refundGuaranteedIfReported } from '@modules/payment/domain/dispute-hold';
import { HELD_PAYMENTS, HeldPaymentsPort } from '@modules/payment/ports/held-payments.port';
import { PaymentRail } from '@modules/payment/ports/payment.types';

import { CALL_DISPUTE_CONFIG, CallDisputeConfig } from '../constants/call-dispute.config';
import { DisputeState } from '../dto/dispute.dto';
import { disputeFilingClosesAt } from '../domain/call-dispute';

/** How long the receipt waits for the chain's "is the hold live" answer before promising nothing. */
export const HOLD_LIVE_TIMEOUT_MS = 2_000;

/** Whether a report filed now would be refund-guaranteed, and until when. */
export interface RefundEligibility {
  readonly refundable: boolean;
  /**
   * The instant the answer lapses: `collectable_at − guard` for a held
   * payment. `null` when it is not refundable, or when no end is known yet (a
   * rail-B voucher not redeemed: its hour starts at redemption).
   */
  readonly until: Date | null;
}

const NOT_REFUNDABLE: RefundEligibility = Object.freeze({ refundable: false, until: null });

/**
 * Read-only: what a buyer report filed now would be granted, for the receipt's
 * `refundableIfReportedNow` (wave-1 audit I1). It never writes, never locks
 * and is not on the filing path: `CallDisputeService.file` decides with its own
 * SQL under its locks, and an integration test proves the two agree.
 *
 * In `DisputeModule`, beside `CallDisputeService`, so both resolve the same
 * `HELD_PAYMENTS` (or neither does): the receipt cannot promise a refund the
 * filing would not grant because one of them sees the chain hold and the other
 * does not.
 *
 * The same preconditions as the filing (settled, paid, another provider,
 * inside the filing window, never decided), then
 * {@link refundGuaranteedIfReported}. The chain check runs last, only for rail
 * B, with a short timeout; any failure answers "not refundable".
 */
@Injectable()
export class RefundEligibilityService {
  private readonly logger = new Logger(RefundEligibilityService.name);

  constructor(
    private readonly disputes: DisputeRepository,
    @Inject(CALL_DISPUTE_CONFIG) private readonly config: CallDisputeConfig,
    @Inject(HELD_PAYMENTS) private readonly held: HeldPaymentsPort,
  ) {}

  async ofCall(
    intent: PaymentIntentEntity,
    settledAt: Date | null,
    now: Date = new Date(),
  ): Promise<RefundEligibility> {
    const answer = await this.beforeDecided(intent, settledAt, now, (call) => this.holdLive(call));
    if (!answer.refundable) return NOT_REFUNDABLE;
    const decided = await this.disputes.findOneBy({
      organizationId: intent.organizationId,
      intentId: intent.id,
      state: In([DisputeState.UPHELD, DisputeState.REJECTED]),
    });
    return decided ? NOT_REFUNDABLE : answer;
  }

  /**
   * {@link ofCall} for a page of one organization's calls, with the decided
   * reports read in one query and the chain's hold read once per asset (B7
   * review nit 2). The same answer per call, plus `reported`: a report is
   * already open on it (it cannot be reported again).
   */
  async ofCalls(
    calls: readonly { intent: PaymentIntentEntity; settledAt: Date | null }[],
    now: Date = new Date(),
  ): Promise<Map<string, RefundEligibility & { readonly reported: boolean }>> {
    const answers = new Map<string, RefundEligibility & { readonly reported: boolean }>();
    const live = new Map<string, Promise<boolean>>();
    const holdLive = (intent: PaymentIntentEntity) => {
      const asset = intent.assetId;
      if (!live.has(asset)) live.set(asset, this.holdLive(intent));
      return live.get(asset)!;
    };
    const candidates: { intent: PaymentIntentEntity; answer: RefundEligibility }[] = [];
    for (const { intent, settledAt } of calls) {
      const answer = await this.beforeDecided(intent, settledAt, now, holdLive);
      if (answer.refundable) candidates.push({ intent, answer });
      else answers.set(intent.id, { ...NOT_REFUNDABLE, reported: false });
    }
    if (candidates.length === 0) return answers;
    const reports = await this.disputes.find({
      where: candidates.map(({ intent }) => ({
        organizationId: intent.organizationId,
        intentId: intent.id,
        state: In([
          DisputeState.UPHELD,
          DisputeState.REJECTED,
          DisputeState.OPEN,
          DisputeState.UNDER_REVIEW,
        ]),
      })),
    });
    for (const { intent, answer } of candidates) {
      const mine = reports.filter((report) => report.intentId === intent.id);
      const decided = mine.some(
        (report) => report.state === DisputeState.UPHELD || report.state === DisputeState.REJECTED,
      );
      answers.set(
        intent.id,
        decided ? { ...NOT_REFUNDABLE, reported: true } : { ...answer, reported: mine.length > 0 },
      );
    }
    return answers;
  }

  /** Everything {@link ofCall} checks except the decided-report lookup. */
  private async beforeDecided(
    intent: PaymentIntentEntity,
    settledAt: Date | null,
    now: Date,
    holdLive: (intent: PaymentIntentEntity) => Promise<boolean>,
  ): Promise<RefundEligibility> {
    const closesAt = disputeFilingClosesAt(intent, settledAt, this.config.filingWindowMs);
    if (closesAt === null || now.getTime() > closesAt.getTime()) return NOT_REFUNDABLE;

    const facts = {
      status: intent.status,
      rail: intent.rail,
      holdId: intent.holdId ?? null,
      holdReleasedAt: intent.holdReleasedAt ?? null,
      disputeOutcome: intent.disputeOutcome ?? null,
      heldStatus: intent.heldStatus ?? null,
      collectableAt: intent.collectableAt ?? null,
      redemptionLapsedAt: intent.redemptionLapsedAt ?? null,
      redemptionLastError: intent.redemptionLastError ?? null,
    };
    const context = { now, guardSeconds: DISPUTE_FILING_GUARD_SECONDS };
    // The cheap check first, as if the hold were live; the chain only when the rest passed.
    if (!refundGuaranteedIfReported(facts, { ...context, holdLive: true })) return NOT_REFUNDABLE;
    if (intent.rail === PaymentRail.RAIL_B_VOUCHER && !(await holdLive(intent))) {
      return NOT_REFUNDABLE;
    }
    const until =
      facts.heldStatus === 'HELD' && facts.collectableAt
        ? new Date(facts.collectableAt.getTime() - DISPUTE_FILING_GUARD_SECONDS * 1000)
        : null;
    return { refundable: true, until };
  }

  /** The chain's answer, or `false` on no port, an error or no answer within the timeout. */
  private async holdLive(intent: PaymentIntentEntity): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.held.holdLive(intent.assetId as AssetId),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), HOLD_LIVE_TIMEOUT_MS);
        }),
      ]);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`holdLive(${intent.assetId}) failed; no refund promised: ${reason}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
