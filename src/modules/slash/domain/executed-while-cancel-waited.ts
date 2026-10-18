import { Logger } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

/** Alert name: a withdrawn judgement executed on chain while its cancel waited. */
export const EXECUTED_WHILE_CANCEL_WAITED_ALERT = 'slash_executed_while_cancel_waited';

/**
 * A judgement this platform had withdrawn was executed on chain while its
 * cancel waited. Money left the provider's stake; it is paged, not hidden.
 * Recording the execution (and compensating) belongs to the admin-cancel
 * sweep's `recordAnExecutionNobodyAskedFor`; this only says it, and writes
 * nothing.
 *
 * One page per case (`ONCE_PER_INCIDENT`, keyed by the proposal id), so every
 * place that sees it — the cancel route and the case brief — may call this as
 * often as it is reached. Never throws.
 */
export async function alertExecutedWhileCancelWaited(
  alerts: AlertPort | null | undefined,
  logger: Logger,
  proposal: Pick<SlashProposalEntity, 'id' | 'status' | 'chainRequestId' | 'penaltyAmount'>,
  where: 'part' | 'record',
): Promise<void> {
  logger.error(
    `slash proposal ${proposal.id} (${proposal.status}): its on-chain ${where} was EXECUTED while ` +
      `the cancel waited; the stake was taken. Not written as cancelled — needs recording and a human`,
  );
  try {
    await alerts?.emit({
      severity: AlertSeverity.CRITICAL,
      name: EXECUTED_WHILE_CANCEL_WAITED_ALERT,
      summary: 'A withdrawn slash judgement was executed on chain while its cancel waited',
      details: {
        proposalId: proposal.id,
        requestId: proposal.chainRequestId,
        caseStatus: proposal.status,
        penaltyMinor: proposal.penaltyAmount,
        where,
      },
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: proposal.id,
    });
  } catch (error) {
    logger.error(
      `slash proposal ${proposal.id}: the executed-while-cancel-waited alert failed`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
