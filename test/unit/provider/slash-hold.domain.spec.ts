import {
  decayedWindow,
  nextSlashHoldState,
  NOT_HELD,
  SlashHoldReason,
  slashHoldReasons,
  SlashHoldStakeReading,
} from '@modules/provider/domain/slash-hold';

const NOW = 1_800_000_000n;
const healthy: SlashHoldStakeReading = {
  bonded: 100_000_000n,
  unbonding: 0n,
  pendingSlash: 0n,
  slashedInWindow: 0n,
  slashWindowStartedAt: 0n,
  penaltyAmount: 1_000_000n,
  slashCapBps: 1_000, // 10% of at-risk: 10,000,000
  minimumStake: 50_000_000n,
};
const idle = { recordWaiting: false, windowRefused: false };

describe('slashHoldReasons', () => {
  it('holds nothing for a healthy stake', () => {
    expect(slashHoldReasons(healthy, idle, NOW)).toEqual([]);
  });

  it('1. a full provider window with an upheld record waiting', () => {
    const full = { ...healthy, slashedInWindow: 10_000_000n, slashWindowStartedAt: NOW };
    expect(slashHoldReasons(full, { recordWaiting: true, windowRefused: false }, NOW)).toEqual([
      SlashHoldReason.SLASH_WINDOW_FULL,
    ]);
    // Full, but nothing waits: no hold.
    expect(slashHoldReasons(full, idle, NOW)).toEqual([]);
    // The window drained: no hold.
    const drained = { ...full, slashWindowStartedAt: NOW - 86_400n };
    expect(slashHoldReasons(drained, { recordWaiting: true, windowRefused: false }, NOW)).toEqual(
      [],
    );
  });

  it('1. a full verifier-key window, seen as a WAIT refusal, with a record waiting', () => {
    expect(slashHoldReasons(healthy, { recordWaiting: true, windowRefused: true }, NOW)).toEqual([
      SlashHoldReason.SLASH_WINDOW_FULL,
    ]);
  });

  it('2. pendingSlash >= atRisk - penaltyAmount', () => {
    expect(slashHoldReasons({ ...healthy, pendingSlash: 99_000_000n }, idle, NOW)).toEqual([
      SlashHoldReason.STAKE_FULLY_RESERVED,
    ]);
    expect(slashHoldReasons({ ...healthy, pendingSlash: 98_999_999n }, idle, NOW)).toEqual([]);
  });

  it('3. bonded < minimumStake', () => {
    expect(slashHoldReasons({ ...healthy, bonded: 49_999_999n }, idle, NOW)).toEqual([
      SlashHoldReason.BONDED_BELOW_MINIMUM,
    ]);
  });

  it('decays the window as the contract does, rounding up', () => {
    expect(decayedWindow(100n, NOW - 43_200n, NOW)).toBe(50n);
    expect(decayedWindow(3n, NOW - 1n, NOW)).toBe(3n);
    expect(decayedWindow(100n, NOW, NOW)).toBe(100n);
  });
});

describe('nextSlashHoldState (the hysteresis)', () => {
  const t0 = new Date('2026-10-15T00:00:00Z');
  const t1 = new Date('2026-10-15T00:01:00Z');

  it('holds at once and keeps the first hold time', () => {
    const held = nextSlashHoldState(NOT_HELD, [SlashHoldReason.STAKE_FULLY_RESERVED], t0);
    expect(held).toMatchObject({ held: true, heldSince: t0, clearChecks: 0 });
    expect(nextSlashHoldState(held, [SlashHoldReason.BONDED_BELOW_MINIMUM], t1)).toMatchObject({
      held: true,
      heldSince: t0,
      reasons: [SlashHoldReason.BONDED_BELOW_MINIMUM],
    });
  });

  it('releases only after two consecutive clear checks', () => {
    const held = nextSlashHoldState(NOT_HELD, [SlashHoldReason.STAKE_FULLY_RESERVED], t0);
    const once = nextSlashHoldState(held, [], t1);
    expect(once).toMatchObject({ held: true, clearChecks: 1 });
    // A flap back resets the count.
    const flapped = nextSlashHoldState(once, [SlashHoldReason.STAKE_FULLY_RESERVED], t1);
    expect(flapped).toMatchObject({ held: true, clearChecks: 0, heldSince: t0 });
    const twice = nextSlashHoldState(nextSlashHoldState(flapped, [], t1), [], t1);
    expect(twice).toEqual(NOT_HELD);
  });
});
