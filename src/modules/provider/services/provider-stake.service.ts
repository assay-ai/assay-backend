import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsNull } from 'typeorm';

import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { chainMetadata } from '@modules/chains/chain-metadata';
import { ENABLED_CHAINS_ENV } from '@modules/chains/enabled-chains';
import { platformAssetFrom } from '@modules/chains/platform-asset';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { minimumStakeFor } from '@modules/tool/domain/routing/stake-gate';
import {
  MinimumStakeByChain,
  MinimumStakeParameters,
} from '@modules/tool/domain/routing/routing.types';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode, ToolBinding } from '@modules/tool/ports/tool.types';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { MoneyUtil } from '@shared/utils/money.util';

import { ProviderErrors } from '../errors/provider.errors';
import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolment,
  ChainEnrolmentPort,
} from '../ports/chain-enrolment.port';
import {
  GetProviderStakeResponseDto,
  ProviderStakeGraceDto,
  ProviderStakeRequirementItemDto,
  STAKE_REQUIREMENT_RULE,
} from '../dto/get-provider-stake.dto';
import {
  ONCHAIN_STAKE_READER,
  OnChainStake,
  OnChainStakeReaderPort,
} from '../ports/onchain-stake-reader.port';
import { PROVIDER_REGISTRY, ProviderRegistryPort } from '../ports/provider-registry.port';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';
import { PROVIDER_STAKE_SOURCE_MODE_ENV } from './composite-provider-stake.source';

/** DI token — see the class comment for why this duplicates `ToolModule`'s `ROUTER_CONFIG`. */
export const PROVIDER_MINIMUM_STAKE_PARAMETERS = 'PROVIDER_MINIMUM_STAKE_PARAMETERS';

/** `1.5×`, as basis points. The recommended buffer. */
const RECOMMENDED_BUFFER_BPS = 15_000;

/**
 * The floor and the multiple, for **one** chain — the asset named by
 * `PLATFORM_STAKE_ASSET_ID`.
 *
 * Still single-chain, and now deliberately so rather than by omission.
 * {@link loadMinimumStakeByChain} below is the per-chain surface; this one survives
 * because three call sites genuinely want one chain's numbers and would be
 * lying if they took a map: `ProviderStakeService.getStake` (the Capital
 * screen, whose STAKE is now per chain but whose requirement half — `itemise`,
 * `requirementTotal`, the grace rows — is still single-floor),
 * `provider-terms.ts`, and the stake monitor's sweep.
 *
 * `decimals` now comes from the asset registry rather than a literal `6`. The
 * literal was correct for every asset this platform has registered and would
 * have silently mis-scaled an 18-decimal collateral asset by twelve orders of
 * magnitude — the kind of number that arrives as a routing gate that never
 * refuses anybody.
 */
export function loadMinimumStakeParameters(config: ConfigService): MinimumStakeParameters {
  // Not devnet USDC by default any more — see `platformAssetFrom`.
  const asset = platformAssetFrom(config);
  return {
    floor: MoneyUtil.of(
      config.get<string>('PROVIDER_MINIMUM_STAKE_FLOOR') ?? DEFAULT_MINIMUM_STAKE_FLOOR,
      asset,
      getAssetMetadata(asset).decimals,
    ),
    priceMultiple: Number(
      config.get<string>('PROVIDER_MINIMUM_STAKE_MULTIPLE') ?? DEFAULT_MINIMUM_STAKE_MULTIPLE,
    ),
  };
}

/** `$50`, the default minimum-stake floor. */
const DEFAULT_MINIMUM_STAKE_FLOOR = '50000000';
/** `1000×` the binding's price. */
const DEFAULT_MINIMUM_STAKE_MULTIPLE = '1000';

/** DI token — {@link loadMinimumStakeByChain}'s result, for the write-time chain gate. */
export const PROVIDER_MINIMUM_STAKE_BY_CHAIN = 'PROVIDER_MINIMUM_STAKE_BY_CHAIN';

/**
 * The floor **per enabled chain** — one entry per chain in
 * `ENABLED_CHAINS`, in that chain's own settlement asset.
 *
 * ## What this changes
 *
 * This function used to take a single {@link MinimumStakeParameters} and key it
 * under `chainIdOf(floor.asset)`, then assert that the one entry covered every
 * enabled chain. With two chains that assertion was **unsatisfiable by
 * construction**: no value of `PLATFORM_STAKE_ASSET_ID` names two chains, so the
 * boot refused whatever an operator did. The refusal was correct — a deployment
 * must not serve paid calls on a chain whose collateral it cannot price — and it
 * was the thing standing in front of the second chain; it is closed here.
 *
 * ## The floor's amount is one number; its asset is per chain
 *
 * `$50` is the floor on every chain — there is no discount on any of them,
 * because collateral on one chain is invisible to the settlement contract
 * of another — so `PROVIDER_MINIMUM_STAKE_FLOOR` stays a single value. What is
 * per chain is what that `$50` is *denominated in*, and that is **not a new
 * environment variable**: it is `chain-metadata.ts`'s declared
 * `settlementAsset`, which `assertChainMetadata` has already held to `USD-1:1`
 * at 6 decimals at boot in every process. So the derivation is total, needs no
 * operator input, and cannot disagree with the asset the escrow actually holds.
 *
 * Deriving it also means a chain with no metadata row — `eip155:4663`, whose
 * mainnet USDG address is unmeasured — has no floor and cannot acquire one by
 * configuration. That refusal is a deliverable rather than a gap.
 *
 * ## `PLATFORM_STAKE_ASSET_ID` is still checked
 *
 * Three other call sites read it, so it cannot simply stop mattering. If it is
 * set and names no enabled chain's settlement asset it is a stale value that
 * silently agrees with nothing, and this refuses at boot rather than letting the
 * Capital screen report one chain's floor beside another chain's stake.
 *
 * Fails at boot, where somebody is looking, rather than as a per-call
 * `STAKE_UNKNOWN` that reads like a chain outage.
 */
export function loadMinimumStakeByChain(
  config: ConfigService,
  enabled: readonly ChainId[],
): MinimumStakeByChain {
  if (enabled.length === 0) {
    throw ProviderErrors.minimumStakeUnconfigured({
      chains: 'none — ENABLED_CHAINS is empty',
      variable: ENABLED_CHAINS_ENV,
    });
  }

  const amount = config.get<string>('PROVIDER_MINIMUM_STAKE_FLOOR') ?? DEFAULT_MINIMUM_STAKE_FLOOR;
  const priceMultiple = Number(
    config.get<string>('PROVIDER_MINIMUM_STAKE_MULTIPLE') ?? DEFAULT_MINIMUM_STAKE_MULTIPLE,
  );

  const byChain = new Map<ChainId, MinimumStakeParameters>();
  for (const chainId of enabled) {
    // Throws `CHAIN_UNSUPPORTED` for a chain with no row. `assertChainMetadata`
    // has already refused those at boot in every process that has an
    // `ENABLED_CHAINS` provider, so this is reachable only from a direct call —
    // and it is still the honest answer rather than a floor invented for a
    // chain nobody described.
    const asset = chainMetadata(chainId).settlementAsset;
    byChain.set(chainId, {
      floor: MoneyUtil.of(amount, asset, getAssetMetadata(asset).decimals),
      priceMultiple,
    });
  }

  const declared = config.get<string>('PLATFORM_STAKE_ASSET_ID');
  if (declared && !enabled.some((chainId) => chainMetadata(chainId).settlementAsset === declared)) {
    throw ProviderErrors.minimumStakeUnconfigured({
      chains: enabled.join(', '),
      variable: 'PLATFORM_STAKE_ASSET_ID',
    });
  }

  return byChain;
}

/**
 * `GET /providers/me/stake` — the data behind the provider's Capital screen.
 *
 * ## Four sources, and only one of them can fail the request
 *
 * ```text
 * PROVIDER_STAKE_SOURCE      staked, observedAt          composite, never throws
 * TOOL_CATALOGUE + registry  the requirement, itemised   database
 * provider_stake_grace       a countdown per binding     database
 * ONCHAIN_STAKE_READER       unbonding, exposed          RPC, THROWS
 * ```
 *
 * The last one is caught. **The Capital screen does not 500 when the RPC is
 * down**, and that is a decision rather than an accident:
 *
 * - A provider opening this screen during a chain incident is *precisely* the
 *   provider who needs an answer. The question they came to ask — "am I above
 *   my floor, is my traffic still flowing, how long is left on my grace
 *   period" — is answered entirely out of Postgres. Throwing away all of it
 *   because one RPC of four is unreachable trades an answer for nothing.
 * - This endpoint **takes no money decision**. "Fail closed" is the right rule
 *   for `evaluateStakeGate`, which decides whether to route a paid call on
 *   someone's collateral, and that gate is untouched here and still fails
 *   closed. A read-only report failing closed does not protect anybody; it
 *   just stops answering.
 * - The unknown stays visible. `chainReadable: false` with the chain-derived
 *   fields `null` is the same "absent is not zero" discipline `hasKnownStake`
 *   already applies to `staked` — the screen can render *unknown*, and cannot
 *   accidentally render `$0.00 exposed` on an outage, which is the one wrong
 *   answer that would actually mislead.
 *
 * ## The requirement is `max`, and the payload says so
 *
 * `requirementRule` is the constant `STAKE_REQUIREMENT_RULE`, which carries the
 * full argument against `sum`. The short version
 * is that the gate is evaluated per binding by `evaluateStakeGate`, so `max` is
 * what the platform actually enforces, and the rule must be *named on screen*.
 *
 * `minimumStakeFor` is imported from `tool/domain/routing/stake-gate.ts`
 * (read-only — that module is not ours to edit) rather than re-derived, so this
 * endpoint and the router's actual gate can never disagree about the floor.
 *
 * ## Grace is per binding, and so is this payload
 *
 * A direct consequence of `max`: the requirement differs per binding, so a
 * provider can hold three open grace periods with three different deadlines at
 * once. `provider_stake_grace` is keyed on `binding_id` for that reason and
 * this response follows it. `graceSummary` exists to draw a banner and is
 * explicitly not the source of truth.
 *
 * **Divergence, left deliberately duplicated rather than fixed here**:
 * `ToolModule` builds the identical `{ floor, priceMultiple }` value as
 * `ROUTER_CONFIG`, but does not export that token, and this module may not
 * edit `ToolModule`. `loadMinimumStakeParameters` reads the same two env vars
 * independently. `ToolModule` exporting `ROUTER_CONFIG` (or a parameters-only
 * subset of it) would let this collapse to one provider; noted here rather
 * than worked around with a second source of truth for the numbers.
 */
@Injectable()
export class ProviderStakeService {
  private readonly logger = new Logger(ProviderStakeService.name);

  constructor(
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @Inject(ONCHAIN_STAKE_READER) private readonly onChain: OnChainStakeReaderPort,
    private readonly grace: ProviderStakeGraceRepository,
    @Inject(PROVIDER_MINIMUM_STAKE_PARAMETERS) private readonly parameters: MinimumStakeParameters,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
  ) {}

  async getStake(providerId: string): Promise<GetProviderStakeResponseDto> {
    const now = new Date();

    // The chain the REQUIREMENT is about. It is the floor's own chain,
    // and that is not a shortcut: `itemise` refuses a binding whose `assetId`
    // is not the floor's asset and `requirementTotal` is a `max` over those, so
    // `headroom` and `shortfall` can only ever be about this one chain.
    //
    // What is no longer true is that the whole SCREEN is about it. The stake
    // itself is now reported per chain — see {@link chainsToReport} — because a
    // provider serving two chains must stake on both and only one of those
    // numbers was ever visible here.
    const floorChain = chainIdOf(this.parameters.floor.asset);

    const [stateMap, bindings, graceRows, enrolments] = await Promise.all([
      this.registry.findRoutingStates([providerId]),
      this.findStakedBindings(providerId),
      // Scoped, and open rows only. A row past its deadline that the monitor
      // has not swept yet is still open and still returned — see
      // `ProviderStakeGraceDto.expired` for why that window matters.
      this.grace.find({ where: { organizationId: providerId, resolvedAt: IsNull() } }),
      this.enrolments.enrolmentsOf([providerId]),
    ]);

    // The stake authority is a column on the ENROLMENT since `1759300000003`,
    // one per chain — `providers.stake_authority` is gone, and with it the
    // possibility of reading one chain's account while reporting another's
    // floor. So the authority is resolved per chain, into the entry that names
    // that chain, and never lifted to the response.
    const authorities = chainsToReport(providerId, enrolments, floorChain);

    // Both waves are batched exactly as before: one `stakeOn` for every chain,
    // and one chain read PER CHAIN. The chain reads are deliberately not one
    // batched call — `readChain` catches, and a single batch would let one
    // network's outage set `chainReadable: false` on a chain that answered.
    const [stakeMap, chainReads] = await Promise.all([
      this.stakes.stakeOn([...authorities.keys()].map((chainId) => ({ providerId, chainId }))),
      this.readChains(authorities),
    ]);

    const override = stateMap.get(providerId)?.minimumStakeOverride;
    const graceByBinding = new Map(graceRows.map((row) => [row.bindingId, row]));

    const itemised = bindings.map((binding) =>
      this.itemise(binding, override, graceByBinding.get(binding.id), now),
    );
    const requirement = itemised.map((entry) => entry.item);
    // `max`, never `sum` — see `STAKE_REQUIREMENT_RULE`.
    const requirementTotal = itemised
      .map((entry) => entry.minimum)
      .filter((minimum): minimum is Money => minimum !== null)
      .reduce<Money | null>(
        (highest, next) => (!highest || MoneyUtil.greaterThan(next, highest) ? next : highest),
        null,
      );

    const stake = [...authorities.entries()].map(([chainId, stakeAuthority]) => {
      const reading = stakeMap.get(stakeKey(providerId, chainId));
      const chain = chainReads.get(chainId) ?? { stake: null, readable: true };
      this.warnIfTheChainSeesStakeTheSourceDoesNot(providerId, chainId, reading, chain.stake);

      return {
        chainId,
        hasKnownStake: reading !== undefined,
        staked: reading ? toMoneyDto(reading.staked) : null,
        observedAt: reading?.observedAt.toISOString() ?? null,

        unbonding: chain.stake ? toMoneyDto(chain.stake.unbonding) : null,
        unbondingStartedAt: chain.stake?.unbondingStartedAt?.toISOString() ?? null,
        unbondingCompletesAt: chain.stake?.unbondingCompletesAt?.toISOString() ?? null,
        chainReadable: chain.readable,

        stakeAuthority,
      };
    });

    // The floor's chain, for the figures denominated in the floor's asset.
    // Looked up by chain id, never by a position in the list: `stake[0]` is
    // whichever chain id sorts first, and `eip155:*` sorts ahead of
    // `solana:*` — so on a two-chain deployment the first row is the one the
    // requirement is NOT about, and a headroom taken from it would be reported
    // to a provider whose paid traffic is about to stop.
    const onFloorChain = stakeMap.get(stakeKey(providerId, floorChain));

    return {
      stake,

      requirement,
      requirementRule: STAKE_REQUIREMENT_RULE,
      requirementTotal: requirementTotal ? toMoneyDto(requirementTotal) : null,
      // Independent of `requirementTotal`, deliberately — see the DTO. A
      // provider with a negotiated floor and no published binding has a
      // requirement of "nothing yet" and a negotiated floor of $500 at the same
      // time, and only this field can say the second.
      negotiatedMinimum: override ? toMoneyDto(override) : null,
      graceSummary: summariseGrace(requirement),

      ...this.gap(onFloorChain?.staked ?? null, requirementTotal),
      recommendedBuffer: requirementTotal
        ? toMoneyDto(MoneyUtil.multiplyByRate(requirementTotal, RECOMMENDED_BUFFER_BPS))
        : null,
    };
  }

  /**
   * The provider's ACTIVE bindings that require stake, ordered for the screen.
   *
   * Both filters match `StakeMonitorService.watchedBindings`, which is what the
   * stake monitor opens grace rows from, and both run on the binding **as
   * served** (`findBindings` maps each row to its published revision), exactly
   * as the monitor's do — so an unpublished draft price moves neither the
   * screen's requirement nor the monitor's. Every binding listed here
   * is one that could have a row, and every row can be attached to a listed
   * binding. A screen built off a wider set would show countdowns against
   * bindings the monitor never watches.
   *
   * Read through `TOOL_CATALOGUE` rather than the repository because the
   * catalogue is already this service's dependency and is the port the rest of
   * the provider API reads bindings through; the repository's own method is
   * cross-tenant, which this endpoint has no business being.
   */
  private async findStakedBindings(providerId: string): Promise<ToolBinding[]> {
    const tools = await this.catalogue.listTools();
    const perTool = await Promise.all(tools.map((tool) => this.catalogue.findBindings(tool.id)));

    return (
      perTool
        .flat()
        .filter((binding) => binding.providerId === providerId)
        .filter((binding) => binding.status === BindingStatus.ACTIVE)
        // `FREE` only. `FREEMIUM` requires stake exactly as `evaluateStakeGate`
        // requires it: the same binding serves both free and paid calls, and at
        // selection time nobody knows which this call will be.
        .filter((binding) => binding.pricingMode !== PricingMode.FREE)
        .sort((a, b) => a.toolId.localeCompare(b.toolId) || a.id.localeCompare(b.id))
    );
  }

  /**
   * One binding's row: its price, its own floor, how that floor was reached,
   * its countdown — plus the floor as `Money`, so the `max` never has to parse
   * its own output back out of the DTO.
   */
  private itemise(
    binding: ToolBinding,
    override: Money | undefined,
    graceRow: ProviderStakeGraceEntity | undefined,
    now: Date,
  ): { item: ProviderStakeRequirementItemDto; minimum: Money | null } {
    const grace = graceRow ? this.toGraceDto(graceRow, now) : null;
    const base = {
      bindingId: binding.id,
      toolId: binding.toolId,
      pricingMode: binding.pricingMode,
      grace,
    };

    // The price is a fact about the **binding**, and it is knowable whenever
    // the binding is denominated in the stake asset. It is therefore computed
    // before either short-circuit below, and only the *asset* can suppress it.
    //
    // A negotiated override changes what a binding **requires**, not what it
    // **charges**, and the Capital screen prints those in two different columns. Deriving
    // `price` inside the override branch — as this originally did — blanked the
    // price column for every binding of an override provider, including
    // same-asset bindings whose price is perfectly knowable, for a reason
    // (no scale to render in) that only ever applied to `minimum`. The
    // provider then loses the number the rest of the row is read against.
    //
    // Same asset means the floor's scale is the price's scale: `ToolBinding`
    // carries `priceAmount` + `assetId` and no decimals of its own.
    const price =
      binding.assetId === this.parameters.floor.asset
        ? MoneyUtil.of(
            binding.priceAmount,
            this.parameters.floor.asset,
            this.parameters.floor.decimals,
          )
        : null;

    if (override) {
      // Checked first for `minimum`, exactly as the gate checks it: a
      // negotiated floor is a number the platform agreed outright, so it needs
      // no price and no conversion — including for a binding priced in another
      // asset, where `price` is null for want of a scale rather than because
      // the override suppressed it.
      return {
        item: {
          ...base,
          price: price ? toMoneyDto(price) : null,
          minimum: toMoneyDto(override),
          derivation: `negotiated override ${MoneyUtil.format(override)}`,
        },
        minimum: override,
      };
    }

    if (!price) {
      // No FX, for the reason `evaluateStakeGate` gives: converting a price
      // into the stake asset needs a rate, and a stale rate would silently move
      // the floor. The binding is listed anyway — it is not routable, and the
      // provider is owed the reason rather than a gap in the table. `price` is
      // null because rendering it would need this asset's scale, which is the
      // same lookup the refusal is about.
      return {
        item: {
          ...base,
          price: null,
          minimum: null,
          derivation:
            `priced in ${binding.assetId}, stake floor in ${this.parameters.floor.asset} — ` +
            'not routable (STAKE_ASSET_MISMATCH)',
        },
        minimum: null,
      };
    }

    const minimum = minimumStakeFor(price, this.parameters);

    return {
      item: {
        ...base,
        price: toMoneyDto(price),
        minimum: toMoneyDto(minimum),
        derivation:
          `max(floor ${MoneyUtil.format(this.parameters.floor)}, ` +
          `${this.parameters.priceMultiple} × ${MoneyUtil.format(price)}) = ` +
          MoneyUtil.format(minimum),
      },
      minimum,
    };
  }

  /**
   * The grace row as the screen reads it.
   *
   * The shortfall is `required - observed` **off the row**, not recomputed from
   * today's stake: both amounts were frozen when the period opened because
   * the screen shows "the exact amount needed" beside the countdown, and the
   * countdown is timing the gap as it was at the start.
   * `provider_stake_grace`'s CHECK constraint is strictly
   * `observed_amount < required_amount`, so the subtraction cannot underflow.
   *
   * The row carries its asset but no scale, so the scale is taken from the
   * stake floor when the two agree — which they always do, because the monitor
   * only opens rows for bindings denominated in the floor's asset — and from
   * the asset registry otherwise, rather than assuming.
   */
  private toGraceDto(row: ProviderStakeGraceEntity, now: Date): ProviderStakeGraceDto {
    const asset = row.assetId as AssetId;
    const decimals =
      asset === this.parameters.floor.asset
        ? this.parameters.floor.decimals
        : getAssetMetadata(asset).decimals;

    return {
      startedAt: row.startedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      shortfall: toMoneyDto(
        MoneyUtil.subtract(
          MoneyUtil.of(row.requiredAmount, asset, decimals),
          MoneyUtil.of(row.observedAmount, asset, decimals),
        ),
      ),
      // `now >= expiresAt`, the same boundary `applyStakeGrace` uses. Choosing
      // the other side would tell a provider their traffic is still flowing for
      // one more tick after the row was closed against them.
      expired: now.getTime() >= row.expiresAt.getTime(),
    };
  }

  /**
   * {@link readChain}, once per chain, concurrently and **independently**.
   *
   * One call per chain rather than one batched call over every authority, and
   * the isolation is the whole reason. `bondedStakeOf` throws when the network
   * cannot be reached, so a single batch spanning two chains would turn one
   * network's outage into `chainReadable: false` on every chain in the
   * response — including chains that answered, whose readings are sitting in
   * the same result. That is a fabricated incident on the one screen a provider
   * opens *during* an incident to find out which chain is affected.
   *
   * Two chains is two reads against two different RPC endpoints, which is what
   * it would have cost anyway; nothing is being batched away here.
   */
  private async readChains(
    authorities: ReadonlyMap<ChainId, AccountId | null>,
  ): Promise<ReadonlyMap<ChainId, { stake: OnChainStake | null; readable: boolean }>> {
    const entries = await Promise.all(
      [...authorities.entries()].map(
        async ([chainId, authority]) => [chainId, await this.readChain(authority)] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * The chain half, or an honest "could not read".
   *
   * Three outcomes, and the caller can tell them apart: no stake authority
   * proved (`readable`, nothing to ask about), the chain answered and there is
   * no account at those seeds (`readable`, `stake` absent), and the chain could
   * not be reached at all (`readable: false`). The port throws on the third
   * precisely so it cannot be mistaken for the second.
   */
  private async readChain(
    stakeAuthority: AccountId | null,
  ): Promise<{ stake: OnChainStake | null; readable: boolean }> {
    if (!stakeAuthority) {
      return { stake: null, readable: true };
    }

    const account = stakeAuthority;
    try {
      const found = await this.onChain.bondedStakeOf([account]);
      return { stake: found.get(account) ?? null, readable: true };
    } catch (error) {
      // Logged rather than raised. See the class comment for the argument.
      this.logger.warn(
        `Could not read the stake account for ${account}; serving the Capital screen without ` +
          `its chain-derived fields: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { stake: null, readable: false };
    }
  }

  /**
   * The one disagreement this endpoint can see and nothing else can.
   *
   * `staked` comes from `PROVIDER_STAKE_SOURCE` and `chainReadable` comes from
   * `ONCHAIN_STAKE_READER`, and they answer different questions — which is
   * fine until they disagree. Under `PROVIDER_STAKE_SOURCE_MODE=config` (the
   * DEFAULT, so an unset variable means it) the source is a hand-written seed
   * file, and a provider who registered through the console is in no seed
   * file. They then get `hasKnownStake: false` next to a `chainReadable: true`
   * that says the chain answered — because it did, in this very request, with
   * their balance in it, which this method is the only place to notice.
   *
   * The consequence is not cosmetic: `evaluateStakeGate` reads the same
   * source, so `STAKE_AT_MINIMUM` can never pass and the provider cannot
   * publish a PAID binding however much collateral they hold.
   *
   * What is deliberately NOT done here is preferring the chain figure for
   * `staked`. The screen has to show the number the gate will actually
   * compare, or it tells a provider they are covered while the router refuses
   * them. So the fix for the disagreement is an operator moving
   * `PROVIDER_STAKE_SOURCE_MODE` forwards — and all this does is stop that
   * being a silent lockout somebody has to reverse-engineer from a `null`.
   */
  private warnIfTheChainSeesStakeTheSourceDoesNot(
    providerId: string,
    chainId: ChainId,
    fromSource: ProviderStake | undefined,
    onChain: OnChainStake | null,
  ): void {
    // Absent from both is an ordinary state — a provider who has proved an
    // authority and not staked yet — and so is an account that exists and is
    // empty. Neither is a disagreement.
    if (fromSource || !onChain || MoneyUtil.isZero(onChain.bonded)) {
      return;
    }

    this.logger.warn(
      `Provider ${providerId} has ${MoneyUtil.format(onChain.bonded)} bonded on ${chainId} under ` +
        `${onChain.account}, but the stake source has no reading for them, so the stake gate ` +
        `sees STAKE_UNKNOWN and they cannot publish a paid binding. This is what ` +
        `${PROVIDER_STAKE_SOURCE_MODE_ENV}=config answers for a provider no stake seed file ` +
        `names; promote it to chain_with_config_fallback to serve a proved stake authority ` +
        `off the chain.`,
    );
  }

  /**
   * `headroom` and `shortfall`, as two unsigned amounts.
   *
   * `Money` cannot be negative — `MoneyUtil.subtract` throws
   * `MONEY_AMOUNT_UNDERFLOW` below zero, by design — so the difference is split
   * by direction rather than signed. Exactly one of the two is ever non-zero,
   * and both are `null` when either operand is unknown, because a headroom of
   * `$0.00` and "we do not know your stake" are the two states this screen must
   * never merge.
   */
  private gap(
    staked: Money | null,
    required: Money | null,
  ): { headroom: MoneyDto | null; shortfall: MoneyDto | null } {
    if (!staked || !required || staked.asset !== required.asset) {
      return { headroom: null, shortfall: null };
    }
    const zero = MoneyUtil.zero(required.asset, required.decimals);
    return MoneyUtil.greaterThanOrEqual(staked, required)
      ? { headroom: toMoneyDto(MoneyUtil.subtract(staked, required)), shortfall: toMoneyDto(zero) }
      : { headroom: toMoneyDto(zero), shortfall: toMoneyDto(MoneyUtil.subtract(required, staked)) };
  }
}

function toMoneyDto(money: Money): MoneyDto {
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

/**
 * Which chains the Capital screen answers about, and the stake authority on
 * each — `chainId → stakeAuthorityAccountId | null`, ordered by `chainId`.
 *
 * ## The enrolments, and why not the bindings or the enabled list
 *
 * A stake reading resolves through the enrolment's stake authority, so a chain
 * with no enrolment has no account to read and asking about it is a question
 * whose answer is already known. This is the same derivation
 * `CatalogueService.cardStakes` uses for the same provider's card, deliberately:
 * two derivations of one fact drift, and the drift is invisible until the two
 * screens disagree about whether a provider is collateralised.
 *
 * Not the bindings' `settlementChains`, which would lose the stake of a
 * provider who has paused everything — the provider most likely to be reading
 * this screen. Not `ENABLED_CHAINS`, which would print a "not staked" row for
 * every chain a provider has never asked to serve, turning the per-chain stake requirement
 * into a permanent list of things they are not doing.
 *
 * ## Plus the floor's chain, always
 *
 * `requirementTotal`, `headroom`, `shortfall` and `recommendedBuffer` are
 * denominated in the stake floor's asset, so the floor's chain is the one every
 * one of those figures is implicitly about. A response that reported a
 * shortfall against a chain absent from this list could not be read at all —
 * and a provider whose seed-file reading exists without an enrolment row (the
 * ordinary state under `PROVIDER_STAKE_SOURCE_MODE=config`) would otherwise
 * lose the only figure the gate is going to compare.
 *
 * `stakeAuthority` is `null` for a chain with no enrolment and for one enrolled
 * but not yet funded. Those are the same observable state — nothing to read —
 * and `ChainEnrolment` documents the second as its own.
 */
function chainsToReport(
  providerId: string,
  enrolments: ReadonlyMap<string, ChainEnrolment>,
  floorChain: ChainId,
): ReadonlyMap<ChainId, AccountId | null> {
  const byChain = new Map<ChainId, AccountId | null>([[floorChain, null]]);

  for (const enrolment of enrolments.values()) {
    if (enrolment.providerId !== providerId) continue;
    byChain.set(enrolment.chainId, enrolment.stakeAuthorityAccountId);
  }

  // Sorted, so two loads of the screen do not reorder the rows —
  // `enrolmentsOf` makes no promise about the order of its map, exactly as
  // `stakeOn` does not.
  return new Map([...byChain.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Enough to draw one banner. Null when nothing is in grace. */
function summariseGrace(
  items: readonly ProviderStakeRequirementItemDto[],
): { bindingsInGrace: number; earliestExpiresAt: string } | null {
  const open = items
    .map((item) => item.grace)
    .filter((grace): grace is ProviderStakeGraceDto => grace !== null);
  if (open.length === 0) {
    return null;
  }
  return {
    bindingsInGrace: open.length,
    // ISO 8601 in UTC sorts lexicographically, which is the whole reason these
    // are strings on the wire in the first place.
    earliestExpiresAt: open
      .map((grace) => grace.expiresAt)
      .reduce((earliest, next) => (next < earliest ? next : earliest)),
  };
}
