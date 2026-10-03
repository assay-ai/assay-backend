import { Inject, Injectable, Logger } from '@nestjs/common';

import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { MoneyUtil } from '@utils/money.util';

import { splitCompensation, WindowSpend } from '../domain/compensation-split';

/** What a completed slash hands over for distribution. */
export interface CompensationRequest {
  /** The window the penalty was raised for; `null` for a call-level case. */
  readonly windowId: string | null;
  /** The share that reached the vault, off the chain's own `SlashRecord`. */
  readonly agentAmountMinor: string;
  readonly assetId: string;
  readonly decimals: number;
  /** The slash signature — the idempotency key, and the audit trail. */
  readonly signature: string;
  readonly providerId: string;
}

/**
 * Paying the compensating share of an executed penalty to the agents it is
 * owed to — the producer `SLASH_DISTRIBUTION` never had.
 *
 * ## Where the money is by the time this runs
 *
 * In the vault. `slash` paid the agent share to the signed `beneficiary`, which
 * `SlashBeneficiaryService` resolved to the platform's settlement vault, so the
 * on-chain balance the reconciler measures has already gone up by
 * `agentAmountMinor`. This class makes the ledger agree, by crediting each
 * harmed agent their pro-rata share.
 *
 * That ordering is what keeps proof of reserves true at every instant *in the
 * safe direction*: between the chain landing and these entries being written,
 * the vault holds more than the ledger claims — a surplus, which the reconciler
 * reports as a discrepancy rather than a breach. The reverse order would post
 * liabilities against money that has not arrived.
 *
 * ## What is not booked, and why that is not an omission
 *
 * Only the agent share. The platform's share went to `economics.treasury`,
 * which is **not** the vault — booking it would add a liability no vault
 * balance covers. The provider's remaining share never left their stake at all.
 * See `settlement/domain/ledger-book.ts`.
 *
 * ## Partial failure is resumable, not atomic
 *
 * Each credit is its own transaction (`appendNow`). A crash halfway leaves some
 * agents paid and the vault already funded; the next execution pass re-runs the
 * whole distribution and the unique index makes the already-written legs
 * no-ops. The buffered alternative (`append` + `flush`) would be one
 * transaction, but it routes through a process-global writer with a quarantine
 * path that un-writes credit — which manufactures exactly the unexplained
 * surplus this design exists to avoid.
 */
@Injectable()
export class SlashCompensationService {
  private readonly logger = new Logger(SlashCompensationService.name);

  constructor(
    private readonly windowCalls: SlaWindowCallRepository,
    private readonly ledger: LedgerService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
  ) {}

  /**
   * Credit every harmed agent, and tell them.
   *
   * Returns the number of agents credited. Never throws: the penalty has
   * already been taken on chain and the case is already `EXECUTED`, so a
   * failure here must not roll that back or fail the pass — it must be loud and
   * retried on the next tick, which the unique index makes safe.
   */
  async distribute(request: CompensationRequest): Promise<number> {
    const agentAmount = BigInt(request.agentAmountMinor);
    if (agentAmount <= 0n) return 0;

    if (!request.windowId) {
      // A call-level case names one harmed agent and does not need a split.
      // Nothing produces one today (`openFromVerdict` is operator-driven and
      // the proposal lifecycle has no call-level door), so rather than guess at
      // a shape nobody has exercised, this refuses to distribute and says so.
      this.logger.warn(
        `Slash ${request.signature} has no window; ${request.agentAmountMinor} sits in the vault ` +
          'uncredited until call-level compensation exists.',
      );
      return 0;
    }

    const spends = await this.readSpends(request.windowId);
    const credits = splitCompensation(agentAmount, spends);

    if (credits.length === 0) {
      this.logger.warn(
        `Slash ${request.signature}: nobody spent in window ${request.windowId}, so ` +
          `${request.agentAmountMinor} is in the vault with no agent to credit.`,
      );
      return 0;
    }

    let credited = 0;
    for (const credit of credits) {
      try {
        await this.ledger.appendNow({
          organizationId: credit.organizationId,
          accountId: credit.agentAccount as LedgerAccountId,
          entryType: LedgerEntryType.SLASH_DISTRIBUTION,
          money: MoneyUtil.of(
            credit.amount.toString(),
            request.assetId as AssetId,
            request.decimals,
          ),
          // The idempotency key. `uq_ledger_entries_slash_distribution` is on
          // `(organization_id, account_id, chain_tx_ref)`, so a retried pass
          // cannot pay the same agent twice for the same slash.
          chainTxRef: request.signature,
        });
        credited += 1;
      } catch (error) {
        if (isDuplicate(error)) {
          // Already paid on an earlier attempt. Not an error — it is the retry
          // path working.
          credited += 1;
          continue;
        }
        this.logger.error(
          `Slash ${request.signature}: could not credit ${credit.agentAccount}: ` +
            `${(error as Error).message}`,
        );
        continue;
      }

      await this.announce(request, credit.organizationId, credit.agentAccount, credit.amount);
    }

    return credited;
  }

  private async readSpends(windowId: string): Promise<WindowSpend[]> {
    const rows = await this.windowCalls.sumSpendByAgent(windowId);
    return rows.map((row) => ({
      organizationId: row.organizationId,
      agentAccount: row.agentAccount,
      spend: BigInt(row.spend ?? '0'),
    }));
  }

  /**
   * `agent.slash_compensation_received` — in the notification catalogue long
   * before anything emitted it. Only the provider side was ever told a penalty
   * happened.
   *
   * Best-effort: the money is already in the agent's balance, and a failed
   * notification must not undo it or stop the next agent being paid.
   */
  private async announce(
    request: CompensationRequest,
    organizationId: string,
    agentAccount: string,
    amount: bigint,
  ): Promise<void> {
    try {
      await this.notifications.notify({
        organizationId,
        event: NotificationEvent.SLASH_COMPENSATION_RECEIVED,
        title: 'You were compensated for a bad result',
        body:
          'A provider was penalised for a call that failed our checks, and your share of that ' +
          'penalty has been credited to your balance.',
        subjectType: 'slash_execution',
        subjectId: request.signature,
        dedupeKey: `${request.signature}:${agentAccount}`,
        payload: {
          amount: amount.toString(),
          assetId: request.assetId,
          decimals: request.decimals,
          providerId: request.providerId,
          windowId: request.windowId,
          signature: request.signature,
        },
      });
    } catch (error) {
      this.logger.error(
        `Slash ${request.signature}: credited ${agentAccount} but could not notify them: ` +
          `${(error as Error).message}`,
      );
    }
  }
}

/** Postgres unique violation. */
function isDuplicate(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}
