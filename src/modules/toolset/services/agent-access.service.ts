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
import { categoryOf } from '@modules/tool/ports/tool.types';
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
import { AccessEpochService } from './access-epoch.service';
import { AccessResolver, agentRulesOf } from './access.resolver';
import { ConnectUrlsService } from './connect-urls.service';
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
    const access = await this.validateAccess(organizationId, body);
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
        for (const tool of catalogue) {
          const byName = filter.tools === null || names.has(tool.name);
          const byCategory = filter.categories === null || categories.has(categoryOf(tool));
          if (byName && byCategory) toolIds.add(tool.id);
        }
        continue;
      }
      if (server.toolsetId && !toolsetRefs.some((ref) => ref.toolsetId === server.toolsetId)) {
        toolsetRefs.push({ toolsetId: server.toolsetId, version: null, viaUrlOnly: true });
      }
    }

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

    const narrows = body.accessMode === AccessMode.RESTRICTED;
    const values = narrows
      ? {
          accessMode: AccessMode.RESTRICTED,
          allowedToolsets: await this.validateToolsets(organizationId, body.allowedToolsets ?? []),
          allowedToolIds: await this.validateToolIds(body.allowedToolIds ?? []),
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
  ): Promise<Partial<AccessFields>> {
    const access: Partial<AccessFields> = {};
    if (body.accessMode !== undefined) access.accessMode = body.accessMode;
    if (body.allowedToolsets !== undefined) {
      access.allowedToolsets = await this.validateToolsets(organizationId, body.allowedToolsets);
    }
    if (body.allowedToolIds !== undefined) {
      access.allowedToolIds = await this.validateToolIds(body.allowedToolIds);
    }
    if (body.pinnedTools !== undefined) {
      access.pinnedTools = await this.validatePinned(body.pinnedTools);
    }
    if (body.rules) {
      const { rules } = body;
      if (rules.excludeProviderIds !== undefined) {
        access.ruleExcludeProviderIds = [...new Set(rules.excludeProviderIds)];
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
   * Own, live toolsets only, each following its Draft. Another organization's
   * toolset can be allowed only at a pinned version once sharing exists (T2);
   * until then a pin names a version that does not exist.
   */
  private async validateToolsets(
    organizationId: string,
    input: readonly AllowedToolsetInputDto[],
  ): Promise<AllowedToolsetRef[]> {
    const ids = [...new Set(input.map((ref) => ref.toolsetId))];
    const live = new Set(
      (await this.toolsets.findOwnedByIds(organizationId, ids))
        .filter((toolset) => toolset.deletedAt === null)
        .map((toolset) => toolset.id),
    );
    const unknown = ids.filter((id) => !live.has(id));
    if (unknown.length > 0) {
      throw ToolsetErrors.accessInvalid({ reason: 'unknown tool sets', toolsetIds: unknown });
    }
    const pinned = input.filter((ref) => ref.version !== undefined && ref.version !== null);
    if (pinned.length > 0) {
      throw ToolsetErrors.accessInvalid({
        reason: 'a tool set version does not exist yet; follow the latest (version: null)',
        toolsetIds: pinned.map((ref) => ref.toolsetId),
      });
    }
    return ids.map((toolsetId) => ({
      toolsetId,
      version: null,
      viaUrlOnly: input.find((ref) => ref.toolsetId === toolsetId)?.viaUrlOnly !== false,
    }));
  }

  private async validateToolIds(toolIds: readonly string[]): Promise<string[]> {
    const ids = [...new Set(toolIds)];
    const known = new Set((await this.tools.findByIds(ids)).map((tool) => tool.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw ToolsetErrors.accessInvalid({ reason: 'unknown tools', toolIds: unknown });
    }
    return ids;
  }

  private async validatePinned(pinned: readonly string[]): Promise<string[]> {
    const names = [...new Set(pinned)];
    if (names.length > TOOLSET_LIMITS.pinnedTools) {
      throw ToolsetErrors.limitExceeded({ limit: 'pinnedTools', max: TOOLSET_LIMITS.pinnedTools });
    }
    const known = new Set((await this.catalogue.listTools()).map((tool) => tool.name));
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
    const [access, tools] = await Promise.all([
      this.resolver.resolveFor(organizationId, agentId, null),
      this.catalogue.listTools(),
    ]);
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
      (
        await this.toolsets.findOwnedByIds(
          organizationId,
          refs.map((ref) => ref.toolsetId),
        )
      ).map((toolset) => [toolset.id, toolset]),
    );
    return refs.map((ref) => {
      const toolset = found.get(ref.toolsetId);
      return {
        toolsetId: ref.toolsetId,
        version: ref.version,
        viaUrlOnly: ref.viaUrlOnly,
        name: toolset?.name ?? null,
        slug: toolset?.slug ?? null,
        deleted: !toolset || toolset.deletedAt !== null,
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
