import { Inject, Injectable, Logger } from '@nestjs/common';
import { In, IsNull } from 'typeorm';

import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderStakeGraceEntity } from '@database/postgres/entities/provider-stake-grace.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ProviderStakeGraceRepository } from '@database/postgres/repositories/provider-stake-grace.repository';
import { StakeSnapshotRepository } from '@database/postgres/repositories/stake-snapshot.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { AccountId, AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { minimumStakeFor } from '@modules/tool/domain/routing/stake-gate';
import { PricingMode } from '@modules/tool/ports/tool.types';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  STAKE_MONITOR_CONFIG,
  StakeGraceResolution,
  StakeMonitorConfig,
} from '../constants/stake-monitor.constants';
import {
  ONCHAIN_STAKE_READER,
  OnChainStake,
  OnChainStakeReaderPort,
} from '../ports/onchain-stake-reader.port';
import { PROVIDER_MINIMUM_STAKE_PARAMETERS } from './provider-stake.service';
import { PROVIDER_REGISTRY, ProviderRegistryPort } from '../ports/provider-registry.port';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';
import { CHAIN_ENROLMENT_SOURCE, ChainEnrolmentPort } from '../ports/chain-enrolment.port';

/**
 * The stake monitor — one job off a 5-minute tick.
 *
 * ```text
 * open and resolve grace rows   →  provider_stake_grace   (a row we write)
 * ```
 *
 * It used to be two. The second asserted a provider's unsettled exposure on
 * chain with `record_exposure`, and the simplified contract removed that instruction and the
 * `exposed` field it wrote: the program now bounds a withdrawal with
 * `min(matured unbonding, bonded + unbonding − pending_slash)` and a
 * `WITHDRAW_DELAY_SECONDS` that exceeds the maximum life of a redeemable
 * voucher, so there is nothing left for the platform to assert. There is no
 * off-chain replacement.
 *
 * ## The grace-period writer
 *
 * `applyStakeGrace` and `DbStakeGraceSource` were both shipped before anything
 * wrote a row, so in production every `stakeGraceUntil` was `null` and the
 * seven-day grace period did not exist. This is
 * the writer. Three rules govern it and each has a test:
 *
 * - **The clock never restarts.** `uq_provider_stake_grace_open` —
 *   `UNIQUE (binding_id) WHERE resolved_at IS NULL` — makes a second open row
 *   impossible in the schema, so a provider oscillating around their floor
 *   cannot buy a fresh seven days on every dip. The job must not *try*, and
 *   must not treat the database's refusal as an error if it races itself.
 * - **A binding on its floor is above it.** The gate is `stake >= minimum`, and
 *   the table's CHECK is strictly `observed_amount < required_amount`. Both say
 *   the same thing from opposite sides, and a row for an exactly-covered
 *   binding would be refused by Postgres.
 * - **Below the floor with no reading is not a shortfall.** `STAKE_UNKNOWN`
 *   means the source could not answer; opening a grace period on that would
 *   start a countdown against a number nobody has. `applyStakeGrace` refuses to
 *   carry it and so does this.
 *
 * ## Failure isolation
 *
 * Every provider is its own unit. One provider's failed review must not stop
 * the next provider's, and this job touches no chain at all.
 */
@Injectable()
export class StakeMonitorService {
  private readonly logger = new Logger(StakeMonitorService.name);

  constructor(
    private readonly providers: ProviderRepository,
    private readonly bindings: ToolBindingRepository,
    private readonly grace: ProviderStakeGraceRepository,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort,
    @Inject(ONCHAIN_STAKE_READER) private readonly onChain: OnChainStakeReaderPort,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    private readonly snapshots: StakeSnapshotRepository,
    @Inject(PROVIDER_MINIMUM_STAKE_PARAMETERS) private readonly parameters: MinimumStakeParameters,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
    // Emitted on BOTH ports at every one of the three sites below: the
    // operator (`alerts`) and the provider (`notifications`) each need to know,
    // and neither is served by the other's copy — `NotificationPort`'s own
    // class comment makes this the one example where a producer genuinely
    // knows both audiences, because `providerId === organizationId` here.
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(STAKE_MONITOR_CONFIG) private readonly config: StakeMonitorConfig,
  ) {}

  /** One pass over every provider. Never throws — see the class comment. */
  async sweep(): Promise<void> {
    const now = new Date(this.config.now());

    const providers = await this.providers.findAllProviders();
    if (providers.length === 0) {
      return;
    }
    const providerIds = providers.map((provider) => provider.organizationId);

    // Everything the grace half needs, in four statements rather than four per
    // binding. `stakeOn` is the same port the router gates on, and
    // `findRoutingStates` is the same port `evaluateStakeGate` reads
    // `minimumStakeOverride` off — so a row opens exactly when routing would
    // otherwise have cut the binding. A second source for either would let the
    // promise and the gate disagree.
    // One stake question per DISTINCT (provider, settlement chain) pair the
    // watched bindings contain. The grace clock is per binding and a
    // binding settles on one chain, so a provider-level reading would run one
    // countdown off collateral that is not behind the calls it is counting.
    //
    // **Site 4 of 5, expression 1 of 2** in the settlement-chain enumeration in
    // `tool/domain/routing/eligibility.ts`, and one of the two DELIBERATELY
    // LEFT when sites 1-3 moved to per-call selection. The router now chooses a chain per
    // CALL, from the buyer's chains — a quantity a background sweep has no
    // access to, because there is no buyer. What this monitor needs is the set
    // of chains a binding's paid traffic could settle on, which is
    // `binding.settlementChains`, not one chain chosen for one call.
    //
    // **The divergence is real and is not free.** A binding offered on two
    // chains is swept against the chain its price is quoted in, so a provider
    // bonded on the other one keeps a grace row open that the router would not
    // have opened. It is bounded today because every binding on this deployment
    // lists exactly one chain (the migration backfilled it from `asset_id`) and
    // `ENABLED_CHAINS` names one. The fix is a sweep over
    // `binding.settlementChains` with one reading per chain, and it belongs
    // with the work that enables a second chain on one binding.
    const bindingList = await this.bindings.findActivePaidBindings();
    const stakeKeys = [
      ...new Map(
        bindingList.map((binding) => {
          const chainId = chainIdOf(binding.assetId as AssetId);
          return [
            stakeKey(binding.organizationId, chainId),
            { providerId: binding.organizationId, chainId },
          ] as const;
        }),
      ).values(),
    ];

    const [bindings, stakeReadings, openRows, routingStates, enrolments] = await Promise.all([
      Promise.resolve(bindingList),
      this.stakes.stakeOn(stakeKeys),
      this.openGraceRows(providerIds),
      this.registry.findRoutingStates(providerIds),
      this.enrolments.enrolmentsOf(providerIds),
    ]);

    const bindingsByProvider = groupBy(bindings, (binding) => binding.organizationId);
    const openByBinding = new Map(openRows.map((row) => [row.bindingId, row]));

    // The fleet's bonded stake (for proof of reserves), read once per sweep.
    //
    // It is a **pure chain reading**, and it is read here rather than inside
    // the grace loop so that one batch covers the whole fleet — the same
    // `ceil(N/100)` round trips whatever the provider count.
    //
    // **The try/catch is the whole safety of it.** `sweep()` promises never to
    // throw, and the grace countdowns are the job that matters: a bare `await`
    // here would move an RPC call outside every error boundary, so one timeout
    // would abort the sweep and stop every 7-day grace countdown. A
    // proof-of-reserves tile is not worth that.
    // Every proved stake authority the fleet holds, across every chain — the
    // reserves figure is a total, so a provider staked on two chains
    // contributes both accounts. Read off the enrolments since
    // `1759300000003`; `providers.stake_authority` is gone.
    const accounts = [
      ...new Set(
        [...enrolments.values()]
          .map((enrolment) => enrolment.stakeAuthorityAccountId)
          .filter((account): account is AccountId => account !== null),
      ),
    ];

    let bonded: ReadonlyMap<AccountId, OnChainStake> | null = null;
    try {
      bonded = await this.onChain.bondedStakeOf(accounts);
    } catch (error) {
      this.logger.warn(`Fleet stake read failed; skipping this snapshot. ${describe(error)}`);
    }

    if (bonded) {
      await this.writeStakeSnapshot(bonded, accounts.length, now);
    }
    for (const provider of providers) {
      try {
        await this.reviewGrace(
          provider,
          bindingsByProvider.get(provider.organizationId) ?? [],
          stakeReadings,
          routingStates.get(provider.organizationId)?.minimumStakeOverride,
          openByBinding,
          now,
        );
      } catch (error) {
        this.logger.error(
          `Grace review failed for provider ${provider.organizationId}: ${describe(error)}`,
        );
      }
    }
  }

  // ── Job 1: grace ─────────────────────────────────────────────────────────

  /**
   * One provider's bindings against one stake reading.
   *
   * The floor is per binding — `max(floor, priceMultiple × price)`, or the
   * provider's negotiated override if they have one — which is why the table is
   * keyed on `binding_id` and not on the provider: the same provider is
   * simultaneously above it for a cheap binding and below it for an expensive
   * one, and a provider-level row would have to be wrong about one of them.
   *
   * The floor itself is resolved by {@link requirementFor}, which is where the
   * override lives and why it has to.
   */
  private async reviewGrace(
    provider: ProviderEntity,
    bindings: readonly ToolBindingEntity[],
    stakeReadings: ReadonlyMap<string, ProviderStake>,
    override: Money | undefined,
    openByBinding: ReadonlyMap<string, ProviderStakeGraceEntity>,
    now: Date,
  ): Promise<void> {
    for (const binding of bindings) {
      // `FREE` never reaches here (the query excludes it) and `FREEMIUM` does,
      // exactly as `evaluateStakeGate` treats them: the same binding serves
      // both free and paid calls, and at this point we cannot know which.
      if (binding.pricingMode === PricingMode.FREE) {
        continue;
      }

      const required = this.requirementFor(binding, override);
      if (!required) {
        continue;
      }

      // The reading for THIS binding's chain, resolved per binding rather than
      // per provider. Two bindings of one provider on two chains get two
      // answers, and a provider bonded on one of them opens a grace row on the
      // other — which is the invariant, not a corner case.
      //
      // **Site 4 of 5, expression 2 of 2** — see the enumeration in
      // `tool/domain/routing/eligibility.ts`, and the note on expression 1
      // above for why both were left where sites 1-3 moved. This is the one
      // that decides whether a binding's paid traffic is collateral-backed, so
      // it is the expression in this file that most needs the per-chain sweep
      // when a second chain goes live.
      const staked =
        stakeReadings.get(stakeKey(provider.organizationId, chainIdOf(binding.assetId as AssetId)))
          ?.staked ?? null;

      // `STAKE_UNKNOWN` is not a shortfall. See the class comment. The asset is
      // compared against the REQUIREMENT rather than against the floor, because
      // under an override those are not the same value — the same order
      // `evaluateStakeGate` puts its two checks in.
      if (!staked || staked.asset !== required.asset) {
        continue;
      }

      const open = openByBinding.get(binding.id);

      if (MoneyUtil.greaterThanOrEqual(staked, required)) {
        if (open) {
          await this.resolveGrace(open, StakeGraceResolution.CURED, now, staked, required);
        } else {
          await this.warnIfHeadroomLow(provider, binding, staked, required);
        }
        continue;
      }

      if (!open) {
        await this.openGrace(provider, binding, staked, required, now);
        continue;
      }

      // Open and past its deadline: close it against the provider. The
      // comparison is `now >= expiresAt`, the same boundary `applyStakeGrace`
      // uses — choosing the other side here would let a binding route for one
      // more tick after the row was closed against it.
      if (now.getTime() >= open.expiresAt.getTime()) {
        await this.resolveGrace(open, StakeGraceResolution.EXPIRED, now, staked, required);
      }

      // Open and still running: nothing at all. **This is where the clock does
      // not restart.** Re-stamping `started_at`, or closing and reopening, is
      // precisely the behaviour the partial unique index exists to make
      // impossible, and doing it in code would defeat it by writing a row the
      // index is happy with.
    }
  }

  /**
   * One binding's floor, resolved **exactly as `evaluateStakeGate` resolves
   * it**, or `null` for a binding grace does not cover.
   *
   * ## The bug this closes
   *
   * `minimumStakeOverride` is read in three places — the router's gate, the
   * publish gate (through the same gate), and `GET /providers/me/stake`. Until
   * this method existed, the monitor was a fourth reader that did not read it
   * at all: it went straight to `minimumStakeFor(price, parameters)`. For a
   * provider with a negotiated floor **below** the computed one, the monitor
   * therefore opened a seven-day countdown against a number the gate had never
   * enforced, and the Capital screen would render `minimum: $25.00,
   * staked: $30.00, shortfall: $0` directly beside it. Two of those three
   * surfaces would have been right and the third would have been counting down
   * to a cut that could not happen. Above the computed floor it fails the other
   * way: the provider is under-collateralised by the agreed number and nothing
   * starts a clock.
   *
   * The fix is the **source**, not the arithmetic: this reads
   * `ProviderRoutingState.minimumStakeOverride` off `PROVIDER_REGISTRY`, which
   * is the one place `evaluateStakeGate` reads it from and the one place
   * `ProviderStakeService` reads it from. A locally-derived override would have
   * been a fifth interpretation of the same field.
   *
   * ## What makes this latent rather than live — and who trips it first
   *
   * **Nothing in `src/` writes `minimumStakeOverride`.** `DbProviderRegistry`
   * is the bound `PROVIDER_REGISTRY`, and it explicitly does not populate the
   * field: the negotiated floor has no column on `providers`, so the
   * registry returns routing states without it, always. The field is consumed
   * in four places now and produced in none.
   *
   * So no provider in production can be in the disagreeing state today. The
   * consequence of that is the part worth carrying forward: **the whole
   * override branch — here, in the gate, and on the Capital screen — will be
   * exercised for the first time by whoever adds the column.** Whatever they
   * add has to satisfy all four readers at once, and the tests beside this
   * method are the only description of what "at once" means. Adding the column
   * without running them is how three surfaces quietly disagree on day one.
   */
  private requirementFor(binding: ToolBindingEntity, override: Money | undefined): Money | null {
    if (override) {
      // Checked first, exactly as the gate checks it: a negotiated floor is a
      // number the platform agreed outright, so it needs no price and no
      // conversion — which is also why it comes before the asset test. A
      // binding the gate admits on an override is a binding grace must cover.
      return override;
    }

    // No FX, for the reason the gate gives: converting a price into the stake
    // asset needs a rate, and a stale rate would silently move the floor. The
    // gate rejects this binding as `STAKE_ASSET_MISMATCH`, which grace does not
    // cover — so there is nothing to promise and nothing to open.
    if (binding.assetId !== this.parameters.floor.asset) {
      return null;
    }

    const price = MoneyUtil.of(
      binding.priceAmount,
      this.parameters.floor.asset,
      this.parameters.floor.decimals,
    );
    return minimumStakeFor(price, this.parameters);
  }

  private async openGrace(
    provider: ProviderEntity,
    binding: ToolBindingEntity,
    staked: Money,
    required: Money,
    now: Date,
  ): Promise<void> {
    const expiresAt = new Date(now.getTime() + this.config.gracePeriodMs);

    try {
      await this.grace.insert({
        organizationId: provider.organizationId,
        bindingId: binding.id,
        startedAt: now,
        expiresAt,
        // Frozen at the moment the period opens, because the screen shows "the exact
        // amount needed" beside the countdown, and re-deriving it from a later
        // price would answer a different question than the one the clock times.
        requiredAmount: required.amount,
        observedAmount: staked.amount,
        assetId: required.asset,
        resolvedAt: null,
        resolution: null,
      });
    } catch (error) {
      // `uq_provider_stake_grace_open` refusing a second open row is the
      // schema doing its job, not a failure: two passes overlapping, or a
      // second scheduler that should not exist, both land here and both are
      // correctly a no-op. Anything else is re-raised for the caller's
      // per-provider handler.
      if (!isUniqueViolation(error)) {
        throw error;
      }
      this.logger.debug(
        `A grace period was already open for binding ${binding.id}; leaving its clock alone`,
      );
      return;
    }

    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: 'provider_stake_grace_opened',
      summary:
        `Binding ${binding.id} is below its stake floor; routing continues until ` +
        expiresAt.toISOString(),
      details: {
        providerId: provider.organizationId,
        bindingId: binding.id,
        staked: MoneyUtil.format(staked),
        required: MoneyUtil.format(required),
        expiresAt: expiresAt.toISOString(),
      },
    });

    // On both ports — see the constructor comment. The operator's alert above
    // is not a substitute for telling the provider their own binding is on the
    // clock.
    await this.notifications.notify({
      organizationId: provider.organizationId,
      event: NotificationEvent.PROVIDER_STAKE_GRACE_OPENED,
      title: 'Stake below your minimum — grace period started',
      body:
        `Your stake for one binding is below your ${MoneyUtil.format(required)} minimum. ` +
        `A 7-day grace period starts, routing continues, and unpaid earnings are swept to ` +
        `stake automatically until the floor is met. Grace ends ${expiresAt.toISOString()}.`,
      subjectType: 'binding',
      subjectId: binding.id,
      payload: {
        bindingId: binding.id,
        staked: staked.amount,
        required: required.amount,
        asset: required.asset,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: binding.id,
    });
  }

  private async resolveGrace(
    row: ProviderStakeGraceEntity,
    resolution: StakeGraceResolution,
    now: Date,
    staked: Money,
    required: Money,
  ): Promise<void> {
    // Scoped criteria, not a bare id: an id belongs to *some* organization, and
    // acting on it without naming which is how a row gets written across a
    // tenant boundary (`docs/architecture.md` §Multi-Organization Scoping).
    await this.grace.update(
      { organizationId: row.organizationId, id: row.id },
      { resolvedAt: now, resolution },
    );

    await this.alerts.emit({
      severity:
        resolution === StakeGraceResolution.EXPIRED ? AlertSeverity.CRITICAL : AlertSeverity.INFO,
      name:
        resolution === StakeGraceResolution.EXPIRED
          ? 'provider_stake_grace_expired'
          : 'provider_stake_grace_cured',
      summary:
        resolution === StakeGraceResolution.EXPIRED
          ? `Binding ${row.bindingId} has run out of grace and stops taking paid traffic`
          : `Binding ${row.bindingId} is back above its stake floor`,
      details: {
        providerId: row.organizationId,
        bindingId: row.bindingId,
        staked: MoneyUtil.format(staked),
        required: MoneyUtil.format(required),
        startedAt: row.startedAt.toISOString(),
      },
    });

    // On both ports — see the constructor comment.
    const expired = resolution === StakeGraceResolution.EXPIRED;
    await this.notifications.notify({
      organizationId: row.organizationId,
      event: expired
        ? NotificationEvent.PROVIDER_STAKE_GRACE_EXPIRED
        : NotificationEvent.PROVIDER_STAKE_GRACE_CURED,
      title: expired ? 'Grace period expired — routing paused' : 'Stake restored — routing resumes',
      body: expired
        ? `Binding ${row.bindingId} ran out of its 7-day grace period still below the ` +
          `${MoneyUtil.format(required)} minimum and has stopped taking paid traffic.`
        : `Binding ${row.bindingId} is back above its ${MoneyUtil.format(required)} minimum. ` +
          `Paid routing continues without interruption.`,
      subjectType: 'binding',
      subjectId: row.bindingId,
      payload: {
        bindingId: row.bindingId,
        staked: staked.amount,
        required: required.amount,
        asset: required.asset,
        startedAt: row.startedAt.toISOString(),
      },
      dedupeKey: row.bindingId,
    });
  }

  /**
   * *Warn when approaching the floor* — before the floor, not after it.
   *
   * Measured against the requirement rather than against the stake, so the
   * warning means the same thing to a provider with one binding and to one with
   * ten. Only raised for a binding with **no open row**: a provider already
   * inside a grace period does not need to be told they are close to a line
   * they are under.
   */
  private async warnIfHeadroomLow(
    provider: ProviderEntity,
    binding: ToolBindingEntity,
    staked: Money,
    required: Money,
  ): Promise<void> {
    const requiredAtomic = MoneyUtil.toAtomic(required);
    if (requiredAtomic === 0n) {
      return;
    }
    const headroom = MoneyUtil.toAtomic(staked) - requiredAtomic;

    // Integer arithmetic throughout: `Number(headroom) / Number(required)`
    // would lose precision on a `u64` and this comparison decides whether a
    // provider is told anything at all. `ratio` is scaled by 10,000 so a
    // fractional threshold survives without a float.
    const threshold = BigInt(Math.round(this.config.headroomWarningRatio * 10_000));
    if (headroom * 10_000n >= requiredAtomic * threshold) {
      return;
    }

    await this.alerts.emit({
      severity: AlertSeverity.WARN,
      name: 'provider_stake_headroom_low',
      summary: `Binding ${binding.id} is within ${this.config.headroomWarningRatio * 100}% of its stake floor`,
      details: {
        providerId: provider.organizationId,
        bindingId: binding.id,
        staked: MoneyUtil.format(staked),
        required: MoneyUtil.format(required),
      },
      // Otherwise this pages again every 5-minute pass for as long as the
      // binding stays in the low-headroom band, which can be days.
      aggregation: AlertAggregation.ONCE_PER_INCIDENT,
      dedupeKey: binding.id,
    });

    // On both ports — see the constructor comment.
    await this.notifications.notify({
      organizationId: provider.organizationId,
      event: NotificationEvent.PROVIDER_STAKE_HEADROOM_LOW,
      title: 'Stake headroom is running low',
      body:
        `Binding ${binding.id} is within ${this.config.headroomWarningRatio * 100}% of its ` +
        `${MoneyUtil.format(required)} stake floor (staked: ${MoneyUtil.format(staked)}). Top up ` +
        `now to avoid a grace period.`,
      subjectType: 'binding',
      subjectId: binding.id,
      payload: {
        bindingId: binding.id,
        staked: staked.amount,
        required: required.amount,
        asset: required.asset,
      },
      dedupeKey: binding.id,
    });
  }

  private async openGraceRows(providerIds: readonly string[]): Promise<ProviderStakeGraceEntity[]> {
    // A scoped read, not a cross-tenant one: the provider set is already in
    // hand, so naming every organization satisfies the guard honestly rather
    // than working around it — the same call `DbStakeGraceSource` makes.
    return this.grace.find({
      where: { organizationId: In([...providerIds]), resolvedAt: IsNull() },
    });
  }
  /**
   * One row per sweep: what the whole fleet has bonded, and how many stake
   * accounts that covers (for the proof-of-reserves page).
   *
   * `bonded` is a **pure chain reading**, never `PROVIDER_STAKE_SOURCE`. The
   * composite source runs in `chain_with_config_fallback` and mixes chain reads
   * with values from a JSON file for providers not yet proved on chain;
   * publishing that under "stake locked in the settlement program" would put an
   * unverifiable number on the one page whose entire purpose is verifiability —
   * the same reason an unverifiable "3-of-5" multisig claim was dropped.
   *
   * Skipped entirely on a failed read (the caller passes `null`), never written
   * as a zero: a zero is a claim that the fleet has no stake. A fleet whose
   * providers genuinely hold no stake account is a different answer and *is*
   * written — `providerCount: 0` is what makes the two readable apart.
   *
   * Failing to write must not fail the sweep, for the same reason the read is
   * wrapped: the grace countdowns are the job that matters.
   */
  private async writeStakeSnapshot(
    bonded: ReadonlyMap<AccountId, OnChainStake>,
    accountCount: number,
    now: Date,
  ): Promise<void> {
    let total = MoneyUtil.zero(this.parameters.floor.asset, this.parameters.floor.decimals);
    for (const stake of bonded.values()) {
      // A stake account denominated in something other than the floor's asset
      // cannot be added to it, and `MoneyUtil.add` would throw. Skipping the
      // row keeps the published total in one unit; including it would make the
      // figure meaningless in a way no reader could detect.
      if (
        stake.bonded.asset !== this.parameters.floor.asset ||
        stake.bonded.decimals !== this.parameters.floor.decimals
      ) {
        this.logger.warn(
          `Stake account ${stake.account} is denominated in ${stake.bonded.asset}, not ` +
            `${this.parameters.floor.asset}; excluded from the fleet snapshot`,
        );
        continue;
      }
      total = MoneyUtil.add(total, stake.bonded);
    }

    try {
      await this.snapshots.insertSnapshot({
        readAt: now,
        stakeAsset: total.asset,
        decimals: total.decimals,
        bondedTotal: MoneyUtil.toAtomic(total).toString(),
        // Accounts read, not stake accounts found. A provider whose account the
        // chain has never seen still had its authority queried, and the page
        // says "providers with a stake account" — see the entity docstring.
        providerCount: accountCount,
      });
    } catch (error) {
      this.logger.error(`Could not write the fleet stake snapshot: ${describe(error)}`);
    }
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key(item), [item]);
    }
  }
  return grouped;
}

/**
 * Postgres `23505`, whatever driver wrapper it arrives inside.
 *
 * Read off the error rather than off the constraint name so that the check
 * survives the index being renamed, and matched narrowly so an ordinary write
 * failure is never mistaken for "somebody already opened this period".
 */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
