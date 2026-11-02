import { nonTransactionalStep } from '@database/postgres/non-transactional-migration';

/**
 * Final review 2026-11-01 ops F6: the non-transactional migrations (010, 020,
 * 040) build or validate on `payment_intents` outside a transaction. They run
 * with session timeouts (an idle-in-transaction session must not hang the
 * deploy) and refuse to run twice at once (run B's DROP of the temporary index
 * racing run A's build).
 */
function runner(locked: boolean) {
  const queries: string[] = [];
  return {
    queries,
    query: jest.fn(async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/pg_try_advisory_lock/.test(sql)) return [{ locked }];
      return [];
    }),
  };
}

describe('nonTransactionalStep (ops F6)', () => {
  it('sets lock and statement timeouts, holds a run lock, and resets everything after', async () => {
    const r = runner(true);
    const work = jest.fn(async () => {
      r.queries.push('WORK');
    });
    await nonTransactionalStep(r as never, 'DebtGuardHeldReplacement1793404800020', work);
    expect(work).toHaveBeenCalledTimes(1);
    const at = (pattern: RegExp) => r.queries.findIndex((q) => pattern.test(q));
    expect(at(/pg_try_advisory_lock/)).toBeLessThan(at(/^WORK$/));
    expect(at(/SET lock_timeout = '60s'/)).toBeLessThan(at(/^WORK$/));
    expect(at(/SET statement_timeout = '1h'/)).toBeLessThan(at(/^WORK$/));
    expect(at(/RESET lock_timeout/)).toBeGreaterThan(at(/^WORK$/));
    expect(at(/RESET statement_timeout/)).toBeGreaterThan(at(/^WORK$/));
    expect(at(/pg_advisory_unlock/)).toBeGreaterThan(at(/^WORK$/));
  });

  it('resets and unlocks even when the work fails', async () => {
    const r = runner(true);
    await expect(
      nonTransactionalStep(r as never, 'x', async () => {
        throw new Error('canceling statement due to lock timeout');
      }),
    ).rejects.toThrow(/lock timeout/);
    expect(r.queries.some((q) => /RESET lock_timeout/.test(q))).toBe(true);
    expect(r.queries.some((q) => /pg_advisory_unlock/.test(q))).toBe(true);
  });

  it('refuses while another run holds the same migration', async () => {
    const r = runner(false);
    const work = jest.fn(async () => undefined);
    await expect(nonTransactionalStep(r as never, 'x', work)).rejects.toThrow(
      /another migration run/,
    );
    expect(work).not.toHaveBeenCalled();
  });
});
