import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  STAKE_GRACE_PERIOD_MS,
  StakeGraceResolution,
} from '@modules/provider/constants/stake-monitor.constants';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  ACCOUNT_A,
  ASSET,
  BINDING_A,
  CHAIN,
  NOW,
  PROVIDER_A,
  binding,
  harness,
  openGraceRow,
  provider,
  stakeMap,
  usdc,
  FakeBandStore,
} from './helpers/stake-monitor-harness';

/**
 * The stake monitor, which since the contract simplification does one job off
 * a 5-minute tick: opening and resolving grace rows. The second job asserted a provider's
 * unsettled exposure on chain with `record_exposure`, and the program no longer
 * has that instruction or the field it wrote.
 *
 * The wiring lives in `./helpers/stake-monitor-harness`, shared with the other
 * suites over this service so that none of them can drift into proving its
 * behaviour against a differently-built monitor.
 */

describe('StakeMonitorService — grace periods', () => {
  it('opens a grace row when a binding first falls below its floor', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const row = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    expect(row.organizationId).toBe(PROVIDER_A);
    expect(row.bindingId).toBe(BINDING_A);
    expect(row.requiredAmount).toBe('50000000');
    expect(row.observedAmount).toBe('40000000');
    expect(row.assetId).toBe(ASSET);
    expect(row.startedAt).toEqual(NOW);
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + STAKE_GRACE_PERIOD_MS));
    expect(row.resolvedAt).toBeNull();
    expect(row.resolution).toBeNull();
  });

  it('does NOT restart the clock while a row is already open', async () => {
    // Without this, a provider oscillating around the threshold has grace
    // forever. The partial unique index makes a second OPEN row impossible, so
    // the job must not try — and must not treat the rejection as an error.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
      graceRows: [openGraceRow()],
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
    expect(h.grace.update).not.toHaveBeenCalled();
  });

  it('resolves the row as CURED when stake comes back above', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '80000000']]),
      graceRows: [openGraceRow()],
    });

    await h.service.sweep();

    expect(h.grace.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = h.grace.update.mock.calls[0] as [
      Record<string, unknown>,
      Partial<ProviderStakeGraceEntity>,
    ];
    expect(criteria).toEqual({ organizationId: PROVIDER_A, id: 'grace-1' });
    expect(patch.resolution).toBe(StakeGraceResolution.CURED);
    expect(patch.resolvedAt).toEqual(NOW);
    expect(h.grace.insert).not.toHaveBeenCalled();
  });

  it('resolves the row as EXPIRED when the deadline passes with no top-up', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
      graceRows: [openGraceRow({ expiresAt: new Date(NOW.getTime() - 1000) })],
    });

    await h.service.sweep();

    const [, patch] = h.grace.update.mock.calls[0] as [
      Record<string, unknown>,
      Partial<ProviderStakeGraceEntity>,
    ];
    expect(patch.resolution).toBe(StakeGraceResolution.EXPIRED);
    expect(patch.resolvedAt).toEqual(NOW);
    // The clock does not restart: an expired period is closed, not reopened.
    expect(h.grace.insert).not.toHaveBeenCalled();
  });

  it('warns at headroom < 20% while still ABOVE the floor', async () => {
    // This is "warn when about to hit the floor".
    // Without it the first thing a provider hears is that they are already below.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      // $55 against a $50 floor — 10% headroom.
      stakes: stakeMap([[PROVIDER_A, '55000000']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
    expect(h.alerts.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: AlertSeverity.INFO,
        name: 'provider_stake_headroom_low',
        details: expect.objectContaining({ bindingId: BINDING_A, providerId: PROVIDER_A }),
      }),
    );
  });

  it('tells the provider the headroom in dollars, by tool, once per incident', async () => {
    const TOOL = '06399979-f8b8-4c9e-a9b1-bd2a5924d442';
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [Object.assign(binding(BINDING_A, PROVIDER_A, '50000'), { toolId: TOOL })],
      // $55.955 against a $50 floor.
      stakes: stakeMap([[PROVIDER_A, '55955000']]),
      toolNames: new Map([[TOOL, 'get_weather']]),
    });

    await h.service.sweep();

    const [request] = h.notifications.notify.mock.calls[0] as [Record<string, unknown>];
    expect(request.event).toBe('provider.stake_headroom_low');
    expect(request.title).toBe(
      'get_weather: your stake ($55.95) is within $10.00 of the $50.00 minimum',
    );
    expect(request.body).toBe(
      'Below the minimum, paid calls continue for 7 days; after that get_weather stops taking ' +
        'paid calls until you add stake. A penalty can take you below it. Add stake to keep a margin.',
    );
    for (const text of [request.title, request.body] as string[]) {
      expect(text).not.toContain(BINDING_A);
      expect(text).not.toMatch(/\d\.\d{6}/);
      expect(text).not.toMatch(/binding|floor|grace/i);
    }
    // The incident is the figures: the same stake and minimum tomorrow is not a new one.
    // No band store wired here: the UTC day stands in for the incident.
    expect(request.dedupeKey).toBe(
      `${BINDING_A}:${NOW.toISOString().slice(0, 10)}:55955000:50000000`,
    );
    expect(request.payload).toMatchObject({
      toolName: 'get_weather',
      decimals: 6,
      margin: '10000000',
    });
  });

  it('re-notifies headroom per incident: same figures once, changed figures or a new stay again', async () => {
    const store = new FakeBandStore();
    const sweep = async (stake: string, now: Date) => {
      const h = harness({
        providers: [provider(PROVIDER_A, ACCOUNT_A)],
        bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
        stakes: stakeMap([[PROVIDER_A, stake]]),
        redis: store,
        now,
      });
      await h.service.sweep();
      const call = h.notifications.notify.mock.calls.find(
        ([request]) => (request as { event: string }).event === 'provider.stake_headroom_low',
      );
      return call ? (call[0] as { dedupeKey: string }).dedupeKey : null;
    };
    const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

    const first = await sweep('55000000', NOW);
    // The same figures on the next day: the same key, so the catalogue's ONCE holds it.
    expect(await sweep('55000000', later(24))).toBe(first);
    // Different figures inside the same stay: a new notice.
    expect(await sweep('54000000', later(25))).not.toBe(first);
    // Leaves the band, then comes back to the very same figures: a new incident.
    expect(await sweep('100000000', later(26))).toBeNull();
    const again = await sweep('55000000', later(48));
    expect(again).not.toBe(first);
    expect(again).toBe(`${BINDING_A}:${later(48).toISOString()}:55000000:50000000`);

    // Below the minimum, then cured back into the band at the same figures: a new incident too.
    expect(await sweep('40000000', later(50))).toBeNull();
    const cured = await sweep('55000000', later(52));
    expect(cured).toBe(`${BINDING_A}:${later(52).toISOString()}:55000000:50000000`);
  });

  it('names a catalogue string id as the tool, as the case page does', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
    });

    await h.service.sweep();

    const [request] = h.notifications.notify.mock.calls[0] as [Record<string, unknown>];
    expect(request.title).toBe('search_web: your stake is below the $50.00 minimum');
    expect(request.payload).toMatchObject({ graceDays: 7 });
  });

  it('names no id when the tool cannot be read', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [
        Object.assign(binding(BINDING_A, PROVIDER_A, '50000'), {
          toolId: '0caf90d0-5710-412b-8e88-afc0f661004e',
        }),
      ],
      stakes: stakeMap([[PROVIDER_A, '40000000']]),
      toolNames: new Map(),
    });

    await h.service.sweep();

    const [request] = h.notifications.notify.mock.calls[0] as [Record<string, unknown>];
    expect(request.event).toBe('provider.stake_grace_opened');
    expect(request.title).toBe('One paid tool: your stake is below the $50.00 minimum');
    expect(request.body).not.toContain(BINDING_A);
    expect(request.body).toContain('Your stake ($40.00) is below the $50.00 minimum.');
  });

  it('does not warn while headroom is comfortable', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '100000000']]),
    });

    await h.service.sweep();

    expect(h.alerts.emit).not.toHaveBeenCalled();
  });

  it('opens nothing for a FREE binding', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '0', PricingMode.FREE)],
      stakes: stakeMap([[PROVIDER_A, '0']]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
    expect(h.alerts.emit).not.toHaveBeenCalled();
  });

  it('opens nothing for a binding exactly ON its floor', async () => {
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '50000000']]),
    });

    await h.service.sweep();

    // `>=` passes the gate, and the table's CHECK is strict
    // (`observed_amount < required_amount`) — a row here would be refused by
    // Postgres, which is the schema saying the same thing.
    expect(h.grace.insert).not.toHaveBeenCalled();
  });

  it('measures against the NEGOTIATED OVERRIDE, not the formula, when the provider has one', async () => {
    // The three-surfaces bug. `evaluateStakeGate` honours
    // `minimumStakeOverride` and so does `GET /providers/me/stake`; the monitor
    // did not, and computed `max(floor, 1000 × price)` regardless. A provider
    // on a negotiated $25 floor holding $30 was therefore routable, shown
    // `minimum: $25.00 / shortfall: $0` on the Capital screen, and counted down
    // for seven days by this job against a $50 floor nothing enforced.
    //
    // $30 staked, $25 negotiated, $50 computed. Nothing is opened.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '30000000']]),
      overrides: new Map([[PROVIDER_A, usdc('25000000')]]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
    // Read from the same port the gate reads, for the same provider set.
    expect(h.registry.findRoutingStates).toHaveBeenCalledWith([PROVIDER_A]);
  });

  it('opens a row against the override when the override is the number they are under', async () => {
    // The other direction: an override ABOVE the computed floor. $60 staked
    // clears `max(floor 50, 1000 × 0.05) = 50`, so the formula says nothing is
    // wrong — while the number the platform actually agreed is $100, and the
    // gate has already stopped routing this binding.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '60000000']]),
      overrides: new Map([[PROVIDER_A, usdc('100000000')]]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const row = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    // Frozen at the override, so the "exact amount needed" shown beside the
    // countdown is $40 and not the $-10 the formula would have implied.
    expect(row.requiredAmount).toBe('100000000');
    expect(row.observedAmount).toBe('60000000');
  });

  it('resolves an open row as CURED against the override rather than the formula', async () => {
    // $30 staked against a $25 override: cured. Against the $50 formula it
    // would still be a shortfall, and the row would sit open until it expired
    // and cut a binding the router was happily serving.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: stakeMap([[PROVIDER_A, '30000000']]),
      overrides: new Map([[PROVIDER_A, usdc('25000000')]]),
      graceRows: [openGraceRow()],
    });

    await h.service.sweep();

    const [, patch] = h.grace.update.mock.calls[0] as [
      Record<string, unknown>,
      Partial<ProviderStakeGraceEntity>,
    ];
    expect(patch.resolution).toBe(StakeGraceResolution.CURED);
  });

  it('opens nothing when the stake reading is missing', async () => {
    // `STAKE_UNKNOWN` is not a shortfall. `applyStakeGrace` refuses to carry it
    // and so must the writer, or a grace row would be opened on a number
    // nobody has.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000')],
      stakes: new Map(),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
  });
});

/**
 * Which chain the GRACE CLOCK counts against.
 *
 * **Site 4 of 5, expression 2 of 2** in the settlement-chain enumeration in
 * `tool/domain/routing/eligibility.ts` — the expression that comment calls *"the
 * one that decides whether a binding's paid traffic is collateral-backed"*.
 * `stake-monitor-snapshot.spec.ts` pins the KEYS the sweep asks for; this pins
 * the reading the clock actually reads, which is the half that was open.
 *
 * ## Why this reaches the clock without a second stake floor
 *
 * `requirementFor` returns the provider's `minimumStakeOverride` **before** the
 * floor-asset test, exactly as `evaluateStakeGate` does — a negotiated floor is
 * a number the platform agreed outright, so it needs no price and no
 * conversion. So a binding priced on a second chain, plus an override
 * denominated in that same chain's asset, produces `required.asset ===
 * staked.asset` and the clock runs. No second `PROVIDER_MINIMUM_STAKE_FLOOR`
 * is involved.
 *
 * ## Where the line is, precisely
 *
 * What stays deferred is the **derived**-requirement path: a binding on a second
 * chain with no override returns `null` from `requirementFor` (the floor-asset
 * test) and is skipped before the clock, so exercising it needs a second floor —
 * which no configuration can supply while `loadMinimumStakeParameters` reads one
 * `PLATFORM_STAKE_ASSET_ID`. And because the override is per PROVIDER, it can
 * denominate only one asset, so *"one provider, two bindings, two clocks, two
 * chains"* is also still blocked. Neither is covered here.
 */
describe('StakeMonitorService — the grace clock reads THIS binding’s chain', () => {
  const OTHER_ASSET = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;
  const OTHER_CHAIN = chainIdOf(OTHER_ASSET);

  /** A `Money` on the second chain — `usdc()` builds on the floor's chain. */
  function otherChainMoney(atomic: string): Money {
    return MoneyUtil.of(atomic, OTHER_ASSET, 6);
  }

  it('opens a row off the second chain’s reading when that is where the binding settles', async () => {
    // One binding, priced on the second chain. The provider is short THERE:
    // $40 staked against a $100 negotiated floor denominated in the same asset.
    // A monitor reading the FLOOR's chain finds no reading for this provider at
    // all, treats it as `STAKE_UNKNOWN`, and opens nothing — so the provider
    // whose collateral has actually fallen keeps taking paid traffic with no
    // countdown running and no notification sent.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000', PricingMode.PAID, OTHER_ASSET)],
      stakes: new Map([
        [
          stakeKey(PROVIDER_A, OTHER_CHAIN),
          {
            providerId: PROVIDER_A,
            chainId: OTHER_CHAIN,
            staked: otherChainMoney('40000000'),
            observedAt: NOW,
          },
        ],
      ]),
      overrides: new Map([[PROVIDER_A, otherChainMoney('100000000')]]),
    });

    await h.service.sweep();

    expect(h.grace.insert).toHaveBeenCalledTimes(1);
    const row = h.grace.insert.mock.calls[0][0] as Partial<ProviderStakeGraceEntity>;
    // The row records the SECOND chain's numbers and asset, not the floor's —
    // the provider is shown "the exact amount needed" beside the countdown, and a row
    // frozen against the wrong chain's collateral would quote a figure the
    // provider cannot act on.
    expect(row.observedAmount).toBe('40000000');
    expect(row.requiredAmount).toBe('100000000');
    expect(row.assetId).toBe(OTHER_ASSET);
  });

  it('opens nothing when the provider is above their floor on the binding’s own chain', async () => {
    // The other direction, and worth being precise about what it does and does
    // not catch. The provider is comfortably above their override ON THE SECOND
    // CHAIN — where the binding settles — and holds almost nothing on the
    // floor's chain. Nothing opens, which is the correct answer.
    //
    // It does NOT, on its own, catch a monitor reading the floor's chain: that
    // monitor finds a devnet-denominated reading against a mainnet-denominated
    // requirement, the asset test in `reviewGrace` refuses the pair, and it
    // also opens nothing. The case above is what kills that degenerate. This
    // one exists so "no row opened" is asserted for a provider who is genuinely
    // fine, rather than only for one the monitor could not see.
    const h = harness({
      providers: [provider(PROVIDER_A, ACCOUNT_A)],
      bindings: [binding(BINDING_A, PROVIDER_A, '50000', PricingMode.PAID, OTHER_ASSET)],
      stakes: new Map([
        [
          stakeKey(PROVIDER_A, OTHER_CHAIN),
          {
            providerId: PROVIDER_A,
            chainId: OTHER_CHAIN,
            staked: otherChainMoney('500000000'),
            observedAt: NOW,
          },
        ],
        [
          stakeKey(PROVIDER_A, CHAIN),
          {
            providerId: PROVIDER_A,
            chainId: CHAIN,
            staked: usdc('1'),
            observedAt: NOW,
          },
        ],
      ]),
      overrides: new Map([[PROVIDER_A, otherChainMoney('100000000')]]),
    });

    await h.service.sweep();

    expect(h.grace.insert).not.toHaveBeenCalled();
  });
});
