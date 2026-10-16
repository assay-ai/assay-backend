import { ConfigService } from '@nestjs/config';

import { loadProviderTerms } from '@modules/provider/services/provider-terms';

/**
 * The commercial terms the provider console prints.
 *
 * The interesting assertions here are all about one row. The UI mock-up shows
 * "$100 minimum"; the platform enforces
 * `PROVIDER_MINIMUM_STAKE_FLOOR` through `minimumStakeFor`, and the two are not
 * the same number. A terms table that prints the mock-up's figure would tell a
 * provider they had cleared a bar the router then rejects them against — so
 * these tests pin the table to the *enforced* value, and pin the rendering to
 * something a human would accept as a price.
 */
function configWith(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('loadProviderTerms', () => {
  it('renders the stake floor as a price, not as a ledger amount', () => {
    const terms = loadProviderTerms(configWith({}));
    const stake = terms.commercialTerms.find((term) => term.key === 'stakeRequired');

    // Not `$50.000000` — USDC's six decimals are right for a ledger line and
    // wrong for a price tag a person reads.
    expect(stake?.value).toBe('$50.00 minimum');
  });

  it('follows the configured floor rather than a constant typed into this file', () => {
    const terms = loadProviderTerms(configWith({ PROVIDER_MINIMUM_STAKE_FLOOR: '250000000' }));
    const stake = terms.commercialTerms.find((term) => term.key === 'stakeRequired');

    expect(stake?.value).toBe('$250.00 minimum');
  });

  // R17-R-03: the printed take rate is the charged one, PLATFORM_FEE_BPS.
  it('prints the take rate from PLATFORM_FEE_BPS, ignoring the retired display setting', () => {
    const takeRate = (values: Record<string, string>) =>
      loadProviderTerms(configWith(values)).commercialTerms.find((term) => term.key === 'takeRate')
        ?.value;

    expect(takeRate({})).toBe('10%');
    expect(takeRate({ PLATFORM_FEE_BPS: '1250' })).toBe('12.5%');
    expect(takeRate({ PLATFORM_FEE_BPS: '1000', PROVIDER_TERMS_TAKE_RATE_PERCENT: '20' })).toBe(
      '10%',
    );
  });

  it('never rounds the floor up', () => {
    // A floor shown lower than it is would be a bar cleared on screen and
    // failed at the gate; shown higher is merely conservative. Truncation is
    // the safe direction, so $50.999999 must read as $50.99, not $51.00.
    const terms = loadProviderTerms(configWith({ PROVIDER_MINIMUM_STAKE_FLOOR: '50999999' }));
    const stake = terms.commercialTerms.find((term) => term.key === 'stakeRequired');

    expect(stake?.value).toBe('$50.99 minimum');
  });

  it('builds the acceptance line from the published versions', () => {
    const terms = loadProviderTerms(
      configWith({
        PROVIDER_TERMS_AGREEMENT_VERSION: 'v2.1',
        PROVIDER_TERMS_PAYOUT_VERSION: 'v1.3',
        PROVIDER_TERMS_SLASH_POLICY_VERSION: 'v4.0',
      }),
    );

    expect(terms.acceptanceLine).toBe(
      'I accept the provider agreement v2.1, the payout terms v1.3 and the slash policy v4.0',
    );
  });

  it('states the whole commercial table the frame prints', () => {
    const terms = loadProviderTerms(configWith({}));

    expect(terms.commercialTerms.map((term) => `${term.label}: ${term.value}`)).toEqual([
      'Take rate: 10%',
      'Payouts: as each call settles',
      'Reserve held: $0.00',
      'Clawback: never',
      'Stake required: $50.00 minimum',
      'Slashed when: DATA_FAIL only',
      'Where a penalty goes: 60 / 30 / 10',
    ]);
  });
});
