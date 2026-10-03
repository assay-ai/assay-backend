import {
  STAGE_STATUS_LABEL,
  STAGE_STATUS_NOTE,
  StageStatus,
  UNSAMPLED_STAGES,
  VERIFICATION_PIPELINE,
  VerificationStage,
  creditsProvider,
  effectiveConsequence,
  isProviderAtFault,
  isStagePass,
  notReached,
  stageRan,
  VERDICT_CONSEQUENCE,
  VerdictOutcome,
  VerdictStatus,
} from '@modules/verification/domain';

/**
 * The verdict vocabulary, asserted rather than reviewed.
 *
 * Everything here is a table check. That is deliberate: the settlement rules
 * live in `VERDICT_CONSEQUENCE` as data precisely so a test can hold them, and
 * the alternative — a reviewer remembering that `MISAPPLIED` must not strike —
 * is the failure mode behind the highest-risk deploy in the system.
 */
describe('verdict vocabulary', () => {
  describe('the vocabulary is wide enough to avoid the obvious false FAIL', () => {
    it('carries EMPTY_CONFIRMED and MISAPPLIED', () => {
      // The two the vocabulary adds. Without them, a legitimately empty result
      // and a check pointed at the wrong thing both collapse into FAIL, which
      // is a strike against a provider that did nothing wrong.
      expect(VerdictStatus.EMPTY_CONFIRMED).toBe('EMPTY_CONFIRMED');
      expect(VerdictStatus.MISAPPLIED).toBe('MISAPPLIED');
    });

    it('gives every status a settlement consequence', () => {
      for (const status of Object.values(VerdictStatus)) {
        expect(VERDICT_CONSEQUENCE[status]).toBeDefined();
      }
      expect(Object.keys(VERDICT_CONSEQUENCE)).toHaveLength(Object.values(VerdictStatus).length);
    });
  });

  describe('exactly one verdict can cost a provider money', () => {
    it('is FAIL, and nothing else is slashable', () => {
      const slashable = Object.values(VerdictStatus).filter(
        (status) => VERDICT_CONSEQUENCE[status].slashable,
      );
      expect(slashable).toEqual([VerdictStatus.FAIL]);
    });

    it('welds slashable to strike — a class that strikes is the only one that can slash', () => {
      for (const status of Object.values(VerdictStatus)) {
        const consequence = VERDICT_CONSEQUENCE[status];
        expect(consequence.slashable).toBe(consequence.strike);
      }
    });

    it('never both credits the provider and strikes them', () => {
      for (const status of Object.values(VerdictStatus)) {
        const consequence = VERDICT_CONSEQUENCE[status];
        expect(consequence.settle && consequence.strike).toBe(false);
      }
    });
  });

  describe('the two verdicts the vocabulary exists for', () => {
    it.each([VerdictStatus.EMPTY_CONFIRMED, VerdictStatus.EMPTY_UNVERIFIED])(
      '%s pays the provider and records no strike',
      (status) => {
        const consequence = VERDICT_CONSEQUENCE[status];
        expect(consequence.outcome).toBe(VerdictOutcome.SETTLE);
        expect(consequence.settle).toBe(true);
        expect(consequence.strike).toBe(false);
        expect(consequence.slashable).toBe(false);
        expect(consequence.metric).toBe('coverage');
      },
    );

    it('MISAPPLIED voids the call — nobody is charged and nobody is struck', () => {
      const consequence = VERDICT_CONSEQUENCE[VerdictStatus.MISAPPLIED];
      expect(consequence.outcome).toBe(VerdictOutcome.VOID);
      expect(consequence.settle).toBe(false);
      expect(consequence.strike).toBe(false);
      expect(consequence.slashable).toBe(false);
      // The metric is the point of the class: a rising misapplication rate is a
      // signal about a tool description or a policy, not about a provider.
      expect(consequence.metric).toBe('misapplication');
    });

    it('defaults to paying — every status except FAIL credits the provider', () => {
      const nonPaying = Object.values(VerdictStatus).filter(
        (status) => !VERDICT_CONSEQUENCE[status].settle,
      );
      expect(nonPaying.sort()).toEqual([VerdictStatus.FAIL, VerdictStatus.MISAPPLIED].sort());
    });
  });

  describe('the helpers agree with the table', () => {
    it('isProviderAtFault is true for FAIL alone', () => {
      const atFault = Object.values(VerdictStatus).filter(isProviderAtFault);
      expect(atFault).toEqual([VerdictStatus.FAIL]);
    });

    it('creditsProvider tracks settle', () => {
      for (const status of Object.values(VerdictStatus)) {
        expect(creditsProvider(status)).toBe(VERDICT_CONSEQUENCE[status].settle);
      }
    });
  });

  describe('shadow mode has no economic effect, whatever the verdict says', () => {
    it('turns even a FAIL into the paying consequence', () => {
      const consequence = effectiveConsequence({ status: VerdictStatus.FAIL, shadow: true });
      expect(consequence.settle).toBe(true);
      expect(consequence.strike).toBe(false);
      expect(consequence.slashable).toBe(false);
    });

    it('leaves an ACTIVE verdict alone', () => {
      const consequence = effectiveConsequence({ status: VerdictStatus.FAIL, shadow: false });
      expect(consequence).toBe(VERDICT_CONSEQUENCE[VerdictStatus.FAIL]);
    });

    it('never lets a shadow verdict strike, for any status', () => {
      for (const status of Object.values(VerdictStatus)) {
        expect(effectiveConsequence({ status, shadow: true }).strike).toBe(false);
      }
    });
  });
});

/**
 * The receipt half. Every assertion here is a restatement of one rule:
 * **a stage that did not run must never read as a stage that passed.**
 */
describe('stage vocabulary', () => {
  it('has exactly one status that is a pass', () => {
    const passes = Object.values(StageStatus).filter(isStagePass);
    expect(passes).toEqual([StageStatus.PASSED]);
  });

  it('does not label any other status "passed"', () => {
    for (const status of Object.values(StageStatus)) {
      if (status === StageStatus.PASSED) continue;
      expect(STAGE_STATUS_LABEL[status]).not.toBe('passed');
      expect(STAGE_STATUS_LABEL[status]).not.toContain('passed');
    }
  });

  it('prints the receipt wording for a stage the pipeline never got to', () => {
    expect(STAGE_STATUS_LABEL[StageStatus.NOT_REACHED]).toBe('not reached');
    expect(STAGE_STATUS_NOTE[StageStatus.NOT_REACHED]).toBe('checks stop at the first failure');
  });

  it('gives every status a label and a note, so no receipt row can render blank', () => {
    for (const status of Object.values(StageStatus)) {
      expect(STAGE_STATUS_LABEL[status]).toBeTruthy();
      expect(STAGE_STATUS_NOTE[status]).toBeTruthy();
    }
  });

  it('counts only the statuses that reached a judgement as having run', () => {
    const ran = Object.values(StageStatus).filter(stageRan);
    expect(ran.sort()).toEqual(
      [StageStatus.PASSED, StageStatus.FAILED, StageStatus.MISAPPLIED].sort(),
    );
  });

  it('builds a not-reached result with no score — a stage that did not run did not score zero', () => {
    const result = notReached(VerificationStage.SEMANTIC);
    expect(result.status).toBe(StageStatus.NOT_REACHED);
    expect(isStagePass(result.status)).toBe(false);
    expect(result.score).toBeNull();
  });

  it('orders the pipeline cheapest-first and marks the first two unsampled', () => {
    expect(VERIFICATION_PIPELINE).toEqual([
      VerificationStage.SCHEMA,
      VerificationStage.DETERMINISTIC_RULES,
      VerificationStage.CROSS_CHECK,
      VerificationStage.SEMANTIC,
    ]);
    // The cheap layers run on every call. They are the first two, and
    // they are the ones no sampler may ever touch.
    expect(UNSAMPLED_STAGES).toEqual([
      VerificationStage.SCHEMA,
      VerificationStage.DETERMINISTIC_RULES,
    ]);
  });
});
