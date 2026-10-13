import { planEvidenceMismatch } from '@modules/slash/domain/slash-plan-evidence';

/**
 * Review H-2: before anything is signed, the stored plan must be what the
 * evidence (the window's failed, priced calls to this provider) produces.
 */
describe('planEvidenceMismatch', () => {
  const A = 'eip155:46630:0x00000000000000000000000000000000000000a1';
  const B = 'eip155:46630:0x00000000000000000000000000000000000000b2';
  const ATTACKER = 'eip155:46630:0x00000000000000000000000000000000000000ee';

  // Weights 300 / 100 over a 400 penalty: shares 300 / 100.
  const evidence = new Map([
    [A, 300n],
    [B, 100n],
  ]);
  const part = (agent: string, overrides: Record<string, string> = {}) => ({
    agentAccount: agent,
    beneficiaryAccount: agent,
    weightAmount: evidence.get(agent)?.toString() ?? '0',
    uncappedShareAmount: agent === A ? '300' : '100',
    penaltyAmount: agent === A ? '300' : '100',
    planPenaltyAmount: '400',
    ...overrides,
  });
  const check = (parts: ReturnType<typeof part>[], casePenalty = 400n) =>
    planEvidenceMismatch({ casePenalty, evidence, parts });

  it('accepts the plan the evidence produces, and a capped one', () => {
    expect(check([part(A), part(B)])).toBeNull();
    // A cap lowers penalties; it never raises them.
    expect(check([part(A, { penaltyAmount: '150' }), part(B, { penaltyAmount: '50' })])).toBeNull();
    // Mixed-case EVM address is the same account.
    expect(
      check([
        part(A, { beneficiaryAccount: A.toUpperCase().replace('EIP155', 'eip155') }),
        part(B),
      ]),
    ).toBeNull();
  });

  it('refuses a beneficiary that is not the harmed agent', () => {
    expect(check([part(A, { beneficiaryAccount: ATTACKER }), part(B)])).toMatch(/beneficiary/);
  });

  it('refuses an agent with no failed, priced call to this provider in the window', () => {
    expect(check([part(A), part(B), part(ATTACKER, { penaltyAmount: '1' })])).toMatch(
      /not a payer/,
    );
  });

  it('refuses a raised penalty, a changed weight or share, and a sum above the case penalty', () => {
    expect(check([part(A, { penaltyAmount: '301' }), part(B)])).toMatch(/penalty/);
    expect(check([part(A, { weightAmount: '900' }), part(B)])).toMatch(/weight/);
    expect(check([part(A, { uncappedShareAmount: '350', penaltyAmount: '300' }), part(B)])).toMatch(
      /share/,
    );
    expect(check([part(A), part(B)], 399n)).toMatch(/above the case penalty/);
  });

  it('refuses an empty plan and a duplicated agent', () => {
    expect(check([])).toMatch(/no parts/);
    expect(check([part(A), part(A)])).toMatch(/twice/);
  });
});
