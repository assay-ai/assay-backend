import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';

import { isApprovalQueued } from '../services/operator-approval.service';

/**
 * A two-person route answers 202 with `{approvalId, …}` when it queued the
 * action for a second operator, and its usual status with the action's result
 * when it ran.
 */
export function answerOrQueued<T>(response: Response, result: T): T {
  if (isApprovalQueued(result)) response.status(HttpStatus.ACCEPTED);
  return result;
}
