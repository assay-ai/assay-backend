import {
  nextSlashHoldState,
  NOT_HELD,
  SlashHoldReason,
  slashHoldReasons,
  SlashHoldStakeReading,
} from '@modules/provider/domain/slash-hold';

const healthy: SlashHoldStakeReading = {
  bonded: 100_000_000n,
  unbonding: 0n,
  pendingSlash: 0n,
  penaltyAmount: 1_000_000n,
  minimumStake: 50_000_000n,
};
const idle = { recordWaiting: false, windowRefused: false };

describe('slashHoldReasons', () => {
  it('holds nothing for a healthy stake', () => {
    expect(slashHoldReasons(healthy, idle)).toEqual([]);
  });

  it('1. an upheld record waiting whose last execute was refused SlashWindowNotDrained', () => {
    expect(slashHoldReasons(healthy, { recordWaiting: true, windowRefused: true })).toEqual([
      SlashHoldReason.SLASH_WINDOW_FULL,
    ]);
    // A record waiting with no refusal yet, or a refusal with nothing waiting: no hold.
    expect(slashHoldReasons(healthy, { recordWaiting: true, windowRefused: false })).toEqual([]);
    expect(slashHoldReasons(healthy, { recordWaiting: false, windowRefused: true })).toEqual([]);
  });

  // Condition 2 alone: no minimum, so the D-26 free-bonded check (3) stays quiet.
  const noMinimum = { ...healthy, minimumStake: 0n };

  it('2. atRisk - pendingSlash < penaltyAmount', () => {
    expect(slashHoldReasons({ ...noMinimum, pendingSlash: 99_000_001n }, idle)).toEqual([
      SlashHoldReason.STAKE_FULLY_RESERVED,
    ]);
    // Free stake of exactly one penalty still backs it (review S-6).
    expect(slashHoldReasons({ ...noMinimum, pendingSlash: 99_000_000n }, idle)).toEqual([]);
  });

  it('2. leaves out the reservations of records frozen by an on-chain dispute', () => {
    const reserved = { ...noMinimum, pendingSlash: 100_000_000n };
    expect(slashHoldReasons(reserved, idle)).toEqual([SlashHoldReason.STAKE_FULLY_RESERVED]);
    expect(slashHoldReasons({ ...reserved, disputedReserved: 1_000_000n }, idle)).toEqual([]);
    // Never below zero.
    expect(slashHoldReasons({ ...healthy, pendingSlash: 1n, disputedReserved: 5n }, idle)).toEqual(
      [],
    );
  });

  it('3. bonded < minimumStake', () => {
    expect(slashHoldReasons({ ...healthy, bonded: 49_999_999n }, idle)).toEqual([
      SlashHoldReason.BONDED_BELOW_MINIMUM,
    ]);
  });

  it('3. FREE bonded < minimumStake (D-26): every reservation counts, disputed ones included', () => {
    // 100 bonded, 50.000001 reserved: 49.999999 free, below 50 — the chain stops paying.
    const reserved = { ...healthy, pendingSlash: 50_000_001n };
    expect(slashHoldReasons(reserved, idle)).toEqual([SlashHoldReason.BONDED_BELOW_MINIMUM]);
    expect(slashHoldReasons({ ...reserved, disputedReserved: 50_000_001n }, idle)).toEqual([
      SlashHoldReason.BONDED_BELOW_MINIMUM,
    ]);
    // Exactly the minimum free still routes; more reserved than bonded floors at zero.
    expect(slashHoldReasons({ ...healthy, pendingSlash: 50_000_000n }, idle)).toEqual([]);
    expect(
      slashHoldReasons({ ...healthy, unbonding: 200_000_000n, pendingSlash: 150_000_000n }, idle),
    ).toEqual([SlashHoldReason.BONDED_BELOW_MINIMUM]);
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
