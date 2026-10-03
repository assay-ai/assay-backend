import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { MCP_SCHEMA_CONTRACT_VIOLATION_REASON } from '../constants/mcp.constants';

/**
 * How a demo verdict poll ends.
 *
 * The page shows the response and *"holding $X"* immediately, then fills the
 * three check lines in when the worker has judged. That gap is real — money is
 * held at once and judgement arrives later — and the page says so rather than
 * hiding it.
 *
 * **`PENDING` must have a way out.** Two of the four states below exist only
 * because it does not always resolve, and both are reachable in production:
 *
 * - `SETTLED_WITHOUT_JUDGEMENT` — a schema-contract violation refunds
 *   **synchronously** (`McpToolCallService`, the `SCHEMA_FAIL` branch), so the
 *   worker never receives the call. The money is final and the three check
 *   lines are never coming. Polling forever would be waiting on nothing.
 * - `GAVE_UP` — the worker is dead or the queue is stuck. The page says there
 *   is no verdict rather than pretending one is still on its way.
 *
 * Without these two, the most-scrutinised screen in the product spins forever
 * exactly when something is wrong — which is exactly when it is watched.
 *
 * Pure: the caller passes the rows and the clock.
 */

export enum DemoVerdictState {
  PENDING = 'PENDING',
  READY = 'READY',
  /** Refunded before the worker ever saw it. No stages will ever exist. */
  SETTLED_WITHOUT_JUDGEMENT = 'SETTLED_WITHOUT_JUDGEMENT',
  /** No verdict inside the deadline. Said plainly, not spun on. */
  GAVE_UP = 'GAVE_UP',
}

/**
 * How long a demo poll waits before saying it does not know.
 *
 * Generous relative to the worker's normal turnaround — the failure this
 * bounds is a stuck queue, not a slow one, and giving up on a verdict that was
 * about to arrive would show a wrong answer to make a right one faster.
 */
export const DEMO_VERDICT_DEADLINE_MS = 90_000;

export interface DemoVerdictInput {
  readonly intentStatus: PaymentIntentStatus;
  /** `payment_intents.reason`, which names a synchronous refund. */
  readonly intentReason: string | null;
  /** Whether a verification record exists AND has left `PENDING`. */
  readonly judged: boolean;
  readonly createdAt: Date;
  readonly now: Date;
}

export function decideDemoVerdictState(input: DemoVerdictInput): DemoVerdictState {
  // A recorded verdict is the best answer available and outranks every
  // inference below it, including the synchronous-refund shape. If one exists,
  // it is what happened.
  if (input.judged) {
    return DemoVerdictState.READY;
  }

  if (
    input.intentStatus === PaymentIntentStatus.REFUNDED &&
    input.intentReason === MCP_SCHEMA_CONTRACT_VIOLATION_REASON
  ) {
    return DemoVerdictState.SETTLED_WITHOUT_JUDGEMENT;
  }

  if (input.now.getTime() - input.createdAt.getTime() > DEMO_VERDICT_DEADLINE_MS) {
    // Note this catches a SETTLED-but-unjudged call too, which is the
    // `UNVERIFIED` settlement: the money is final but no policy ran, so there
    // are no stages. Reporting READY there would render three empty check
    // lines as though they had passed.
    return DemoVerdictState.GAVE_UP;
  }

  return DemoVerdictState.PENDING;
}
