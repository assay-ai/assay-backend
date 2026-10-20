import { canTransition, SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';

describe('the slash case state machine', () => {
  it('lets an EXECUTING case be cancelled when the chain says the judgement is void', () => {
    // A revoked verifier key voids everything in flight. The case was claimed
    // EXECUTING, execute_slash refused with VerifierRevoked, and there is no
    // path back to UPHELD that would not retry a dead judgement forever.
    expect(canTransition(SlashProposalStatus.EXECUTING, SlashProposalStatus.CANCELLED)).toBe(true);
  });

  it('still refuses to re-execute or to reverse an unexecuted case', () => {
    expect(canTransition(SlashProposalStatus.EXECUTED, SlashProposalStatus.EXECUTING)).toBe(false);
    expect(canTransition(SlashProposalStatus.EXECUTING, SlashProposalStatus.REVERSED)).toBe(false);
    expect(canTransition(SlashProposalStatus.CANCELLED, SlashProposalStatus.UPHELD)).toBe(false);
  });

  it('reverses only an EXECUTED case', () => {
    for (const from of Object.values(SlashProposalStatus)) {
      expect(canTransition(from, SlashProposalStatus.REVERSED)).toBe(
        from === SlashProposalStatus.EXECUTED,
      );
    }
  });

  it('lets a DISPUTED case go only where the arbiter sends it', () => {
    expect(canTransition(SlashProposalStatus.DISPUTED, SlashProposalStatus.UPHELD)).toBe(true);
    expect(canTransition(SlashProposalStatus.DISPUTED, SlashProposalStatus.CANCELLED)).toBe(true);
    expect(canTransition(SlashProposalStatus.DISPUTED, SlashProposalStatus.EXECUTING)).toBe(false);
  });
});
