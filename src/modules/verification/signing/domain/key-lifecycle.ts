/**
 * The lifecycle of a verifier signing key, as data.
 *
 * ## Why there is a local state machine at all when the chain has one
 *
 * The on-chain registry already answers one question — *may this key's
 * signature move money?* — and it is the authoritative answer, because it is the
 * one the settlement program reads. This state machine answers a different one:
 * *which key should this platform sign with right now?* The two are not the
 * same, and the gap between them is precisely where a rotation lives.
 *
 * ```text
 *              on-chain                       here
 *   new key    Active (enrolled)              PENDING   ← enrolled, not signing yet
 *   cutover    Active                         ACTIVE    ← new signatures use it
 *   old key    Active (still enrolled)        RETIRED   ← its old signatures still verify
 *   retired    Revoked                        REVOKED   ← terminal, both sides
 * ```
 *
 * Collapsing them into one state would make rotation a step function: the
 * instant a key became the one we sign with, the previous one would stop being
 * accepted, and every attestation in flight would be worthless. Key custody requires
 * rotation *without stopping the system*, and the overlap the two extra
 * states buy is the whole of that requirement.
 *
 * ## What this file is not
 *
 * It holds no authority. Nothing here can make an unregistered key signable —
 * `VerifierKeyDirectory` checks the chain as well, and the chain checks itself
 * again at `slash`. A compromised application tier that rewrites this table
 * gets to choose which of its *already-enrolled* keys to use, and nothing more.
 * That containment is why a stolen verifier key is survivable; this module is
 * written so as not to widen it.
 */

export enum SigningKeyState {
  /**
   * Material exists and the key may be enrolled on-chain, but nothing signs
   * with it. Where a key waits out the gap between "provisioned" and "cut
   * over", which on a real rotation is hours or days.
   */
  PENDING = 'PENDING',

  /**
   * The key new attestations are signed with. **At most one per deployment**,
   * enforced by a partial unique index rather than by this file — see
   * `verifier-signing-key.entity.ts`. Two active keys is not a worse rotation,
   * it is an unanswerable question about which key an attestation should have
   * come from.
   */
  ACTIVE = 'ACTIVE',

  /**
   * Superseded, still enrolled on-chain, still verifiable. Nothing new is
   * signed with it.
   *
   * The overlap state. A key sits here from the cutover until an operator is
   * satisfied that nothing in flight still depends on it, which is why leaving
   * it is a deliberate act and not a timer.
   */
  RETIRED = 'RETIRED',

  /**
   * Terminal, here and on-chain. Nothing signs with it and nothing it signed is
   * accepted any more.
   */
  REVOKED = 'REVOKED',
}

/**
 * Every legal move, and deliberately nothing else.
 *
 * Read the two absences rather than the entries:
 *
 * - **Nothing leaves `REVOKED`.** It mirrors `revoke_verifier` on-chain, which
 *   never closes the account so that the PDA can never be re-initialised. A
 *   local table that could quietly move a key back out of `REVOKED` would let a
 *   compromised application tier resume signing with the key that caused the
 *   incident — the chain would still refuse the slash, but the platform would
 *   spend the incident issuing attestations it believes are good.
 * - **Nothing reaches `PENDING`.** A key is provisioned once. "Back to pending"
 *   would mean un-enrolling it, and enrolment is not ours to undo.
 *
 * `RETIRED → ACTIVE` *is* allowed, and is the one edge worth defending: a
 * rotation that goes wrong at 3am has to be undoable, the previous key is still
 * enrolled on-chain and still valid, and the alternative — revoke and start
 * over — is a longer outage during an incident. A key that is retired because
 * it is *suspect* is revoked, not retired; that is what the state is for.
 */
export const LEGAL_SIGNING_KEY_TRANSITIONS: Readonly<
  Record<SigningKeyState, readonly SigningKeyState[]>
> = Object.freeze({
  [SigningKeyState.PENDING]: Object.freeze([SigningKeyState.ACTIVE, SigningKeyState.REVOKED]),
  [SigningKeyState.ACTIVE]: Object.freeze([SigningKeyState.RETIRED, SigningKeyState.REVOKED]),
  [SigningKeyState.RETIRED]: Object.freeze([SigningKeyState.ACTIVE, SigningKeyState.REVOKED]),
  [SigningKeyState.REVOKED]: Object.freeze([]),
});

export function canTransition(from: SigningKeyState, to: SigningKeyState): boolean {
  return LEGAL_SIGNING_KEY_TRANSITIONS[from].includes(to);
}

/**
 * Is this the state a key signs new attestations in?
 *
 * A function rather than `state === ACTIVE` at each call site, for the reason
 * `isProviderAtFault` next door in `../../domain/verdict.ts` gives: a comparison
 * against one member is a rule that stops being true the day a fifth state
 * exists, and it stops being true silently.
 */
export function signsNewAttestations(state: SigningKeyState): boolean {
  return state === SigningKeyState.ACTIVE;
}

/**
 * Could a signature this key produced still be accepted by the program?
 *
 * Broader than {@link signsNewAttestations} on purpose — a `RETIRED` key is
 * still enrolled on-chain, so an attestation it signed before the cutover is
 * still executable until the key is revoked. Anything reasoning about
 * *outstanding* attestations has to use this one; anything choosing a key to
 * sign with has to use the other. Conflating them is how a rotation either
 * invalidates work in flight or keeps signing with a superseded key.
 */
export function mayStillBeHonoured(state: SigningKeyState): boolean {
  return state === SigningKeyState.ACTIVE || state === SigningKeyState.RETIRED;
}
