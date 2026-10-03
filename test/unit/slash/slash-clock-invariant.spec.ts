import { loadSlashConfig } from '@modules/slash/constants/slash.constants';

/**
 * The one arithmetic fact the two-phase slash depends on.
 *
 * `execute_slash`'s payer is *any* signer, so at `executable_at` the judgement
 * becomes executable by anybody on the internet. If the off-chain dispute can
 * still be open at that instant, a third party can take a provider's stake
 * while their case is being adjudicated. The windows must therefore close
 * strictly before the chain opens.
 */
describe('the off-chain windows fit inside the on-chain timelock', () => {
  const ENV_KEYS = [
    'SLASH_TIMELOCK_HOURS',
    'SLASH_RESPONSE_WINDOW_HOURS',
    'SLASH_PLATFORM_DECISION_WINDOW_HOURS',
    'SLASH_EXECUTION_GUARD_HOURS',
  ] as const;

  // Save and restore rather than delete: these tests must leave `process.env`
  // exactly as they found it, whatever an operator's `.env` happens to set.
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original.clear();
  });

  it('ships defaults that leave a guard band', () => {
    const config = loadSlashConfig();

    expect(config.timelockMs).toBe(72 * 3_600_000);
    expect(config.responseWindowMs).toBe(48 * 3_600_000);
    // 23, not 24. The hour comes off the platform's own deadline, which is the
    // side that should bear the cost of the process.
    expect(config.platformDecisionWindowMs).toBe(23 * 3_600_000);
    expect(config.executionGuardMs).toBe(1 * 3_600_000);
    expect(
      config.responseWindowMs + config.platformDecisionWindowMs + config.executionGuardMs,
    ).toBeLessThanOrEqual(config.timelockMs);
  });

  it('refuses to boot when the windows no longer fit', () => {
    // 48 + 24 + 1 = 73 > 72. Before this assertion existed, 48 + 24 = 72 was
    // the shipped default and left exactly zero slack for a one-minute cron.
    process.env.SLASH_PLATFORM_DECISION_WINDOW_HOURS = '24';

    expect(() => loadSlashConfig()).toThrow(
      /SLASH_RESPONSE_WINDOW_HOURS \+ SLASH_PLATFORM_DECISION_WINDOW_HOURS \+ SLASH_EXECUTION_GUARD_HOURS/,
    );
  });

  it('names every window, the sum and the limit so the operator can see the dial', () => {
    process.env.SLASH_PLATFORM_DECISION_WINDOW_HOURS = '24';

    // The operator sees only this string when the process refuses to start, so
    // it has to carry the arithmetic AND say which dial each number came from.
    // `48 + 24 + 1` alone does not tell you which one to turn.
    expect(() => loadSlashConfig()).toThrow(/48 \+ 24 \+ 1 = 73 > 72/);
    expect(() => loadSlashConfig()).toThrow(/SLASH_RESPONSE_WINDOW_HOURS=48/);
    expect(() => loadSlashConfig()).toThrow(/SLASH_PLATFORM_DECISION_WINDOW_HOURS=24/);
    expect(() => loadSlashConfig()).toThrow(/SLASH_EXECUTION_GUARD_HOURS=1/);
    expect(() => loadSlashConfig()).toThrow(/SLASH_TIMELOCK_HOURS=72/);
  });

  // The boundary is `<=`, not `<`, and that is a requirement rather than an
  // accident of the shipped defaults: the guard band is the slack, so spending
  // exactly all of it is the intended fit. Pinned on values that are not the
  // defaults, so the pair still tests the comparator if the defaults ever move.
  it('accepts windows that sum to exactly the timelock', () => {
    process.env.SLASH_TIMELOCK_HOURS = '50';
    process.env.SLASH_RESPONSE_WINDOW_HOURS = '30';
    process.env.SLASH_PLATFORM_DECISION_WINDOW_HOURS = '15';
    process.env.SLASH_EXECUTION_GUARD_HOURS = '5';

    const config = loadSlashConfig();
    expect(
      config.responseWindowMs + config.platformDecisionWindowMs + config.executionGuardMs,
    ).toBe(config.timelockMs);
  });

  it('refuses the same combination one hour over the timelock', () => {
    process.env.SLASH_TIMELOCK_HOURS = '50';
    process.env.SLASH_RESPONSE_WINDOW_HOURS = '30';
    process.env.SLASH_PLATFORM_DECISION_WINDOW_HOURS = '15';
    process.env.SLASH_EXECUTION_GUARD_HOURS = '6';

    expect(() => loadSlashConfig()).toThrow(/30 \+ 15 \+ 6 = 51 > 50/);
  });

  it('accepts a longer timelock rather than demanding shorter windows', () => {
    // The chain's Config.slash_delay_seconds may be raised above its 72h floor.
    // Raising the backend's copy to match is the operator's way out.
    process.env.SLASH_PLATFORM_DECISION_WINDOW_HOURS = '24';
    process.env.SLASH_TIMELOCK_HOURS = '96';

    expect(() => loadSlashConfig()).not.toThrow();
  });

  it('still falls back on a malformed value rather than throwing on the typo', () => {
    // The existing readInt contract: an operational dial with a typo in it must
    // not stop the process that adjudicates penalties from booting.
    process.env.SLASH_EXECUTION_GUARD_HOURS = 'not-a-number';

    expect(loadSlashConfig().executionGuardMs).toBe(1 * 3_600_000);
  });
});
