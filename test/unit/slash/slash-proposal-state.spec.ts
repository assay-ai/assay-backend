import { ResolutionKind } from '@modules/slash/domain/arbitration';
import {
  AUTOMATIC_RESOLUTION_KINDS,
  canTransition,
  SlashProposalStatus,
} from '@modules/slash/domain/slash-proposal-state';

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

  /**
   * `execute_slash` is permissionless once `executable_at` passes, so a
   * stranger can spend a standing record after an adjudicator has overturned
   * the case. `recordAnExecutionNobodyAskedFor` records the money and keeps the
   * decision, which leaves a real `OVERTURNED` row whose provider is out of
   * pocket — and the reversal is the only way that money goes back.
   *
   * The edge alone does not authorise reversing an overturn: `reverse()` gates
   * on `executed_at`/`applied_amount`, and this table is the half that stops a
   * status which acquires them some other way from slipping through.
   */
  it('lets an OVERTURNED case be reversed, because the chain can execute one anyway', () => {
    expect(canTransition(SlashProposalStatus.OVERTURNED, SlashProposalStatus.REVERSED)).toBe(true);
  });

  it('gives OVERTURNED no other way out — a reversal is not a re-decision', () => {
    for (const to of Object.values(SlashProposalStatus)) {
      if (to === SlashProposalStatus.REVERSED) continue;
      expect(canTransition(SlashProposalStatus.OVERTURNED, to)).toBe(false);
    }
  });

  it('lists a chain-voided closure among the kinds that resolve a case without a human', () => {
    // Nobody adjudicated this one — the chain did — so it belongs with the
    // other three automatic kinds. Nothing consumes AUTOMATIC_RESOLUTION_KINDS
    // today, so this asserts membership of the list and nothing about
    // behaviour; the list has to be complete before the check that reads it is
    // written.
    expect(AUTOMATIC_RESOLUTION_KINDS).toContain(ResolutionKind.AUTO_CHAIN_VOIDED);
  });
});
