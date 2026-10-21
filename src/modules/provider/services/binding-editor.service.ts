import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { BindingVersionEntity } from '@database/postgres/entities/binding-version.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { evaluateStakeGate } from '@modules/tool/domain/routing/stake-gate';
import { MinimumStakeByChain, RoutingCandidate } from '@modules/tool/domain/routing/routing.types';
import { MappingDirection, RequestMappingSpec } from '@modules/tool/domain/mapping/mapping.types';
import { checkResponseAgainstSchema } from '@modules/tool/domain/mapping/contract-check';
import {
  inspectRequestMapping,
  inspectResponseMapping,
} from '@modules/tool/domain/mapping/mapping-validator';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { BindingStatus, PricingMode, Tool, ToolBinding } from '@modules/tool/ports/tool.types';
import { EGRESS_RELAY_CONFIG, EgressRelayConfig } from '@shared/network/egress';
import { canonicalJson } from '@shared/crypto/canonical-json';

import {
  SaveToolBindingBodyDto,
  SavedToolBindingDto,
  UpdateToolBindingBodyDto,
} from '../dto/save-tool-binding.dto';
import { ProviderRoutingState } from '../ports/provider.types';
import { ValidateMappingBodyDto, ValidateMappingResponseDto } from '../dto/validate-mapping.dto';
import { CredentialVaultService } from '../credentials/credential-vault.service';
import { ProviderErrors } from '../errors/provider.errors';
import {
  assayMappingHeaders,
  authModeNeedsKey,
  credentialQueryKeys,
  MAX_MAPPING_HEADERS,
  mappingHeaderCount,
  originOf,
  assertRelayableEndpoint,
  secretConstantHeaders,
} from '../credentials/credential-rules';
import {
  CHAIN_ENROLMENT_SOURCE,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '../ports/chain-enrolment.port';
import { PROVIDER_STAKE_SOURCE, ProviderStakePort, stakeKey } from '../ports/provider-stake.port';
import { PROVIDER_MINIMUM_STAKE_BY_CHAIN } from './provider-stake.service';

import { canBind, publishedEndpointOf, toDetailDto } from './provider-tool-bindings.service';
import { assertBindingContract, defaultBindingRange } from '../domain/binding-contract';

/**
 * The fields a revision is *about*.
 *
 * Changing any of them raises `mapping_version` and writes a new
 * `binding_versions` snapshot, so the change goes live only by a publish.
 * The tester run that was green a moment ago is invalidated when the change
 * touches the call (`tested-call.ts`: endpoint, mappings, timeout, contract
 * terms) — a green tick that survived it would vouch for something nobody
 * ran. A change of the offer alone (price, pricing mode, asset, chains) keeps
 * it: the tester sends none of those (BUG-PRV-CATALOG-02).
 *
 * `slaFailureRate` and the free-tier figures are deliberately outside the set.
 * They change routing arithmetic and quota accounting, not what the endpoint is
 * asked or what comes back, so re-running a mapping tester over them would be
 * friction that teaches providers to click through the gate.
 *
 * **`maxRps` and `maxDailyCalls` are outside it for the same reason**.
 * `mapping_version` describes *what served a call*; a ceiling describes *how
 * many calls get served*. Making a provider re-run the tester because they
 * lowered `maxRps` would price the act we most want them to take freely — a
 * provider who cannot cheaply say "I can take less" answers `429` instead, and
 * a `429` lands on their own availability record.
 *
 * `timeoutMs` is the third ceiling and it IS in the set, which is the
 * asymmetry worth holding: a different deadline changes the outcome of a call
 * that was made, so a green tester run at the old deadline is not evidence
 * about the new one.
 *
 * **`settlementChains` is in the set and is NOT in {@link snapshotOf}**. It
 * belongs here for the reason `assetId` does: where a binding settles is a term
 * of the offer, and a reviewer approving a published revision must see it
 * change rather than find it moved underneath one they already approved. It is
 * absent from the snapshot because `binding_versions` has no column for it —
 * only `tool_bindings` has the column — so for now the two lists
 * deliberately do not agree, and the direction of the disagreement is the safe
 * one: the revision moves for a change the snapshot does not record, rather
 * than the snapshot recording a value no revision moved for. What that costs is
 * replay fidelity: a `binding_versions` row cannot say which chains revision N
 * was offered on. What a *settled* call actually settled on is on the payment
 * intent, which is the record a dispute argues over, so nothing about a dispute
 * becomes unanswerable — but the seam is real and closing it is a
 * `binding_versions.settlement_chains` column.
 */
const VERSIONED_FIELDS = [
  'endpoint',
  'requestMapping',
  'responseMapping',
  'pricingMode',
  'priceAmount',
  'assetId',
  'settlementChains',
  'timeoutMs',
  // T3: the contract majors served and the optional fields promised are terms
  // of the revision too — a new major needs a re-map and a green tester run
  // for that major (§7.5), and a newly promised field is checked on every
  // call, so neither may reach traffic without a publish.
  'toolVersionRange',
  'providesOutputFields',
  'supportsInputFields',
] as const;

/**
 * The binding editor.
 *
 * This is what decides whether the system can scale, and the reason is
 * arithmetic: before this, a binding could only be added by
 * an operator editing `TOOL_CATALOGUE_SEED_FILE`, so the rate at which supply
 * could grow was the rate at which we could do that by hand. Open registration
 * without this is a front door into a room with no furniture.
 *
 * Three things this class is careful about.
 *
 * **It validates with the router's own functions.** `inspectRequestMapping` /
 * `inspectResponseMapping` are what the mapping engine ships and what the call path runs;
 * Save adds no rules of its own. A mapping that saves and then fails at
 * dispatch would make the editor a liar, and a mapping the editor rejects and
 * the router would have accepted makes it an obstacle.
 *
 * **It stores the canonical form.** The shorthand a provider types (`"$.query"`
 * for a selector, `"en"` for a constant) is ambiguous the moment it is at rest
 * — a constant that genuinely starts with `$.` has two readings — so
 * `normalizeMappingNode` resolves it here, once, and nothing downstream ever
 * re-derives the question. Normalisation is idempotent, so an editor can load,
 * show and re-save a stored mapping unchanged.
 *
 * **A draft and a live binding are the same row.** Editing a published binding
 * raises the revision and leaves `published_version` behind; traffic keeps
 * being served by the published revision until the provider publishes again.
 * A separate "draft copy" table would need a merge, and a merge is where two
 * mappings become one nobody wrote.
 */
@Injectable()
export class BindingEditorService {
  private readonly logger = new Logger(BindingEditorService.name);

  constructor(
    private readonly bindings: ToolBindingRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(CHAIN_ENROLMENT_SOURCE) private readonly enrolments: ChainEnrolmentPort,
    @Inject(PROVIDER_STAKE_SOURCE) private readonly stakes: ProviderStakePort,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    @Inject(PROVIDER_MINIMUM_STAKE_BY_CHAIN)
    private readonly minimumStakeByChain: MinimumStakeByChain,
    @Inject(EGRESS_RELAY_CONFIG)
    private readonly relayConfig: EgressRelayConfig | null,
    // Lets a save refuse switching a live binding to an API-key mode without a
    // key for its live origin. Required: a missing vault module must fail at
    // boot rather than silently turn the guard off.
    private readonly vault: CredentialVaultService,
  ) {}

  /**
   * Check a mapping without saving it — what the console calls while the
   * provider types.
   *
   * Invalid mappings leave as `TOOL_MAPPING_INVALID` rather than as a `200`
   * carrying `valid: false`, because the pointer is the useful part and a
   * caller that forgets to branch on a boolean shows a green editor over a
   * broken mapping.
   */
  async validateMapping(body: ValidateMappingBodyDto): Promise<ValidateMappingResponseDto> {
    const context = body.toolId ? { toolId: body.toolId } : undefined;

    if (body.direction === MappingDirection.REQUEST) {
      const request = inspectRequestMapping(body.mapping, context);
      // The same header count, `x-assay-*`, secret-constant and credential
      // query checks the save runs, so the editor can say so as the provider
      // types. No endpoint here: only the mapping's own entries are checked.
      assertNoCredentialsInMapping('', request.spec);
      return {
        canonical: request.spec,
        selectors: [...request.selectors],
        transforms: [...request.transforms],
      };
    }

    const response = inspectResponseMapping(body.mapping, context);

    // The second half of "check types and required fields": a response mapping
    // that cannot satisfy the tool contract whatever comes back. Only possible
    // when the caller says which tool they are mapping — the console always
    // does, so this runs on every keystroke it sends.
    if (body.toolId) {
      const tool = await this.tool(body.toolId);
      checkResponseAgainstSchema(response.spec, tool.outputSchema, context);
    }

    return {
      canonical: response.spec,
      selectors: [...response.selectors],
      transforms: [...response.transforms],
    };
  }

  async create(
    organizationId: string,
    subject: string,
    body: SaveToolBindingBodyDto,
  ): Promise<SavedToolBindingDto> {
    this.assertEndpointRelayable(body.endpoint);
    const tool = await this.catalogue.findTool(body.toolId);
    // A provider tool's only implementation is its own provider's binding
    // (§7.6): anyone else's binding for it is refused exactly like a tool
    // that does not exist, so the id is no oracle either.
    if (!tool || !canBind(tool, organizationId)) {
      throw ProviderErrors.bindingToolUnknown({ toolId: body.toolId });
    }

    const context = { toolId: body.toolId, providerId: organizationId };
    const request = inspectRequestMapping(body.requestMapping, context);
    const requestMapping = request.spec;
    assertNoCredentialsInMapping(body.endpoint, requestMapping);
    const responseMapping = inspectResponseMapping(body.responseMapping, context).spec;
    // The contract half (T3): the majors served — the tool's current major
    // unless named — and the optional fields promised, checked against every
    // major in the range; the response mapping must write each major's core
    // fields plus the declared outputs.
    const terms = {
      toolVersionRange: body.toolVersionRange ?? defaultBindingRange(tool),
      providesOutputFields: dedupe(body.providesOutputFields ?? []),
      supportsInputFields: dedupe(body.supportsInputFields ?? []),
    };
    const toolVersionRange = assertBindingContract(
      tool,
      terms,
      { responseMapping, requestSelectors: request.selectors },
      context,
    );

    // Refused here rather than by `class-validator`, because the two facts are
    // one fact: an asset the platform does not know has no decimals, and a
    // price with no scale is not a price.
    assertKnownAsset(body.assetId);
    assertPriceMatchesMode(body.pricingMode, body.priceAmount);

    const row = new ToolBindingEntity();
    row.organizationId = organizationId;
    row.toolId = body.toolId;
    row.endpoint = body.endpoint;
    row.requestMapping = requestMapping;
    row.responseMapping = responseMapping;
    row.toolVersionRange = toolVersionRange;
    row.providesOutputFields = terms.providesOutputFields;
    row.supportsInputFields = terms.supportsInputFields;
    // No default (D10): the DTO requires an explicit choice.
    row.authMode = body.authMode;
    row.pricingMode = body.pricingMode;
    row.priceAmount = body.pricingMode === PricingMode.FREE ? '0' : body.priceAmount;
    row.assetId = body.assetId;
    // Whatever the provider declared. NOT `?? [chainIdOf(body.assetId)]`: a
    // default derived from the price would make the field look optional and
    // would silently offer a binding on the one chain its price happens to be
    // quoted in, which is the collapse the chain list exists to prevent. The DTO
    // requires the field, so an omission is a 400 and not a guess.
    row.settlementChains = body.settlementChains;
    row.freeQuotaPerAgent = body.freeQuotaPerAgent ?? null;
    row.freeDailyBudget = freeDailyBudgetColumn(body.freeDailyBudget ?? null);
    row.slaFailureRate = String(body.slaFailureRate);
    row.timeoutMs = body.timeoutMs;
    // `?? null` and not `?? 0`: an undeclared ceiling is the absence of one,
    // and `0` on this column would mean the provider declared themselves
    // unroutable. The DTO refuses `0` for that reason; this keeps the same
    // rule true of a body that simply omitted the field.
    row.maxRps = body.maxRps ?? null;
    row.maxDailyCalls = body.maxDailyCalls ?? null;
    // Never anything else. A binding that could be born `ACTIVE` would be a
    // path around the publish gate — see the `chk_tool_bindings_active_is_published`
    // constraint, which is the row refusing the same thing.
    row.status = BindingStatus.DRAFT;
    row.mappingVersion = 1;
    row.publishedVersion = null;
    row.publishedAt = null;

    await this.assertChainsRoutable(
      organizationId,
      row.settlementChains as ChainId[],
      row.pricingMode as PricingMode,
      row.priceAmount,
      row.assetId as AssetId,
      // No id yet — the row is inserted below. The id only reaches
      // `evaluateStakeGate`'s detail strings, and refusing before the insert is
      // the point: a gate that ran after it would leave the row behind.
      '(new)',
    );

    const saved = await this.inTransaction(async (manager) => {
      const inserted = await manager.save(ToolBindingEntity, row);
      await manager.save(BindingVersionEntity, snapshotOf(inserted, subject));
      return inserted;
    }, body.toolId);

    return toSavedDto(saved, null);
  }

  async update(
    organizationId: string,
    subject: string,
    bindingId: string,
    body: UpdateToolBindingBodyDto,
  ): Promise<SavedToolBindingDto> {
    const row = await this.loadEditable(organizationId, bindingId);

    // Taken **before** anything is mutated. The alternative — re-reading the
    // row after the edit — makes "did this change" depend on the repository
    // handing back a second, distinct instance, which is true of TypeORM today
    // and is not a property worth resting a revision number on.
    const before = versionedSnapshot(row);
    const chainsBefore = JSON.stringify(row.settlementChains);

    if (body.requestMapping !== undefined) {
      row.requestMapping = inspectRequestMapping(body.requestMapping, {
        toolId: row.toolId,
        bindingId: row.id,
        providerId: organizationId,
      }).spec;
    }

    if (body.requestMapping !== undefined || body.endpoint !== undefined) {
      assertNoCredentialsInMapping(body.endpoint ?? row.endpoint, row.requestMapping);
    }

    if (body.responseMapping !== undefined) {
      const context = { toolId: row.toolId, bindingId: row.id, providerId: organizationId };
      row.responseMapping = inspectResponseMapping(body.responseMapping, context).spec;
    }
    if (body.toolVersionRange !== undefined) row.toolVersionRange = body.toolVersionRange;
    if (body.providesOutputFields !== undefined) {
      row.providesOutputFields = dedupe(body.providesOutputFields);
    }
    if (body.supportsInputFields !== undefined) {
      row.supportsInputFields = dedupe(body.supportsInputFields);
    }
    // The contract check runs again whenever anything it reads changed: a
    // mapping, the range, or a declared field.
    if (
      body.requestMapping !== undefined ||
      body.responseMapping !== undefined ||
      body.toolVersionRange !== undefined ||
      body.providesOutputFields !== undefined ||
      body.supportsInputFields !== undefined
    ) {
      const context = { toolId: row.toolId, bindingId: row.id, providerId: organizationId };
      row.toolVersionRange = assertBindingContract(
        await this.tool(row.toolId),
        {
          toolVersionRange: row.toolVersionRange ?? '^1',
          providesOutputFields: row.providesOutputFields ?? [],
          supportsInputFields: row.supportsInputFields ?? [],
        },
        {
          responseMapping: row.responseMapping,
          requestSelectors: inspectRequestMapping(row.requestMapping, context).selectors,
        },
        context,
      );
    }

    if (body.assetId !== undefined) {
      assertKnownAsset(body.assetId);
      row.assetId = body.assetId;
    }

    // `undefined` leaves the list alone. There is no "clear it" spelling — the
    // DTO refuses `[]` and the row's CHECK refuses it again, because a binding
    // offered on no chain is unroutable in a way no screen explains.
    if (body.settlementChains !== undefined) row.settlementChains = body.settlementChains;
    if (body.endpoint !== undefined) {
      this.assertEndpointRelayable(body.endpoint);
      row.endpoint = body.endpoint;
    }
    // Outside `VERSIONED_FIELDS`: a descriptive setting, not a term of the revision.
    if (body.authMode !== undefined) row.authMode = body.authMode;
    if (body.pricingMode !== undefined) row.pricingMode = body.pricingMode;
    if (body.priceAmount !== undefined) row.priceAmount = body.priceAmount;
    if (body.freeQuotaPerAgent !== undefined) row.freeQuotaPerAgent = body.freeQuotaPerAgent;
    if (body.freeDailyBudget !== undefined) {
      row.freeDailyBudget = freeDailyBudgetColumn(body.freeDailyBudget);
    }
    if (body.slaFailureRate !== undefined) row.slaFailureRate = String(body.slaFailureRate);
    if (body.timeoutMs !== undefined) row.timeoutMs = body.timeoutMs;
    // `undefined` leaves the ceiling alone, `null` clears it. Assigned before
    // the revision comparison below and deliberately outside `VERSIONED_FIELDS`,
    // so a ceiling change writes the row and moves nothing else.
    if (body.maxRps !== undefined) row.maxRps = body.maxRps;
    if (body.maxDailyCalls !== undefined) row.maxDailyCalls = body.maxDailyCalls;
    if (row.pricingMode === PricingMode.FREE) row.priceAmount = '0';
    // After the merge, so `{ pricingMode: 'PAID' }` against a stored zero and
    // `{ priceAmount: '0' }` against a stored PAID are both caught.
    assertPriceMatchesMode(row.pricingMode as PricingMode, row.priceAmount);

    // Answered against what was read, not against what the caller sent: a
    // `PATCH` that re-sends the same endpoint is not an edit, and treating it
    // as one would invalidate a green tester run for nothing.
    // Only when the body named the list. An unrelated `PATCH` must not fail
    // because the provider's stake dipped since publication — noticing that is
    // the router's job, on every call, and making it the editor's would leave a
    // provider unable to fix a typo in their endpoint during an outage.
    if (body.settlementChains !== undefined) {
      await this.assertChainsRoutable(
        organizationId,
        row.settlementChains as ChainId[],
        row.pricingMode as PricingMode,
        row.priceAmount,
        row.assetId as AssetId,
        row.id,
      );
    }

    if (body.authMode !== undefined) {
      await this.assertLiveCredentials(organizationId, row, body.authMode);
    }

    const changed = versionedSnapshot(row) !== before;
    const chainsChanged = JSON.stringify(row.settlementChains) !== chainsBefore;

    const saved = await this.inTransaction(async (manager) => {
      // Locked and re-read before the write: a draft discarded since the
      // read above (`DELETE …/tool-bindings/:id`) is a 404, not re-created
      // by `save` inserting a row it no longer finds.
      const current = await manager.findOne(ToolBindingEntity, {
        where: { organizationId, id: row.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) throw ProviderErrors.bindingNotFound({ bindingId: row.id });
      let revised = false;
      if (changed) {
        // An edit that lands back on the published terms is not a draft. It
        // returns to the published revision, whose tester run is still green,
        // instead of minting a revision that differs from it in nothing.
        const published = chainsChanged ? null : await publishedRevision(manager, row);
        if (published && sameTerms(row, published)) {
          row.mappingVersion = published.mappingVersion;
        } else {
          // Past the highest stored revision, not `+ 1`: after a return to
          // the published one, the abandoned draft's number is still taken.
          const highest = await manager.maximum(BindingVersionEntity, 'mappingVersion', {
            organizationId: row.organizationId,
            bindingId: row.id,
          });
          row.mappingVersion = Math.max(highest ?? 0, row.mappingVersion) + 1;
          revised = true;
        }
      }
      const updated = await manager.save(ToolBindingEntity, row);
      if (revised) {
        await manager.save(BindingVersionEntity, snapshotOf(updated, subject));
      }
      return {
        row: updated,
        publishedEndpoint: await publishedEndpointOf(
          { findOne: (options) => manager.findOne(BindingVersionEntity, options) },
          updated,
        ),
      };
    }, row.toolId);

    return toSavedDto(saved.row, saved.publishedEndpoint);
  }

  /**
   * With the relay configured, an endpoint it cannot carry (not https, an IP
   * literal, a port it cannot reach) is refused at Save.
   */
  private assertEndpointRelayable(endpoint: string): void {
    assertRelayableEndpoint(endpoint, Boolean(this.relayConfig));
  }

  /**
   * Throws `credentialsRequiredForAuthMode` when `authMode` needs a key and the
   * published (ACTIVE or PAUSED) binding has no credential set for the origin of
   * its published endpoint. The live address is the published revision's;
   * without a set for it every live call would be a platform fault. Shared by
   * the auth-mode switch and the resume, which puts the binding back on that
   * address.
   */
  async assertLiveCredentials(
    organizationId: string,
    row: ToolBindingEntity,
    authMode: string,
  ): Promise<void> {
    if (
      !authModeNeedsKey(authMode) ||
      row.publishedVersion == null ||
      (row.status !== BindingStatus.ACTIVE && row.status !== BindingStatus.PAUSED)
    ) {
      return;
    }
    const published = await this.publishedEndpoint(row);
    if (!published) return;
    const sets = await this.vault.list(organizationId, row.id);
    if (!sets.some((set) => set.origin === originOf(published))) {
      throw ProviderErrors.credentialsRequiredForAuthMode();
    }
  }

  /** The endpoint of the published revision, or null when never published. */
  async publishedEndpoint(row: ToolBindingEntity): Promise<string | null> {
    return publishedEndpointOf(
      { findOne: (options) => this.dataSource.manager.findOne(BindingVersionEntity, options) },
      row,
    );
  }

  /**
   * The write-time half of the routability invariant.
   *
   * Three questions, in this order, and the order decides which refusal a
   * provider sees when several apply:
   *
   *   1. does this deployment offer the chain at all?   — not about them
   *   2. do they hold an ACTIVE enrolment on it?        — fixed by a signature
   *   3. is the collateral there?                       — fixed by a transfer
   *
   * Same doctrine `filterEligible` follows: report the condition the subject
   * cannot fix by moving money before the one they can.
   *
   * **This check does not make the list trustworthy.** It is true at write time
   * and can be false ten minutes later — a provider may unstake, or be slashed,
   * without touching the binding. The router re-reads the stake on every
   * decision for exactly that reason, and this gate exists to make the refusal
   * *legible* at the moment it is asked for, not to spare the router the work.
   */
  private async assertChainsRoutable(
    organizationId: string,
    settlementChains: readonly ChainId[],
    pricingMode: PricingMode,
    priceAmount: string,
    assetId: AssetId,
    bindingId: string,
  ): Promise<void> {
    for (const chainId of settlementChains) {
      if (!this.enabledChains.includes(chainId)) {
        throw ProviderErrors.bindingChainNotEnabled({
          chainId,
          enabled: this.enabledChains.join(', '),
        });
      }
    }

    const enrolments = await this.enrolments.enrolmentsOf([organizationId]);
    for (const chainId of settlementChains) {
      const enrolment = enrolments.get(enrolmentKey(organizationId, chainId));
      if (!enrolment || enrolment.status !== ChainEnrolmentStatus.ACTIVE) {
        throw ProviderErrors.bindingChainNotEnrolled({ chainId });
      }
    }

    // A FREE binding settles nothing, so there is no collateral to require —
    // the same exemption `evaluateStakeGate` and `evaluatePayoutGate` grant,
    // and for the same reason. FREEMIUM is NOT exempt.
    if (pricingMode === PricingMode.FREE) return;

    const stakes = await this.stakes.stakeOn(
      settlementChains.map((chainId) => ({ providerId: organizationId, chainId })),
    );

    for (const chainId of settlementChains) {
      const parameters = this.minimumStakeByChain.get(chainId);
      if (!parameters) {
        // Cannot happen: `loadMinimumStakeByChain` asserts a floor for every
        // enabled chain at boot, and step 1 above already refused a chain that
        // is not enabled. Refused rather than skipped, because "we could not
        // work out whether to admit this" must never mean "admit it".
        throw ProviderErrors.bindingChainStakeBelowMinimum({
          chainId,
          detail: 'no minimum stake is configured for this chain',
        });
      }

      // The same pure function the router uses, on a candidate built from the
      // values being saved. One implementation of "is this staked enough",
      // called from both gates — a second copy here would drift, and the drift
      // would show up as a binding that publishes and does not route.
      const reading = stakes.get(stakeKey(organizationId, chainId));
      const verdict = evaluateStakeGate(
        {
          binding: { id: bindingId, pricingMode, priceAmount, assetId } as ToolBinding,
          provider: { providerId: organizationId } as ProviderRoutingState,
          stakeByChain: reading ? new Map([[chainId, reading]]) : new Map(),
          stakeGraceUntil: null,
          observedCalls: null,
          ceilingHit: null,
          settlementChains: [chainId],
        } as RoutingCandidate,
        chainId,
        parameters,
      );

      if (verdict.passed === false) {
        throw ProviderErrors.bindingChainStakeBelowMinimum({ chainId, detail: verdict.detail });
      }
    }
  }

  private async tool(toolId: string): Promise<Tool> {
    const tool = await this.catalogue.findTool(toolId);
    if (!tool) throw ProviderErrors.bindingToolUnknown({ toolId });
    return tool;
  }

  /** The row, or the 404/409 that says why it may not be edited. */
  async loadEditable(organizationId: string, bindingId: string): Promise<ToolBindingEntity> {
    const row = await this.bindings.findOne({ where: { organizationId, id: bindingId } });

    if (!row) {
      throw ProviderErrors.bindingNotFound({ bindingId });
    }

    // `SUSPENDED` is the platform's action, not the provider's — `PAUSED` is
    // theirs. Letting an edit clear a suspension would make the state
    // a suggestion.
    if (row.status === BindingStatus.SUSPENDED) {
      throw ProviderErrors.bindingNotEditable({ bindingId, status: row.status });
    }

    return row;
  }

  /**
   * The binding row and its snapshot, or neither.
   *
   * `manager` rather than the repositories, for the reason
   * `ProviderPayoutAddressService.consumeAndStore` gives: an
   * `OrganizationScopedRepository` is bound to the global connection and
   * cannot be rebound onto a transaction. `organizationId` is set on both
   * entities before they get here, so nothing is written unscoped.
   */
  private async inTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
    toolId: string,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION_CODE) {
        // `uq_tool_bindings_organization_tool`. Decided by Postgres rather
        // than by a read-then-write two requests can interleave.
        this.logger.warn(`Duplicate binding refused for tool ${toolId}`);
        throw ProviderErrors.bindingAlreadyExists({ toolId });
      }
      throw error;
    }
  }
}

/**
 * The versioned fields, as one comparable string.
 *
 * A string rather than a structural diff because the only question is "did any
 * of these change", and `JSON.stringify` over a fixed key order answers it for
 * the two `jsonb` mappings and the five scalars alike.
 */
function versionedSnapshot(row: ToolBindingEntity): string {
  return JSON.stringify(VERSIONED_FIELDS.map((field) => termOf(row, field)));
}

/** A versioned field, with the T3 contract terms read at their column defaults when unset. */
function termOf(row: ToolBindingEntity, field: (typeof VERSIONED_FIELDS)[number]): unknown {
  if (field === 'toolVersionRange') return row.toolVersionRange ?? '^1';
  if (field === 'providesOutputFields' || field === 'supportsInputFields') {
    return [...(row[field] ?? [])].sort();
  }
  return row[field];
}

/**
 * The published revision's snapshot, when the row is a draft on top of one.
 *
 * `null` for a binding never published or already at its published revision:
 * there is nothing to return to.
 */
async function publishedRevision(
  manager: EntityManager,
  row: ToolBindingEntity,
): Promise<BindingVersionEntity | null> {
  if (row.publishedVersion == null || row.publishedVersion === row.mappingVersion) {
    return null;
  }
  return manager.findOne(BindingVersionEntity, {
    where: {
      organizationId: row.organizationId,
      bindingId: row.id,
      mappingVersion: row.publishedVersion,
    },
  });
}

/**
 * Whether the row offers exactly the terms a snapshot recorded — every field
 * {@link snapshotOf} copies. `canonicalJson`, because `jsonb` hands mappings
 * back with its own key order.
 *
 * `settlementChains` has no snapshot column, so the caller only asks this when
 * the edit left the chains alone.
 */
function sameTerms(row: ToolBindingEntity, snapshot: BindingVersionEntity): boolean {
  const terms = (source: ToolBindingEntity | BindingVersionEntity) =>
    canonicalJson([
      source.endpoint,
      source.requestMapping,
      source.responseMapping,
      source.pricingMode,
      String(source.priceAmount),
      source.assetId,
      source.timeoutMs,
      source.toolVersionRange ?? '^1',
      [...(source.providesOutputFields ?? [])].sort(),
      [...(source.supportsInputFields ?? [])].sort(),
    ]);
  return terms(row) === terms(snapshot);
}

function assertKnownAsset(assetId: string): void {
  // Throws `CHAIN_ASSET_NOT_REGISTERED` when it is not one of ours, which is a
  // better message than anything this module could invent for the same fact.
  getAssetMetadata(assetId as AssetId);
}

/**
 * The immutable record of one revision.
 *
 * Every field is copied rather than joined. A snapshot that read the price
 * back off `tool_bindings` would report today's price for a call served last
 * month, and the price in force is precisely what a settlement dispute argues
 * over.
 */
function snapshotOf(row: ToolBindingEntity, authoredBy: string): BindingVersionEntity {
  const snapshot = new BindingVersionEntity();
  snapshot.organizationId = row.organizationId;
  snapshot.bindingId = row.id;
  snapshot.mappingVersion = row.mappingVersion;
  snapshot.toolId = row.toolId;
  snapshot.endpoint = row.endpoint;
  snapshot.requestMapping = row.requestMapping;
  snapshot.responseMapping = row.responseMapping;
  snapshot.pricingMode = row.pricingMode;
  snapshot.priceAmount = row.priceAmount;
  snapshot.assetId = row.assetId;
  snapshot.timeoutMs = row.timeoutMs;
  snapshot.toolVersionRange = row.toolVersionRange ?? '^1';
  snapshot.providesOutputFields = [...(row.providesOutputFields ?? [])];
  snapshot.supportsInputFields = [...(row.supportsInputFields ?? [])];
  snapshot.authoredBy = authoredBy;
  snapshot.publishedAt = null;
  snapshot.publishedBy = null;
  return snapshot;
}

/**
 * The save response, which is the detail shape.
 *
 * It was a second, hand-copied mapper for as long as `publishedVersion` and
 * `hasUnpublishedChanges` lived only on `SavedToolBindingDto`. They are on
 * `ToolBindingDetailDto` now, so the two shapes are one shape and this is a
 * delegation rather than a duplicate — one function computes
 * `hasUnpublishedChanges`, and the editor and the detail read cannot answer it
 * differently.
 *
 * Kept as a name rather than folded into its call sites: `binding-publish` and
 * `binding-pause` both spread it, and renaming the import in three services buys
 * nothing.
 *
 * The annotation is what makes the delegation safe, so do not drop it. It is
 * wider than `toDetailDto`'s own return type, and that assignment only compiles
 * while `SavedToolBindingDto` stays structurally identical to its parent. Give
 * the subclass one real field and TypeScript raises `TS2322` **on this line** —
 * so a save-only field cannot be added and silently left unset; the build stops
 * until someone writes a real body here.
 */
export const toSavedDto: (
  row: ToolBindingEntity,
  publishedEndpoint: string | null,
) => SavedToolBindingDto = toDetailDto;

/**
 * Refuses more than {@link MAX_MAPPING_HEADERS} mapping headers (the relay's
 * per-request cap, less what Assay adds); credentials in the endpoint query,
 * constant query entries, and secret-looking constant headers; and any header
 * in Assay's `x-assay-` namespace, which the invoker also drops on the way out.
 */
function assertNoCredentialsInMapping(endpoint: string, mapping: RequestMappingSpec): void {
  const count = mappingHeaderCount(mapping);
  if (count > MAX_MAPPING_HEADERS) {
    throw ProviderErrors.tooManyMappingHeaders({ count, max: MAX_MAPPING_HEADERS });
  }
  const reserved = assayMappingHeaders(mapping);
  if (reserved.length > 0) throw ProviderErrors.reservedMappingHeader({ headers: reserved });
  const keys = credentialQueryKeys(endpoint, mapping);
  if (keys.length > 0) throw ProviderErrors.credentialInQuery({ keys });
  const headers = secretConstantHeaders(mapping);
  if (headers.length > 0) throw ProviderErrors.secretInMapping({ headers });
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** `FREE` is the only mode allowed to cost nothing; `PAID` and `FREEMIUM` both charge past the free tier. */
function assertPriceMatchesMode(pricingMode: PricingMode, priceAmount: string): void {
  if (pricingMode !== PricingMode.FREE && BigInt(priceAmount) <= 0n) {
    throw ProviderErrors.bindingPriceNotPositive({ pricingMode });
  }
}

/**
 * `free_daily_budget` is a call count (free calls per day across all agents) kept in
 * its original `numeric(78,0)` column, which TypeORM reads and writes as a string.
 * The DTO already bounds it to a positive int4, so the string is always exact.
 */
function freeDailyBudgetColumn(calls: number | null): string | null {
  return calls === null ? null : String(calls);
}
