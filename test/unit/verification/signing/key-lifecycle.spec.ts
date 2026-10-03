import {
  LEGAL_SIGNING_KEY_TRANSITIONS,
  SigningKeyState,
  canTransition,
  mayStillBeHonoured,
  signsNewAttestations,
} from '@modules/verification/signing/domain/key-lifecycle';

describe('signing key lifecycle', () => {
  const ALL = Object.values(SigningKeyState);

  it('lets a key be enrolled, cut over to, superseded and retired', () => {
    // The routine rotation, end to end, as a path through the table.
    expect(canTransition(SigningKeyState.PENDING, SigningKeyState.ACTIVE)).toBe(true);
    expect(canTransition(SigningKeyState.ACTIVE, SigningKeyState.RETIRED)).toBe(true);
    expect(canTransition(SigningKeyState.RETIRED, SigningKeyState.REVOKED)).toBe(true);
  });

  it('lets a rotation be rolled back', () => {
    // A cutover that goes wrong has to be undoable without a revoke: the
    // previous key is still enrolled on-chain and still valid.
    expect(canTransition(SigningKeyState.RETIRED, SigningKeyState.ACTIVE)).toBe(true);
  });

  it('lets any live key be revoked immediately', () => {
    // Incident response must not require a key to be retired first.
    expect(canTransition(SigningKeyState.PENDING, SigningKeyState.REVOKED)).toBe(true);
    expect(canTransition(SigningKeyState.ACTIVE, SigningKeyState.REVOKED)).toBe(true);
    expect(canTransition(SigningKeyState.RETIRED, SigningKeyState.REVOKED)).toBe(true);
  });

  it('makes REVOKED terminal, mirroring the on-chain one-way door', () => {
    // `revoke_verifier` never closes the PDA precisely so a revoked key can
    // never be re-registered. A local table that could walk back out of REVOKED
    // would let a compromised app tier resume signing with the key that caused
    // the incident.
    expect(LEGAL_SIGNING_KEY_TRANSITIONS[SigningKeyState.REVOKED]).toEqual([]);
    for (const to of ALL) {
      expect(canTransition(SigningKeyState.REVOKED, to)).toBe(false);
    }
  });

  it('lets nothing return to PENDING', () => {
    // A key is provisioned once. "Back to pending" would mean un-enrolling it,
    // and enrolment is not the platform's to undo.
    for (const from of ALL) {
      expect(canTransition(from, SigningKeyState.PENDING)).toBe(false);
    }
  });

  it('has no state that can transition to itself', () => {
    // A self-transition would report success for an operation that changed
    // nothing — the shape of an idempotent rotate that silently did not rotate.
    for (const state of ALL) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('covers every state, so a new one cannot be added without a decision', () => {
    expect(Object.keys(LEGAL_SIGNING_KEY_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  describe('the two questions the states answer', () => {
    it('signs new attestations: ACTIVE alone', () => {
      expect(ALL.filter(signsNewAttestations)).toEqual([SigningKeyState.ACTIVE]);
    });

    it('may still be honoured: ACTIVE and RETIRED', () => {
      // Broader on purpose. A retired key is still enrolled on-chain, so an
      // attestation it signed before the cutover is still executable — and
      // conflating the two questions is how a rotation either invalidates work
      // in flight or keeps signing with a superseded key.
      expect(ALL.filter(mayStillBeHonoured)).toEqual([
        SigningKeyState.ACTIVE,
        SigningKeyState.RETIRED,
      ]);
    });
  });
});
