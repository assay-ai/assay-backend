import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  DisputeResolutionState,
  OUTCOME_CONSEQUENCE,
} from '@modules/slash/domain/arbitration';
import { DisputeState } from '@modules/dispute/dto/dispute.dto';

/**
 * The arbitration vocabulary, pinned.
 *
 * Modelled on `verdict-vocabulary.spec.ts`, which pins the seven verdict
 * statuses one domain over, and for the same reason: these are not behaviours
 * that can drift quietly, they are *statements about what a word means*, and a
 * change to one of them changes who loses money.
 */
describe('arbitration vocabulary', () => {
  it('has exactly two outcomes, and every one has a consequence row', () => {
    const outcomes = Object.values(ArbitrationOutcome);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(OUTCOME_CONSEQUENCE[outcome]).toBeDefined();
      expect(ARBITRATION_STATE_MAP[outcome]).toBeDefined();
    }
  });

  /**
   * The polarity flip, asserted in both directions.
   *
   * `disputes.state = 'UPHELD'` means the provider's objection was upheld — the
   * provider *won*. `slash_proposals.outcome = 'UPHELD'` means the proposal was
   * upheld — the provider *lost*. Getting this backwards would tell a provider
   * they won a case they lost, in writing, with money attached, so it is worth
   * a test that states it as plainly as possible.
   */
  it('maps an upheld proposal to a REJECTED objection, a recalculated one to PARTIALLY_UPHELD', () => {
    expect(ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD]).toBe(DisputeResolutionState.REJECTED);
    expect(ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD_RECALCULATED]).toBe(
      DisputeResolutionState.PARTIALLY_UPHELD,
    );
  });

  it('agrees member-for-member with the dispute module’s own state enum', () => {
    expect(Object.values(DisputeResolutionState).sort()).toEqual(
      Object.values(DisputeState).sort(),
    );
  });

  it('leaves the penalty standing and counts no outcome as a false positive', () => {
    for (const outcome of Object.values(ArbitrationOutcome)) {
      expect(OUTCOME_CONSEQUENCE[outcome].penaltyStands).toBe(true);
      expect(OUTCOME_CONSEQUENCE[outcome].countsAsFalsePositive).toBe(false);
    }
  });
});
