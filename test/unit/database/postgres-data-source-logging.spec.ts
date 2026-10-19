/**
 * Review R1-m3: the migration CLI's DataSource logs as the app does — with
 * `DATABASE_LOGGING=true`, queries without their bound parameters.
 */
describe('PostgresDataSource logging', () => {
  const saved = process.env.DATABASE_LOGGING;
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_LOGGING;
    else process.env.DATABASE_LOGGING = saved;
  });

  function load(): { logging?: unknown; logger?: unknown } {
    let options: { logging?: unknown; logger?: unknown } = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PostgresDataSource } = require('@database/postgres/postgres.data-source');
      options = PostgresDataSource.options;
    });
    return options;
  }

  it('uses ParameterlessQueryLogger when DATABASE_LOGGING=true', () => {
    process.env.DATABASE_LOGGING = 'true';
    const options = load();
    expect(options.logging).toBe(true);
    // Loaded in an isolated registry, so compared by class name.
    expect((options.logger as object).constructor.name).toBe('ParameterlessQueryLogger');
  });

  it('does not log when DATABASE_LOGGING is off', () => {
    process.env.DATABASE_LOGGING = 'false';
    expect(load().logging).toBe(false);
  });
});
