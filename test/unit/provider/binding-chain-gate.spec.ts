import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ChainEnrolmentStatus } from '@modules/provider/ports/chain-enrolment.port';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { AppError } from '@shared/errors/app-errors';

import { buildBindingEditorHarness } from './helpers/binding-editor-harness';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const PROVIDER = 'p1';

/**
 * The write-time half of the routability invariant.
 *
 * Enabling a chain on a binding requires an enrolment with sufficient stake,
 * checked at write time. Refuse with a named error; do not accept and quietly
 * not route.
 *
 * The last clause is what these tests are about. Accepting the write and
 * letting the router silently drop the chain produces a provider staring at a
 * console that says their tool is offered on two chains while their traffic
 * says otherwise, with nothing anywhere naming the reason.
 */
describe('binding settlementChains write gate', () => {
  const failure = async (fn: () => Promise<unknown>): Promise<AppError> => {
    try {
      await fn();
    } catch (error) {
      return error as AppError;
    }
    throw new Error('expected a refusal');
  };

  const codeOf = async (fn: () => Promise<unknown>): Promise<string> =>
    (await failure(fn)).errorCode;

  it('accepts a chain the provider is enrolled on and staked for', async () => {
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET, MAINNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    const saved = await harness.editor.create(PROVIDER, 'cred', {
      ...harness.validBody,
      settlementChains: [DEVNET],
    });

    expect(saved.settlementChains).toEqual([DEVNET]);
  });

  it('refuses a chain with no enrolment, naming the chain', async () => {
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET, MAINNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    const error = await failure(() =>
      harness.editor.create(PROVIDER, 'cred', {
        ...harness.validBody,
        settlementChains: [DEVNET, MAINNET],
      }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED);
    // The chain, not just the code. A refusal that does not say WHICH of the
    // two chains is one a provider cannot act on, and a gate that named the
    // first chain in the list rather than the failing one would pass on the
    // code alone.
    expect(error.message).toContain(MAINNET);
    expect(error.message).not.toContain(DEVNET);
    // Nothing was written. A gate that refused after the insert leaves a row
    // behind offering a chain the provider is not on.
    expect(harness.rows).toHaveLength(0);
  });

  it('refuses a chain the provider is enrolled on but under-staked for', async () => {
    // Enrolment and stake are different facts (decision (a)): the row exists
    // before the money. A gate that checked only the enrolment would let this
    // through, and the router would then drop the chain with nothing said.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET, MAINNET],
      enrolments: [
        { providerId: PROVIDER, chainId: DEVNET },
        { providerId: PROVIDER, chainId: MAINNET },
      ],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000', [`${PROVIDER}|${MAINNET}`]: '1' },
    });

    const error = await failure(() =>
      harness.editor.create(PROVIDER, 'cred', {
        ...harness.validBody,
        settlementChains: [DEVNET, MAINNET],
      }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM);
    expect(error.message).toContain(MAINNET);
    // **The shortfall specifically**, and not `STAKE_UNKNOWN` or
    // `STAKE_ASSET_MISMATCH`, which raise this same error code and would let
    // the case go green on a gate that never compared two numbers. The detail
    // is `evaluateStakeGate`'s own — `staked 0.000001 USDC, minimum 50.00 USDC`.
    expect(error.message).toContain('staked');
    expect(error.message).toContain('minimum');
  });

  it('refuses an enrolment that exists and is not ACTIVE', async () => {
    // A closed enrolment is a chain the platform has withdrawn the provider
    // from. Nothing in this codebase reopens one, so accepting the write would
    // publish a chain that can never route — see `PAYOUT_ENROLMENT_NOT_ACTIVE`.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [
        { providerId: PROVIDER, chainId: DEVNET, status: ChainEnrolmentStatus.SUSPENDED },
      ],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          settlementChains: [DEVNET],
        }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED);
  });

  it("refuses another provider's enrolment as if it were absent", async () => {
    // The key is `${providerId}|${chainId}`, and a gate that keyed on the chain
    // alone would read a stranger's enrolment as this provider's. Every other
    // case here uses one provider, so nothing else can catch it.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: 'someone-else', chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          settlementChains: [DEVNET],
        }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED);
  });

  it('refuses a chain this deployment does not offer', async () => {
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          settlementChains: ['eip155:46630' as ChainId],
        }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENABLED);
  });

  it('reports the not-enabled chain ahead of a missing enrolment on it', async () => {
    // Both are true of `eip155:46630` here. The gate's order reports the
    // condition the provider CANNOT fix first: telling them to enrol on a chain
    // this deployment does not serve sends them somewhere that cannot help.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          settlementChains: [DEVNET, 'eip155:46630' as ChainId],
        }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENABLED);
  });

  it('applies the same gate on update, not only on create', async () => {
    // The hole a create-only gate leaves: publish on one chain, then PATCH a
    // second one in. `update()` goes through a different method and the gate
    // has to be on both.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET, MAINNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });
    const saved = await harness.editor.create(PROVIDER, 'cred', {
      ...harness.validBody,
      settlementChains: [DEVNET],
    });

    expect(
      await codeOf(() =>
        harness.editor.update(PROVIDER, 'cred', saved.id, { settlementChains: [DEVNET, MAINNET] }),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED);
  });

  it('leaves an unrelated PATCH alone when the stake has since fallen away', async () => {
    // The other half of the `update()` rule, and the one a gate that simply ran
    // on every PATCH would break: a provider whose collateral dipped must still
    // be able to fix a typo in their endpoint. Noticing the shortfall is the
    // router's job, on every call — not the editor's, at a moment the provider
    // did not ask about money.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '1000000000' },
    });
    const saved = await harness.editor.create(PROVIDER, 'cred', {
      ...harness.validBody,
      settlementChains: [DEVNET],
    });

    // The stake is gone, and the body says nothing about chains.
    const broke = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: {},
    });
    broke.rows.push(harness.rows[0]);

    const updated = await broke.editor.update(PROVIDER, 'cred', saved.id, {
      endpoint: 'https://provider.example.com/v2',
    });

    expect(updated.endpoint).toBe('https://provider.example.com/v2');
  });

  it('a FREE binding still needs the enrolment, and does not need the stake', async () => {
    // Mirrors evaluateStakeGate and evaluatePayoutGate: nothing settles on a
    // FREE binding so there is no collateral to require, but there is still a
    // chain the call is nominally offered on, and enrolling on it is what makes
    // that chain meaningful.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: {},
    });

    const saved = await harness.editor.create(PROVIDER, 'cred', {
      ...harness.validBody,
      pricingMode: 'FREE',
      priceAmount: '0',
      settlementChains: [DEVNET],
    } as never);

    expect(saved.settlementChains).toEqual([DEVNET]);
  });

  it('a FREE binding with no enrolment is still refused', async () => {
    // The half the case above cannot make: an exemption written as "FREE skips
    // the whole gate" passes it and fails here.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET, MAINNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: {},
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          pricingMode: 'FREE',
          priceAmount: '0',
          settlementChains: [MAINNET],
        } as never),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_NOT_ENROLLED);
  });

  it('a FREEMIUM binding is NOT exempt from the stake half', async () => {
    // `evaluateStakeGate` gates FREEMIUM like PAID because the quota has not
    // been checked at selection time. A gate that spelled its exemption
    // `!== PricingMode.PAID` would let an unbonded provider offer a chain that
    // charges.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: {},
    });

    expect(
      await codeOf(() =>
        harness.editor.create(PROVIDER, 'cred', {
          ...harness.validBody,
          pricingMode: 'FREEMIUM',
          settlementChains: [DEVNET],
        } as never),
      ),
    ).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM);
  });

  it('scales the floor with the price, rather than comparing against a flat $50', async () => {
    // $1.00 a call at `priceMultiple: 1000` needs $1,000 behind it, not $50.
    // Every other case here is priced at $0.05, where `max(floor, 1000 × price)`
    // is exactly the floor — so a gate that compared against the floor alone,
    // or hardcoded 50000000, passes all of them. This provider holds $100:
    // comfortably over the floor and nowhere near the requirement.
    //
    // What it pins is that the editor runs `evaluateStakeGate`, the router's
    // own function, rather than a second copy of the rule. A copy would drift,
    // and the drift shows up as a binding that publishes and does not route.
    const harness = buildBindingEditorHarness({
      enabledChains: [DEVNET],
      enrolments: [{ providerId: PROVIDER, chainId: DEVNET }],
      stakes: { [`${PROVIDER}|${DEVNET}`]: '100000000' },
    });

    const error = await failure(() =>
      harness.editor.create(PROVIDER, 'cred', {
        ...harness.validBody,
        priceAmount: '1000000',
        settlementChains: [DEVNET],
      }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM);
    expect(error.message).toContain('1000.00');
  });
});
