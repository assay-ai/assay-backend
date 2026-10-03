import { splitCompensation, WindowSpend } from '@modules/slash/domain/compensation-split';

/**
 * Dividing the agent share of a penalty across the agents who spent in
 * the window.
 *
 * The property that matters is not fairness, it is **exactness**: the vault
 * gains `agentAmount` on chain, and the ledger credits must sum to the same
 * number. Any dust left over or conjured up shows later as an unexplained
 * surplus or shortfall in proof of reserves, attributable to nothing.
 */

function spend(agentAccount: string, amount: bigint, organizationId = 'org-1'): WindowSpend {
  return { organizationId, agentAccount, spend: amount };
}

describe('splitCompensation', () => {
  it('gives a single agent the whole share', () => {
    const credits = splitCompensation(1_000_000n, [spend('agent-a', 500n)]);

    expect(credits).toEqual([
      { organizationId: 'org-1', agentAccount: 'agent-a', amount: 1_000_000n },
    ]);
  });

  it('splits 3:1 exactly', () => {
    const credits = splitCompensation(1_000_000n, [spend('agent-a', 300n), spend('agent-b', 100n)]);

    expect(credits).toEqual([
      { organizationId: 'org-1', agentAccount: 'agent-a', amount: 750_000n },
      { organizationId: 'org-1', agentAccount: 'agent-b', amount: 250_000n },
    ]);
  });

  /**
   * 10 ÷ 3 in integer minor units. Floors give 3+3+3 and lose a unit; this
   * allocates the remainder by largest fractional part, ties broken by account
   * so the outcome is deterministic rather than dependent on row order.
   */
  it('allocates the indivisible remainder and still sums exactly', () => {
    const credits = splitCompensation(10n, [
      spend('agent-a', 1n),
      spend('agent-b', 1n),
      spend('agent-c', 1n),
    ]);

    expect(credits.reduce((total, credit) => total + credit.amount, 0n)).toBe(10n);
    expect(credits.map((credit) => credit.amount).sort()).toEqual([3n, 3n, 4n]);
  });

  it('returns nothing when nobody spent, and does not divide by zero', () => {
    expect(splitCompensation(1_000_000n, [spend('agent-a', 0n)])).toEqual([]);
    expect(splitCompensation(1_000_000n, [])).toEqual([]);
  });

  it('returns nothing when there is nothing to share', () => {
    expect(splitCompensation(0n, [spend('agent-a', 500n)])).toEqual([]);
  });

  /**
   * A zero-amount ledger row is a liability of nothing and a notification about
   * nothing. An agent whose share rounds away gets no entry at all.
   */
  it('drops an agent whose share rounds to zero', () => {
    const credits = splitCompensation(2n, [
      spend('agent-big', 1_000_000n),
      spend('agent-tiny', 1n),
    ]);

    expect(credits.every((credit) => credit.amount > 0n)).toBe(true);
    expect(credits.reduce((total, credit) => total + credit.amount, 0n)).toBe(2n);
  });

  it('keeps each agent in their own organization', () => {
    const credits = splitCompensation(1_000n, [
      spend('agent-a', 1n, 'org-a'),
      spend('agent-b', 1n, 'org-b'),
    ]);

    expect(credits.map((credit) => credit.organizationId).sort()).toEqual(['org-a', 'org-b']);
  });

  /**
   * The exactness property, over inputs nobody enumerated. This is the test
   * that would catch a rounding rewrite that looks right on the worked
   * examples above.
   */
  it('sums to the share for arbitrary inputs', () => {
    for (let round = 0; round < 200; round += 1) {
      const agents = 1 + Math.floor(Math.random() * 8);
      const spends = Array.from({ length: agents }, (_unused, index) =>
        spend(`agent-${index}`, BigInt(1 + Math.floor(Math.random() * 100_000))),
      );
      const share = BigInt(Math.floor(Math.random() * 5_000_000));

      const credits = splitCompensation(share, spends);
      const total = credits.reduce((sum, credit) => sum + credit.amount, 0n);

      expect(total).toBe(share);
      expect(credits.every((credit) => credit.amount > 0n)).toBe(true);
    }
  });
});
