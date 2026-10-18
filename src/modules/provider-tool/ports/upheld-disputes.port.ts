/**
 * The upheld-dispute rate of one provider on one tool (design spec §7.6
 * "Verification": "… and upheld disputes (backlog G3.B1)").
 *
 * A narrow seam on purpose. Buyer disputes over paid calls are built
 * elsewhere (G3.B1), and they own what "upheld" means and where it is
 * stored; a provider tool's quality only needs two numbers. Until that
 * lands, {@link NO_UPHELD_DISPUTES} answers `null` — "not measured", never
 * zero: a quality figure that reads "no upheld disputes" before disputes
 * exist would be a claim nobody checked.
 */
export interface UpheldDisputeCounts {
  /** Disputes an operator decided in the window. */
  readonly decided: number;
  /** Of those, upheld for the buyer. */
  readonly upheld: number;
}

export interface UpheldDisputesPort {
  /** Decided and upheld disputes over this provider's calls of this tool since `since`, or `null`. */
  countsFor(providerId: string, toolId: string, since: Date): Promise<UpheldDisputeCounts | null>;
}

export const UPHELD_DISPUTES = 'UPHELD_DISPUTES';

/** The stub until buyer disputes merge: nothing measured. */
export const NO_UPHELD_DISPUTES: UpheldDisputesPort = Object.freeze({
  countsFor: async () => null,
});
