import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  DisputeResolutionState,
  isOverturn,
  OUTCOME_CONSEQUENCE,
  REASON_CODES,
  reasonCodesAreValid,
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
  it('has exactly six outcomes, and every one has a consequence row', () => {
    const outcomes = Object.values(ArbitrationOutcome);
    expect(outcomes).toHaveLength(6);
    for (const outcome of outcomes) {
      expect(OUTCOME_CONSEQUENCE[outcome]).toBeDefined();
      expect(ARBITRATION_STATE_MAP[outcome]).toBeDefined();
      expect(REASON_CODES[outcome].length).toBeGreaterThan(0);
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
  it('maps an upheld proposal to a REJECTED objection, and every overturn to an UPHELD one', () => {
    expect(ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD]).toBe(DisputeResolutionState.REJECTED);
    expect(ARBITRATION_STATE_MAP[ArbitrationOutcome.UPHELD_RECALCULATED]).toBe(
      DisputeResolutionState.PARTIALLY_UPHELD,
    );

    const overturns = Object.values(ArbitrationOutcome).filter(isOverturn);
    expect(overturns).toHaveLength(4);
    for (const outcome of overturns) {
      expect(ARBITRATION_STATE_MAP[outcome]).toBe(DisputeResolutionState.UPHELD);
    }
  });

  it('agrees member-for-member with the dispute module’s own state enum', () => {
    expect(Object.values(DisputeResolutionState).sort()).toEqual(
      Object.values(DisputeState).sort(),
    );
  });

  /**
   * Only findings about **us** sweep.
   *
   * A griefing finding is about one agent's traffic and an insufficient-sample
   * finding is about one window; neither generalises to bindings that never saw
   * them. Sweeping either would cancel penalties on providers whose facts were
   * never in question — the same defect as levying them, pointed the other way.
   */
  it('opens a fleet sweep for exactly the platform and policy defects', () => {
    const sweeping = Object.values(ArbitrationOutcome).filter(
      (outcome) => OUTCOME_CONSEQUENCE[outcome].opensFleetSweep,
    );
    expect(sweeping.sort()).toEqual(
      [
        ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        ArbitrationOutcome.OVERTURNED_POLICY_DEFECT,
      ].sort(),
    );
  });

  /**
   * The false-positive rule, and the two non-obvious members of it.
   *
   * `OVERTURNED_INSUFFICIENT_EVIDENCE` counts against us: we proposed taking
   * money on evidence that could not support it. `OVERTURNED_GRIEFING` does
   * **not**: the measurement was correct, the calls really did fail, and the
   * cause was a third party — counting it would make our own error metric move
   * whenever somebody attacked a provider, which is the one thing it must not
   * do.
   */
  it('counts insufficient evidence against us and griefing against nobody', () => {
    const counted = Object.values(ArbitrationOutcome).filter(
      (outcome) => OUTCOME_CONSEQUENCE[outcome].countsAsFalsePositive,
    );
    expect(counted.sort()).toEqual(
      [
        ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT,
        ArbitrationOutcome.OVERTURNED_POLICY_DEFECT,
        ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE,
      ].sort(),
    );
    expect(OUTCOME_CONSEQUENCE[ArbitrationOutcome.OVERTURNED_GRIEFING].countsAsFalsePositive).toBe(
      false,
    );
  });

  /**
   * An insufficient-evidence overturn leaves the strikes standing.
   *
   * The calls really did fail; we simply could not say at what rate. Removing
   * the strikes would erase an observation rather than a verdict — and the dispute
   * case's restoration record has to say so, rather than promising a restoration that
   * will not happen.
   */
  it('is the only overturn that leaves strikes standing', () => {
    const standing = Object.values(ArbitrationOutcome).filter(
      (outcome) => isOverturn(outcome) && OUTCOME_CONSEQUENCE[outcome].strikesStand,
    );
    expect(standing).toEqual([ArbitrationOutcome.OVERTURNED_INSUFFICIENT_EVIDENCE]);
  });

  it('refuses an empty reason-code list and a code from another outcome', () => {
    expect(reasonCodesAreValid(ArbitrationOutcome.UPHELD, [])).toBe(false);
    expect(reasonCodesAreValid(ArbitrationOutcome.UPHELD, ['MAPPING_REGRESSION'])).toBe(false);
    expect(
      reasonCodesAreValid(ArbitrationOutcome.OVERTURNED_PLATFORM_DEFECT, ['MAPPING_REGRESSION']),
    ).toBe(true);
  });
});
