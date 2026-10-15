import { Logger } from '@nestjs/common';

import { SlashLifecycleJob } from '@modules/slash/jobs/slash-lifecycle.job';

/**
 * The tick, as behaviour rather than as wiring.
 *
 * Every step is faked at the service boundary because what matters here is the
 * *order* the steps run in and the fact that one failing does not stop the
 * rest — neither of which a mock of a repository could show.
 */
class FakeSlashProposals {
  platformMisses: { organizationId: string; id: string }[] = [];
  throws: Error | null = null;

  constructor(
    private readonly record: (name: string) => void = () => {},
    private readonly throwOn: string | null = null,
  ) {}

  async sweepUndisputed(): Promise<number> {
    this.record('sweepUndisputed');
    if (this.throwOn === 'sweepUndisputed') throw new Error('sweepUndisputed failed');
    return 0;
  }

  async sweepPlatformMisses(): Promise<{ organizationId: string; id: string }[]> {
    this.record('sweepPlatformMisses');
    if (this.throws) throw this.throws;
    if (this.throwOn === 'sweepPlatformMisses') throw new Error('sweepPlatformMisses failed');
    return this.platformMisses;
  }
}

class FakeSlashExecution {
  readonly adminCancelRequests: { organizationId: string; proposalId: string; reason: string }[] =
    [];
  cancelThrowsOn: string | null = null;
  /** Counts the admin-cancel sweep, which is a step of the tick in its own right. */
  adminCancelSweeps = 0;

  constructor(
    private readonly record: (name: string) => void = () => {},
    private readonly throwOn: string | null = null,
  ) {}

  async requestAdminCancel(organizationId: string, proposalId: string, reason: string) {
    if (this.cancelThrowsOn === proposalId) throw new Error('rpc timeout');
    this.adminCancelRequests.push({ organizationId, proposalId, reason });
  }

  /** What the closed-case repair answers; a tick is quiet when it is 0. */
  closedCasesRepaired = 0;

  async requestCancelsForClosedCases() {
    this.record('requestCancelsForClosedCases');
    if (this.throwOn === 'requestCancelsForClosedCases') {
      throw new Error('requestCancelsForClosedCases failed');
    }
    return this.closedCasesRepaired;
  }

  async sweepAdminCancels() {
    this.adminCancelSweeps += 1;
    this.record('sweepAdminCancels');
    if (this.throwOn === 'sweepAdminCancels') throw new Error('sweepAdminCancels failed');
    return { mirrored: 0, expired: 0, waiting: 0 };
  }

  async proposeDue() {
    this.record('proposeDue');
    if (this.throwOn === 'proposeDue') throw new Error('proposeDue failed');
    return { proposed: 0, refused: 0, failed: 0 };
  }

  async executeDue() {
    this.record('executeDue');
    if (this.throwOn === 'executeDue') throw new Error('executeDue failed');
    return { executed: 0, voided: 0, failed: 0 };
  }

  async reconcileExecuting() {
    this.record('reconcileExecuting');
    if (this.throwOn === 'reconcileExecuting') throw new Error('reconcileExecuting failed');
    return { recovered: 0, returned: 0, voided: 0 };
  }
}

function buildJob(
  options: {
    record?: (name: string) => void;
    throwOn?: string;
    platformMisses?: { organizationId: string; id: string }[];
  } = {},
) {
  const proposals = new FakeSlashProposals(options.record, options.throwOn ?? null);
  const execution = new FakeSlashExecution(options.record, options.throwOn ?? null);
  if (options.platformMisses) proposals.platformMisses = options.platformMisses;
  const job = new SlashLifecycleJob(proposals as never, execution as never, {} as never);
  return { proposals, execution, job };
}

describe('SlashLifecycleJob — the seven-step tick', () => {
  it('runs the seven steps in the order the clocks require', async () => {
    // Propose before execute, because a case that becomes upheld on this very
    // tick has to reach the chain before anything looks for it there. The
    // admin-cancel sweep after execute, because it READS on-chain records and
    // must not read them one instant before the execute pass finishes moving
    // them. The closed-case repair just before that sweep, so a case it marks
    // is watched on the same tick. Reconcile last, because it is cleanup and
    // must never delay a live judgement.
    const calls: string[] = [];
    const { job } = buildJob({ record: (name: string) => calls.push(name) });

    await job.handleTick();

    expect(calls).toEqual([
      'sweepUndisputed',
      'sweepPlatformMisses',
      'proposeDue',
      'executeDue',
      'requestCancelsForClosedCases',
      'sweepAdminCancels',
      'reconcileExecuting',
    ]);
  });

  it('keeps running the remaining steps when the admin-cancel sweep throws', async () => {
    // A provider's released capital must not depend on the reconcile pass, and
    // the reconcile pass must not depend on this one.
    const calls: string[] = [];
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'sweepAdminCancels',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toContain('reconcileExecuting');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps running the remaining steps when one throws', async () => {
    // The header's rule: an RPC outage that stops execution must not stop the
    // sweeper that costs the platform money.
    const calls: string[] = [];
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'proposeDue',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toContain('executeDue');
    expect(calls).toContain('reconcileExecuting');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps running the remaining steps when sweepUndisputed throws', async () => {
    const calls: string[] = [];
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'sweepUndisputed',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toContain('sweepPlatformMisses');
    expect(calls).toContain('proposeDue');
    expect(calls).toContain('executeDue');
    expect(calls).toContain('reconcileExecuting');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps running the remaining steps when executeDue throws', async () => {
    // executeDue used to be the last step; the reordering that put
    // reconcileExecuting after it created a relationship nothing tested
    // otherwise — that a failure here still lets cleanup run.
    const calls: string[] = [];
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'executeDue',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toContain('reconcileExecuting');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves cleanly when reconcileExecuting throws, as the last step', async () => {
    // Nothing runs after reconcileExecuting, so there is no "did the next
    // step still run" to assert — what this proves instead is that its
    // try/catch is real: every step up to and including it still ran, in
    // order, and handleTick still resolved rather than rejecting the tick.
    const calls: string[] = [];
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'reconcileExecuting',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toEqual([
      'sweepUndisputed',
      'sweepPlatformMisses',
      'proposeDue',
      'executeDue',
      'requestCancelsForClosedCases',
      'sweepAdminCancels',
      'reconcileExecuting',
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('SlashLifecycleJob — the platform-miss sweep', () => {
  /**
   * The chain does not know we missed a deadline. Until it is told the
   * reservation stands and `execute_slash` stays open to anybody once
   * `executable_at` passes — which, on a case the platform failed to work, is
   * the worst possible moment for a stranger to be able to take a provider's
   * stake.
   */
  it('requests an admin cancel for every case it auto-overturned', async () => {
    const { proposals, execution, job } = buildJob();
    proposals.platformMisses = [
      { organizationId: 'org_1', id: 'p1' },
      { organizationId: 'org_2', id: 'p2' },
    ];

    await job.handleTick();

    expect(execution.adminCancelRequests).toEqual([
      { organizationId: 'org_1', proposalId: 'p1', reason: 'AUTO_PLATFORM_MISS' },
      { organizationId: 'org_2', proposalId: 'p2', reason: 'AUTO_PLATFORM_MISS' },
    ]);
  });

  it('keeps asking for the rest when one request fails', async () => {
    const { proposals, execution, job } = buildJob();
    proposals.platformMisses = [
      { organizationId: 'org_1', id: 'p1' },
      { organizationId: 'org_2', id: 'p2' },
    ];
    execution.cancelThrowsOn = 'p1';

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(execution.adminCancelRequests.map((call) => call.proposalId)).toEqual(['p2']);
  });

  it('does nothing to the chain on a tick that overturned nothing', async () => {
    const { execution, job } = buildJob();

    await job.handleTick();

    expect(execution.adminCancelRequests).toEqual([]);
  });

  it('does not take the tick down when the sweep itself throws', async () => {
    const { proposals, job } = buildJob();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    proposals.throws = new Error('the database is unreachable');

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('SlashLifecycleJob — the closed-case repair', () => {
  it('says so, loudly, when it had to ask for a cancel nobody had asked for', async () => {
    const { execution, job } = buildJob();
    execution.closedCasesRepaired = 2;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await job.handleTick();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 closed case(s)'));
    warn.mockRestore();
  });

  it('stays quiet on a tick that repaired nothing', async () => {
    const { job } = buildJob();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await job.handleTick();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps running the remaining steps when it throws', async () => {
    const calls: string[] = [];
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job } = buildJob({
      record: (name: string) => calls.push(name),
      throwOn: 'requestCancelsForClosedCases',
    });

    await expect(job.handleTick()).resolves.toBeUndefined();

    expect(calls).toEqual(expect.arrayContaining(['sweepAdminCancels', 'reconcileExecuting']));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('SlashLifecycleJob — open EVM cases from the in-app objection era (review N-3, R2-5)', () => {
  const row = (id: string) => ({ organizationId: 'org', id });

  function buildWithRulings(rulings: Record<string, unknown>, steps: string[] = []) {
    const proposals = new FakeSlashProposals((name) => steps.push(name));
    const execution = new FakeSlashExecution((name) => steps.push(name));
    const job = new SlashLifecycleJob(
      proposals as never,
      execution as never,
      {} as never,
      { followOpenCasesPastDoor: async () => 0, ...rulings } as never,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return job;
  }

  it('re-derives them page by page after the sweeps, until a page comes back empty', async () => {
    const steps: string[] = [];
    const cursors: unknown[] = [];
    let calls = 0;
    const job = buildWithRulings(
      {
        reconcileOpenCases: async (_limit: number, after: unknown) => {
          calls += 1;
          cursors.push(after ?? null);
          steps.push('reconcileOpenCases');
          if (calls === 1) throw new Error('rpc down'); // retried from the same cursor
          return calls < 4
            ? {
                moved: 1,
                failed: [],
                next: { proposedAt: new Date(calls * 1000), id: `c${calls}` },
              }
            : { moved: 0, failed: [], next: null };
        },
        reconcileCases: async () => ({ moved: 0, failed: [] }),
      },
      steps,
    );

    for (let tick = 0; tick < 6; tick += 1) await job.handleTick();

    expect(calls).toBe(4);
    expect(cursors).toEqual([
      null,
      null,
      { proposedAt: new Date(2000), id: 'c2' },
      { proposedAt: new Date(3000), id: 'c3' },
    ]);
    // Last in the tick: the sweeps of the first tick do not wait behind it.
    expect(steps.indexOf('reconcileOpenCases')).toBeGreaterThan(
      steps.indexOf('reconcileExecuting'),
    );
  });

  it('retries a case whose read failed on later ticks, a bounded number of times', async () => {
    const retried: string[][] = [];
    const job = buildWithRulings({
      reconcileOpenCases: async () => ({ moved: 0, failed: [row('a'), row('b')], next: null }),
      reconcileCases: async (rows: { id: string }[]) => {
        retried.push(rows.map((entry) => entry.id));
        // `a` reads fine on its first retry; `b` never does.
        return { moved: 1, failed: rows.filter((entry) => entry.id === 'b') };
      },
    });

    for (let tick = 0; tick < 10; tick += 1) await job.handleTick();

    expect(retried[0]).toEqual(['a', 'b']);
    expect(retried.slice(1).every((ids) => ids.length === 1 && ids[0] === 'b')).toBe(true);
    expect(retried.length).toBeLessThanOrEqual(5);
  });

  it('never runs two ticks at once in one process', async () => {
    let release: () => void = () => undefined;
    let started = 0;
    const job = buildWithRulings({
      reconcileOpenCases: async () => {
        started += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return { moved: 0, failed: [], next: null };
      },
      reconcileCases: async () => ({ moved: 0, failed: [] }),
    });

    const first = job.handleTick();
    await new Promise((resolve) => setImmediate(resolve));
    await job.handleTick(); // overlaps the first: skipped
    release();
    await first;

    expect(started).toBe(1);
  });

  it('R3-3: a tick hung past the limit pages once and no longer holds the scheduler', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z'), doNotFake: ['setImmediate'] });
    try {
      let started = 0;
      const releases: (() => void)[] = [];
      const alerts: { severity: string; name: string; dedupeKey?: string }[] = [];
      const proposals = new FakeSlashProposals();
      const execution = new FakeSlashExecution();
      const job = new SlashLifecycleJob(
        proposals as never,
        execution as never,
        {} as never,
        {
          followOpenCasesPastDoor: async () => 0,
          reconcileCases: async () => ({ moved: 0, failed: [] }),
          reconcileOpenCases: async () => {
            started += 1;
            await new Promise<void>((resolve) => releases.push(resolve));
            return { moved: 0, failed: [], next: null };
          },
        } as never,
        { emit: async (alert: (typeof alerts)[number]) => void alerts.push(alert) } as never,
      );
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const hung = job.handleTick();
      await new Promise((resolve) => setImmediate(resolve));
      jest.setSystemTime(new Date('2026-10-16T00:05:00Z'));
      await job.handleTick(); // within the limit: skipped, no page
      expect(alerts).toEqual([]);

      jest.setSystemTime(new Date('2026-10-16T00:16:00Z'));
      const next = job.handleTick(); // past the limit: page, and run
      await new Promise((resolve) => setImmediate(resolve));
      expect(alerts).toEqual([
        expect.objectContaining({ severity: 'CRITICAL', name: 'slash_lifecycle_tick_hung' }),
      ]);
      expect(started).toBe(2);

      // The hung tick settling late does not free the guard of the new one.
      releases[0]();
      await hung;
      await job.handleTick();
      expect(started).toBe(2);
      releases[1]();
      await next;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SlashLifecycleJob — open EVM cases past their door (review R2-2)', () => {
  it('follows their records every tick, right after the undisputed sweep', async () => {
    const steps: string[] = [];
    const proposals = new FakeSlashProposals((name) => steps.push(name));
    const execution = new FakeSlashExecution((name) => steps.push(name));
    const rulings = {
      reconcileOpenCases: async () => ({ moved: 0, failed: [], next: null }),
      followOpenCasesPastDoor: async () => {
        steps.push('followOpenCasesPastDoor');
        return 1;
      },
    };
    const job = new SlashLifecycleJob(
      proposals as never,
      execution as never,
      {} as never,
      rulings as never,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await job.handleTick();
    await job.handleTick();

    expect(steps.filter((step) => step === 'followOpenCasesPastDoor')).toHaveLength(2);
    expect(steps.indexOf('followOpenCasesPastDoor')).toBe(steps.indexOf('sweepUndisputed') + 1);
  });
});
