import {
  PROMOTION_GATE,
  PolicyLifecycle,
  PromotionEvidence,
  PromotionRefusal,
  evaluatePromotion,
  falsePositiveRateOf,
} from '@modules/verification/domain';

/**
 * The promote gate.
 *
 * Shadow mode: a policy is promoted
 * to `ACTIVE` *"only when its measured false-positive rate against manually
 * labelled samples is below 2%"*, and shadow mode is *"mandatory, not
 * advisory"*.
 *
 * This suite covers the decision. That the decision is *enforced* — that an
 * unpromoted policy cannot serve real traffic, and cannot even be stored as
 * `ACTIVE` — is proved against a real database in
 * `test/integration/verification/policy-lifecycle.integration.spec.ts`, because
 * a gate that is only tested against its own pure function is a gate that has
 * only been tested where it is easy.
 */

function evidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    shadowCalls: 5_000,
    labelledSamples: 200,
    falsePositives: 2, // 1%
    requestedBy: 'alice',
    approvedBy: 'bob',
    ...overrides,
  };
}

function refusals(decision: ReturnType<typeof evaluatePromotion>): PromotionRefusal[] {
  return decision.failures.map((failure) => failure.code);
}

describe('evaluatePromotion — the happy path', () => {
  it('promotes a policy that shadowed enough, was labelled enough, and was approved by someone else', () => {
    const decision = evaluatePromotion(PolicyLifecycle.SHADOW, evidence());

    expect(decision.promotable).toBe(true);
    expect(decision.failures).toEqual([]);
    expect(decision.falsePositiveRate).toBe(0.01);
  });
});

describe('evaluatePromotion — the false-positive bar', () => {
  it('refuses a rate above 2%', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ labelledSamples: 200, falsePositives: 5 }), // 2.5%
    );

    expect(decision.promotable).toBe(false);
    expect(refusals(decision)).toContain(PromotionRefusal.FALSE_POSITIVE_RATE_TOO_HIGH);
    expect(decision.failures[0].detail).toContain('2.50%');
  });

  it('refuses a rate sitting exactly on 2% — the bar is below, not at', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ labelledSamples: 200, falsePositives: 4 }),
    );

    expect(decision.falsePositiveRate).toBe(PROMOTION_GATE.maxFalsePositiveRate);
    expect(refusals(decision)).toContain(PromotionRefusal.FALSE_POSITIVE_RATE_TOO_HIGH);
  });

  it('accepts a rate just under', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ labelledSamples: 200, falsePositives: 3 }), // 1.5%
    );

    expect(decision.promotable).toBe(true);
  });
});

describe('evaluatePromotion — evidence volume', () => {
  it('refuses too few labelled samples even at a perfect rate', () => {
    // Zero false positives out of ten is not evidence of a 2% bar; a single
    // mislabelled sample there moves the measured rate by 10%.
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ labelledSamples: 10, falsePositives: 0 }),
    );

    expect(decision.promotable).toBe(false);
    expect(refusals(decision)).toContain(PromotionRefusal.INSUFFICIENT_LABELLED_SAMPLES);
  });

  it('refuses too little shadow traffic even with plenty of labels', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ shadowCalls: 120, labelledSamples: 120, falsePositives: 0 }),
    );

    expect(decision.promotable).toBe(false);
    expect(refusals(decision)).toContain(PromotionRefusal.INSUFFICIENT_SHADOW_CALLS);
  });

  it('refuses counts that cannot describe a real measurement', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ labelledSamples: 200, falsePositives: 900 }),
    );

    expect(refusals(decision)).toContain(PromotionRefusal.EVIDENCE_INCOHERENT);
  });

  it('a rate over nothing is null, not zero', () => {
    // `0/0 = 0` would read as a perfect policy and clear the strictest bar.
    expect(falsePositiveRateOf(evidence({ labelledSamples: 0, falsePositives: 0 }))).toBeNull();
  });
});

describe('evaluatePromotion — who may approve', () => {
  it('refuses a self-approval', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ requestedBy: 'alice', approvedBy: 'alice' }),
    );

    expect(decision.promotable).toBe(false);
    expect(refusals(decision)).toContain(PromotionRefusal.SELF_APPROVED);
  });

  it('refuses a self-approval dressed up in whitespace and case', () => {
    const decision = evaluatePromotion(
      PolicyLifecycle.SHADOW,
      evidence({ requestedBy: 'alice', approvedBy: '  Alice ' }),
    );

    expect(refusals(decision)).toContain(PromotionRefusal.SELF_APPROVED);
  });

  it('refuses an empty approver', () => {
    const decision = evaluatePromotion(PolicyLifecycle.SHADOW, evidence({ approvedBy: '' }));

    expect(refusals(decision)).toContain(PromotionRefusal.SELF_APPROVED);
  });
});

describe('evaluatePromotion — where a policy may be promoted from', () => {
  it.each([PolicyLifecycle.DRAFT, PolicyLifecycle.ACTIVE, PolicyLifecycle.WITHDRAWN])(
    'refuses to promote from %s',
    (lifecycle) => {
      const decision = evaluatePromotion(lifecycle, evidence());

      expect(decision.promotable).toBe(false);
      expect(refusals(decision)).toContain(PromotionRefusal.NOT_IN_SHADOW);
    },
  );

  it('tells a DRAFT policy how to become promotable', () => {
    const decision = evaluatePromotion(PolicyLifecycle.DRAFT, evidence());

    expect(decision.failures[0].detail).toContain('Put it into shadow first');
  });
});

describe('evaluatePromotion — reports every unmet bar at once', () => {
  it('does not stop at the first failure', () => {
    // An operator told one thing at a time does two rounds for information we
    // had on the first, and the friction of a gate is what gets gates disabled.
    const decision = evaluatePromotion(
      PolicyLifecycle.DRAFT,
      evidence({
        shadowCalls: 10,
        labelledSamples: 5,
        falsePositives: 4,
        requestedBy: 'alice',
        approvedBy: 'alice',
      }),
    );

    expect(refusals(decision).sort()).toEqual(
      [
        PromotionRefusal.NOT_IN_SHADOW,
        PromotionRefusal.INSUFFICIENT_SHADOW_CALLS,
        PromotionRefusal.INSUFFICIENT_LABELLED_SAMPLES,
        PromotionRefusal.FALSE_POSITIVE_RATE_TOO_HIGH,
        PromotionRefusal.SELF_APPROVED,
      ].sort(),
    );
  });
});
