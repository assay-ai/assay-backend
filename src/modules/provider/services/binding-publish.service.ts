import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { BindingTestRunRepository } from '@database/postgres/repositories/binding-test-run.repository';
import { ChainId } from '@modules/chains/ports/caip.types';
import { PayoutGateVerdict, evaluatePayoutGate } from '@modules/tool/domain/routing/payout-gate';
import {
  StakeGateVerdict,
  evaluateStakeGateOnChain,
} from '@modules/tool/domain/routing/stake-gate';
import { MinimumStakeByChain, RoutingCandidate } from '@modules/tool/domain/routing/routing.types';
import { BindingStatus } from '@modules/tool/ports/tool.types';
import { toToolBinding } from '@modules/tool/services/database-tool-catalogue';

import {
  PublishCheck,
  PublishGateTestRun,
  evaluatePublishGate,
  unmetRequirements,
} from '../domain/publish-gate';
import { PublishCheckDto, PublishedToolBindingDto } from '../dto/publish-tool-binding.dto';
import { ProviderErrors } from '../errors/provider.errors';
import { BindingTestLayer, BindingTestOutcome } from '../ports/binding-test.types';
import { PROVIDER_REGISTRY, ProviderRegistryPort } from '../ports/provider-registry.port';
import {
  PROVIDER_STAKE_SOURCE,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '../ports/provider-stake.port';
import { ProviderStatus, ProviderTier } from '../ports/provider.types';
import { BindingEditorService, toSavedDto } from './binding-editor.service';
import { PROVIDER_MINIMUM_STAKE_BY_CHAIN } from './provider-stake.service';

/**
 * The publish gate. *"An open door still has a step."*
 *
 * Registration is open and there is no approval to remove later; what stands
 * between a stranger's binding and paid traffic is four mechanical conditions
 * — a tester run at *this* revision, that run being green, a proved payout
 * address for a paid binding, and stake at or above the router's own minimum.
 * They are the answer to the risk open registration creates: the connectivity
 * check rejects dead endpoints, and this gate blocks bindings that do not run
 * yet or are not staked enough.
 *
 * ## The stake and payout halves are not re-implemented
 *
 * They are `evaluateStakeGate` and `evaluatePayoutGate` — the two functions
 * `ProviderRouterService` calls on every live call — given a
 * `RoutingCandidate` built from this binding, this provider's registry row and
 * this provider's stake. Publishing a binding the router would then refuse is
 * the failure mode worth designing against: the provider is live, sees
 * nothing, and no screen anywhere explains it. One function, one answer.
 *
 * ## Publishing is two writes and they are one transaction
 *
 * The row moves to `ACTIVE` (a `PAUSED` row stays paused) with
 * `published_version = mapping_version`, and the matching `binding_versions`
 * snapshot is stamped `published_at`/`published_by`. The router serves the
 * published snapshot, not the row's draft fields — see `toServedToolBindings`.
 * Either both happen or neither: a live binding whose revision has no
 * publication record is a call nobody can later prove the terms of, which is
 * the whole reason the snapshot table exists.
 */
@Injectable()
export class BindingPublishService {
  private readonly logger = new Logger(BindingPublishService.name);

  constructor(
    private readonly editor: BindingEditorService,
    private readonly runs: BindingTestRunRepository,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryPort,
    // Per chain, the same map `ROUTER_CONFIG` gates on. A single floor here
    // was the first enabled chain's, which refused every binding settling on
    // any other chain with `STAKE_ASSET_MISMATCH`.
    @Inject(PROVIDER_MINIMUM_STAKE_BY_CHAIN)
    private readonly minimumStakeByChain: MinimumStakeByChain,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  /** The publish checklist, read before the button is pressed. */
  async check(organizationId: string, bindingId: string): Promise<PublishCheckDto> {
    const row = await this.editor.loadEditable(organizationId, bindingId);
    const check = await this.evaluate(organizationId, row);

    return {
      publishable: check.publishable,
      mappingVersion: row.mappingVersion,
      requirements: check.requirements.map((requirement) => ({ ...requirement })),
    };
  }

  async publish(
    organizationId: string,
    subject: string,
    bindingId: string,
  ): Promise<PublishedToolBindingDto> {
    const row = await this.editor.loadEditable(organizationId, bindingId);

    // `PAUSED` too: publishing does not resume (see below), so republishing the
    // revision a paused binding already holds would change nothing.
    if (
      (row.status === BindingStatus.ACTIVE || row.status === BindingStatus.PAUSED) &&
      row.publishedVersion === row.mappingVersion
    ) {
      throw ProviderErrors.bindingAlreadyPublished({
        bindingId,
        mappingVersion: row.mappingVersion,
      });
    }

    const check = await this.evaluate(organizationId, row);
    if (!check.publishable) {
      throw ProviderErrors.publishChecksFailed({
        bindingId,
        // The codes, not the prose: the console renders the checklist from
        // `GET …/publish-check`, and an error message is not where a UI reads
        // its state from.
        failed: unmetRequirements(check)
          .map((requirement) => `${requirement.requirement} (${requirement.code})`)
          .join(', '),
      });
    }

    const publishedAt = new Date();
    const saved = await this.dataSource.transaction(async (manager) => {
      // **Publishing is not resuming.** A `PAUSED` binding takes the new
      // revision and stays paused, with its `pause_reason`/`paused_at` intact,
      // until its provider resumes it — the pause is their hand on their
      // traffic, and a publish is a statement about terms, not about traffic.
      // Setting `ACTIVE` here while the pause fields stood was a 500 from
      // `chk_tool_bindings_pause_attributed`.
      if (row.status !== BindingStatus.PAUSED) {
        row.status = BindingStatus.ACTIVE;
      }
      row.publishedVersion = row.mappingVersion;
      row.publishedAt = publishedAt;

      const updated = await manager.save(ToolBindingEntity, row);

      const stamped = await manager
        .createQueryBuilder()
        .update(BindingVersionEntity)
        .set({ publishedAt, publishedBy: subject })
        .where('organization_id = :organizationId', { organizationId })
        .andWhere('binding_id = :bindingId', { bindingId })
        .andWhere('mapping_version = :mappingVersion', { mappingVersion: row.mappingVersion })
        .execute();

      if (stamped.affected !== 1) {
        // No snapshot for the revision going live. Every save writes one, so
        // this is a repair script or a bug — and publishing anyway would put a
        // binding on the wire whose terms nothing records.
        throw ProviderErrors.publishChecksFailed({
          bindingId,
          failed: `no stored revision ${row.mappingVersion} to publish`,
        });
      }

      return updated;
    });

    this.logger.log(`Binding ${bindingId} published at revision ${row.mappingVersion}`);

    return { ...toSavedDto(saved), publishedAt };
  }

  private async evaluate(organizationId: string, row: ToolBindingEntity): Promise<PublishCheck> {
    const [latestRun, built] = await Promise.all([
      this.latestRun(organizationId, row),
      this.candidate(organizationId, row),
    ]);
    const { candidate, settlementChains } = built;

    // One pass per chain the binding is offered on.
    // Collateral is per chain and is not shared, so "may this go live" is a
    // question about each chain separately — and the checklist reports the
    // failing one BY NAME, because a provider staked on one of two chains has
    // one thing to fix and needs to be told which.
    //
    // **The chains come from `settlementChains`, not from `assetId`.** Originally
    // this file derived one chain from the binding's price
    // (`chainIdOf(binding.assetId)`) — site 2 of the settlement-chain
    // enumeration in `tool/domain/routing/eligibility.ts`, now moved. A binding
    // priced in one chain's USDC and offered on two would otherwise have been
    // approved against one chain's collateral and routed on the other's.
    const payoutByChain = new Map<ChainId, PayoutGateVerdict>();
    const stakeByChain = new Map<ChainId, StakeGateVerdict>();

    for (const chainId of settlementChains) {
      // Both verdicts from the same candidate and the same chain, so the
      // publish checklist and a live routing decision are answering from one
      // snapshot of this provider rather than two reads that can disagree. The
      // publish gate must approve a binding for the chain routing will later
      // gate it on: a different chain here would publish a binding the router
      // refuses — the provider is live, sees nothing, and no screen explains
      // it.
      //
      // Which chains these are asked about is pinned by
      // `test/unit/provider/binding-publish-chain.spec.ts`: hardcoding a chain
      // here passed the entire unit tree before that file existed.
      payoutByChain.set(chainId, evaluatePayoutGate(candidate, chainId));
      stakeByChain.set(
        chainId,
        evaluateStakeGateOnChain(candidate, chainId, this.minimumStakeByChain),
      );
    }

    return evaluatePublishGate({
      mappingVersion: row.mappingVersion,
      latestRun,
      payoutByChain,
      stakeByChain,
    });
  }

  private async latestRun(
    organizationId: string,
    row: ToolBindingEntity,
  ): Promise<PublishGateTestRun | null> {
    const run = await this.runs.findLatestForRevision(organizationId, row.id, row.mappingVersion);
    if (!run) return null;

    return {
      mappingVersion: run.mappingVersion,
      outcome: run.outcome as BindingTestOutcome,
      failedLayer: run.failedLayer as BindingTestLayer | null,
      ranAt: run.createdAt,
    };
  }

  /**
   * This binding as the router would see it, so the router's own gates can be
   * run against it.
   *
   * A provider with no registry row gets a synthesised `ACTIVE`/`NEW` state
   * rather than a rejection, and the distinction is worth stating: the registry
   * is now `providers` itself (`DbProviderRegistry`), so a caller who reached
   * this method has a session, and a session resolves an organization that
   * registered. The synthesis covers the one remaining gap — a binding created
   * before its provider row, which the API cannot produce — and it is
   * deliberately the *permissive* branch only for `status` and `tier`, never
   * for stake, which fails closed inside `evaluateStakeGate`, and never for the
   * payout account, which fails closed inside `evaluatePayoutGate`: a provider
   * with no row has proved no address, and synthesising one would be inventing
   * a payee.
   */
  private async candidate(
    organizationId: string,
    row: ToolBindingEntity,
  ): Promise<{ candidate: RoutingCandidate; settlementChains: readonly ChainId[] }> {
    // The row's DRAFT terms, on purpose — not `toServedToolBindings`. Publishing
    // is the moment the draft becomes the served revision, so this gate must
    // ask whether the stake covers the terms about to go live. Everything that
    // watches traffic already flowing (the router, the stake monitor, the
    // Capital screen) reads the published revision instead.
    const binding = toToolBinding(row);
    // The binding's own declaration, and no derivation of it. The chain a
    // binding settles on is a column now, not a fact about the
    // asset its price happens to be quoted in — see `evaluate()` above.
    const settlementChains = binding.settlementChains ?? [];

    const [stakes, states] = await Promise.all([
      // Read for this binding's own chains alone. Asking about every chain the
      // provider is enrolled on would build a candidate the publish gate could
      // pass on collateral that is not behind this binding's calls.
      this.stakes.stakeOn(
        settlementChains.map((chainId) => ({ providerId: organizationId, chainId })),
      ),
      this.registry.findRoutingStates([organizationId]),
    ]);

    const candidate: RoutingCandidate = {
      binding,
      provider: states.get(organizationId) ?? {
        providerId: organizationId,
        status: ProviderStatus.ACTIVE,
        tier: ProviderTier.NEW,
        stats: {},
        payoutAccountByChain: new Map(),
        payoutEnrolmentChains: new Set(),
      },
      // Every chain that answered, keyed as the gate reads it. A chain with no
      // reading is simply absent, and `evaluateStakeGate` refuses it as
      // `STAKE_UNKNOWN` — never defaulted to zero, and never to another
      // chain's number.
      stakeByChain: new Map(
        settlementChains
          .map((chainId) => [chainId, stakes.get(stakeKey(organizationId, chainId))] as const)
          .filter(([, stake]) => stake !== undefined) as [ChainId, ProviderStake][],
      ),
      settlementChains,
      // The publish gate asks a different question from routing's: "may this
      // binding go live". Grace protects traffic that is already flowing, it
      // does not open the door — so the publish gate never has grace, and the
      // other two routing facts are not its business either.
      stakeGraceUntil: null,
      observedCalls: null,
      ceilingHit: null,
    };

    return { candidate, settlementChains };
  }
}
