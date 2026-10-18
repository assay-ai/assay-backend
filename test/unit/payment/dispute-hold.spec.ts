import { DisputeHoldFacts, refundGuaranteedIfReported } from '@modules/payment/domain/dispute-hold';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const GUARD = 60;
const at = (secondsFromNow: number) => new Date(NOW.getTime() + secondsFromNow * 1000);

const unredeemed: DisputeHoldFacts = {
  status: 'SETTLED',
  rail: 'RAIL_B_VOUCHER',
  holdId: 'hold-1',
  holdReleasedAt: null,
  disputeOutcome: null,
  heldStatus: null,
  collectableAt: null,
  redemptionLapsedAt: null,
  redemptionLastError: null,
};
const held: DisputeHoldFacts = { ...unredeemed, heldStatus: 'HELD', collectableAt: at(3600) };

const guaranteed = (call: DisputeHoldFacts, holdLive = true) =>
  refundGuaranteedIfReported(call, { holdLive, now: NOW, guardSeconds: GUARD });

describe('refundGuaranteedIfReported (wave-1 audit I1)', () => {
  it('a rail-B call held well before collectableAt, or not redeemed yet, is guaranteed', () => {
    expect(guaranteed(held)).toBe(true);
    expect(guaranteed(unredeemed)).toBe(true);
  });

  it('rail B is never guaranteed where the escrow hold is not live on the chain', () => {
    expect(guaranteed(held, false)).toBe(false);
    expect(guaranteed(unredeemed, false)).toBe(false);
  });

  it('rail A does not read the chain hold: the ledger holds it', () => {
    const railA = { ...held, rail: 'RAIL_A_PER_CALL' };
    expect(guaranteed(railA, false)).toBe(true);
    // Rail A has no "not redeemed yet" branch.
    expect(guaranteed({ ...unredeemed, rail: 'RAIL_A_PER_CALL' })).toBe(false);
  });

  it('the guard: more than 60 s before collectableAt only', () => {
    expect(guaranteed({ ...held, collectableAt: at(61) })).toBe(true);
    expect(guaranteed({ ...held, collectableAt: at(60) })).toBe(false);
    expect(guaranteed({ ...held, collectableAt: at(59) })).toBe(false);
    expect(guaranteed({ ...held, collectableAt: at(-1) })).toBe(false);
    expect(guaranteed({ ...held, collectableAt: null })).toBe(false);
  });

  it.each<[string, Partial<DisputeHoldFacts>]>([
    ['not settled', { status: 'VERIFYING' }],
    ['no hold', { holdId: null }],
    ['hold released', { holdReleasedAt: at(-10) }],
    ['a report already holds it', { disputeOutcome: 'OPEN' }],
    ['decided before', { disputeOutcome: 'REJECTED' }],
    ['collected', { heldStatus: 'COLLECTED' }],
    ['refunded', { heldStatus: 'REFUNDED' }],
  ])('not guaranteed: %s', (_, patch) => {
    expect(guaranteed({ ...held, ...patch })).toBe(false);
  });

  it.each<[string, Partial<DisputeHoldFacts>]>([
    ['lapsed (buyer debt)', { redemptionLapsedAt: at(-60) }],
    ['a recorded redemption error', { redemptionLastError: 'DelegateIsRevoked' }],
  ])('an unredeemed voucher is not guaranteed once %s', (_, patch) => {
    expect(guaranteed({ ...unredeemed, ...patch })).toBe(false);
  });
});
