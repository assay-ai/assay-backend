import { AgentRoutingRules } from '@modules/tool/domain/routing';

/**
 * What an agent — or one of its keys — may call, whatever URL the call
 * arrives through (design spec §7.7, "Access policy"; FR-3).
 *
 * ```text
 * allowed(tool, url) = agent policy allows it  AND  (no key narrowing OR the key allows it)
 *
 * a grant allows a tool when
 *   mode ALL
 *   or the tool is listed directly                  (allowed_tool_ids)
 *   or an allowed toolset contains it               (allowed_toolsets)
 *        and, when that toolset is viaUrlOnly, the call came through that toolset's URL
 * ```
 *
 * A key's grant is intersected with its agent's, never unioned: a key can only
 * narrow. Pure — the toolsets' tool lists are resolved before this runs.
 */

export enum AccessMode {
  ALL = 'ALL',
  RESTRICTED = 'RESTRICTED',
}

/** One `allowed_toolsets` element, as stored. */
export interface AllowedToolsetRef {
  readonly toolsetId: string;
  /**
   * `null` follows the latest — allowed only for the org's own toolsets and
   * Official ones. A toolset of another org is pinned to a version (T2); in
   * T1 every toolset is the org's own and only its Draft exists.
   */
  readonly version: number | null;
  /** Its tools are allowed only through that toolset's own URL. */
  readonly viaUrlOnly: boolean;
}

/** An allowed toolset with the tools it holds at the referenced version. */
export interface GrantedToolset {
  readonly toolsetId: string;
  readonly viaUrlOnly: boolean;
  readonly toolIds: ReadonlySet<string>;
}

export interface AccessGrant {
  readonly mode: AccessMode;
  readonly toolIds: ReadonlySet<string>;
  readonly toolsets: readonly GrantedToolset[];
}

/** The agent's resolved access, its key's narrowing and its provider rules. */
export interface ResolvedAccess {
  readonly agentId: string;
  readonly agent: AccessGrant;
  /** `null` when the key narrows nothing. */
  readonly key: AccessGrant | null;
  /** The agent rules; `null` when none are set. */
  readonly rules: AgentRoutingRules | null;
  readonly pinnedTools: readonly string[];
  /** The spend policy version the access was read from; `null` when no policy exists. */
  readonly policyVersion: number | null;
}

export const ALLOW_ALL: AccessGrant = Object.freeze({
  mode: AccessMode.ALL,
  toolIds: new Set<string>(),
  toolsets: Object.freeze([]),
});

/** Whether one grant allows `toolId` on a URL serving `urlToolsetId` (`null`: no toolset). */
export function grantAllows(
  grant: AccessGrant,
  toolId: string,
  urlToolsetId: string | null,
): boolean {
  if (grant.mode === AccessMode.ALL) return true;
  if (grant.toolIds.has(toolId)) return true;
  return grant.toolsets.some(
    (toolset) =>
      toolset.toolIds.has(toolId) && (!toolset.viaUrlOnly || toolset.toolsetId === urlToolsetId),
  );
}

/** Agent ∩ key. Enforced on every call (NFR-3); the list is only a convenience. */
export function accessAllows(
  access: Pick<ResolvedAccess, 'agent' | 'key'>,
  toolId: string,
  urlToolsetId: string | null,
): boolean {
  return (
    grantAllows(access.agent, toolId, urlToolsetId) &&
    (access.key === null || grantAllows(access.key, toolId, urlToolsetId))
  );
}

/** How a tool stands for an agent regardless of URL, for the settings screen. */
export enum ToolAccessStanding {
  /** Callable through any URL that serves it. */
  ALLOWED = 'ALLOWED',
  /** Callable only through the URL of an allowed toolset marked "only through its toolset URL". */
  VIA_TOOLSET_URL = 'VIA_TOOLSET_URL',
  BLOCKED = 'BLOCKED',
}

export function toolStanding(
  access: Pick<ResolvedAccess, 'agent' | 'key'>,
  toolId: string,
): ToolAccessStanding {
  if (accessAllows(access, toolId, null)) return ToolAccessStanding.ALLOWED;
  const viaToolsets = [access.agent, access.key]
    .filter((grant): grant is AccessGrant => grant !== null)
    .flatMap((grant) => grant.toolsets.map((toolset) => toolset.toolsetId));
  return viaToolsets.some((toolsetId) => accessAllows(access, toolId, toolsetId))
    ? ToolAccessStanding.VIA_TOOLSET_URL
    : ToolAccessStanding.BLOCKED;
}

/**
 * A stored `allowed_toolsets` value, read defensively: a malformed element is
 * dropped rather than read as a grant, which fails closed.
 */
export function readAllowedToolsets(value: unknown): AllowedToolsetRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((element): AllowedToolsetRef[] => {
    if (typeof element !== 'object' || element === null) return [];
    const { toolsetId, version, viaUrlOnly } = element as Record<string, unknown>;
    if (typeof toolsetId !== 'string') return [];
    return [
      {
        toolsetId,
        version: typeof version === 'number' ? version : null,
        viaUrlOnly: viaUrlOnly !== false,
      },
    ];
  });
}

/** A grant from its stored parts and the toolsets' resolved tool lists. */
export function buildGrant(
  mode: AccessMode,
  toolIds: readonly string[],
  toolsets: readonly AllowedToolsetRef[],
  toolsOf: (ref: AllowedToolsetRef) => readonly string[],
): AccessGrant {
  if (mode !== AccessMode.RESTRICTED) return ALLOW_ALL;
  return {
    mode,
    toolIds: new Set(toolIds),
    toolsets: toolsets.map((ref) => ({
      toolsetId: ref.toolsetId,
      viaUrlOnly: ref.viaUrlOnly,
      toolIds: new Set(toolsOf(ref)),
    })),
  };
}
