import { Inject, Injectable, Optional } from '@nestjs/common';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { ToolsetVersionRepository } from '@database/postgres/repositories/toolset-sharing.repository';
import {
  ToolsetEntryRepository,
  ToolsetRepository,
} from '@database/postgres/repositories/toolset.repository';
import { AssetId } from '@modules/chains/ports/caip.types';
import { McpSession, storedCredentialIdOf } from '@modules/mcp/ports/mcp-session.port';
import { ProviderTier } from '@modules/provider/ports/provider.types';
import { AgentRoutingRules } from '@modules/tool/domain/routing';
import { BoundedTtlCache } from '@shared/utils/bounded-ttl-cache';
import { MoneyUtil } from '@utils/money.util';

import {
  AccessMode,
  AllowedToolsetRef,
  ResolvedAccess,
  buildGrant,
  readAllowedToolsets,
} from '../domain/access';
import { AccessEpochService } from './access-epoch.service';

/** The backstop: a cached access is never older than this, whatever the epoch says. */
export const ACCESS_CACHE_TTL_MS = 60_000;

/** Injected by tests; production reads the wall clock. */
export const ACCESS_CLOCK = 'ACCESS_CLOCK';

interface CachedAccess {
  readonly epoch: string;
  readonly value: ResolvedAccess;
}

/** Credentials kept per process; the coldest goes first. */
export const ACCESS_CACHE_MAX_ENTRIES = 50_000;

/**
 * An agent's access, its key's narrowing and its agent rules, resolved once
 * and cached per credential (NFR-1).
 *
 * Read from the live spend policy (the agent row, else the organization
 * row) and the credential's own narrowing; the toolsets either names are
 * expanded into their tool ids — the Draft or a published snapshot, see
 * {@link toolsOfToolsets}. Another organization's toolset is read only as
 * the immutable version the reference pins, which was visible to this
 * organization when the reference was written.
 *
 * Cached against the organization's access epoch, which every write to a
 * policy, a credential's narrowing or a toolset's Draft bumps — so a revoke or
 * a narrowing takes effect on the next call on every instance.
 */
@Injectable()
export class AccessResolver {
  private readonly cache: BoundedTtlCache<CachedAccess>;

  constructor(
    private readonly policies: SpendPolicyRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly toolsets: ToolsetRepository,
    private readonly entries: ToolsetEntryRepository,
    private readonly epochs: AccessEpochService,
    private readonly versions: ToolsetVersionRepository,
    @Optional() @Inject(ACCESS_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.cache = new BoundedTtlCache(ACCESS_CACHE_MAX_ENTRIES, ACCESS_CACHE_TTL_MS, now);
  }

  resolve(session: McpSession): Promise<ResolvedAccess> {
    return this.resolveFor(session.organizationId, session.agentId, storedCredentialIdOf(session));
  }

  async resolveFor(
    organizationId: string,
    agentId: string,
    credentialId: string | null,
  ): Promise<ResolvedAccess> {
    const key = `${organizationId}:${agentId}:${credentialId ?? '-'}`;
    // Another organization's shared toolset (an Official one followed at its
    // latest, a takedown) changes under the sharing epoch, not this org's.
    const epoch = await this.epochs.currentWithSharing(organizationId);
    const cached = this.cache.get(key);
    if (epoch !== null && cached?.epoch === epoch) return cached.value;

    const value = await this.load(organizationId, agentId, credentialId);
    if (epoch !== null) this.cache.set(key, { epoch, value });
    return value;
  }

  private async load(
    organizationId: string,
    agentId: string,
    credentialId: string | null,
  ): Promise<ResolvedAccess> {
    const [policy, credential] = await Promise.all([
      this.policies.findLive(organizationId, agentId),
      credentialId
        ? this.credentials.findOneBy({ organizationId, id: credentialId })
        : Promise.resolve(null),
    ]);

    const agentMode = (policy?.accessMode as AccessMode) ?? AccessMode.ALL;
    const agentToolsets = readAllowedToolsets(policy?.allowedToolsets);
    const keyMode = narrowingOf(credential);
    const keyToolsets = keyMode ? readAllowedToolsets(credential?.allowedToolsets) : [];

    const toolsOf = await this.toolsOfToolsets(organizationId, [
      ...(agentMode === AccessMode.RESTRICTED ? agentToolsets : []),
      ...(keyMode === AccessMode.RESTRICTED ? keyToolsets : []),
    ]);

    return {
      agentId,
      agent: buildGrant(agentMode, policy?.allowedToolIds ?? [], agentToolsets, toolsOf),
      key: keyMode
        ? buildGrant(keyMode, credential?.allowedToolIds ?? [], keyToolsets, toolsOf)
        : null,
      rules: agentRulesOf(policy),
      pinnedTools: policy?.pinnedTools ?? [],
      policyVersion: policy?.policyVersion ?? null,
    };
  }

  /**
   * Each referenced toolset's tools, by reference (design spec §7.7):
   *
   * ```text
   * own toolset        version null → its Draft; n → the snapshot of v n; deleted → none
   * Official           version null → its latest shared version; n → v n
   * another org's      n → the snapshot of v n, kept even when deleted; null → none
   * taken down, unknown → none (fail closed)
   * ```
   *
   * A pinned snapshot is immutable, so a new version never widens access and
   * a delete never silently narrows another organization's.
   */
  private async toolsOfToolsets(
    organizationId: string,
    refs: readonly AllowedToolsetRef[],
  ): Promise<(ref: AllowedToolsetRef) => readonly string[]> {
    const ids = [...new Set(refs.map((ref) => ref.toolsetId))];
    if (ids.length === 0) return () => [];

    const found = new Map(
      (await this.toolsets.findAnyByIds(ids)).map((toolset) => [toolset.id, toolset]),
    );
    const drafts = [...found.values()].filter(
      (toolset) =>
        toolset.ownerOrgId === organizationId &&
        toolset.deletedAt === null &&
        toolset.removedAt === null,
    );
    const rows = await this.entries.findByToolsets(drafts.map((toolset) => toolset.id));
    const draftTools = new Map<string, string[]>();
    for (const row of rows) {
      const list = draftTools.get(row.toolsetId) ?? [];
      list.push(row.toolId);
      draftTools.set(row.toolsetId, list);
    }

    const versionOf = (ref: AllowedToolsetRef): number | null => {
      const toolset = found.get(ref.toolsetId);
      if (!toolset || toolset.removedAt) return null;
      if (toolset.ownerOrgId === organizationId) {
        return toolset.deletedAt ? null : ref.version;
      }
      if (ref.version !== null) return ref.version;
      return toolset.ownerOrgId === null ? toolset.lastSharedVersion : null;
    };
    const pairs = refs.flatMap((ref) => {
      const version = versionOf(ref);
      return version === null ? [] : [{ toolsetId: ref.toolsetId, version }];
    });
    const snapshots = new Map(
      (await this.versions.findPairs(pairs)).map((row) => [
        `${row.toolsetId}@${row.version}`,
        row.toolIds,
      ]),
    );

    return (ref) => {
      const toolset = found.get(ref.toolsetId);
      if (!toolset || toolset.removedAt) return [];
      if (toolset.ownerOrgId === organizationId && ref.version === null) {
        return draftTools.get(ref.toolsetId) ?? [];
      }
      const version = versionOf(ref);
      return version === null ? [] : (snapshots.get(`${ref.toolsetId}@${version}`) ?? []);
    };
  }
}

/** The key's narrowing mode, or `null` when it narrows nothing. */
function narrowingOf(credential: AgentCredentialEntity | null): AccessMode | null {
  if (!credential?.accessMode || credential.accessMode === AccessMode.ALL) return null;
  return credential.accessMode as AccessMode;
}

/** The policy's agent rules, or `null` when it sets none. */
export function agentRulesOf(policy: SpendPolicyEntity | null): AgentRoutingRules | null {
  if (!policy) return null;
  const excludeProviderIds = policy.ruleExcludeProviderIds ?? [];
  const rules: AgentRoutingRules = {
    excludeProviderIds,
    maxPrice:
      policy.ruleMaxPrice === null || policy.ruleMaxPrice === undefined
        ? null
        : MoneyUtil.of(policy.ruleMaxPrice, policy.assetId as AssetId, policy.decimals),
    minTier: (policy.ruleMinTier as ProviderTier | null) ?? null,
    minQuality:
      policy.ruleMinQuality === null || policy.ruleMinQuality === undefined
        ? null
        : Number(policy.ruleMinQuality),
  };
  const empty =
    excludeProviderIds.length === 0 &&
    rules.maxPrice === null &&
    rules.minTier === null &&
    rules.minQuality === null;
  return empty ? null : rules;
}
