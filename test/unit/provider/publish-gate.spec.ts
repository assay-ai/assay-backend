import {
  PublishRequirement,
  SECOND_CONTACT_REQUIRED_CODE,
  evaluatePublishGate,
  unmetRequirements,
} from '@modules/provider/domain/publish-gate';
import {
  BindingTestLayer,
  BindingTestOutcome,
  BindingTestWarningCode,
} from '@modules/provider/ports/binding-test.types';
import { BindingAuthMode } from '@modules/tool/ports/tool.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { PayoutGateVerdict } from '@modules/tool/domain/routing/payout-gate';
import { IneligibilityReason } from '@modules/tool/domain/routing/routing.types';
import { StakeGateVerdict } from '@modules/tool/domain/routing/stake-gate';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The publish gate, as a pure function.
 *
 * The cases: publish is blocked when the tester has not run; blocked when the
 * tester is red; blocked when stake is insufficient; passes when all three
 * conditions are met. Each is one `it` below, plus the case that list does not
 * name and the gate turns on — a green run against a revision that has
 * since been edited.
 */
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

/**
 * The one chain every case below is about, unless it says otherwise.
 *
 * Both money requirements are asked per settlement chain, so
 * every input here is a one-entry map. `on()` keeps that from being nine
 * literal `new Map([[CHAIN, …]])`s, and the two-chain cases at the end build
 * their own.
 */
const CHAIN: ChainId = chainIdOf(USDC);
const OTHER: ChainId = CHAIN_IDS.SOLANA_DEVNET;

const on = <T>(verdict: T): ReadonlyMap<ChainId, T> => new Map([[CHAIN, verdict]]);
const STAKE_OK: StakeGateVerdict = { passed: true, minimum: MoneyUtil.of('50000000', USDC, 6) };
const STAKE_SHORT: StakeGateVerdict = {
  passed: false,
  reason: IneligibilityReason.STAKE_BELOW_MINIMUM,
  detail: 'staked 12.00 USDC, minimum 50.00 USDC',
};
const PAYOUT_OK: PayoutGateVerdict = { passed: true };
const PAYOUT_MISSING: PayoutGateVerdict = {
  passed: false,
  reason: IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED,
  detail:
    'provider acme has not proved a payout address, so a settled call on binding b1 would have nobody to credit',
};

const GREEN_RUN = {
  mappingVersion: 4,
  outcome: BindingTestOutcome.PASSED,
  failedLayer: null,
  ranAt: new Date('2026-08-19T09:00:00Z'),
};

function requirement(check: ReturnType<typeof evaluatePublishGate>, name: PublishRequirement) {
  const found = check.requirements.find((entry) => entry.requirement === name);
  if (!found) throw new Error(`the gate did not report ${name}`);
  return found;
}

describe('evaluatePublishGate', () => {
  it('refuses a binding whose tester has never run', () => {
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: null,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    });

    expect(check.publishable).toBe(false);
    expect(requirement(check, PublishRequirement.TESTER_RUN).code).toBe('tester_never_run');
    // Not vacuously met. A tick beside "the tester passed" on a binding nobody
    // tested is the one thing the publish checklist must never draw.
    expect(requirement(check, PublishRequirement.TESTER_PASSED).met).toBe(false);
    expect(requirement(check, PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN).met).toBe(true);
  });

  it('refuses a binding whose last tester run was red, and says which layer', () => {
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: {
        ...GREEN_RUN,
        outcome: BindingTestOutcome.FAILED,
        failedLayer: BindingTestLayer.RESPONSE_MAPPING,
      },
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    });

    expect(check.publishable).toBe(false);
    // The run exists, so that requirement is met — the failure is located at
    // the second one, which is what tells a provider to fix the mapping rather
    // than to press Run.
    expect(requirement(check, PublishRequirement.TESTER_RUN).met).toBe(true);

    const passed = requirement(check, PublishRequirement.TESTER_PASSED);
    expect(passed.code).toBe('tester_failed');
    expect(passed.detail).toContain('RESPONSE_MAPPING');
  });

  it('refuses a binding whose stake is below the minimum, carrying the router’s own reason', () => {
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_SHORT),
    });

    expect(check.publishable).toBe(false);

    const stake = requirement(check, PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN);
    // Verbatim from `evaluateStakeGate`. A provider told "below minimum" when
    // the real problem was `STAKE_UNKNOWN` has been sent to fix the wrong thing.
    expect(stake.code).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);
    expect(stake.detail).toContain('minimum 50.00 USDC');
  });

  it('refuses a green run that was made against a revision since edited', () => {
    const check = evaluatePublishGate({
      // The provider tested revision 4, then changed the mapping.
      mappingVersion: 5,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    });

    expect(check.publishable).toBe(false);
    expect(requirement(check, PublishRequirement.TESTER_RUN).code).toBe('tester_run_is_stale');
    expect(unmetRequirements(check)).toHaveLength(2);
  });

  it('refuses a paid binding whose provider has never proved a payout address', () => {
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_MISSING),
      stakeByChain: on(STAKE_OK),
    });

    expect(check.publishable).toBe(false);

    const payout = requirement(check, PublishRequirement.PAYOUT_ACCOUNT);
    // Verbatim from `evaluatePayoutGate`, so the console shows one word for
    // "unpayable" whether the refusal came from publish or from routing.
    expect(payout.code).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    expect(payout.detail).toContain('has not proved a payout address');
    // Legible, not silent: it names what to do, not only what is wrong.
    expect(payout.detail).toContain('Prove a payout address');
    // And it is the ONLY thing standing in the way — a provider whose stake is
    // fine must not be sent to the stake screen.
    expect(unmetRequirements(check).map((entry) => entry.requirement)).toEqual([
      PublishRequirement.PAYOUT_ACCOUNT,
    ]);
  });

  it('lets it through when all four hold', () => {
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    });

    expect(check.publishable).toBe(true);
    expect(unmetRequirements(check)).toEqual([]);
    // One entry per requirement, always — the checklist is a screen, and a
    // screen with a row missing reads as a row that passed.
    expect(check.requirements).toHaveLength(4);
  });

  describe('API_KEY_CREDENTIALS', () => {
    const base = {
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    };
    const origin = 'https://api.example.com';

    it('is unmet, naming the origin, when a key is required and none is stored', () => {
      const check = evaluatePublishGate({
        ...base,
        credentials: { required: true, origin, present: false },
      });
      const row = requirement(check, PublishRequirement.API_KEY_CREDENTIALS);
      expect(row.met).toBe(false);
      expect(row.code).toBe('credentials_missing_for_origin');
      expect(row.detail).toContain(origin);
      expect(check.publishable).toBe(false);
    });
    it('is met when a set is stored, or no key is required', () => {
      for (const credentials of [
        { required: true, origin, present: true },
        { required: false, origin, present: false },
      ]) {
        const check = evaluatePublishGate({ ...base, credentials });
        expect(requirement(check, PublishRequirement.API_KEY_CREDENTIALS).met).toBe(true);
        expect(check.publishable).toBe(true);
      }
    });
    it('is not asked without credential facts', () => {
      const check = evaluatePublishGate(base);
      expect(check.requirements.map((r) => r.requirement)).not.toContain(
        PublishRequirement.API_KEY_CREDENTIALS,
      );
    });
  });

  describe('SECOND_CONTACT', () => {
    const base = {
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    };

    it('refuses a paid binding whose provider has no second contact', () => {
      const check = evaluatePublishGate({ ...base, secondContact: { paid: true, present: false } });
      const row = requirement(check, PublishRequirement.SECOND_CONTACT);
      expect(row.met).toBe(false);
      expect(row.code).toBe(SECOND_CONTACT_REQUIRED_CODE);
      expect(row.code).toBe('PROVIDER_SECOND_CONTACT_REQUIRED');
      expect(row.detail).toBe('Add a second contact before you list paid tools.');
      expect(check.publishable).toBe(false);
    });
    it('lets a free binding through without a second contact', () => {
      const check = evaluatePublishGate({
        ...base,
        secondContact: { paid: false, present: false },
      });
      expect(requirement(check, PublishRequirement.SECOND_CONTACT).met).toBe(true);
      expect(check.publishable).toBe(true);
    });
    it('lets a paid binding through once the second contact is added', () => {
      const check = evaluatePublishGate({ ...base, secondContact: { paid: true, present: true } });
      expect(requirement(check, PublishRequirement.SECOND_CONTACT).met).toBe(true);
      expect(check.publishable).toBe(true);
    });
    it('is not asked without the facts', () => {
      const check = evaluatePublishGate(base);
      expect(check.requirements.map((r) => r.requirement)).not.toContain(
        PublishRequirement.SECOND_CONTACT,
      );
    });
  });

  describe('SIGNATURE_PROVIDER_CHECKED', () => {
    const base = {
      mappingVersion: 4,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_OK),
    };

    it('blocks a signature-only binding whose endpoint accepted a foreign-provider signature', () => {
      const check = evaluatePublishGate({
        ...base,
        authMode: BindingAuthMode.SIGNATURE,
        latestRun: {
          ...GREEN_RUN,
          authMode: BindingAuthMode.SIGNATURE,
          warnings: [BindingTestWarningCode.ACCEPTS_FOREIGN_PROVIDER],
        },
      });
      const row = requirement(check, PublishRequirement.SIGNATURE_PROVIDER_CHECKED);
      expect(row.met).toBe(false);
      expect(row.code).toBe('accepts_foreign_provider');
      expect(check.publishable).toBe(false);
    });

    it('is met when the endpoint refused it', () => {
      const check = evaluatePublishGate({
        ...base,
        authMode: BindingAuthMode.SIGNATURE,
        latestRun: { ...GREEN_RUN, authMode: BindingAuthMode.SIGNATURE, warnings: [] },
      });
      expect(requirement(check, PublishRequirement.SIGNATURE_PROVIDER_CHECKED).met).toBe(true);
      expect(check.publishable).toBe(true);
    });

    it('is unmet with no counted run', () => {
      const check = evaluatePublishGate({
        ...base,
        authMode: BindingAuthMode.SIGNATURE,
        latestRun: null,
      });
      expect(requirement(check, PublishRequirement.SIGNATURE_PROVIDER_CHECKED).met).toBe(false);
    });

    it.each([BindingAuthMode.BOTH, BindingAuthMode.API_KEY, BindingAuthMode.NONE])(
      'is not asked for %s: the API key, or nothing, is the lock there',
      (authMode) => {
        const check = evaluatePublishGate({
          ...base,
          authMode,
          latestRun: {
            ...GREEN_RUN,
            authMode,
            warnings: [BindingTestWarningCode.ACCEPTS_FOREIGN_PROVIDER],
          },
        });
        expect(check.requirements.map((r) => r.requirement)).not.toContain(
          PublishRequirement.SIGNATURE_PROVIDER_CHECKED,
        );
      },
    );
  });

  it('reports every requirement even when the first one fails', () => {
    const check = evaluatePublishGate({
      mappingVersion: 1,
      latestRun: null,
      payoutByChain: on(PAYOUT_OK),
      stakeByChain: on(STAKE_SHORT),
    });

    expect(check.requirements.map((entry) => entry.requirement)).toEqual([
      PublishRequirement.TESTER_RUN,
      PublishRequirement.TESTER_PASSED,
      PublishRequirement.PAYOUT_ACCOUNT,
      PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    ]);
  });

  it('reports the failing chain by name, and only that chain', () => {
    // Staked on one of two. *"STAKE_AT_MINIMUM: not met"* on a two-chain
    // binding is a refusal a provider cannot act on — they have two chains and
    // no way to know which one to fund.
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: new Map<ChainId, PayoutGateVerdict>([
        [CHAIN, PAYOUT_OK],
        [OTHER, PAYOUT_OK],
      ]),
      stakeByChain: new Map<ChainId, StakeGateVerdict>([
        [CHAIN, STAKE_OK],
        [OTHER, STAKE_SHORT],
      ]),
    });

    const stake = check.requirements.filter(
      (entry) => entry.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    );

    expect(check.publishable).toBe(false);
    expect(stake).toHaveLength(1);
    expect(stake[0].met).toBe(false);
    expect(stake[0].detail).toContain(OTHER);
    expect(stake[0].detail).not.toContain(`${CHAIN}:`);
  });

  it('one green chain does not carry a red one', () => {
    // The `some`/`every` mistake, stated as a case: a gate that ticked the
    // requirement because *a* chain passed would publish a binding that cannot
    // route on half its declared supply, and the console would say every
    // requirement is met.
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: new Map<ChainId, PayoutGateVerdict>([
        [CHAIN, PAYOUT_OK],
        [OTHER, PAYOUT_MISSING],
      ]),
      stakeByChain: new Map<ChainId, StakeGateVerdict>([
        [CHAIN, STAKE_OK],
        [OTHER, STAKE_OK],
      ]),
    });

    expect(check.publishable).toBe(false);
    expect(unmetRequirements(check).map((entry) => entry.requirement)).toEqual([
      PublishRequirement.PAYOUT_ACCOUNT,
    ]);
  });

  it('a binding offered on no chain is unmet, not vacuously met', () => {
    // `[].every(...)` is `true`. A gate that folded the per-chain verdicts with
    // it would tick both money requirements for a binding nothing can route —
    // and the checklist would say so on a screen a provider acts on. The row's
    // own CHECK forbids the empty list; this is the belt to that braces.
    const check = evaluatePublishGate({
      mappingVersion: 4,
      latestRun: GREEN_RUN,
      payoutByChain: new Map(),
      stakeByChain: new Map(),
    });

    expect(check.publishable).toBe(false);
    expect(unmetRequirements(check).map((entry) => entry.requirement)).toEqual([
      PublishRequirement.PAYOUT_ACCOUNT,
      PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    ]);
  });
});
