import {
  IneligibilityReason,
  PayoutGateVerdict,
  evaluatePayoutGate,
  filterEligible,
  payoutAccountOn,
} from '@modules/tool/domain/routing';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { PricingMode } from '@modules/tool/ports/tool.types';

import {
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  anyChainContext,
  buildCandidate,
  usdc,
} from './helpers/routing-fixtures';

/**
 * `evaluatePayoutGate` — a paid call may only be routed to somebody the
 * platform can actually pay.
 *
 * ## What it is defending
 *
 * `payment_intents.provider_account` is written from the provider's ACTIVE
 * enrolment on the settlement chain (`provider_chain_enrolments.
 * payout_account_id`) at the moment the call is served, and the
 * `VERIFYING → SETTLED` edge credits it. A provider who has never proved an
 * address therefore serves calls that cannot settle: the intent moves to
 * `SETTLED`, `resolve()` throws `PAYMENT_PROVIDER_NOT_ASSIGNED`, and the
 * agent's money stays `held` with nothing anywhere returning it. Refusing at
 * selection is the only point where that costs nobody anything.
 *
 * The same function runs at publish time (the publish check) and here, deliberately
 * — see `publish-gate.spec.ts` for the other half. The publish check alone is
 * only ever true on the day the button was pressed; this one is true on every
 * call.
 */
describe('evaluatePayoutGate', () => {
  it('passes a paid binding whose provider has proved an address', () => {
    const verdict = evaluatePayoutGate(
      buildCandidate('provider-a', { staked: usdc(1000) }),
      PAYOUT_CHAIN,
    );

    expect(verdict.passed).toBe(true);
  });

  it('refuses a paid binding whose provider has proved none', () => {
    const verdict = evaluatePayoutGate(
      buildCandidate('provider-a', {
        staked: usdc(1000),
        provider: { payoutAccountByChain: new Map() },
      }),
      PAYOUT_CHAIN,
    );

    expect(verdict.passed).toBe(false);
    // Cast rather than narrowing: this project compiles with
    // `strictNullChecks: false`, under which TypeScript does not narrow a
    // discriminated union by its literal-boolean tag.
    const failure = verdict as Extract<PayoutGateVerdict, { passed: false }>;
    expect(failure.reason).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    // Legible, not a silent skip: the reason names the provider, the binding
    // and what is actually wrong, so a rejection summary reaching a console or
    // an error message says something a human can act on.
    expect(failure.detail).toContain('provider-a');
    expect(failure.detail).toContain('binding-provider-a');
    expect(failure.detail).toContain('has not proved a payout address');
    // And on WHICH chain — the whole point of per-chain enrolment. A detail that named only
    // the provider would read identically for a provider payable on the other
    // chain, which is the case this gate now has to distinguish.
    expect(failure.detail).toContain(PAYOUT_CHAIN);
  });

  it('exempts a FREE binding, which never creates a payment intent to settle', () => {
    const verdict = evaluatePayoutGate(
      buildCandidate('provider-a', {
        staked: usdc(1000),
        binding: { pricingMode: PricingMode.FREE },
        provider: { payoutAccountByChain: new Map() },
      }),
      PAYOUT_CHAIN,
    );

    expect(verdict.passed).toBe(true);
  });

  it('does NOT exempt FREEMIUM, whose quota has not been checked at selection time', () => {
    // The same reasoning `evaluateStakeGate` gives, and it has to hold here for
    // the stronger reason: a `FREEMIUM` binding whose quota is exhausted falls
    // through to the paid path *inside the same call*, so guessing "free" here
    // would route a charged call to a provider nobody can pay.
    const verdict = evaluatePayoutGate(
      buildCandidate('provider-a', {
        staked: usdc(1000),
        binding: { pricingMode: PricingMode.FREEMIUM },
        provider: { payoutAccountByChain: new Map() },
      }),
      PAYOUT_CHAIN,
    );

    expect(verdict.passed).toBe(false);
  });
});

describe('filterEligible — the routing exclusion', () => {
  it('keeps a provider with a proved address in the eligible set', () => {
    const candidate = buildCandidate('provider-a', { staked: usdc(1000) });

    const { eligible, rejected } = filterEligible(
      [candidate],
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext([candidate]),
    );

    expect(eligible).toEqual([candidate]);
    expect(rejected).toEqual([]);
    // Sanity: the default fixture really does carry one, so the negative case
    // below is testing the absence and not a typo.
    expect(candidate.provider.payoutAccountByChain.get(PAYOUT_CHAIN)).toBe(PAYOUT_ACCOUNT);
  });

  it('drops a provider with none, and says so rather than skipping quietly', () => {
    const candidate = buildCandidate('provider-a', {
      staked: usdc(1000),
      provider: { payoutAccountByChain: new Map() },
    });

    const { eligible, rejected } = filterEligible(
      [candidate],
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext([candidate]),
    );

    expect(eligible).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    // The candidate travels with the rejection, so `summariseRejections` can
    // name the binding in `TOOL_NO_ELIGIBLE_BINDING` — this is what makes the
    // refusal reach the agent and the provider console instead of dying here.
    expect(rejected[0].candidate).toBe(candidate);
  });

  it('reports the missing address ahead of a stake shortfall, not instead of it', () => {
    // Both conditions hold. The reported reason is the one the provider cannot
    // fix by moving money — the same ordering rule that puts a suspension above
    // a shortfall. Sending someone to top up when the real problem is a missing
    // signature sends them to the wrong screen.
    const candidates = [
      buildCandidate('provider-a', {
        staked: usdc(1),
        provider: { payoutAccountByChain: new Map() },
      }),
    ];
    const { rejected } = filterEligible(
      candidates,
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext(candidates),
    );

    expect(rejected[0].reason).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
  });

  it('still reports a suspension first, because that one is not the provider’s to fix', () => {
    const candidates = [
      buildCandidate('provider-a', {
        staked: usdc(1000),
        provider: { status: 'SUSPENDED' as never, payoutAccountByChain: new Map() },
      }),
    ];
    const { rejected } = filterEligible(
      candidates,
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext(candidates),
    );

    expect(rejected[0].reason).toBe(IneligibilityReason.PROVIDER_NOT_ACTIVE);
  });

  it('leaves a FREE binding routable with no address at all', () => {
    const candidate = buildCandidate('provider-a', {
      binding: { pricingMode: PricingMode.FREE },
      provider: { payoutAccountByChain: new Map() },
    });

    const { eligible } = filterEligible(
      [candidate],
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext([candidate]),
    );

    expect(eligible).toEqual([candidate]);
  });
});

describe('per chain', () => {
  const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

  it('passes on a chain the provider proved an address for', () => {
    const candidate = buildCandidate('p', {
      provider: { payoutAccountByChain: new Map([[DEVNET, PAYOUT_ACCOUNT]]) },
    });

    expect(evaluatePayoutGate(candidate, DEVNET).passed).toBe(true);
  });

  it('refuses on a chain the provider did NOT prove an address for', () => {
    const candidate = buildCandidate('p', {
      provider: { payoutAccountByChain: new Map([[DEVNET, PAYOUT_ACCOUNT]]) },
    });

    const verdict = evaluatePayoutGate(candidate, MAINNET);

    expect(verdict.passed).toBe(false);
    expect(verdict).toMatchObject({ reason: IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED });
    expect((verdict as { detail: string }).detail).toContain(MAINNET);
  });

  it('refuses when the map is empty — an unenrolled provider is not payable', () => {
    const candidate = buildCandidate('p', { provider: { payoutAccountByChain: new Map() } });

    expect(evaluatePayoutGate(candidate, DEVNET).passed).toBe(false);
  });

  it('still exempts FREE bindings on any chain', () => {
    const candidate = buildCandidate('p', {
      binding: { pricingMode: PricingMode.FREE },
      provider: { payoutAccountByChain: new Map() },
    });

    expect(evaluatePayoutGate(candidate, MAINNET).passed).toBe(true);
  });
});

/**
 * Which chain `filterEligible` actually asks about.
 *
 * For these one-chain fixtures it is
 * `chainIdOf(binding.assetId)` — the chain the binding's price is quoted in,
 * which is by construction the chain it settles on today. These two cases pin
 * that it is *derived* and not a constant: one of them fails on any fixed
 * chain, whichever chain is picked.
 */
describe('filterEligible takes the chain from the binding, not from a default', () => {
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
  const MAINNET_ACCOUNT = `${MAINNET}:HnT3pdiw7DagqUY6pST8YBVxfBxMncbQZaDmW8itofu7` as AccountId;

  it('refuses a mainnet-priced binding from a provider proved only on devnet', () => {
    const candidate = buildCandidate('provider-a', {
      binding: { assetId: ASSET_IDS.USDC_SOLANA_MAINNET },
      // The fixture default: an address on PAYOUT_CHAIN, which is devnet.
    });

    const { eligible, rejected } = filterEligible(
      [candidate],
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext([candidate]),
    );

    expect(eligible).toEqual([]);
    expect(rejected[0].reason).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    expect(rejected[0].detail).toContain(MAINNET);
  });

  it('lets the same binding PAST the payout gate when the provider is proved on mainnet', () => {
    const candidate = buildCandidate('provider-a', {
      binding: { assetId: ASSET_IDS.USDC_SOLANA_MAINNET },
      provider: { payoutAccountByChain: new Map([[MAINNET, MAINNET_ACCOUNT]]) },
    });

    const { rejected } = filterEligible(
      [candidate],
      MINIMUM_STAKE_BY_CHAIN,
      anyChainContext([candidate]),
    );

    // The mirror image of the case above. A gate that asked about a hardcoded
    // chain fails one of these two, whichever chain it hardcodes.
    //
    // Asserted as "past the payout gate" rather than "eligible" because this
    // candidate cannot be eligible for an unrelated reason: `MINIMUM_STAKE_BY_
    // CHAIN` carries a floor for devnet only, and since stake became per-chain a settlement
    // chain with no configured floor is refused rather than handed another
    // chain's (`STAKE_UNKNOWN`, detail "no minimum stake is configured for").
    // The payout gate runs FIRST, so reaching the stake refusal is exactly the
    // proof that the payout one passed — and it stays honest about what this
    // fixture can and cannot show.
    //
    // Before stake was per-chain this line read `STAKE_ASSET_MISMATCH`: there was one floor,
    // it was denominated in devnet USDC, and the gate refused a binding priced
    // in another asset outright. The floor lookup now happens one step earlier
    // and answers first. Both are refusals and neither is the payout gate's.
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).not.toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    expect(rejected[0].reason).toBe(IneligibilityReason.STAKE_UNKNOWN);
    expect(rejected[0].detail).toContain('no minimum stake is configured for');
  });
});

/**
 * `payoutAccountOn` — the single reader of the map outside the gate.
 *
 * Its whole job is to be looked up BY CHAIN. The degenerate it exists to
 * defeat is a lookup that returns whatever is first in the map, which on a
 * one-chain provider is indistinguishable from correct.
 */
describe('payoutAccountOn', () => {
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
  const MAINNET_ACCOUNT = `${MAINNET}:HnT3pdiw7DagqUY6pST8YBVxfBxMncbQZaDmW8itofu7` as AccountId;

  function twoChains() {
    // Insertion order puts mainnet FIRST, so "the map's first entry" and "the
    // entry for PAYOUT_CHAIN" are different values.
    return buildCandidate('provider-a', {
      provider: {
        payoutAccountByChain: new Map([
          [MAINNET, MAINNET_ACCOUNT],
          [PAYOUT_CHAIN, PAYOUT_ACCOUNT],
        ]),
      },
    }).provider;
  }

  it('returns the address for the chain asked about, not the first in the map', () => {
    expect(payoutAccountOn(twoChains(), PAYOUT_CHAIN)).toBe(PAYOUT_ACCOUNT);
    expect(payoutAccountOn(twoChains(), MAINNET)).toBe(MAINNET_ACCOUNT);
  });

  it('returns null for a chain that is not in the map', () => {
    expect(payoutAccountOn(twoChains(), CHAIN_IDS.BASE_MAINNET)).toBeNull();
  });

  it('returns null for a ONE-entry map asked about a different chain', () => {
    // The case the two-entry fixtures above cannot see, and it is the shape of
    // every provider in the database today: `select count(*) from
    // provider_chain_enrolments` is one row on one chain. A lookup that says
    // "one enrolment, no ambiguity, hand it back" is indistinguishable from
    // correct on every other test in this file — and it is exactly the
    // "never the first entry" rule, spelled `size === 1`.
    //
    // It would be unreachable if the gate and the router were asked about the
    // same `chainIdOf(binding.assetId)`. `chooseSettlementChain` breaks that
    // symmetry: it replaces the gate's chain and leaves the router's own
    // derivation behind, at which point this lookup is
    // the last thing standing between a settled call and a payee on a chain
    // that cannot see it.
    const provider = buildCandidate('provider-a', {
      provider: { payoutAccountByChain: new Map([[PAYOUT_CHAIN, PAYOUT_ACCOUNT]]) },
    }).provider;

    expect(provider.payoutAccountByChain.size).toBe(1);
    expect(payoutAccountOn(provider, MAINNET)).toBeNull();
    expect(payoutAccountOn(provider, CHAIN_IDS.BASE_MAINNET)).toBeNull();
    // And the one it IS enrolled on still answers, so this is a chain check
    // and not a function that learned to return null.
    expect(payoutAccountOn(provider, PAYOUT_CHAIN)).toBe(PAYOUT_ACCOUNT);
  });

  it('returns null for a provider with no enrolments at all', () => {
    const provider = buildCandidate('provider-a', {
      provider: { payoutAccountByChain: new Map() },
    }).provider;

    expect(payoutAccountOn(provider, PAYOUT_CHAIN)).toBeNull();
  });
});

/**
 * A closed enrolment is not a missing signature (`PAYOUT_ENROLMENT_NOT_ACTIVE`).
 *
 * `DbProviderRegistry` keeps only ACTIVE enrolments in `payoutAccountByChain`,
 * so from the gate's side a `SUSPENDED` chain and a chain that was never
 * enrolled look identical — one absent key. `payoutEnrolmentChains` is what
 * tells them apart, and the difference is what the provider is told to do:
 * "sign from the wallet you want paying" is actionable, and is a lie to
 * somebody who already did.
 */
describe('a closed enrolment reports its own reason, not PAYOUT_ACCOUNT_UNPROVED', () => {
  const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

  /** Enrolled on mainnet, but the address is not in the routable map. */
  function closedOnMainnet() {
    return buildCandidate('provider-a', {
      provider: {
        payoutAccountByChain: new Map([[PAYOUT_CHAIN, PAYOUT_ACCOUNT]]),
        payoutEnrolmentChains: new Set([PAYOUT_CHAIN, MAINNET]),
      },
    });
  }

  it('refuses with PAYOUT_ENROLMENT_NOT_ACTIVE, and says the address IS proved', () => {
    const verdict = evaluatePayoutGate(closedOnMainnet(), MAINNET);

    expect(verdict.passed).toBe(false);
    const failure = verdict as Extract<PayoutGateVerdict, { passed: false }>;
    expect(failure.reason).toBe(IneligibilityReason.PAYOUT_ENROLMENT_NOT_ACTIVE);
    expect(failure.detail).toContain(MAINNET);
    expect(failure.detail).toContain('has a payout address proved on');
    expect(failure.detail).toContain('not ACTIVE');
    // The sentence it must NOT say — it is the one that sends a provider to
    // repeat a step they have already completed and that repeating cannot fix.
    expect(failure.detail).not.toContain('has not proved a payout address');
  });

  it('still says PAYOUT_ACCOUNT_UNPROVED for a chain with no enrolment at all', () => {
    const verdict = evaluatePayoutGate(closedOnMainnet(), CHAIN_IDS.BASE_MAINNET);

    const failure = verdict as Extract<PayoutGateVerdict, { passed: false }>;
    expect(failure.reason).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    expect(failure.detail).toContain('has not proved a payout address');
  });

  it('does not let the enrolment set admit anybody — the pass branch reads the ADDRESS', () => {
    // The dangerous shape of this field: a gate that consulted it on the way in
    // rather than only on the way out would route a paid call to a provider the
    // platform has withdrawn from that chain, which is the whole thing the
    // ACTIVE filter exists to stop.
    const candidate = buildCandidate('provider-a', {
      provider: {
        payoutAccountByChain: new Map(),
        payoutEnrolmentChains: new Set([PAYOUT_CHAIN, MAINNET, CHAIN_IDS.BASE_MAINNET]),
      },
    });

    expect(evaluatePayoutGate(candidate, PAYOUT_CHAIN).passed).toBe(false);
    expect(evaluatePayoutGate(candidate, MAINNET).passed).toBe(false);
    expect(evaluatePayoutGate(candidate, CHAIN_IDS.BASE_MAINNET).passed).toBe(false);
  });

  it('is still exempt for a FREE binding, whatever the enrolment says', () => {
    const candidate = buildCandidate('provider-a', {
      binding: { pricingMode: PricingMode.FREE },
      provider: {
        payoutAccountByChain: new Map(),
        payoutEnrolmentChains: new Set([MAINNET]),
      },
    });

    expect(evaluatePayoutGate(candidate, MAINNET).passed).toBe(true);
  });
});
