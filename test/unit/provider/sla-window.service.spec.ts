import { Logger } from '@nestjs/common';

import { SlaWindowConfig } from '@modules/provider/constants/sla-window.constants';
import { SlaWindowService } from '@modules/provider/services/sla-window.service';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import { PostSlaWindowCallInput } from '@modules/verification/ports/sla-window-poster.port';

/**
 * `SlaWindowService` — the write path.
 *
 * Every fake below is in-memory and reproduces exactly the one property each
 * test needs from the real schema: `uq_sla_windows_open` and
 * `uq_sla_window_calls_intent` as thrown unique violations, and the counters
 * as plain numbers so a strike's arithmetic can be checked by hand. Nothing
 * here stands up a database — see `docs/architecture.md` §Testing.
 */

const ORG = 'org-1';
const BINDING = 'binding-1';
const TOOL = 'search_web';
const ASSET = 'usdc-mainnet';
const PRICE = '1000000'; // 1.000000 USDC

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function uniqueViolation(constraint: string): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint,
    },
  );
}

class FakeSlaWindows {
  readonly rows = new Map<string, Record<string, any>>();
  private sequenceCounter = 0;

  seed(row: Record<string, any>): void {
    this.rows.set(row.id, { ...row });
  }

  async findOpenForBinding(organizationId: string, bindingId: string) {
    for (const row of this.rows.values()) {
      if (
        row.organizationId === organizationId &&
        row.bindingId === bindingId &&
        row.status === 'OPEN'
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async nextSequence(organizationId: string, bindingId: string): Promise<number> {
    let max = 0;
    for (const row of this.rows.values()) {
      if (row.organizationId === organizationId && row.bindingId === bindingId) {
        max = Math.max(max, row.sequence);
      }
    }
    return max + 1;
  }

  async insert(values: Record<string, any>) {
    if (values.status === 'OPEN') {
      for (const row of this.rows.values()) {
        if (
          row.organizationId === values.organizationId &&
          row.bindingId === values.bindingId &&
          row.status === 'OPEN'
        ) {
          throw uniqueViolation('uq_sla_windows_open');
        }
      }
    }
    const id = `win-${++this.sequenceCounter}`;
    this.rows.set(id, { id, version: 1, ...values });
    return { identifiers: [{ id }] } as any;
  }

  async findOneBy(where: { organizationId: string; id: string }) {
    const row = this.rows.get(where.id);
    if (!row || row.organizationId !== where.organizationId) return null;
    return { ...row };
  }

  /** Mirrors the real `AND status = 'OPEN'` predicate, and its row count. */
  async incrementCounters(
    _organizationId: string,
    id: string,
    input: { countedAsQuality: boolean; countedAsFailure: boolean; priceAmount: string },
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'OPEN') return 0;
    row.totalCalls += 1;
    if (input.countedAsQuality) row.verifiedCalls += 1;
    if (input.countedAsFailure) row.failedCalls += 1;
    row.totalCallAmount = (BigInt(row.totalCallAmount) + BigInt(input.priceAmount)).toString();
    return 1;
  }

  async stampWarningIfLower(
    _organizationId: string,
    id: string,
    level: string,
    now: Date,
    isCritical: boolean,
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0;
    if (row.warningLevel === level) return 0;
    row.warningLevel = level;
    row.warnedAt = row.warnedAt ?? now;
    if (isCritical) row.criticalWarnedAt = now;
    return 1;
  }

  async closeIfOpen(
    _organizationId: string,
    id: string,
    patch: { outcome: string; closedAt: Date; samplingEscalationRequested: boolean },
  ): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'OPEN') return 0;
    row.status = 'CLOSED';
    row.outcome = patch.outcome;
    row.closedAt = patch.closedAt;
    row.samplingEscalationRequested = patch.samplingEscalationRequested;
    return 1;
  }

  async findDueForSweep(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.status === 'OPEN' && (row.deadlineAt as Date).getTime() <= now.getTime())
      .slice(0, limit)
      .map((row) => ({ organizationId: row.organizationId, id: row.id }));
  }
}

class FakeSlaWindowCalls {
  readonly rows: Array<Record<string, any>> = [];

  async insert(values: Record<string, any>): Promise<void> {
    if (this.rows.some((row) => row.intentId === values.intentId)) {
      throw uniqueViolation('uq_sla_window_calls_intent');
    }
    this.rows.push({ id: `call-${this.rows.length + 1}`, ...values });
  }

  async findByWindow(organizationId: string, windowId: string, limit: number) {
    return this.rows
      .filter((row) => row.organizationId === organizationId && row.windowId === windowId)
      .slice(0, limit);
  }

  async countFailuresByReasonCode(organizationId: string, windowId: string) {
    return group(this.rows, organizationId, windowId, 'reasonCode');
  }

  async countFailuresByAgentId(organizationId: string, windowId: string) {
    return group(this.rows, organizationId, windowId, 'agentId');
  }
}

function group(
  rows: Array<Record<string, any>>,
  organizationId: string,
  windowId: string,
  field: string,
): Array<{ key: string; count: string }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.organizationId !== organizationId || row.windowId !== windowId || !row.countedAsFailure)
      continue;
    const key = row[field] ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count: String(count) }));
}

class FakeSlaStrikes {
  readonly rows: Array<Record<string, any>> = [];

  async insert(values: Record<string, any>): Promise<void> {
    if (this.rows.some((row) => row.windowId === values.windowId)) {
      throw uniqueViolation('uq_sla_strikes_window');
    }
    this.rows.push({ id: `strike-${this.rows.length + 1}`, ...values });
  }
}

class FakeToolBindings {
  readonly rows = new Map<string, Record<string, any>>();

  seed(row: Record<string, any>): void {
    this.rows.set(row.id, { ...row });
  }

  async findOneBy(where: { organizationId: string; id: string }) {
    const row = this.rows.get(where.id);
    if (!row || row.organizationId !== where.organizationId) return null;
    return { ...row };
  }
}

class FakeNotifications {
  readonly notifications: Array<{ event: NotificationEvent; dedupeKey?: string; body: string }> =
    [];

  async notify(request: {
    event: NotificationEvent;
    dedupeKey?: string;
    body: string;
  }): Promise<void> {
    this.notifications.push(request);
  }
}

interface Harness {
  readonly service: SlaWindowService;
  readonly windows: FakeSlaWindows;
  readonly calls: FakeSlaWindowCalls;
  readonly strikes: FakeSlaStrikes;
  readonly bindings: FakeToolBindings;
  readonly notifications: FakeNotifications;
  /** Mutable — a test can move the injected clock forward without waiting. */
  clock: number;
}

function harness(configOverrides: Partial<SlaWindowConfig> = {}): Harness {
  const windows = new FakeSlaWindows();
  const calls = new FakeSlaWindowCalls();
  const strikes = new FakeSlaStrikes();
  const bindings = new FakeToolBindings();
  const notifications = new FakeNotifications();

  bindings.seed({ id: BINDING, organizationId: ORG, slaFailureRate: '0.05000' });

  const clockHolder = { clock: Date.parse('2026-08-01T00:00:00.000Z') };

  const config: SlaWindowConfig = {
    minVerifiedCalls: 400,
    zScore: 2.58,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    warningRatio: 0.8,
    warningMinSampleFraction: 0.25,
    penaltyMultiplier: 2,
    now: () => clockHolder.clock,
    ...configOverrides,
  };

  const service = new SlaWindowService(
    windows as any,
    calls as any,
    strikes as any,
    bindings as any,
    notifications as any,
    config,
  );

  return {
    service,
    windows,
    calls,
    strikes,
    bindings,
    notifications,
    get clock() {
      return clockHolder.clock;
    },
    set clock(value: number) {
      clockHolder.clock = value;
    },
  };
}

function callInput(overrides: Partial<PostSlaWindowCallInput> = {}): PostSlaWindowCallInput {
  return {
    organizationId: ORG,
    providerId: ORG,
    bindingId: BINDING,
    toolId: TOOL,
    intentId: `intent-${Math.random()}`,
    agentId: 'agent-1',
    verdictStatus: VerdictStatus.PASS,
    reasonCode: null,
    priceAmount: PRICE,
    assetId: ASSET,
    postedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlaWindowService.postCall', () => {
  it('opens a window lazily, snapshotting the binding’s declared rate and every constant', async () => {
    const { service, windows } = harness();

    await service.postCall(callInput({ intentId: 'intent-1', verdictStatus: VerdictStatus.PASS }));

    expect(windows.rows.size).toBe(1);
    const window = [...windows.rows.values()][0];
    expect(window).toMatchObject({
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      sequence: 1,
      status: 'OPEN',
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 1,
      verifiedCalls: 1,
      failedCalls: 0,
      assetId: ASSET,
    });
  });

  it('a no-bindingId call (legacy traffic) is a no-op, not an error', async () => {
    const { service, windows, calls } = harness();

    await service.postCall(callInput({ bindingId: null }));

    expect(windows.rows.size).toBe(0);
    expect(calls.rows).toHaveLength(0);
  });

  /**
   * The gate-straddle race. `postCall` is not one transaction, so worker A can
   * cross the sample gate and close the window — computing a strike from
   * exactly those counters — while worker B, which read the same open window
   * a moment earlier, is still on its way to the increment.
   *
   * Without `AND status = 'OPEN'` on the increment, B's call lands in a window
   * that has already been judged, and `sla_strikes` then cites numbers that no
   * longer match the `sla_windows` row it names. A provider comparing the two
   * in a dispute would find our own evidence disagreeing with itself.
   */
  it('a call that arrives after its window closed is recorded but not counted', async () => {
    const { service, windows, calls, strikes } = harness();

    // Drive the window to one call short of the gate, all failing, so the
    // close is a BREACH_PROPOSED and a strike is actually written.
    for (let i = 0; i < 399; i += 1) {
      await service.postCall(
        callInput({ intentId: `straddle-${i}`, verdictStatus: VerdictStatus.FAIL }),
      );
    }

    const window = [...windows.rows.values()][0];
    expect(window.status).toBe('OPEN');
    expect(window.verifiedCalls).toBe(399);

    // Worker A: the 400th call closes the window at the gate.
    await service.postCall(
      callInput({ intentId: 'straddle-closer', verdictStatus: VerdictStatus.FAIL }),
    );
    expect(window.status).toBe('CLOSED');
    expect(window.verifiedCalls).toBe(400);
    expect(strikes.rows).toHaveLength(1);
    expect(strikes.rows[0].verifiedCalls).toBe(400);

    // Worker B: read the window while it was still open, arrives now.
    await service.postCall(
      callInput({ intentId: 'straddle-late', verdictStatus: VerdictStatus.FAIL }),
    );

    // The counters are still exactly the set the strike was computed from...
    expect(window.verifiedCalls).toBe(400);
    expect(window.failedCalls).toBe(400);
    expect(strikes.rows).toHaveLength(1);
    expect(strikes.rows[0].verifiedCalls).toBe(400);
    expect(strikes.rows[0].failedCalls).toBe(400);

    // ...and the late call is not lost. It is on the record as having arrived,
    // which is the conservative direction: discarding it would hide the fact.
    expect(calls.rows.some((row) => row.intentId === 'straddle-late')).toBe(true);
  });

  it('a duplicate post for the same intentId is a no-op: counters do not move twice', async () => {
    const { service, windows, calls } = harness();
    const input = callInput({ intentId: 'intent-dup' });

    await service.postCall(input);
    await service.postCall(input); // e.g. BullMQ redelivery

    expect(calls.rows).toHaveLength(1);
    const window = [...windows.rows.values()][0];
    expect(window.totalCalls).toBe(1);
    expect(window.verifiedCalls).toBe(1);
  });

  it('a FAIL verdict counts toward both the denominator and the numerator', async () => {
    const { service, windows } = harness();

    await service.postCall(
      callInput({
        intentId: 'intent-fail',
        verdictStatus: VerdictStatus.FAIL,
        reasonCode: 'MIN_ARRAY_LENGTH',
      }),
    );

    const window = [...windows.rows.values()][0];
    expect(window.verifiedCalls).toBe(1);
    expect(window.failedCalls).toBe(1);
  });

  it('MISAPPLIED (not the provider’s fault) counts toward neither', async () => {
    const { service, windows } = harness();

    await service.postCall(
      callInput({ intentId: 'intent-void', verdictStatus: VerdictStatus.MISAPPLIED }),
    );

    const window = [...windows.rows.values()][0];
    expect(window.totalCalls).toBe(1);
    expect(window.verifiedCalls).toBe(0);
    expect(window.failedCalls).toBe(0);
  });

  it('the UNVERIFIED sentinel (no decision policy) counts toward neither', async () => {
    const { service, windows } = harness();

    await service.postCall(
      callInput({ intentId: 'intent-unverified', verdictStatus: 'UNVERIFIED' }),
    );

    const window = [...windows.rows.values()][0];
    expect(window.totalCalls).toBe(1);
    expect(window.verifiedCalls).toBe(0);
  });

  it('two concurrent posts to a fresh binding open exactly one window (uq_sla_windows_open)', async () => {
    const { service, windows } = harness();

    await Promise.all([
      service.postCall(callInput({ intentId: 'intent-race-a' })),
      service.postCall(callInput({ intentId: 'intent-race-b' })),
    ]);

    expect(windows.rows.size).toBe(1);
    const window = [...windows.rows.values()][0];
    expect(window.totalCalls).toBe(2);
    expect(window.verifiedCalls).toBe(2);
  });

  it('a warning level is stamped exactly once under concurrent posts crossing the same band', async () => {
    const { service, windows, notifications } = harness();
    // Pre-seeded well above the 80%-of-declared band (4.0%) and above the
    // 25% sample floor (100 of 400), so both concurrent posts see the band
    // crossed on their own read regardless of interleaving order.
    windows.seed({
      id: 'win-existing',
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      sequence: 1,
      status: 'OPEN',
      outcome: null,
      openedAt: new Date('2026-07-25T00:00:00.000Z'),
      deadlineAt: new Date('2026-08-01T00:00:00.000Z'),
      closedAt: null,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 100,
      verifiedCalls: 100,
      failedCalls: 6, // 6% — above the 4% band
      totalCallAmount: (100n * BigInt(PRICE)).toString(),
      assetId: ASSET,
      warningLevel: null,
      warnedAt: null,
      criticalWarnedAt: null,
      samplingEscalationRequested: false,
    });

    await Promise.all([
      service.postCall(callInput({ intentId: 'intent-warn-a', verdictStatus: VerdictStatus.PASS })),
      service.postCall(callInput({ intentId: 'intent-warn-b', verdictStatus: VerdictStatus.PASS })),
    ]);

    const warnings = notifications.notifications.filter(
      (n) => n.event === NotificationEvent.PROVIDER_SLA_WINDOW_WARNING,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].dedupeKey).toBe('win-existing:WARNING');
  });

  it('within-SLA at the sample gate: closes WITHIN_SLA, writes no strike', async () => {
    const { service, windows, strikes, notifications } = harness();

    // 400 verified calls, 15 failures — 3.75%, comfortably inside
    // 5% + 2.58*sqrt(0.05*0.95/400) ≈ 7.81%.
    for (let i = 1; i <= 400; i += 1) {
      const isFail = i <= 15;
      await service.postCall(
        callInput({
          intentId: `intent-within-${i}`,
          verdictStatus: isFail ? VerdictStatus.FAIL : VerdictStatus.PASS,
          reasonCode: isFail ? 'MIN_ARRAY_LENGTH' : null,
        }),
      );
    }

    const window = [...windows.rows.values()][0];
    expect(window.status).toBe('CLOSED');
    expect(window.outcome).toBe('WITHIN_SLA');
    expect(strikes.rows).toHaveLength(0);
    expect(
      notifications.notifications.some(
        (n) => n.event === NotificationEvent.PROVIDER_SLA_BREACH_PROPOSED,
      ),
    ).toBe(false);
  });

  /**
   * A realistic call sequence that leads to a strike, and the
   * strike record it produces, field by field.
   *
   * 400 verified calls at a 5% declared rate, 60 of them FAIL (15% observed):
   * well past the effective threshold at n=400
   * (5% + 2.58·√(0.05·0.95/400) ≈ 7.81%), so the window closes
   * `BREACH_PROPOSED` on the 400th call and a strike is written in the same
   * pass. The 60 failures are spread evenly across the sequence (not bunched
   * at the start) so the test also exercises the warning path realistically.
   */
  it('400 calls at 15% observed against a 5% declaration produce exactly one strike', async () => {
    const { service, windows, strikes, notifications } = harness();
    const totalCalls = 400;
    const totalFailures = 60;
    const agents = ['ag-1', 'ag-2', 'ag-3', 'ag-4', 'ag-5'];

    for (let i = 1; i <= totalCalls; i += 1) {
      // Evenly distributes `totalFailures` marks across `totalCalls` slots —
      // the standard "n items into k buckets" spacing, so failures are
      // interspersed rather than clustered.
      const isFail =
        Math.floor((i * totalFailures) / totalCalls) !==
        Math.floor(((i - 1) * totalFailures) / totalCalls);

      await service.postCall(
        callInput({
          intentId: `intent-breach-${i}`,
          agentId: agents[i % agents.length],
          verdictStatus: isFail ? VerdictStatus.FAIL : VerdictStatus.PASS,
          reasonCode: isFail ? 'MIN_ARRAY_LENGTH' : null,
        }),
      );
    }

    const window = [...windows.rows.values()][0];
    expect(window.status).toBe('CLOSED');
    expect(window.outcome).toBe('BREACH_PROPOSED');
    expect(window.verifiedCalls).toBe(400);
    expect(window.failedCalls).toBe(60);

    expect(strikes.rows).toHaveLength(1);
    const strike = strikes.rows[0];

    // Printed so the actual strike record is visible in the test output.

    console.log('Strike record:', JSON.stringify(strike, null, 2));

    expect(strike).toMatchObject({
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      windowId: window.id,
      status: 'RECORDED',
      totalCalls: 400,
      verifiedCalls: 400,
      failedCalls: 60,
      observedRate: 0.15,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      penaltyMultiplier: 2,
      averagePriceAmount: '1000000',
      penaltyAmount: '80000000', // 400,000,000 × 0.10 excess × 2, in minor units
      assetId: ASSET,
    });
    expect(strike.tolerance).toBeCloseTo(2.58 * Math.sqrt((0.05 * 0.95) / 400), 6);
    expect(strike.effectiveThreshold).toBeCloseTo(0.05 + strike.tolerance, 10);
    expect(strike.excessRate).toBeCloseTo(0.1, 10);
    expect(strike.estimatedBadCalls).toBeCloseTo(40, 6);
    expect(Array.isArray(strike.computation)).toBe(true);
    expect(strike.computation.length).toBeGreaterThan(0);

    expect(
      notifications.notifications.some(
        (n) => n.event === NotificationEvent.PROVIDER_SLA_BREACH_PROPOSED,
      ),
    ).toBe(true);
  });

  it('two concurrent posts racing the close CAS on the same window never write two strikes', async () => {
    const { service, windows, strikes } = harness();
    // One call short of the gate, and already well past the effective
    // threshold — whichever of the two concurrent posts below lands first
    // pushes `verifiedCalls` to the gate, and BOTH will see it crossed on
    // their own post-increment read, so both attempt `closeWindow`.
    windows.seed({
      id: 'win-gate',
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      sequence: 1,
      status: 'OPEN',
      outcome: null,
      openedAt: new Date('2026-07-25T00:00:00.000Z'),
      deadlineAt: new Date('2026-08-08T00:00:00.000Z'),
      closedAt: null,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 399,
      verifiedCalls: 399,
      failedCalls: 59, // ~14.8% — already well past the ~7.8% effective threshold
      totalCallAmount: (399n * BigInt(PRICE)).toString(),
      assetId: ASSET,
      warningLevel: 'CRITICAL',
      warnedAt: new Date('2026-07-26T00:00:00.000Z'),
      criticalWarnedAt: new Date('2026-07-26T00:00:00.000Z'),
      samplingEscalationRequested: false,
    });

    await Promise.all([
      service.postCall(callInput({ intentId: 'intent-gate-a', verdictStatus: VerdictStatus.FAIL })),
      service.postCall(callInput({ intentId: 'intent-gate-b', verdictStatus: VerdictStatus.FAIL })),
    ]);

    // Exactly one window, closed, and exactly one strike — the `closeIfOpen`
    // CAS is what makes the loser's `closeWindow` a no-op rather than a
    // second write, and `uq_sla_strikes_window` is the backstop under that.
    expect(windows.rows.size).toBe(1);
    const window = windows.rows.get('win-gate')!;
    expect(window.status).toBe('CLOSED');
    expect(window.outcome).toBe('BREACH_PROPOSED');
    expect(strikes.rows).toHaveLength(1);
  });
});

describe('SlaWindowService.sweepExpiredWindows', () => {
  it('closes an OPEN window past its deadline as INSUFFICIENT_SAMPLE when short of the gate', async () => {
    const state = harness();
    const { service, windows, strikes } = state;

    windows.seed({
      id: 'win-stale',
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      sequence: 1,
      status: 'OPEN',
      outcome: null,
      openedAt: new Date('2026-07-01T00:00:00.000Z'),
      deadlineAt: new Date('2026-07-08T00:00:00.000Z'),
      closedAt: null,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 50,
      verifiedCalls: 50,
      failedCalls: 40, // 80% observed — would clearly breach, if it were slashable
      totalCallAmount: (50n * BigInt(PRICE)).toString(),
      assetId: ASSET,
      warningLevel: null,
      warnedAt: null,
      criticalWarnedAt: null,
      samplingEscalationRequested: false,
    });
    state.clock = Date.parse('2026-08-01T00:00:00.000Z'); // well past the deadline

    const closed = await service.sweepExpiredWindows();

    expect(closed).toBe(1);
    const window = windows.rows.get('win-stale')!;
    expect(window.status).toBe('CLOSED');
    expect(window.outcome).toBe('INSUFFICIENT_SAMPLE');
    expect(window.samplingEscalationRequested).toBe(true);
    // Below the gate: no penalty is possible, however bad the observation looks.
    expect(strikes.rows).toHaveLength(0);
  });

  it('leaves windows not yet past their deadline alone', async () => {
    const state = harness();
    const { service, windows } = state;

    windows.seed({
      id: 'win-fresh',
      organizationId: ORG,
      providerId: ORG,
      bindingId: BINDING,
      toolId: TOOL,
      sequence: 1,
      status: 'OPEN',
      outcome: null,
      openedAt: new Date('2026-08-01T00:00:00.000Z'),
      deadlineAt: new Date('2026-08-08T00:00:00.000Z'),
      closedAt: null,
      declaredFailureRate: '0.05000',
      minVerifiedCalls: 400,
      zScore: 2.58,
      maxAgeMs: String(7 * 24 * 60 * 60 * 1000),
      warningRatio: 0.8,
      warningMinSampleFraction: 0.25,
      penaltyMultiplier: 2,
      totalCalls: 10,
      verifiedCalls: 10,
      failedCalls: 0,
      totalCallAmount: (10n * BigInt(PRICE)).toString(),
      assetId: ASSET,
      warningLevel: null,
      warnedAt: null,
      criticalWarnedAt: null,
      samplingEscalationRequested: false,
    });
    state.clock = Date.parse('2026-08-02T00:00:00.000Z'); // before the deadline

    const closed = await service.sweepExpiredWindows();

    expect(closed).toBe(0);
    expect(windows.rows.get('win-fresh')!.status).toBe('OPEN');
  });
});
