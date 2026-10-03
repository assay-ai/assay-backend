import { MCP_SCHEMA_CONTRACT_VIOLATION_REASON } from '@modules/mcp/constants/mcp.constants';
import {
  DEMO_VERDICT_DEADLINE_MS,
  DemoVerdictState,
  decideDemoVerdictState,
} from '@modules/mcp/domain/demo-verdict-state';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

/**
 * The live demo — how a demo poll ends.
 *
 * The two terminal states below `READY` are the point of this file. Without
 * them the product's most-scrutinised screen spins forever exactly when
 * something has gone wrong, which is exactly when it is being looked at
 * hardest.
 */
describe('decideDemoVerdictState', () => {
  const now = new Date('2026-09-03T10:00:00.000Z');
  const fresh = new Date(now.getTime() - 2_000);
  const old = new Date(now.getTime() - DEMO_VERDICT_DEADLINE_MS - 1);

  it('is READY once a verdict has been recorded', () => {
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.REFUNDED,
      intentReason: null,
      judged: true,
      createdAt: fresh,
      now,
    });

    expect(state).toBe(DemoVerdictState.READY);
  });

  it('is PENDING while the worker has not judged it yet', () => {
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.VERIFYING,
      intentReason: null,
      judged: false,
      createdAt: fresh,
      now,
    });

    expect(state).toBe(DemoVerdictState.PENDING);
  });

  it('says the money settled without a judgement on a schema-contract refund', () => {
    // `mcp-tool-call.service.ts:730` refunds SYNCHRONOUSLY on a schema
    // violation, so the worker never receives that call. The three check lines
    // will NEVER fill in, and a page that kept polling would be waiting on
    // something that is not coming.
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.REFUNDED,
      intentReason: MCP_SCHEMA_CONTRACT_VIOLATION_REASON,
      judged: false,
      createdAt: fresh,
      now,
    });

    expect(state).toBe(DemoVerdictState.SETTLED_WITHOUT_JUDGEMENT);
  });

  it('prefers the recorded verdict over the synchronous-refund shape', () => {
    // Defensive ordering: if a verdict somehow exists, it is the better answer
    // than "no judgement is coming", whatever the intent's reason says.
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.REFUNDED,
      intentReason: MCP_SCHEMA_CONTRACT_VIOLATION_REASON,
      judged: true,
      createdAt: fresh,
      now,
    });

    expect(state).toBe(DemoVerdictState.READY);
  });

  it('gives up once the deadline passes, rather than pretending to still run', () => {
    // Worker dead, queue stuck. The page says there is no verdict — it does
    // not keep spinning, and it does not invent one.
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.VERIFYING,
      intentReason: null,
      judged: false,
      createdAt: old,
      now,
    });

    expect(state).toBe(DemoVerdictState.GAVE_UP);
  });

  it('does not give up on a call that was already judged, however old', () => {
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.SETTLED,
      intentReason: null,
      judged: true,
      createdAt: old,
      now,
    });

    expect(state).toBe(DemoVerdictState.READY);
  });

  it('treats a settled-but-unjudged call past the deadline as GAVE_UP, not READY', () => {
    // `UNVERIFIED` settlement: no policy ran. The money is final but there are
    // no stages to show, and claiming READY would render three empty check
    // lines as though they had passed.
    const state = decideDemoVerdictState({
      intentStatus: PaymentIntentStatus.SETTLED,
      intentReason: null,
      judged: false,
      createdAt: old,
      now,
    });

    expect(state).toBe(DemoVerdictState.GAVE_UP);
  });
});
