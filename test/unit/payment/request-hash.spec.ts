import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import {
  REQUEST_HASH_RE,
  RequestHashInput,
  computeRequestHash,
} from '@modules/payment/domain/request-hash';

import { expectErrorCode } from '../helpers/expect-error-code';

const base: RequestHashInput = {
  method: 'POST',
  path: '/v1/weather',
  query: { units: 'metric' },
  body: { city: 'Paris', days: 3 },
  toolId: '11111111-1111-4111-8111-111111111111',
  providerId: '22222222-2222-4222-8222-222222222222',
  amount: '1000000',
  asset: ASSET_IDS.USDC_SOLANA_MAINNET,
};

const hash = (patch: Partial<RequestHashInput> = {}) => computeRequestHash({ ...base, ...patch });

/**
 * The serialiser seam: the serialiser lives in `shared/` and throws its
 * own error, so `computeRequestHash` translates. Without this, a non-JSON body
 * answers a client with a 500 instead of the error code the API contract names.
 */
describe('a non-JSON value still surfaces as the payment error code', () => {
  it.each([
    ['a Map in the body', { body: { payload: new Map([['a', 1]]) } }],
    ['NaN in the query', { query: { limit: NaN } }],
  ])('%s', (_name, patch) => {
    expectErrorCode(
      () => hash(patch as Partial<RequestHashInput>),
      PaymentErrorCode.PAYMENT_REQUEST_NOT_CANONICALISABLE,
    );
  });
});

describe('computeRequestHash', () => {
  it('produces a self-describing sha256 digest', () => {
    expect(hash()).toMatch(REQUEST_HASH_RE);
  });

  it('is stable across calls', () => {
    expect(hash()).toBe(hash());
  });

  it('is stable when the request is assembled in a different key order', () => {
    expect(hash({ body: { days: 3, city: 'Paris' } })).toBe(hash());
  });

  it('normalises the method case', () => {
    expect(hash({ method: 'post' })).toBe(hash());
  });

  it('treats an absent query and a null query as the same thing', () => {
    expect(hash({ query: undefined })).toBe(hash({ query: null }));
  });

  /**
   * One assertion per field the hash is documented to cover. If a field is ever
   * dropped from the pre-image, exactly one of these fails, and the failure
   * names the field — which is the whole reason to enumerate them rather than
   * assert on a golden digest.
   */
  describe('every covered field changes the digest', () => {
    it.each<[string, Partial<RequestHashInput>]>([
      ['method', { method: 'GET' }],
      ['path', { path: '/v1/weather/premium' }],
      ['query', { query: { units: 'imperial' } }],
      ['query — added key', { query: { units: 'metric', verbose: 'true' } }],
      ['body — value', { body: { city: 'Paris', days: 30 } }],
      ['body — added key', { body: { city: 'Paris', days: 3, premium: true } }],
      ['body — removed key', { body: { city: 'Paris' } }],
      ['body — nested value', { body: { city: 'Paris', days: 3, opts: { hourly: true } } }],
      ['toolId', { toolId: '33333333-3333-4333-8333-333333333333' }],
      ['providerId', { providerId: '44444444-4444-4444-8444-444444444444' }],
      ['amount', { amount: '1000001' }],
      ['asset', { asset: ASSET_IDS.USDC_SOLANA_DEVNET }],
    ])('%s', (_name, patch) => {
      expect(hash(patch)).not.toBe(hash());
    });
  });

  /**
   * The pre-image must fail **closed** on a missing field.
   *
   * `canonicalJson` drops `undefined` properties, which is right inside `body`
   * and `query` and catastrophic for the fixed fields: a missing `path` would
   * not throw, the key would simply vanish, and every path would hash the same
   * — one voucher authorising a whole tool. Asserting per field rather than in
   * one lump so that the failure names which one stopped failing closed.
   */
  describe('a missing mandatory field is refused, never dropped', () => {
    it.each(['method', 'path', 'toolId', 'providerId', 'amount', 'asset'] as const)(
      '%s',
      (field) => {
        expectErrorCode(
          () => hash({ [field]: undefined }),
          PaymentErrorCode.PAYMENT_REQUEST_NOT_CANONICALISABLE,
        );
      },
    );

    it('and an empty string is missing, not a value', () => {
      expectErrorCode(
        () => hash({ path: '' }),
        PaymentErrorCode.PAYMENT_REQUEST_NOT_CANONICALISABLE,
      );
    });
  });

  it('refuses a method that is not an ASCII token', () => {
    // `toUpperCase` is many-to-one over Unicode: `"POſT"` folds to `"POST"`.
    // Two distinct methods sharing a digest is one binding, not two.
    expect('POſT'.toUpperCase()).toBe('POST');
    expectErrorCode(
      () => hash({ method: 'POſT' }),
      PaymentErrorCode.PAYMENT_REQUEST_NOT_CANONICALISABLE,
    );
  });

  it('does not confuse two fields whose values are swapped', () => {
    // A naive concatenation would hash `toolId + providerId` identically here.
    expect(hash({ toolId: base.providerId, providerId: base.toolId })).not.toBe(hash());
  });

  it('does not let a value containing the separator impersonate another field', () => {
    // The pre-image is JSON, not a delimited string, so a crafted value is
    // escaped rather than parsed as structure.
    expect(hash({ path: `${base.path}","toolId":"x` })).not.toBe(hash());
  });
});
