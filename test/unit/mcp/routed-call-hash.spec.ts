import { AssetId } from '@modules/chains/ports/caip.types';
import {
  REQUEST_HASH_RE,
  computeRequestHash,
  computeRoutedCallHash,
} from '@modules/payment/domain/request-hash';

import { expectErrorCode } from '../helpers/expect-error-code';

/**
 * `computeRoutedCallHash` — the pre-image for a call the platform
 * routes.
 *
 * The provider-bound hash binds who serves the call. This one cannot: an MCP
 * agent buys a tool, and which operator answers is a routing decision that
 * failover can change mid-call. What the two must never do is agree.
 */
describe('computeRoutedCallHash — binding the tool, not the provider', () => {
  const ASSET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5' as AssetId;

  const CALL = {
    method: 'POST',
    path: '/mcp/tools/search_web',
    query: null,
    body: { query: 'moon landing' },
    toolId: 'tool-1',
    amount: '10000',
    asset: ASSET,
  };

  it('produces a self-describing sha256 digest', () => {
    expect(computeRoutedCallHash(CALL)).toMatch(REQUEST_HASH_RE);
  });

  it('is stable across key order in the arguments', () => {
    const reordered = {
      ...CALL,
      body: { b: 2, a: 1 },
    };
    const same = { ...CALL, body: { a: 1, b: 2 } };

    expect(computeRoutedCallHash(reordered)).toBe(computeRoutedCallHash(same));
  });

  it('changes when the arguments change', () => {
    expect(computeRoutedCallHash(CALL)).not.toBe(
      computeRoutedCallHash({ ...CALL, body: { query: 'apollo 11' } }),
    );
  });

  it('changes when the price changes, so a re-quote cannot reuse the binding', () => {
    expect(computeRoutedCallHash(CALL)).not.toBe(
      computeRoutedCallHash({ ...CALL, amount: '1000000' }),
    );
  });

  /**
   * The domain separation. Without the `scheme` key a routed-call digest and a
   * provider-bound digest over the same fields would be the same value, and
   * either could be presented where the other was expected.
   */
  it('never collides with a provider-bound hash', () => {
    const providerBound = computeRequestHash({ ...CALL, providerId: 'provider-a' });

    expect(computeRoutedCallHash(CALL)).not.toBe(providerBound);
  });

  it('refuses a missing mandatory field rather than dropping it from the pre-image', () => {
    expectErrorCode(
      () => computeRoutedCallHash({ ...CALL, path: undefined as unknown as string }),
      'PAYMENT_REQUEST_NOT_CANONICALISABLE',
    );
    expectErrorCode(
      () => computeRoutedCallHash({ ...CALL, toolId: '' }),
      'PAYMENT_REQUEST_NOT_CANONICALISABLE',
    );
  });
});
