import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { ToolsetVersionRepository } from '@database/postgres/repositories/toolset-sharing.repository';
import { ToolsetRepository } from '@database/postgres/repositories/toolset.repository';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { chainMetadata } from '@modules/chains/chain-metadata';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import {
  AccessFields,
  SpendPolicyService,
} from '@modules/spend-policy/services/spend-policy.service';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, categoryOf, isListedTool, isVisibleToOrg } from '@modules/tool/ports/tool.types';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { AuditActor, AuditLogWriter } from '@shared/audit';

import { AccessMode, AllowedToolsetRef, readAllowedToolsets, toolStanding } from '../domain/access';
import { McpPathKind } from '../domain/mcp-url';
import {
  AgentAccessDto,
  AllowedToolsetDto,
  AllowedToolsetInputDto,
  CredentialAccessDto,
  OnlyConnectedResultDto,
  UpdateAgentAccessBodyDto,
  UpdateCredentialAccessBodyDto,
} from '../dto/agent-access.dto';
import { ToolsetErrors } from '../errors/toolset.errors';
import { OFFICIAL_HANDLE } from '../domain/handle';
import {
  SharedPathKind,
  listedInCatalogue,
  newestServed,
  sharedPathFor,
  versionServes,
} from '../domain/sharing';
import { pinPathOf, pinReaches } from '../domain/pin';
import { HandlesService } from './handles.service';
import { sharingStateOf } from './sharing-row';
import { AccessEpochService } from './access-epoch.service';
import { AccessResolver, agentRulesOf } from './access.resolver';
import { ConnectUrlsService, ServerInUseRow } from './connect-urls.service';
import { TOOLSET_LIMITS } from './toolsets.service';

/**
 * "What this agent can use": the access policy, the agent rules and the
 * pinned tools (design spec §7.7, `GET/PATCH /agents/:id/access`), and the
 * per-key narrowing (`PATCH /agent-credentials/:id/access`, API only).
 *
 * Written as a new spend-policy version at the agent's scope, so it has the
 * same history, audit entry and `policy_version` as every other limit, and
 * every write bumps the organization's access epoch — the next call on every
 * MCP instance sees it (NFR-1).
 *
 * An agent of another organization, or a credential of one, is a 404.
 */
@Injectable()
export class AgentAccessService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly policies: SpendPolicyRepository,
    private readonly spendPolicy: SpendPolicyService,
    private readonly enforcement: SpendPolicyEnforcementService,
    private readonly toolsets: ToolsetRepository,
    private readonly tools: ToolRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
    private readonly quotes: QuoteIndexService,
    private readonly resolver: AccessResolver,
    private readonly epochs: AccessEpochService,
    private readonly connectUrls: ConnectUrlsService,
    private readonly audit: AuditLogWriter,
    private readonly config: ConfigService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(ENABLED_CHAINS) private readonly enabledChains: readonly ChainId[],
    private readonly versions: ToolsetVersionRepository,
    private readonly handles: HandlesService,
  ) {}

  /** `readerAgentId`: a machine credential's own agent, which is all it may read. */
  async get(
    organizationId: string,
    agentId: string,
    readerAgentId: string | null = null,
  ): Promise<AgentAccessDto> {
    if (readerAgentId !== null && readerAgentId !== agentId) {
      throw AccountErrors.agentNotFound({ agentId });
    }
    const agent = await this.requireAgent(organizationId, agentId);
    const policy = await this.policies.findLive(organizationId, agentId);
    return this.toDto(organizationId, agentId, policy, this.chainOf(agent.chainId));
  }

  async patch(
    organizationId: string,
    agentId: string,
    body: UpdateAgentAccessBodyDto,
    actor: AuditActor,
  ): Promise<AgentAccessDto> {
    const agent = await this.requireAgent(organizationId, agentId);
    const current = await this.policies.findLive(organizationId, agentId);
    const access = await this.validateAccess(
      organizationId,
      body,
      readAllowedToolsets(current?.allowedToolsets),
    );
    await this.write(
      organizationId,
      agentId,
      this.chainOf(agent.chainId),
      access,
      body.changeReason,
      actor,
    );
    return this.get(organizationId, agentId);
  }

  /**
   * "Only what's connected" (§7.7): RESTRICTED to the toolsets behind the
   * agent's servers in use, following their Draft with `viaUrlOnly` on, plus
   * the tools named in their `?tools=` and `?category=` filters. A plain `/`
   * among them means everything, so access stays ALL and `everything` says so.
   */
  async onlyConnected(
    organizationId: string,
    agentId: string,
    actor: AuditActor,
  ): Promise<OnlyConnectedResultDto> {
    const agent = await this.requireAgent(organizationId, agentId);
    const servers = await this.connectUrls.serversInUse(organizationId, agentId);
    const catalogue = await this.catalogue.listTools();

    let everything = false;
    const toolsetRefs: AllowedToolsetRef[] = [];
    const candidates: ServerInUseRow[] = [];
    const toolIds = new Set<string>();
    for (const server of servers) {
      const { path, filter } = server.parsed;
      const narrowed = filter.tools !== null || filter.categories !== null;
      if (path.kind === McpPathKind.ROOT && !narrowed) {
        everything = true;
        continue;
      }
      if (path.kind === McpPathKind.ROOT) {
        const names = new Set(filter.tools?.map((selector) => selector.name) ?? []);
        const categories = new Set(filter.categories ?? []);
        // `/` serves the LISTED catalogue only.
        for (const tool of catalogue.filter(isListedTool)) {
          const byName = filter.tools === null || names.has(tool.name);
          const byCategory = filter.categories === null || categories.has(categoryOf(tool));
          if (byName && byCategory) toolIds.add(tool.id);
        }
        continue;
      }
      if (server.toolsetId && !toolsetRefs.some((ref) => ref.toolsetId === server.toolsetId)) {
        candidates.push(server);
      }
    }
    toolsetRefs.push(...(await this.connectedRefs(organizationId, candidates)));

    const access: Partial<AccessFields> = everything
      ? { accessMode: AccessMode.ALL }
      : {
          accessMode: AccessMode.RESTRICTED,
          allowedToolsets: toolsetRefs,
          allowedToolIds: [...toolIds],
        };
    await this.write(
      organizationId,
      agentId,
      this.chainOf(agent.chainId),
      access,
      'only what is connected',
      actor,
    );
    return { ...(await this.get(organizationId, agentId)), everything };
  }

  /**
   * The toolsets behind servers in use, pinned to the versions those URLs
   * serve (§7.7). Own: as the URL says (Draft, or `@n`). Official: as the URL
   * says (latest, or `@n`). Another organization's: pinned to the URL's
   * version, else the version its calls were served, else the last shared one
   * — and only when the agent actually called through it or the organization
   * can see it now, so a handed-out URL naming somebody's private toolset
   * grants and reveals nothing.
   */
  private async connectedRefs(
    organizationId: string,
    servers: readonly ServerInUseRow[],
  ): Promise<AllowedToolsetRef[]> {
    const found = new Map(
      (await this.toolsets.findAnyByIds(servers.map((s) => s.toolsetId as string))).map((t) => [
        t.id,
        t,
      ]),
    );
    const now = new Date();
    const refs: AllowedToolsetRef[] = [];
    for (const server of servers) {
      const toolset = found.get(server.toolsetId as string);
      if (!toolset || toolset.removedAt) continue;
      if (refs.some((ref) => ref.toolsetId === toolset.id)) continue;
      if (toolset.ownerOrgId === organizationId) {
        if (toolset.deletedAt) continue;
        refs.push({ toolsetId: toolset.id, version: server.toolsetVersion, viaUrlOnly: true });
        continue;
      }
      if (!(await this.handles.ownerHandleActive(toolset.ownerOrgId))) continue;
      const { path } = server.parsed;
      const pathVersion = 'version' in path ? (path as { version: number | null }).version : null;
      const token = path.kind === McpPathKind.UNLISTED_TOOLSET ? path.token : undefined;
      // How this pin reaches the toolset: through its link or its `/@…` URL.
      const taken =
        toolset.ownerOrgId === null ? {} : pinPathOf(token ? 'UNLISTED' : 'PUBLIC', token);
      if (server.lastCallAt !== null && server.toolsetVersion !== null) {
        // It was served to this agent through a shared URL: pin what it got
        // (an Official set followed at its latest when the URL followed it).
        const version =
          toolset.ownerOrgId === null && pathVersion === null ? null : server.toolsetVersion;
        refs.push({ toolsetId: toolset.id, version, viaUrlOnly: true, ...taken });
        continue;
      }
      // Only handed out: it must be shared to this organization now, and the
      // pinned version one that was shared that way.
      const kind = sharedPathFor(sharingStateOf(toolset), token, now);
      if (!kind) continue;
      if (toolset.ownerOrgId === null && pathVersion === null) {
        refs.push({ toolsetId: toolset.id, version: null, viaUrlOnly: true });
        continue;
      }
      const version = pathVersion ?? newestServed(toolset, kind);
      const row = version ? await this.versions.findVersion(toolset.id, version) : null;
      if (!row || !versionServes(row.sharedAs, kind)) continue;
      refs.push({ toolsetId: toolset.id, version: row.version, viaUrlOnly: true, ...taken });
    }
    return refs;
  }

  async getCredential(organizationId: string, credentialId: string): Promise<CredentialAccessDto> {
    const credential = await this.requireCredential(organizationId, credentialId);
    return this.toCredentialDto(organizationId, credential);
  }

  /** A key can only narrow: its grant is intersected with its agent's (`accessAllows`). */
  async patchCredential(
    organizationId: string,
    credentialId: string,
    body: UpdateCredentialAccessBodyDto,
    actor: AuditActor,
  ): Promise<CredentialAccessDto> {
    const credential = await this.requireCredential(organizationId, credentialId);

    // An omitted field keeps its value; `accessMode: null` (or ALL) removes
    // the narrowing whole.
    const mode = body.accessMode === undefined ? credential.accessMode : body.accessMode;
    const values =
      mode === AccessMode.RESTRICTED
        ? {
            accessMode: AccessMode.RESTRICTED,
            allowedToolsets:
              body.allowedToolsets === undefined
                ? readAllowedToolsets(credential.allowedToolsets)
                : await this.validateToolsets(
                    organizationId,
                    body.allowedToolsets ?? [],
                    readAllowedToolsets(credential.allowedToolsets),
                  ),
            allowedToolIds:
              body.allowedToolIds === undefined
                ? (credential.allowedToolIds ?? [])
                : await this.validateToolIds(organizationId, body.allowedToolIds ?? []),
          }
        : { accessMode: null, allowedToolsets: null, allowedToolIds: null };

    await this.dataSource.transaction(async (manager) => {
      await manager.update(AgentCredentialEntity, { organizationId, id: credential.id }, values);
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'credential.access_updated',
        resourceType: 'agent_credential',
        resourceId: credential.id,
        before: {
          accessMode: credential.accessMode,
          allowedToolsets: credential.allowedToolsets,
          allowedToolIds: credential.allowedToolIds,
        },
        after: values as Record<string, unknown>,
      });
    });
    await this.epochs.bump(organizationId);

    return this.getCredential(organizationId, credential.id);
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  private async write(
    organizationId: string,
    agentId: string,
    chainId: ChainId,
    access: Partial<AccessFields>,
    changeReason: string | undefined,
    actor: AuditActor,
  ): Promise<void> {
    // A policy row always exists under an agent's own: the first write at
    // this scope inherits every limit from the organization default, which is
    // seeded here from the documented defaults if this organization has never
    // made a call — never an uncapped agent row.
    const asset = chainMetadata(chainId).settlementAsset as AssetId;
    await this.enforcement.ensureOrganizationDefault(
      organizationId,
      asset,
      getAssetMetadata(asset).decimals,
    );
    await this.spendPolicy.patch(organizationId, agentId, { changeReason }, actor, access);
    await this.epochs.bump(organizationId);
  }

  private async validateAccess(
    organizationId: string,
    body: UpdateAgentAccessBodyDto,
    held: readonly AllowedToolsetRef[],
  ): Promise<Partial<AccessFields>> {
    // Omitted keeps a value; a `null` list clears it; `accessMode` has no null.
    const access: Partial<AccessFields> = {};
    if (body.accessMode !== undefined && body.accessMode !== null) {
      access.accessMode = body.accessMode;
    }
    if (body.allowedToolsets !== undefined) {
      access.allowedToolsets = await this.validateToolsets(
        organizationId,
        body.allowedToolsets ?? [],
        held,
      );
    }
    if (body.allowedToolIds !== undefined) {
      access.allowedToolIds = await this.validateToolIds(organizationId, body.allowedToolIds ?? []);
    }
    if (body.pinnedTools !== undefined) {
      access.pinnedTools = await this.validatePinned(organizationId, body.pinnedTools ?? []);
    }
    if (body.rules) {
      const { rules } = body;
      if (rules.excludeProviderIds !== undefined) {
        access.ruleExcludeProviderIds = [...new Set(rules.excludeProviderIds ?? [])];
      }
      if (rules.maxPrice !== undefined) access.ruleMaxPrice = rules.maxPrice;
      if (rules.minTier !== undefined) access.ruleMinTier = rules.minTier;
      if (rules.minQuality !== undefined) {
        access.ruleMinQuality = rules.minQuality === null ? null : String(rules.minQuality);
      }
    }
    return access;
  }

  /**
   * The pinned-access rules (design spec §7.7, FR-3):
   *
   * - your own live toolset: follow its Draft (`version: null`) or pin a
   *   published version;
   * - an Official toolset that is listed: follow its latest or pin one;
   * - another organization's: pinned only, to a version published while it
   *   was shared, and only when this organization can see it — PUBLIC and
   *   listed (or in its public grace period), or link-only with the link's
   *   current token. Anything else is the same "unknown" as a missing id.
   *
   * A reference already held, unchanged (same toolset and version), is kept
   * as it is even when its toolset was deleted or stopped being shared since:
   * editing another field never silently drops it.
   */
  private async validateToolsets(
    organizationId: string,
    input: readonly AllowedToolsetInputDto[],
    held: readonly AllowedToolsetRef[] = [],
  ): Promise<AllowedToolsetRef[]> {
    const byId = new Map<string, AllowedToolsetInputDto>();
    for (const ref of input) byId.set(ref.toolsetId, ref);
    const ids = [...byId.keys()];
    const found = new Map(
      (await this.toolsets.findAnyByIds(ids)).map((toolset) => [toolset.id, toolset]),
    );
    const now = new Date();

    const unknown: string[] = [];
    const unpinned: string[] = [];
    const noVersion: string[] = [];
    const out: AllowedToolsetRef[] = [];
    for (const id of ids) {
      const ref = byId.get(id) as AllowedToolsetInputDto;
      const version = ref.version ?? null;
      const viaUrlOnly = ref.viaUrlOnly !== false;
      // A link sent again is a fresh proof, so the pin is taken anew with it.
      const kept =
        ref.unlistedToken === undefined
          ? held.find((h) => h.toolsetId === id && h.version === version)
          : undefined;
      if (kept) {
        // Unchanged: it keeps how it was taken.
        out.push({ ...kept, viaUrlOnly });
        continue;
      }

      const toolset = found.get(id);
      const own = toolset?.ownerOrgId === organizationId;
      const official = toolset !== undefined && toolset.ownerOrgId === null;
      if (!toolset || toolset.deletedAt || toolset.removedAt) {
        unknown.push(id);
        continue;
      }
      let path: SharedPathKind | null = null;
      if (!own) {
        const state = sharingStateOf(toolset);
        path = official
          ? listedInCatalogue(state)
            ? 'PUBLIC'
            : null
          : sharedPathFor(state, ref.unlistedToken, now);
        // A frozen handle stops every way into its organization's toolsets,
        // by id as much as by URL.
        if (!path || !(await this.handles.ownerHandleActive(toolset.ownerOrgId))) {
          unknown.push(id);
          continue;
        }
        if (version === null && !official) {
          unpinned.push(id);
          continue;
        }
      }
      if (version !== null) {
        // Another organization pins only a version shared the way it sees the
        // toolset: never a PRIVATE one, never an UNLISTED one without the link.
        const newest = path ? newestServed(toolset, path) : toolset.latestVersion;
        const row =
          newest && version <= newest ? await this.versions.findVersion(id, version) : null;
        if (!row || (path && !versionServes(row.sharedAs, path))) {
          noVersion.push(id);
          continue;
        }
      }
      out.push(
        own || official || !path
          ? { toolsetId: id, version, viaUrlOnly }
          : { toolsetId: id, version, viaUrlOnly, ...pinPathOf(path, ref.unlistedToken) },
      );
    }

    if (unknown.length > 0) {
      throw ToolsetErrors.accessInvalid({ reason: 'unknown tool sets', toolsetIds: unknown });
    }
    if (unpinned.length > 0) {
      throw ToolsetErrors.accessInvalid({
        reason: "another organization's tool set is allowed at a pinned version only; set version",
        toolsetIds: unpinned,
      });
    }
    if (noVersion.length > 0) {
      throw ToolsetErrors.accessInvalid({
        reason: 'a tool set version does not exist',
        toolsetIds: noVersion,
      });
    }
    return out;
  }

  /**
   * Tools an access policy may name: LISTED ones and the organization's own
   * provider tools. Another organization's PRIVATE or UNLISTED provider tool
   * is reached through its provider's toolset URL only (§7.6), so naming it
   * here is the same "unknown tools" as a tool that does not exist.
   */
  private async validateToolIds(
    organizationId: string,
    toolIds: readonly string[],
  ): Promise<string[]> {
    const ids = [...new Set(toolIds)];
    const known = new Set(
      (await this.tools.findByIds(ids))
        .filter((tool) =>
          isVisibleToOrg(tool as Pick<Tool, 'visibility' | 'ownerOrgId'>, organizationId),
        )
        .map((tool) => tool.id),
    );
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw ToolsetErrors.accessInvalid({ reason: 'unknown tools', toolIds: unknown });
    }
    return ids;
  }

  private async validatePinned(
    organizationId: string,
    pinned: readonly string[],
  ): Promise<string[]> {
    const names = [...new Set(pinned)];
    if (names.length > TOOLSET_LIMITS.pinnedTools) {
      throw ToolsetErrors.limitExceeded({ limit: 'pinnedTools', max: TOOLSET_LIMITS.pinnedTools });
    }
    const known = new Set(
      (await this.catalogue.listTools())
        .filter((tool) => isVisibleToOrg(tool, organizationId))
        .map((tool) => tool.name),
    );
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw ToolsetErrors.accessInvalid({ reason: 'unknown pinned tools', tools: unknown });
    }
    return names;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  private async toDto(
    organizationId: string,
    agentId: string,
    policy: SpendPolicyEntity | null,
    chainId: ChainId,
  ): Promise<AgentAccessDto> {
    const refs = readAllowedToolsets(policy?.allowedToolsets);
    const rules = agentRulesOf(policy);
    return {
      agentId,
      scope: !policy ? 'DEFAULT' : policy.agentId === null ? 'ORGANIZATION' : 'AGENT',
      policyVersion: policy?.policyVersion ?? null,
      accessMode: (policy?.accessMode as AccessMode) ?? AccessMode.ALL,
      allowedToolsets: await this.describeToolsets(organizationId, refs),
      allowedToolIds: policy?.allowedToolIds ?? [],
      rules: {
        excludeProviderIds: rules?.excludeProviderIds ? [...rules.excludeProviderIds] : [],
        maxPrice: rules?.maxPrice ?? null,
        minTier: rules?.minTier ?? null,
        minQuality: rules?.minQuality ?? null,
      },
      pinnedTools: policy?.pinnedTools ?? [],
      tools: await this.toolEffects(organizationId, agentId, chainId),
    };
  }

  /** Per listed tool: whether the agent may call it, and how many providers its rules leave. */
  private async toolEffects(
    organizationId: string,
    agentId: string,
    chainId: ChainId,
  ): Promise<AgentAccessDto['tools']> {
    const [access, all] = await Promise.all([
      this.resolver.resolveFor(organizationId, agentId, null),
      this.catalogue.listTools(),
    ]);
    // Per tool this organization can see: LISTED ones and its own.
    const tools = all.filter((tool) => isVisibleToOrg(tool, organizationId));
    const context = {
      payerChains: this.enabledChains,
      withdrawingChains: [],
      defaultChainId: chainId,
      enabledChains: this.enabledChains,
    };
    const ids = tools.map((tool) => tool.id);
    const [total, left] = await Promise.all([
      this.quotes.quoteMany(ids, () => context),
      this.quotes.quoteMany(ids, () => ({
        ...context,
        rules: { agent: access.rules, entry: null },
      })),
    ]);
    return tools.map((tool) => ({
      toolId: tool.id,
      name: tool.name,
      category: categoryOf(tool),
      access: toolStanding(access, tool.id),
      providersTotal: total.get(tool.id)?.routableBindings ?? 0,
      providersLeft: left.get(tool.id)?.routableBindings ?? 0,
    }));
  }

  private async describeToolsets(
    organizationId: string,
    refs: readonly AllowedToolsetRef[],
  ): Promise<AllowedToolsetDto[]> {
    const found = new Map(
      (await this.toolsets.findAnyByIds(refs.map((ref) => ref.toolsetId))).map((toolset) => [
        toolset.id,
        toolset,
      ]),
    );
    const handles = await this.handles.handlesOf(
      [...found.values()].flatMap((toolset) => (toolset.ownerOrgId ? [toolset.ownerOrgId] : [])),
    );
    // Another organization's toolset is named as the pinned version names
    // itself: its current name may be a later, unseen version's.
    const pinned = new Map(
      (
        await this.versions.findPairs(
          refs.flatMap((ref) =>
            ref.version !== null ? [{ toolsetId: ref.toolsetId, version: ref.version }] : [],
          ),
        )
      ).map((row) => [`${row.toolsetId}@${row.version}`, row.name]),
    );

    const now = new Date();
    return refs.map((ref) => {
      const toolset = found.get(ref.toolsetId);
      const own = toolset?.ownerOrgId === organizationId;
      const state = toolset ? sharingStateOf(toolset) : null;
      // How this pin reaches the toolset now: through the `/@…` URL or the
      // same link it was taken with — the newest version on that path is
      // what "Update available" offers, and nothing else.
      const handleActive =
        !!toolset && (toolset.ownerOrgId === null || handles.has(toolset.ownerOrgId));
      const reach = !own && state && handleActive ? pinReaches(ref, state, now) : null;
      const status = !toolset
        ? 'DELETED'
        : toolset.removedAt
          ? 'REMOVED'
          : toolset.deletedAt
            ? 'DELETED'
            : !own && !reach
              ? 'NOT_SHARED'
              : 'ACTIVE';
      return {
        toolsetId: ref.toolsetId,
        version: ref.version,
        viaUrlOnly: ref.viaUrlOnly,
        name: own
          ? (toolset?.name ?? null)
          : (pinned.get(`${ref.toolsetId}@${ref.version}`) ?? (toolset ? toolset.name : null)),
        slug: toolset?.slug ?? null,
        deleted: !toolset || toolset.deletedAt !== null,
        handle: !toolset
          ? null
          : toolset.ownerOrgId === null
            ? OFFICIAL_HANDLE
            : (handles.get(toolset.ownerOrgId) ?? null),
        own,
        status,
        latestVersion: !toolset
          ? null
          : own
            ? toolset.latestVersion
            : reach && status === 'ACTIVE'
              ? newestServed(toolset, reach)
              : null,
      };
    });
  }

  private async toCredentialDto(
    organizationId: string,
    credential: AgentCredentialEntity,
  ): Promise<CredentialAccessDto> {
    const mode = (credential.accessMode as AccessMode | null) ?? null;
    return {
      credentialId: credential.id,
      agentId: credential.agentId,
      accessMode: mode,
      allowedToolsets: await this.describeToolsets(
        organizationId,
        readAllowedToolsets(credential.allowedToolsets),
      ),
      allowedToolIds: credential.allowedToolIds ?? [],
    };
  }

  private async requireAgent(organizationId: string, agentId: string) {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.organizationId !== organizationId) {
      throw AccountErrors.agentNotFound({ agentId });
    }
    return agent;
  }

  private async requireCredential(
    organizationId: string,
    credentialId: string,
  ): Promise<AgentCredentialEntity> {
    const credential = await this.credentials.findOneBy({ organizationId, id: credentialId });
    if (!credential) throw AccountErrors.credentialNotFound({ id: credentialId });
    return credential;
  }

  /** The agent's chain, or the deployment's default for an agent with no wallet yet. */
  private chainOf(chainId: string | null): ChainId {
    return (chainId ||
      this.config.get<string>('auth.privy.defaultChainId') ||
      this.enabledChains[0]) as ChainId;
  }
}
