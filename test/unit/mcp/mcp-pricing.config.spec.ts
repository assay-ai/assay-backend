import { mcpPricingFrom } from '@modules/mcp/services/mcp-pricing.config';

/** M8: the fee is the contract's rate on a chain read, `PLATFORM_FEE_BPS` everywhere else. */
describe('mcpPricingFrom', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as never;
  const CHAIN = 'eip155:46630';

  it('uses the contract take rate once the chain was read', () => {
    const pricing = mcpPricingFrom(config({ PLATFORM_FEE_BPS: '1000' }), {
      current: () => ({ source: 'chain', takeRateBps: 800 }),
    });
    expect(pricing.platformFeeBpsFor?.(CHAIN)).toBe(800);
  });

  it('falls back to PLATFORM_FEE_BPS while the chain was never read', () => {
    const pricing = mcpPricingFrom(config({ PLATFORM_FEE_BPS: '1200' }), {
      current: () => ({ source: 'config', takeRateBps: 1200 }),
    });
    expect(pricing.platformFeeBpsFor?.(CHAIN)).toBeNull();
    expect(pricing.platformFeeBps).toBe(1200);
  });

  it('falls back for a chain with no contract, and with no cache at all', () => {
    expect(
      mcpPricingFrom(config({}), { current: () => null }).platformFeeBpsFor?.(CHAIN),
    ).toBeNull();
    const none = mcpPricingFrom(config({}), null);
    expect(none.platformFeeBpsFor?.(CHAIN)).toBeNull();
    expect(none.platformFeeBps).toBe(1000);
  });
});
