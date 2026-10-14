import { DataSource } from 'typeorm';

import { OperatorApprover, OperatorSession } from '@modules/operator/ports/operator-session.port';
import { payloadHash } from '@modules/operator/services/operator-approval.service';

/**
 * A `PENDING` approval requested by `requester`, and `approver` as the second
 * operator who approved it — what `OperatorApprovalService.approve` hands a
 * domain service. For tests that drive a two-person domain method directly;
 * the queue itself is covered by `operator-approvals.integration.spec.ts`.
 */
export async function approvalFor(
  dataSource: DataSource,
  requester: OperatorSession,
  approver: OperatorSession,
  action = 'test.direct',
): Promise<OperatorApprover> {
  const payload = { direct: true };
  const [row] = (await dataSource.query(
    `INSERT INTO operator_approvals (action, target, payload, payload_hash, requested_by, expires_at)
     VALUES ($1, 'test:direct', $2::jsonb, $3, $4, now() + interval '1 hour')
     RETURNING id`,
    [action, JSON.stringify(payload), payloadHash(payload), requester.operatorId],
  )) as { id: string }[];
  return { ...approver, approvalId: row.id };
}
