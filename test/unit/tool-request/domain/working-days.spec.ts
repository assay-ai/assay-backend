import {
  FIRST_RESPONSE_WORKING_DAYS,
  addWorkingDays,
  computeFirstResponseDueAt,
} from '@modules/tool-request/domain/working-days';

describe('addWorkingDays', () => {
  it('adds plain weekdays when no weekend is crossed', () => {
    // Monday 2026-08-24T10:00:00Z + 2 working days -> Wednesday.
    const from = new Date('2026-08-24T10:00:00.000Z');
    expect(addWorkingDays(from, 2).toISOString()).toBe('2026-08-26T10:00:00.000Z');
  });

  it('rolls a Friday filing over the weekend', () => {
    // Friday 2026-08-21T09:00:00Z + 2 working days -> Mon, Tue -> Tuesday.
    const from = new Date('2026-08-21T09:00:00.000Z');
    expect(addWorkingDays(from, 2).toISOString()).toBe('2026-08-25T09:00:00.000Z');
  });

  it('rolls a Saturday filing over the weekend', () => {
    // Saturday 2026-08-22T09:00:00Z + 2 working days -> Mon, Tue -> Tuesday.
    const from = new Date('2026-08-22T09:00:00.000Z');
    expect(addWorkingDays(from, 2).toISOString()).toBe('2026-08-25T09:00:00.000Z');
  });

  it('rolls a Sunday filing over the weekend', () => {
    // Sunday 2026-08-23T09:00:00Z + 2 working days -> Mon, Tue -> Tuesday.
    const from = new Date('2026-08-23T09:00:00.000Z');
    expect(addWorkingDays(from, 2).toISOString()).toBe('2026-08-25T09:00:00.000Z');
  });

  it('spans a weekend that falls strictly inside the window', () => {
    // Thursday 2026-08-20T09:00:00Z + 2 working days -> Fri, (skip Sat/Sun), Mon -> Monday.
    const from = new Date('2026-08-20T09:00:00.000Z');
    expect(addWorkingDays(from, 2).toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  it('preserves the time of day', () => {
    const from = new Date('2026-08-24T14:37:05.123Z');
    expect(addWorkingDays(from, 1).toISOString()).toBe('2026-08-25T14:37:05.123Z');
  });

  it('is a no-op for zero working days', () => {
    const from = new Date('2026-08-24T10:00:00.000Z');
    expect(addWorkingDays(from, 0).getTime()).toBe(from.getTime());
  });

  it('reads the day of week in UTC, not the host offset', () => {
    // 2026-08-21 is a Friday in UTC. A host reading it in a trailing offset
    // (e.g. UTC-7) would see 2026-08-20 local, a Thursday — the exact defect
    // class `abstract.entity.ts` documents for `Date#getDay()`.
    const fridayLateUtc = new Date('2026-08-21T23:30:00.000Z');
    // From Friday: Mon, Tue -> Tuesday. If this were computed off the local
    // (pre-UTC-rollover) Thursday instead, one fewer weekend day would be
    // skipped and the result would land on Monday.
    expect(addWorkingDays(fridayLateUtc, 2).toISOString()).toBe('2026-08-25T23:30:00.000Z');
  });

  it('rejects a negative working-day count', () => {
    expect(() => addWorkingDays(new Date('2026-08-24T10:00:00.000Z'), -1)).toThrow(RangeError);
  });
});

describe('computeFirstResponseDueAt', () => {
  it('uses the two-working-day promise the copy states', () => {
    expect(FIRST_RESPONSE_WORKING_DAYS).toBe(2);
  });

  it('matches addWorkingDays(filedAt, 2)', () => {
    const filedAt = new Date('2026-08-24T10:00:00.000Z');
    expect(computeFirstResponseDueAt(filedAt)).toEqual(addWorkingDays(filedAt, 2));
  });
});
