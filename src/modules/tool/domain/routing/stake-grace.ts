import { IneligibilityReason } from './routing.types';
import { StakeGateVerdict } from './stake-gate';

/**
 * The 7-day grace period, as a second pure function.
 *
 * ```text
 * evaluateStakeGate ──▶ verdict ──applyStakeGrace──▶ verdict'
 *   (unchanged)                     (routing only)
 * ```
 *
 * ## Why this is not a branch inside `evaluateStakeGate`
 *
 * The gate has two callers and only one of them is traffic.
 * `BindingPublishService.stakeGate` builds a `RoutingCandidate` by hand and
 * calls `evaluateStakeGate` directly, to answer *may this binding go live*. If
 * grace lived inside the gate, the publish checklist would start rendering
 * `STAKE_GRACE_EXPIRED` against a binding that has never served a single call —
 * a reason that cannot be true of it, on a screen a provider actually reads and
 * acts on.
 *
 * The rule underneath is sharper than the mechanics: **grace protects traffic
 * that is already flowing; it does not open the door.** A binding that has
 * never cleared the floor has nothing to protect, and `STAKE_BELOW_MINIMUM` is
 * the whole and correct answer there. So the publish gate passes
 * `stakeGraceUntil: null` and never calls this function, and the router calls
 * it on every candidate.
 *
 * ## Why the gate itself must keep working when stake is real
 *
 * `evaluateStakeGate` is a step function: below the floor, not routable, in the
 * same instant. That is safe while stake is a configured stand-in, because a
 * config value does not move on its own. It stops being safe the moment the
 * reading comes off chain, because the settlement program has been able to
 * *reduce* it by slashing — one $5 slash against a provider sitting near their
 * floor would take their entire paid traffic offline with no warning and no act
 * of theirs. The grace period forbids exactly that: routing continues for
 * 7 days, and the provider's screen
 * opens with `Your traffic is still flowing.`
 *
 * ## Below the minimum with NO grace row is NOT an expired grace
 *
 * The fourth branch below looks like a missing case and is a decision. The
 * monitor job that opens grace rows runs on a timer, so between the moment a
 * provider drops below their floor and the moment the row exists there is a
 * window — up to one tick — in which the correct answer is exactly what the
 * gate already said. Relabelling that window would put "your grace period
 * expired" in a receipt and on a rejection screen belonging to someone who
 * never had one, and it would do it during the few minutes when they most need
 * to be told the truth about why traffic stopped.
 *
 * That is also why {@link IneligibilityReason.STAKE_BELOW_MINIMUM} stays
 * reachable after this function exists.
 *
 * ## No clock
 *
 * `now` is a parameter, like everything else in `domain/routing/`. A routing
 * decision has to be replayable from its recorded inputs — disputes ask
 * *why this binding*, months later — and a function that reads the wall clock
 * answers a different question on every run.
 */

/**
 * Let a binding inside an open grace period keep taking paid traffic.
 *
 * `graceUntil` is a fact about the grace row and nothing else: `null` means no
 * open row, and a date means one is open until then. It says nothing about the
 * stake comparison, which is `verdict`'s job — see `RoutingCandidate.stakeGraceUntil`
 * for why a loader that nulled the date whenever stake was sufficient would
 * make the gate read its own answer back as an input.
 *
 * The boundary belongs to the expired side (`now >= graceUntil`): a period that
 * says it runs out at T is over at T. Not arbitrary — the job that resolves
 * rows uses the same comparison, so choosing the other side here would let a
 * binding route for one more tick after the row was closed against it.
 */
export function applyStakeGrace(
  verdict: StakeGateVerdict,
  graceUntil: Date | null,
  now: Date,
): StakeGateVerdict & { readonly inGrace?: true } {
  // Already routable. Grace has nothing to add, and marking it `inGrace` would
  // put a binding that is comfortably above its floor onto the grace countdown
  // screen.
  // `=== true` rather than a bare truthiness test: this project compiles with
  // `strictNullChecks: false`, under which TypeScript does not narrow a
  // discriminated union on a bare boolean check, and `eligibility.ts` spells the
  // same test `gate.passed === false` for the same reason.
  if (verdict.passed === true) {
    return verdict;
  }

  // Grace answers exactly one question — "is this provider a little short of
  // their floor". `STAKE_UNKNOWN` means we could not read the stake at all and
  // `STAKE_ASSET_MISMATCH` means the comparison could not be made; passing
  // either on the strength of a grace row would route paid traffic backed by a
  // number nobody has. Everything else here belongs to another gate entirely.
  if (verdict.reason !== IneligibilityReason.STAKE_BELOW_MINIMUM) {
    return verdict;
  }

  // The window described above: below the floor, and the row does not exist
  // yet. The gate's own answer is the true one.
  //
  // `==` rather than `===`, deliberately, so this also catches `undefined`. The
  // only caller today converts at the boundary (`provider-router.service.ts`
  // does `graceUntil.get(binding.id) ?? null`, because the source returns a
  // `ReadonlyMap` whose miss is `undefined`), so this is defence, not a live
  // bug. It is worth the character because of WHICH input it protects: under
  // `strictNullChecks: false` a caller that forgot that conversion would reach
  // `undefined.getTime()` two lines down — a TypeError thrown inside routing,
  // on the single commonest input there is, since almost no binding has a grace
  // row. Failing loudly on the rare path is fine; failing loudly on the default
  // path is an outage.
  if (graceUntil == null) {
    return verdict;
  }

  if (now.getTime() >= graceUntil.getTime()) {
    return {
      passed: false,
      reason: IneligibilityReason.STAKE_GRACE_EXPIRED,
      // Both halves, deliberately. The shortfall is what the provider has to
      // fix; the deadline is why they are being cut *now* rather than when the
      // shortfall first appeared. A detail with one and not the other answers
      // half of what the rejection screen is asked.
      detail: `${verdict.detail}; grace expired ${graceUntil.toISOString()}`,
    };
  }

  return {
    passed: true,
    // `null`, not the floor that was missed. The failed verdict carries the
    // minimum only as text inside `detail`, and re-deriving the `Money` would
    // mean taking `MinimumStakeParameters` and the binding — i.e. re-running
    // the gate, from a function whose entire job is to not be the gate. The
    // `minimum` field is display metadata for a candidate that passed; `inGrace`
    // is the part a caller must branch on.
    minimum: null,
    // The flag exists so that "routable" and "routable because we are carrying
    // them" are never the same value. The provider console needs to tell them
    // apart to render the countdown, and a receipt that recorded the first when the second was
    // true would lose the reason a call was served under-collateralised.
    inGrace: true,
  };
}
