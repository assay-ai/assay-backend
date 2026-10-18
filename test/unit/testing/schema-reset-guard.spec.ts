import { assertSafeToResetSchema } from '../../integration/helpers/test-database';

describe('assertSafeToResetSchema', () => {
  it('allows a local *_test database', () => {
    expect(() => assertSafeToResetSchema('app_ledger_test', 'localhost', {})).not.toThrow();
    expect(() => assertSafeToResetSchema('x402_x_test', '127.0.0.1', {})).not.toThrow();
    expect(() => assertSafeToResetSchema('x402_x_test', '::1', {})).not.toThrow();
  });

  it.each(['app', 'postgres', 'app_test_data', 'production'])('refuses %s', (name) => {
    expect(() => assertSafeToResetSchema(name, 'localhost', {})).toThrow(/must end in "_test"/);
  });

  it('refuses a remote host unless explicitly allowed', () => {
    expect(() => assertSafeToResetSchema('app_test', 'db.internal', {})).toThrow(/non-local host/);
    expect(() =>
      assertSafeToResetSchema('app_test', 'db.internal', { ALLOW_TEST_SCHEMA_RESET: '1' }),
    ).not.toThrow();
  });
});
