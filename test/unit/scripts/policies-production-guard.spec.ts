import { assertNotProduction } from '../../../scripts/mcp/production-guard';

describe('scripts/mcp/policies.ts production guard', () => {
  it('refuses to run with NODE_ENV=production', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
  });

  it('runs anywhere else', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertNotProduction({})).not.toThrow();
  });
});
