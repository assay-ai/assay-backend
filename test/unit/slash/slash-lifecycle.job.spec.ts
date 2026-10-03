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

describe('SlashLifecycleJob — the six-step tick', () => {
  it('runs the six steps in the order the clocks require', async () => {
    // Propose before execute, because a case that becomes upheld on this very
    // tick has to reach the chain before anything looks for it there. The
    // admin-cancel sweep after execute, because it READS on-chain records and
    // must not read them one instant before the execute pass finishes moving
    // them. Reconcile last, because it is cleanup and must never delay a live
    // judgement.
    const calls: string[] = [];
    const { job } = buildJob({ record: (name: string) => calls.push(name) });

    await job.handleTick();

    expect(calls).toEqual([
      'sweepUndisputed',
      'sweepPlatformMisses',
      'proposeDue',
      'executeDue',
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
