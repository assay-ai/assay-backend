import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { StakeGraceResolution } from '@modules/provider/constants/stake-monitor.constants';
import { PricingMode } from '@modules/tool/ports/tool.types';

import {
  ACCOUNT_A,
  ASSET,
  BINDING_A,
  PROVIDER_A,
  binding,
  harness,
  openGraceRow,
  provider,
  stakeMap,
} from './helpers/stake-monitor-harness';

/**
 * **The grace clock is timed against the PUBLISHED terms, not the draft.**
 *
 * The binding editor writes an unpublished price, pricing mode or asset onto
 * the `tool_bindings` row and leaves `published_version` behind; the router
 * keeps serving the published `binding_versions` snapshot until the provider
 * publishes again. The monitor used to read the row, so saving a draft price
 * moved the floor — opening or curing a grace countdown — for terms no call
 * was being served at. These pin it to the served revision.
 *
 * Floor: `max($50, 1000 × price)`. $0.05 → $50, $0.10 → $100.
 */
describe('StakeMonitorService — the requirement is the published revision’s', () => {
  /** A live binding at revision 1 with an unpublished revision 2 saved on the row. */
  function drafted(
    draft: { priceAmount: string; pricingMode?: PricingMode },
    published: { priceAmount: string; pricingMode?: PricingMode },
  ): { row: ToolBindingEntity; snapshot: BindingVersionEntity } {
    const row = {
      ...binding(BINDING_A, PROVIDER_A, draft.priceAmount, draft.pricingMode),
      mappingVersion: 2,
      publishedVersion: 1,
    } as unknown as ToolBindingEntity;
    const snapshot = {
      organizationId: PROVIDER_A,
      bindingId: BINDING_A,
      mappingVersion: 1,
      endpoint: 'https://provider.example.com/api',
      requestMapping: {},
      responseMapping: {},
      pricingMode: published.pricingMode ?? PricingMode.PAID,
      priceAmount: published.priceAmount,
      assetId: ASSET,
      timeoutMs: 5_000,
    } as unknown as BindingVersionEntity;
    return { row, snapshot };
  }

  it('a draft price RAISE does not open a grace row until it is published', async () => {
    // Published at $0.05 ($50 floor), draft at $0.10 ($100 floor), $60 staked:
    // above the served floor, below the draft's.
    const { row, snapshot } = drafted({ priceAmount: '100000' }, { priceAmount: '50000' });
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [snapshot],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
    // One batched snapshot lookup for the sweep, not one per binding.
    expect(h.versions.find).toHaveBeenCalledTimes(1);
  });

  it('the same price opens the grace row once it IS the published revision', async () => {
    const published = {
      ...binding(BINDING_A, PROVIDER_A, '100000'),
      mappingVersion: 2,
      publishedVersion: 2,
    } as unknown as ToolBindingEntity;
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [published],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const inserted = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    expect(inserted.requiredAmount).toBe('100000000');
    // Nothing drifted, so nothing to look up.
    expect(h.versions.find).not.toHaveBeenCalled();
  });

  it('a draft price CUT neither cures an open row nor shrinks the requirement', async () => {
    // Published at $0.10 ($100 floor), draft at $0.05 ($50 floor), $60 staked.
    const { row, snapshot } = drafted({ priceAmount: '50000' }, { priceAmount: '100000' });
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [snapshot],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
      graceRows: [openGraceRow()],
    });

    await h.service.sweep();

    expect(h.grace.update).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: StakeGraceResolution.CURED }),
    );
    expect(h.grace.insert).not.toHaveBeenCalled();
  });

  it('a draft price CUT does not stop a new grace row opening at the served floor', async () => {
    const { row, snapshot } = drafted({ priceAmount: '50000' }, { priceAmount: '100000' });
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [snapshot],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const inserted = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    expect(inserted.requiredAmount).toBe('100000000');
  });

  it('a draft that makes a published PAID binding FREE keeps it watched', async () => {
    const { row, snapshot } = drafted(
      { priceAmount: '0', pricingMode: PricingMode.FREE },
      { priceAmount: '100000' },
    );
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [snapshot],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const inserted = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    expect(inserted.requiredAmount).toBe('100000000');
  });

  it('a draft that makes a published FREE binding paid does not start watching it', async () => {
    const { row, snapshot } = drafted(
      { priceAmount: '100000' },
      { priceAmount: '0', pricingMode: PricingMode.FREE },
    );
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [snapshot],
      stakes: stakeMap([[PROVIDER_A, '10000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
  });

  it('a drifted binding whose published snapshot is missing is not watched', async () => {
    // `toServedToolBindings` fails closed to DRAFT, so the router serves no
    // paid traffic on it and there is nothing for grace to protect.
    const { row } = drafted({ priceAmount: '100000' }, { priceAmount: '50000' });
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [row],
      versions: [],
      stakes: stakeMap([[PROVIDER_A, '10000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
  });
});
