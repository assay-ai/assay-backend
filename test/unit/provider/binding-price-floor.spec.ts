import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  loadPaidPriceFloor,
  minPaidPriceAtomic,
  NO_PAID_PRICE_FLOOR,
  PaidPriceFloor,
  paidPriceBelowFloor,
} from '@modules/payment/domain/paid-price-floor';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AppError } from '@shared/errors/app-errors';

import { buildBindingEditorHarness } from './helpers/binding-editor-harness';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const PROVIDER = '7c1b6a52-3f0e-4c1a-9d55-0a2f4b9e1c01';
const INTERNAL = '0f3e2d1c-4b5a-4968-8776-5a4b3c2d1e0f';

/** $0.10, with the internal provider exempt — the production default plus one exemption. */
const FLOOR: PaidPriceFloor = loadPaidPriceFloor({
  MIN_PAID_PRICE_USD: '0.10',
  MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS: ` ${INTERNAL.toUpperCase()} `,
});

function harness(floor: PaidPriceFloor = FLOOR) {
  return buildBindingEditorHarness({
    enabledChains: [DEVNET],
    enrolments: [
      { providerId: PROVIDER, chainId: DEVNET },
      { providerId: INTERNAL, chainId: DEVNET },
    ],
    stakes: {
      [`${PROVIDER}|${DEVNET}`]: '1000000000',
      [`${INTERNAL}|${DEVNET}`]: '1000000000',
    },
    priceFloor: floor,
  });
}

async function failure(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a refusal');
}

describe('paid price floor — the arithmetic', () => {
  it('defaults to $0.10, which is 100000 atomic at 6 decimals', () => {
    const floor = loadPaidPriceFloor({});
    expect(floor.minUsd).toBe('0.10');
    expect(minPaidPriceAtomic(floor, 6)).toBe(100_000n);
    expect(floor.exemptProviderIds.size).toBe(0);
  });

  it('rounds a floor finer than the asset scale up, never down', () => {
    expect(minPaidPriceAtomic(loadPaidPriceFloor({ MIN_PAID_PRICE_USD: '0.0000001' }), 6)).toBe(1n);
  });

  it('refuses to boot on a malformed amount or exempt id', () => {
    expect(() => loadPaidPriceFloor({ MIN_PAID_PRICE_USD: '$0.10' })).toThrow(/MIN_PAID_PRICE_USD/);
    expect(() => loadPaidPriceFloor({ MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS: 'internal' })).toThrow(
      /MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS/,
    );
  });

  it('allows exactly the minimum, refuses one atomic unit less, exempts the listed provider', () => {
    expect(paidPriceBelowFloor(FLOOR, PROVIDER, '100000', 6)).toBeNull();
    expect(paidPriceBelowFloor(FLOOR, PROVIDER, '99999', 6)).toBe(100_000n);
    expect(paidPriceBelowFloor(FLOOR, INTERNAL, '1000', 6)).toBeNull();
    expect(paidPriceBelowFloor(NO_PAID_PRICE_FLOOR, PROVIDER, '1', 6)).toBeNull();
  });
});

describe('binding editor — paid price floor', () => {
  it('refuses to create a PAID binding below the minimum, naming it, and writes nothing', async () => {
    const { editor, validBody, rows } = harness();

    const error = await failure(() =>
      editor.create(PROVIDER, 'cred', { ...validBody, priceAmount: '1000' }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_PRICE_BELOW_MINIMUM);
    expect(error.message).toContain('$0.10');
    expect(error.message).toContain('100000');
    expect(rows).toHaveLength(0);
  });

  it('refuses a FREEMIUM binding below the minimum too', async () => {
    const { editor, validBody } = harness();

    const error = await failure(() =>
      editor.create(PROVIDER, 'cred', {
        ...validBody,
        pricingMode: PricingMode.FREEMIUM,
        priceAmount: '50000',
        freeQuotaPerAgent: 10,
      }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_PRICE_BELOW_MINIMUM);
  });

  it('accepts exactly the minimum', async () => {
    const { editor, validBody } = harness();

    const saved = await editor.create(PROVIDER, 'cred', { ...validBody, priceAmount: '100000' });

    expect(saved.price.amount).toBe('100000');
  });

  it('leaves FREE bindings alone', async () => {
    const { editor, validBody } = harness();

    const saved = await editor.create(PROVIDER, 'cred', {
      ...validBody,
      pricingMode: PricingMode.FREE,
      priceAmount: '0',
    });

    expect(saved.pricingMode).toBe(PricingMode.FREE);
  });

  it('refuses an update that lowers the price below the minimum', async () => {
    const { editor, validBody } = harness();
    const saved = await editor.create(PROVIDER, 'cred', { ...validBody, priceAmount: '100000' });

    const error = await failure(() =>
      editor.update(PROVIDER, 'cred', saved.id, { priceAmount: '99999' }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_PRICE_BELOW_MINIMUM);
  });

  it('refuses any update of a binding priced below the minimum before the floor existed', async () => {
    const { editor, validBody, rows } = harness();
    const saved = await editor.create(PROVIDER, 'cred', { ...validBody, priceAmount: '100000' });
    // As written before the floor: $0.001.
    rows[0].priceAmount = '1000';

    const error = await failure(() =>
      editor.update(PROVIDER, 'cred', saved.id, { timeoutMs: 9_000 }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_PRICE_BELOW_MINIMUM);
    // Raising the price in the same edit is the way out.
    const raised = await editor.update(PROVIDER, 'cred', saved.id, {
      timeoutMs: 9_000,
      priceAmount: '100000',
    });
    expect(raised.price.amount).toBe('100000');
  });

  it('lets an exempt (internal) provider create and update below the minimum', async () => {
    const { editor, validBody } = harness();

    const saved = await editor.create(INTERNAL, 'cred', { ...validBody, priceAmount: '1000' });
    expect(saved.price.amount).toBe('1000');

    const updated = await editor.update(INTERNAL, 'cred', saved.id, { priceAmount: '2000' });
    expect(updated.price.amount).toBe('2000');
  });
});
