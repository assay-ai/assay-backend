/**
 * `classifyForReconciliation` — the per-call export's
 * classification.
 *
 * One row per case, matching the style of `response-classification.spec.ts`:
 * the whole point is that every combination the export can actually produce
 * reaches a labelled bucket, so the matrix is the test.
 */
import { PaymentIntentCallClass, PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { ResponseClass } from '@modules/tool/domain/classification';

import {
  CALL_RECONCILIATION_CLASSES,
  CallReconciliationCandidate,
  CallReconciliationClass,
  classifyForReconciliation,
} from '@modules/provider/domain/call-reconciliation';

function candidate(overrides: Partial<CallReconciliationCandidate>): CallReconciliationCandidate {
  return {
    callClass: 'PAID',
    status: 'SETTLED',
    classification: null,
    ...overrides,
  };
}

describe('classifyForReconciliation — reconciliation vocabulary', () => {
  const CASES: Array<{
    readonly name: string;
    readonly input: Partial<CallReconciliationCandidate>;
    readonly expected: CallReconciliationClass;
  }> = [
    {
      name: 'PAID + SETTLED → PAID_CREDITED',
      input: { callClass: 'PAID', status: 'SETTLED' },
      expected: CallReconciliationClass.PAID_CREDITED,
    },
    {
      name: 'PAID + SETTLED on rail B, voucher not yet redeemed → PAID_AWAITING_REDEMPTION',
      input: { callClass: 'PAID', status: 'SETTLED', awaitingRedemption: true },
      expected: CallReconciliationClass.PAID_AWAITING_REDEMPTION,
    },
    {
      name: 'PAID + SETTLED on rail B, redeemed → PAID_CREDITED',
      input: { callClass: 'PAID', status: 'SETTLED', awaitingRedemption: false },
      expected: CallReconciliationClass.PAID_CREDITED,
    },
    {
      name: 'PAID + SETTLED, credited from platform funds → PLATFORM_ABSORBED',
      input: { callClass: 'PAID', status: 'SETTLED', platformAbsorbed: true },
      expected: CallReconciliationClass.PLATFORM_ABSORBED,
    },
    {
      name: 'an open hold wins over an absorbed flag → PAID_AWAITING_REDEMPTION',
      input: {
        callClass: 'PAID',
        status: 'SETTLED',
        awaitingRedemption: true,
        platformAbsorbed: true,
      },
      expected: CallReconciliationClass.PAID_AWAITING_REDEMPTION,
    },
    {
      name: 'an open hold on a VERIFYING intent is still PENDING',
      input: { callClass: 'PAID', status: 'VERIFYING', awaitingRedemption: true },
      expected: CallReconciliationClass.PENDING,
    },
    {
      name: 'PAID + REFUNDED → PAID_UNCREDITED (verification FAIL)',
      input: { callClass: 'PAID', status: 'REFUNDED' },
      expected: CallReconciliationClass.PAID_UNCREDITED,
    },
    {
      name: 'PAID + REFUNDED → PAID_UNCREDITED (schema-contract refund)',
      input: { callClass: 'PAID', status: 'REFUNDED', classification: 'DATA_RESULT' },
      expected: CallReconciliationClass.PAID_UNCREDITED,
    },
    {
      name: 'PAID + VOIDED + SYSTEM_ERROR classification → SYSTEM_ERROR',
      input: { callClass: 'PAID', status: 'VOIDED', classification: 'SYSTEM_ERROR' },
      expected: CallReconciliationClass.SYSTEM_ERROR,
    },
    {
      name: 'PAID + VOIDED + REQUEST_ERROR classification → REQUEST_ERROR',
      input: { callClass: 'PAID', status: 'VOIDED', classification: 'REQUEST_ERROR' },
      expected: CallReconciliationClass.REQUEST_ERROR,
    },
    {
      name: 'PAID + EXPIRED + REQUEST_ERROR classification → REQUEST_ERROR',
      input: { callClass: 'PAID', status: 'EXPIRED', classification: 'REQUEST_ERROR' },
      expected: CallReconciliationClass.REQUEST_ERROR,
    },
    {
      name: 'PAID + VOIDED + no classification recorded → SYSTEM_ERROR (documented fallback)',
      input: { callClass: 'PAID', status: 'VOIDED', classification: null },
      expected: CallReconciliationClass.SYSTEM_ERROR,
    },
    {
      name: 'FREE wins regardless of status',
      input: { callClass: 'FREE', status: 'REFUNDED' },
      expected: CallReconciliationClass.FREE,
    },
    {
      name: 'FREE wins even when SETTLED',
      input: { callClass: 'FREE', status: 'SETTLED' },
      expected: CallReconciliationClass.FREE,
    },
    {
      name: 'TEST wins regardless of status',
      input: { callClass: 'TEST', status: 'SETTLED' },
      expected: CallReconciliationClass.TEST,
    },
    {
      name: 'EXPLORATION wins regardless of status',
      input: { callClass: 'EXPLORATION', status: 'VOIDED', classification: 'SYSTEM_ERROR' },
      expected: CallReconciliationClass.EXPLORATION,
    },
    {
      name: 'isExcluded overrides an otherwise-credited PAID/SETTLED call',
      input: { callClass: 'PAID', status: 'SETTLED', isExcluded: true },
      expected: CallReconciliationClass.EXCLUDED,
    },
    {
      name: 'isExcluded does not apply to FREE — intrinsic class still wins',
      input: { callClass: 'FREE', status: 'SETTLED', isExcluded: true },
      expected: CallReconciliationClass.FREE,
    },
    {
      name: 'PAID + CREATED (never funded) → PENDING',
      input: { callClass: 'PAID', status: 'CREATED' },
      expected: CallReconciliationClass.PENDING,
    },
    {
      name: 'PAID + FUNDS_SECURED → PENDING',
      input: { callClass: 'PAID', status: 'FUNDS_SECURED' },
      expected: CallReconciliationClass.PENDING,
    },
    {
      name: 'PAID + PROVIDER_EXECUTING → PENDING',
      input: { callClass: 'PAID', status: 'PROVIDER_EXECUTING' },
      expected: CallReconciliationClass.PENDING,
    },
    {
      name: 'PAID + VERIFYING (worker has not run yet) → PENDING',
      input: { callClass: 'PAID', status: 'VERIFYING' },
      expected: CallReconciliationClass.PENDING,
    },
  ];

  for (const { name, input, expected } of CASES) {
    it(name, () => {
      expect(classifyForReconciliation(candidate(input))).toBe(expected);
    });
  }

  it('has no CANARY member — canaries must classify as ordinary PAID_CREDITED', () => {
    expect(Object.values(CallReconciliationClass)).not.toContain('CANARY');
    // A canary call is, by construction, an ordinary PAID/SETTLED row — there
    // is nothing in the candidate shape that could even mark one, which is
    // the property the reconciliation export requires.
    expect(classifyForReconciliation(candidate({ callClass: 'PAID', status: 'SETTLED' }))).toBe(
      CallReconciliationClass.PAID_CREDITED,
    );
  });

  it('is total: every declared class is reachable, and CALL_RECONCILIATION_CLASSES lists all eleven', () => {
    const reached = new Set(CASES.map((c) => c.expected));
    for (const member of Object.values(CallReconciliationClass)) {
      expect(reached.has(member)).toBe(true);
    }
    expect(CALL_RECONCILIATION_CLASSES).toHaveLength(Object.values(CallReconciliationClass).length);
  });

  it('the string literals are paired with the real enums (payment + classifier)', () => {
    // `CallClassValue` against `PaymentIntentCallClass`.
    expect(Object.values(PaymentIntentCallClass).sort()).toEqual(
      ['PAID', 'FREE', 'TEST', 'EXPLORATION'].sort(),
    );
    // `IntentStatusValue` against `PaymentIntentStatus` — every terminal status
    // this function switches on must be a real one.
    for (const status of ['SETTLED', 'REFUNDED', 'VOIDED', 'EXPIRED']) {
      expect(Object.values(PaymentIntentStatus)).toContain(status);
    }
    // `ResponseClassValue` against `ResponseClass`.
    expect(Object.values(ResponseClass)).toContain('SYSTEM_ERROR');
    expect(Object.values(ResponseClass)).toContain('REQUEST_ERROR');
  });
});
