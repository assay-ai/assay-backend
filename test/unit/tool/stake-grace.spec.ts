import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IneligibilityReason,
  StakeGateVerdict,
  applyStakeGrace,
} from '@modules/tool/domain/routing';

import { usdc } from './helpers/routing-fixtures';

/**
 * `applyStakeGrace` — the 7-day countdown, as a function.
 *
 * The gate itself (`evaluateStakeGate`) is untouched by all of this, and that
 * separation is what these tests are really pinning down. The publish gate
 * calls the gate directly with `stakeGraceUntil: null`, so a binding that has
 * never been published can never be told its grace expired; grace only ever
 * layers onto the *routing* path, where there is traffic to protect.
 *
 * Five branches, and the one worth defending in review is the fourth: below the
 * minimum with NO grace row is still `STAKE_BELOW_MINIMUM`, not
 * `STAKE_GRACE_EXPIRED`. The monitor job that opens rows runs on a 5-minute
 * tick, so there is a window in which a provider has just dropped below the
 * floor and has no row yet. Relabelling that window would print "your grace
 * expired" on the screen of someone who never had any.
 */
describe('applyStakeGrace', () => {
  const BELOW: StakeGateVerdict = {
    passed: false,
    reason: IneligibilityReason.STAKE_BELOW_MINIMUM,
    detail: 'staked 40.000000, minimum 50.000000',
  };

  const NOW = new Date('2026-08-20T12:00:00.000Z');
  const IN_THREE_DAYS = new Date('2026-08-23T12:00:00.000Z');
  const THREE_DAYS_AGO = new Date('2026-08-17T12:00:00.000Z');

  // -------------------------------------------------------------------------
  // 1. A passing verdict is never touched
  // -------------------------------------------------------------------------

  it('returns a passing verdict unchanged, grace row or not', () => {
    const passed: StakeGateVerdict = { passed: true, minimum: usdc(50) };

    expect(applyStakeGrace(passed, null, NOW)).toBe(passed);
    expect(applyStakeGrace(passed, IN_THREE_DAYS, NOW)).toBe(passed);
    expect(applyStakeGrace(passed, THREE_DAYS_AGO, NOW)).toBe(passed);
  });

  it('does not mark a verdict that passed on its own merits as in grace', () => {
    const passed: StakeGateVerdict = { passed: true, minimum: usdc(50) };
    const result = applyStakeGrace(passed, IN_THREE_DAYS, NOW);

    expect(result).not.toHaveProperty('inGrace');
  });

  // -------------------------------------------------------------------------
  // 2. Below the minimum, inside an open grace period → traffic keeps flowing
  // -------------------------------------------------------------------------

  it('passes a below-minimum binding whose grace has not run out, flagged inGrace', () => {
    const result = applyStakeGrace(BELOW, IN_THREE_DAYS, NOW);

    expect(result).toEqual({ passed: true, minimum: null, inGrace: true });
  });

  it('is still inside grace one millisecond before the deadline', () => {
    const oneMsBefore = new Date(IN_THREE_DAYS.getTime() - 1);
    const result = applyStakeGrace(BELOW, IN_THREE_DAYS, oneMsBefore);

    expect(result.passed).toBe(true);
    expect(result).toHaveProperty('inGrace', true);
  });

  // -------------------------------------------------------------------------
  // 3. Below the minimum, grace run out → a reason of its own
  // -------------------------------------------------------------------------

  it('relabels a below-minimum binding whose grace has run out', () => {
    const result = applyStakeGrace(BELOW, THREE_DAYS_AGO, NOW);

    expect(result.passed).toBe(false);
    expect(result).toMatchObject({ reason: IneligibilityReason.STAKE_GRACE_EXPIRED });
    expect(result).not.toHaveProperty('inGrace');
  });

  it('keeps the shortfall AND names the deadline in the detail', () => {
    // The widening is a readability choice, NOT a type-system requirement, and
    // an earlier version of this comment claimed otherwise. Verified by probe:
    // `(A | B) & X` distributes to `(A & X) | (B & X)`, so the returned
    // intersection DOES narrow on `result.passed === false` with no assignment
    // at all — `result.reason` and `result.detail` are both reachable.
    //
    // What does not narrow is a BARE truthiness test (`if (result.passed)`),
    // because this project compiles with `strictNullChecks: false`. That is the
    // rule worth carrying: `=== true` / `=== false`, never bare. Callers do not
    // need this widening line, and the false version of this note would have had
    // every one of them write a pointless one.
    //
    // One genuine wrinkle of the intersection: `inGrace` is readable on the
    // FAILED arm too, as `true | undefined`, so `result.passed === false &&
    // result.inGrace` compiles and is permanently false. A proper union would
    // reject it. Not worth reshaping the signature for.
    const result: StakeGateVerdict = applyStakeGrace(BELOW, THREE_DAYS_AGO, NOW);

    expect(result.passed).toBe(false);
    if (result.passed === true) return;
    // The shortfall is what the provider must fix; the deadline is why they are
    // being cut now rather than three days ago. A detail carrying one without
    // the other answers half the question the rejection screen asks.
    expect(result.detail).toContain('staked 40.000000, minimum 50.000000');
    expect(result.detail).toContain(THREE_DAYS_AGO.toISOString());
  });

  it('treats the deadline itself as expired, not as the last moment of grace', () => {
    // `now >= graceUntil` — the boundary belongs to the expired side, so a
    // period that says it expires at T is over at T rather than at T+1ms.
    const result = applyStakeGrace(BELOW, NOW, NOW);

    expect(result).toMatchObject({
      passed: false,
      reason: IneligibilityReason.STAKE_GRACE_EXPIRED,
    });
  });

  // -------------------------------------------------------------------------
  // 4. Below the minimum with NO grace row → unchanged. The important one.
  // -------------------------------------------------------------------------

  it('leaves a below-minimum binding with no grace row as STAKE_BELOW_MINIMUM', () => {
    expect(applyStakeGrace(BELOW, null, NOW)).toBe(BELOW);
  });

  it('never says grace expired to a binding that never had grace', () => {
    const result: StakeGateVerdict = applyStakeGrace(BELOW, null, NOW);

    expect(result.passed).toBe(false);
    if (result.passed === true) return;
    expect(result.reason).not.toBe(IneligibilityReason.STAKE_GRACE_EXPIRED);
  });

  it('treats an absent grace date as no grace, not as a crash', () => {
    // The cast is the point of the test. Callers convert at the boundary today
    // (`?? null` in the router, because a `ReadonlyMap` miss is `undefined`),
    // but `strictNullChecks: false` means nothing in the type system enforces
    // that. A caller who forgets would otherwise hit `undefined.getTime()` —
    // a TypeError inside routing, on the commonest input there is.
    const absent = undefined as unknown as Date | null;
    const result: StakeGateVerdict = applyStakeGrace(BELOW, absent, NOW);

    expect(result).toBe(BELOW);
  });

  // -------------------------------------------------------------------------
  // 5. Every other rejection is none of grace's business
  // -------------------------------------------------------------------------

  it.each([
    IneligibilityReason.STAKE_UNKNOWN,
    IneligibilityReason.STAKE_ASSET_MISMATCH,
    IneligibilityReason.PROVIDER_NOT_ACTIVE,
    IneligibilityReason.BINDING_NOT_ACTIVE,
  ])('leaves a %s verdict alone even with an open grace row', (reason) => {
    const verdict: StakeGateVerdict = { passed: false, reason, detail: 'unrelated' };

    // Grace answers exactly one question — "is this provider a little short of
    // their floor" — and a stake source that is down or an asset that does not
    // match is not that question. Passing those on a grace row would route paid
    // traffic on the strength of a reading nobody has.
    expect(applyStakeGrace(verdict, IN_THREE_DAYS, NOW)).toBe(verdict);
    expect(applyStakeGrace(verdict, THREE_DAYS_AGO, NOW)).toBe(verdict);
  });

  // -------------------------------------------------------------------------
  // 6. Purity
  // -------------------------------------------------------------------------

  it('returns the same answer for the same inputs', () => {
    const first = applyStakeGrace(BELOW, IN_THREE_DAYS, NOW);
    const second = applyStakeGrace(BELOW, IN_THREE_DAYS, NOW);

    expect(first).toEqual(second);
  });

  it('does not mutate the verdict or the dates it was handed', () => {
    const verdict: StakeGateVerdict = { ...BELOW };
    const graceUntil = new Date(IN_THREE_DAYS);
    const now = new Date(NOW);

    applyStakeGrace(verdict, graceUntil, now);

    expect(verdict).toEqual(BELOW);
    expect(graceUntil.toISOString()).toBe(IN_THREE_DAYS.toISOString());
    expect(now.toISOString()).toBe(NOW.toISOString());
  });

  it('reads no clock — `now` arrives as a parameter', () => {
    const nowSpy = jest.spyOn(Date, 'now');

    applyStakeGrace(BELOW, IN_THREE_DAYS, NOW);
    applyStakeGrace(BELOW, THREE_DAYS_AGO, NOW);
    applyStakeGrace(BELOW, null, NOW);

    expect(nowSpy).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('has no clock read in its source at all', () => {
    // The spy above only proves the branches these tests walked. Everything
    // under `domain/routing/` is replayable — a disputed call months later has
    // to be answerable with "why this binding", which stops being true the
    // moment a decision depends on when it was asked rather than on what it was
    // handed.
    const source = readFileSync(
      join(__dirname, '../../../src/modules/tool/domain/routing/stake-grace.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new Date\s*\(\s*\)/);
  });
});
