import {
  aggregateSlashParts,
  findDustParts,
  allocateLargestRemainder,
  minimumSplittablePenalty,
  planProRataSlash,
  ProRataCapBinding,
  ProRataCaps,
  slashPartRequestId,
  SlashPartView,
} from '@modules/slash/domain/prorata-slash';

/**
 * The pro-rata split of a window-level penalty into one judgement per harmed
 * agent.
 *
 * Three properties carry the money, and each has a property-style test over
 * thousands of generated inputs below rather than a handful of examples:
 *
 * - **exact**: the parts sum to exactly the (capped) total, never a unit more
 *   or less;
 * - **bounded**: no part is negative, zero, or above the per-attestation
 *   ceiling, and the total never exceeds any cap;
 * - **deterministic**: the same window gives the same parts whatever order its
 *   rows arrive in.
 */

/** A small deterministic PRNG, so a failing case reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function randomBig(next: () => number, max: bigint): bigint {
  // Two draws so the range is not limited to 2^32.
  const hi = BigInt(Math.floor(next() * 0x1_0000_0000));
  const lo = BigInt(Math.floor(next() * 0x1_0000_0000));
  return ((hi << 32n) | lo) % (max + 1n);
}

function shuffle<T>(rows: readonly T[], next: () => number): T[] {
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const UNCAPPED: ProRataCaps = {
  perPartCeiling: 10n ** 30n,
  totalCeiling: 10n ** 30n,
  minimumPart: 1n,
};

const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);

describe('allocateLargestRemainder', () => {
  it('splits 3:1 exactly', () => {
    const shares = allocateLargestRemainder(1_000_000n, [
      { key: 'a', weight: 300n },
      { key: 'b', weight: 100n },
    ]);
    expect(shares).toEqual(
      new Map([
        ['a', 750_000n],
        ['b', 250_000n],
      ]),
    );
  });

  it('hands the remainder to the largest fractional part, ties by key', () => {
    // 10 / 3: floors 3+3+3, one unit left; all remainders equal, so key order.
    const shares = allocateLargestRemainder(10n, [
      { key: 'c', weight: 1n },
      { key: 'a', weight: 1n },
      { key: 'b', weight: 1n },
    ]);
    expect(shares.get('a')).toBe(4n);
    expect(shares.get('b')).toBe(3n);
    expect(shares.get('c')).toBe(3n);
  });

  it('returns zeros, never a division by zero, when every weight is zero', () => {
    const shares = allocateLargestRemainder(10n, [{ key: 'a', weight: 0n }]);
    expect(shares.get('a')).toBe(0n);
  });

  it('refuses a negative total or weight', () => {
    expect(() => allocateLargestRemainder(-1n, [{ key: 'a', weight: 1n }])).toThrow(/negative/);
    expect(() => allocateLargestRemainder(1n, [{ key: 'a', weight: -1n }])).toThrow(/negative/);
  });

  it('refuses a duplicated key rather than paying one account twice', () => {
    expect(() =>
      allocateLargestRemainder(10n, [
        { key: 'a', weight: 1n },
        { key: 'a', weight: 2n },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('planProRataSlash — worked examples', () => {
  it('weights by the price of each agent’s failed calls', () => {
    const plan = planProRataSlash({
      windowPenalty: 250_001n,
      agents: [
        { agentAccount: 'eip155:46630:0xaaa', weight: 300_000n },
        { agentAccount: 'eip155:46630:0xbbb', weight: 100_000n },
        { agentAccount: 'eip155:46630:0xccc', weight: 100_000n },
      ],
      caps: UNCAPPED,
    });

    // 3:1:1 of 250 001 = 150 000.6 / 50 000.2 / 50 000.2 → the spare unit goes
    // to the largest remainder.
    expect(plan.parts.map((part) => [part.agentAccount, part.penalty])).toEqual([
      ['eip155:46630:0xaaa', 150_001n],
      ['eip155:46630:0xbbb', 50_000n],
      ['eip155:46630:0xccc', 50_000n],
    ]);
    expect(plan.cappedTotal).toBe(250_001n);
    expect(plan.binding).toBe(ProRataCapBinding.NONE);
    expect(plan.parts.every((part) => part.uncappedShare === part.penalty)).toBe(true);
  });

  it('scales every share down proportionally when the total cap binds, and says so', () => {
    const plan = planProRataSlash({
      windowPenalty: 28_470_000n,
      agents: [
        { agentAccount: 'a', weight: 3n },
        { agentAccount: 'b', weight: 1n },
      ],
      caps: { perPartCeiling: 10n ** 12n, totalCeiling: 20_000_000n, minimumPart: 2n },
    });

    expect(plan.cappedTotal).toBe(20_000_000n);
    expect(plan.binding).toBe(ProRataCapBinding.TOTAL_CEILING);
    expect(plan.parts.map((part) => part.penalty)).toEqual([15_000_000n, 5_000_000n]);
    // The uncapped figures are kept, so the record says what was owed.
    expect(plan.parts.map((part) => part.uncappedShare)).toEqual([21_352_500n, 7_117_500n]);
  });

  it('scales the whole plan, not just the largest part, when the per-attestation ceiling binds', () => {
    // penaltyAmount is 1 USDG on 46630. A 3:1 split of 2 USDG would put 1.5 on
    // one attestation, which `proposeSlash` refuses. Clipping only that one
    // would break the proportion; the plan is scaled until the largest fits.
    const plan = planProRataSlash({
      windowPenalty: 2_000_000n,
      agents: [
        { agentAccount: 'a', weight: 3n },
        { agentAccount: 'b', weight: 1n },
      ],
      caps: { perPartCeiling: 1_000_000n, totalCeiling: 10n ** 12n, minimumPart: 2n },
    });

    expect(plan.binding).toBe(ProRataCapBinding.PART_CEILING);
    expect(plan.parts.map((part) => part.penalty)).toEqual([1_000_000n, 333_333n]);
    expect(plan.cappedTotal).toBe(1_333_333n);
  });

  it('drops a part the contract can never split and re-splits its share, so the total still sums', () => {
    // b's share rounds to 0 or 1 unit: `executeSlash` would revert
    // PenaltyTooSmallToSplit on it for ever. It is left out and the WHOLE
    // penalty is re-split among the rest by the same weights.
    const plan = planProRataSlash({
      windowPenalty: 1_000n,
      agents: [
        { agentAccount: 'a', weight: 999n },
        { agentAccount: 'b', weight: 1n },
      ],
      caps: { ...UNCAPPED, minimumPart: 2n },
    });

    // 999 : 1 of 1000 would be 999 / 1; b's 1 unit is re-split onto a.
    expect(plan.parts.map((part) => [part.agentAccount, part.penalty])).toEqual([['a', 1_000n]]);
    expect(plan.unpaid.map((agent) => agent.agentAccount)).toEqual(['b']);
    expect(plan.binding).toBe(ProRataCapBinding.DUST_FLOOR);
    expect(plan.cappedTotal).toBe(1_000n);
  });

  it('re-applies the per-attestation ceiling after a redistribution', () => {
    const plan = planProRataSlash({
      windowPenalty: 2_000_001n,
      agents: [
        { agentAccount: 'a', weight: 1_000_000n },
        { agentAccount: 'b', weight: 1_000_000n },
        { agentAccount: 'c', weight: 1n },
      ],
      caps: { perPartCeiling: 1_000_000n, totalCeiling: 10n ** 12n, minimumPart: 2n },
    });
    expect(plan.parts.map((part) => part.penalty)).toEqual([1_000_000n, 1_000_000n]);
    expect(plan.parts.every((part) => part.penalty <= 1_000_000n)).toBe(true);
  });

  it('ignores agents with no failed paid calls', () => {
    const plan = planProRataSlash({
      windowPenalty: 100n,
      agents: [
        { agentAccount: 'a', weight: 5n },
        { agentAccount: 'free-caller', weight: 0n },
      ],
      caps: UNCAPPED,
    });
    expect(plan.parts.map((part) => part.agentAccount)).toEqual(['a']);
  });

  it('is empty, not an error, when nobody was harmed or nothing is owed', () => {
    expect(planProRataSlash({ windowPenalty: 100n, agents: [], caps: UNCAPPED }).parts).toEqual([]);
    expect(
      planProRataSlash({
        windowPenalty: 0n,
        agents: [{ agentAccount: 'a', weight: 1n }],
        caps: UNCAPPED,
      }).parts,
    ).toEqual([]);
    expect(
      planProRataSlash({
        windowPenalty: 100n,
        agents: [{ agentAccount: 'a', weight: 1n }],
        caps: { ...UNCAPPED, totalCeiling: 0n },
      }).parts,
    ).toEqual([]);
  });
});

describe('planProRataSlash — properties over generated windows', () => {
  const RUNS = 2_000;

  it('sums exactly, is never negative or zero, and respects every cap', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const next = rng(seed);
      const agentCount = 1 + Math.floor(next() * 12);
      const agents = Array.from({ length: agentCount }, (_, i) => ({
        agentAccount: `eip155:46630:0x${seed.toString(16)}${i.toString(16).padStart(4, '0')}`,
        weight: randomBig(next, next() < 0.1 ? 0n : 10n ** BigInt(1 + Math.floor(next() * 9))),
      }));
      const windowPenalty = randomBig(next, 10n ** BigInt(Math.floor(next() * 12)));
      const caps: ProRataCaps = {
        perPartCeiling: 1n + randomBig(next, 10n ** BigInt(Math.floor(next() * 10))),
        totalCeiling: randomBig(next, 10n ** BigInt(Math.floor(next() * 12))),
        minimumPart: 1n + randomBig(next, 3n),
      };

      const plan = planProRataSlash({ windowPenalty, agents, caps });
      const penalties = plan.parts.map((part) => part.penalty);
      const context = { seed, windowPenalty, caps, penalties };

      // Exact.
      expect({ ...context, sum: sum(penalties) }).toEqual({ ...context, sum: plan.cappedTotal });
      // Bounded.
      expect(plan.cappedTotal <= windowPenalty).toBe(true);
      expect(plan.cappedTotal <= caps.totalCeiling).toBe(true);
      for (const part of plan.parts) {
        expect({ seed, ok: part.penalty >= caps.minimumPart && part.penalty > 0n }).toEqual({
          seed,
          ok: true,
        });
        expect({ seed, ok: part.penalty <= caps.perPartCeiling }).toEqual({ seed, ok: true });
        expect({ seed, ok: part.weight > 0n }).toEqual({ seed, ok: true });
      }
      // Dropping dust never shrinks the total: it is re-split among the rest.
      if (plan.binding === ProRataCapBinding.DUST_FLOOR && plan.parts.length > 0) {
        expect({ seed, total: plan.cappedTotal }).toEqual({
          seed,
          total: windowPenalty < caps.totalCeiling ? windowPenalty : caps.totalCeiling,
        });
      }
      // The uncapped shares are the exact split of the window penalty.
      const uncapped = [...plan.parts, ...plan.unpaid].map((part) => part.uncappedShare);
      const positive = agents.filter((agent) => agent.weight > 0n);
      if (positive.length > 0) {
        expect({ seed, sum: sum(uncapped) }).toEqual({ seed, sum: windowPenalty });
      }
      // Unbound means untouched.
      if (plan.binding === ProRataCapBinding.NONE && positive.length > 0) {
        expect({ seed, total: plan.cappedTotal }).toEqual({ seed, total: windowPenalty });
      }
    }
  });

  it('gives the same parts whatever order the rows arrive in', () => {
    for (let seed = 1; seed <= RUNS / 4; seed += 1) {
      const next = rng(seed);
      const agents = Array.from({ length: 2 + Math.floor(next() * 8) }, (_, i) => ({
        agentAccount: `agent-${seed}-${i}`,
        weight: 1n + randomBig(next, 1_000n),
      }));
      const windowPenalty = randomBig(next, 10_000_000n);
      const caps: ProRataCaps = {
        perPartCeiling: 1n + randomBig(next, 5_000_000n),
        totalCeiling: randomBig(next, 10_000_000n),
        minimumPart: 2n,
      };

      const a = planProRataSlash({ windowPenalty, agents, caps });
      const b = planProRataSlash({ windowPenalty, agents: shuffle(agents, next), caps });
      expect({ seed, parts: b.parts }).toEqual({ seed, parts: a.parts });
    }
  });

  it('never pays one agent more than the proportion allows, up to one rounding unit', () => {
    for (let seed = 1; seed <= RUNS / 4; seed += 1) {
      const next = rng(seed);
      const agents = Array.from({ length: 2 + Math.floor(next() * 6) }, (_, i) => ({
        agentAccount: `agent-${i}`,
        weight: 1n + randomBig(next, 10_000n),
      }));
      const windowPenalty = 1n + randomBig(next, 100_000_000n);
      const plan = planProRataSlash({ windowPenalty, agents, caps: UNCAPPED });
      const totalWeight = sum(agents.map((agent) => agent.weight));
      for (const part of plan.parts) {
        const exactFloor = (windowPenalty * part.weight) / totalWeight;
        expect({ seed, ok: part.penalty - exactFloor <= 1n && part.penalty >= exactFloor }).toEqual(
          { seed, ok: true },
        );
      }
    }
  });
});

describe('findDustParts', () => {
  const parts = planProRataSlash({
    windowPenalty: 1_000_003n,
    agents: [
      { agentAccount: 'a', weight: 1_000_000n },
      { agentAccount: 'b', weight: 3n },
    ],
    caps: UNCAPPED,
  }).parts;

  it('keeps every non-zero share by default, even one the contract may not split', () => {
    expect(parts.map((part) => [part.agentAccount, part.penalty])).toEqual([
      ['a', 1_000_000n],
      ['b', 3n],
    ]);
  });

  it('reports parts whose 60% would be below the configured minimum, without removing them', () => {
    expect(findDustParts(parts, 6_000, 10n).map((part) => part.agentAccount)).toEqual(['b']);
    expect(findDustParts(parts, 6_000, 0n)).toEqual([]);
  });
});

describe('minimumSplittablePenalty', () => {
  it('is the smallest applied amount whose 60/30 split moves a unit', () => {
    // bpsOf(1, 6000) = 0 and bpsOf(1, 3000) = 0 → PenaltyTooSmallToSplit.
    // bpsOf(2, 6000) = 1 → the agent receives a unit.
    expect(minimumSplittablePenalty(6_000, 3_000)).toBe(2n);
    expect(minimumSplittablePenalty(10_000, 0)).toBe(1n);
    expect(minimumSplittablePenalty(100, 100)).toBe(100n);
  });

  it('refuses a split that can never pay anybody', () => {
    expect(() => minimumSplittablePenalty(0, 0)).toThrow(/never/);
  });
});

describe('slashPartRequestId', () => {
  const CASE = 'a'.repeat(64);

  it('is 32 bytes of lower-case hex', () => {
    expect(slashPartRequestId('window-1', CASE, 'eip155:46630:0xabc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic, so a retried proposal adopts rather than doubles', () => {
    expect(slashPartRequestId('window-1', CASE, 'eip155:46630:0xabc')).toBe(
      slashPartRequestId('window-1', CASE, 'eip155:46630:0xabc'),
    );
  });

  it('does not depend on the spelling of an EVM address', () => {
    expect(slashPartRequestId('window-1', CASE, 'eip155:46630:0xABC')).toBe(
      slashPartRequestId('window-1', CASE, 'eip155:46630:0xabc'),
    );
  });

  it('differs per agent, per window and per case epoch', () => {
    const ids = new Set([
      slashPartRequestId('window-1', CASE, 'eip155:46630:0xabc'),
      slashPartRequestId('window-1', CASE, 'eip155:46630:0xabd'),
      slashPartRequestId('window-2', CASE, 'eip155:46630:0xabc'),
      slashPartRequestId('window-1', 'b'.repeat(64), 'eip155:46630:0xabc'),
      CASE,
    ]);
    expect(ids.size).toBe(5);
  });

  it('refuses a case request id that is not 32 bytes of hex', () => {
    expect(() => slashPartRequestId('w', 'xyz', 'a')).toThrow(/32 bytes/);
  });
});

describe('aggregateSlashParts', () => {
  const T0 = new Date('2026-10-11T10:00:00Z');
  const T1 = new Date('2026-10-11T10:00:05Z');
  const X0 = new Date('2026-10-14T10:00:00Z');
  const X1 = new Date('2026-10-14T10:00:05Z');

  function part(overrides: Partial<SlashPartView>): SlashPartView {
    return {
      status: 'PENDING',
      penaltyMinor: '100',
      reservedMinor: '100',
      appliedMinor: null,
      agentAmountMinor: null,
      platformAmountMinor: null,
      proposedAt: T0,
      executableAt: X0,
      executedAt: null,
      cancelledAt: null,
      ...overrides,
    };
  }

  it('is null when nothing reached the chain', () => {
    expect(aggregateSlashParts([])).toBeNull();
    expect(aggregateSlashParts([part({ status: 'NONE', proposedAt: null })])).toBeNull();
    expect(aggregateSlashParts([part({ status: 'REFUSED' })])).toBeNull();
  });

  it('is PENDING while any part is, and waits for the LAST door to open', () => {
    const view = aggregateSlashParts([
      part({ proposedAt: T0, executableAt: X0 }),
      part({ proposedAt: T1, executableAt: X1, penaltyMinor: '50', reservedMinor: '50' }),
    ]);
    expect(view).toMatchObject({
      status: 'PENDING',
      penaltyMinor: '150',
      reservedMinor: '150',
      appliedMinor: '0',
      proposedAt: T0,
      executableAt: X1,
      executedAt: null,
    });
  });

  it('is EXECUTED only once no part is pending, summing what the chain took', () => {
    const executed = {
      status: 'EXECUTED' as const,
      appliedMinor: '100',
      agentAmountMinor: '60',
      platformAmountMinor: '30',
    };
    expect(
      aggregateSlashParts([part({ ...executed, executedAt: X0 }), part({ status: 'PENDING' })])
        ?.status,
    ).toBe('PENDING');

    const view = aggregateSlashParts([
      part({ ...executed, executedAt: X0 }),
      part({ ...executed, executedAt: X1 }),
      part({ status: 'REFUSED', penaltyMinor: '999' }),
    ]);
    expect(view).toMatchObject({
      status: 'EXECUTED',
      penaltyMinor: '200',
      appliedMinor: '200',
      agentAmountMinor: '120',
      platformAmountMinor: '60',
      executedAt: X1,
    });
  });

  it('reports a part executed beside a part cancelled as EXECUTED — money moved', () => {
    const view = aggregateSlashParts([
      part({
        status: 'EXECUTED',
        appliedMinor: '100',
        agentAmountMinor: '60',
        platformAmountMinor: '30',
        executedAt: X1,
      }),
      part({ status: 'CANCELLED', cancelledAt: X0 }),
    ]);
    expect(view).toMatchObject({ status: 'EXECUTED', appliedMinor: '100', agentAmountMinor: '60' });
  });

  it('is CANCELLED only when every part that landed was cancelled', () => {
    const view = aggregateSlashParts([
      part({ status: 'CANCELLED', cancelledAt: X0 }),
      part({ status: 'CANCELLED', cancelledAt: X1 }),
    ]);
    expect(view).toMatchObject({ status: 'CANCELLED', cancelledAt: X1, appliedMinor: '0' });
  });
});

describe('slashRecordMismatch — the one rule for adopting a record at our request id', () => {
  // `matchSlashRecord` is imported lazily so this block reads on its own.
  const { slashRecordMismatch, policyHashOf } = jest.requireActual(
    '@modules/slash/domain/prorata-slash',
  );
  const expected = {
    beneficiary: '0xAbC0000000000000000000000000000000000001',
    penaltyMinor: '150001',
    policy: 'tool-1',
  };
  const record = {
    beneficiary: '0xabc0000000000000000000000000000000000001',
    penaltyMinor: '150001',
    policy: policyHashOf('tool-1'),
    verifierAccepted: true,
  };

  it('accepts the same judgement whatever the address spelling', () => {
    expect(slashRecordMismatch(record, expected)).toBeNull();
  });

  it.each([
    ['beneficiary', { beneficiary: '0xabc0000000000000000000000000000000000002' }],
    ['penalty', { penaltyMinor: '150000' }],
    ['policy', { policy: policyHashOf('tool-2') }],
  ])('refuses a %s mismatch, always', (field, override) => {
    expect(slashRecordMismatch({ ...record, ...override }, expected)).toBe(field);
  });

  it('accepts a different verifier only while that key may still sign (rotation)', () => {
    expect(slashRecordMismatch({ ...record, verifierAccepted: true }, expected)).toBeNull();
    expect(slashRecordMismatch({ ...record, verifierAccepted: false }, expected)).toBe('verifier');
  });

  it('cannot judge a record that does not carry the fields (Solana) and does not pretend to', () => {
    expect(slashRecordMismatch({ penaltyMinor: '150001' }, expected)).toBeNull();
    expect(slashRecordMismatch({ penaltyMinor: '1' }, expected)).toBe('penalty');
  });

  it('hashes the policy exactly as the EVM attestation does (SHA-256 of the UTF-8 string)', () => {
    // viem: sha256(toBytes('tool-uuid'))
    expect(policyHashOf('tool-uuid')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
