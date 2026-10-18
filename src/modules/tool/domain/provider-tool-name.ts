import { isReservedToolName } from './reserved-tool-names';

/**
 * Provider tool names (design spec §7.1): `{handle}__{tool}`. Pure.
 *
 * - `{tool}` matches `^[a-z][a-z0-9_]{1,39}$` (at most 40 characters) and
 *   holds no `__`, so the first `__` of a name is always the separator;
 * - the whole name is at most 48 characters (NFR-7), so a client prefix
 *   such as `mcp__{server}__` with a 9-character server name stays within 64.
 *
 * Both caps are hard limits, enforced on save and again by
 * `chk_tools_provider_name`. A standard tool never contains `__`, so the two
 * kinds cannot collide; `uq_tools_name` keeps names unique across both.
 */

export const PROVIDER_TOOL_LOCAL_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const PROVIDER_TOOL_LOCAL_MAX = 40;
export const TOOL_NAME_MAX = 48;
export const PROVIDER_TOOL_SEPARATOR = '__';

/** `{handle}__{tool}`. */
export function providerToolName(handle: string, local: string): string {
  return `${handle}${PROVIDER_TOOL_SEPARATOR}${local}`;
}

/** Why `{handle}__{local}` cannot name a provider tool; empty when it can. */
export function providerToolNameProblems(handle: string, local: string): string[] {
  const problems: string[] = [];
  if (typeof local !== 'string' || !PROVIDER_TOOL_LOCAL_RE.test(local)) {
    problems.push(
      `the tool name must be 2–${PROVIDER_TOOL_LOCAL_MAX} characters: lowercase letters, digits ` +
        `and "_", starting with a letter`,
    );
    return problems;
  }
  if (local.includes(PROVIDER_TOOL_SEPARATOR)) {
    problems.push('the tool name cannot contain "__", which separates it from the public name');
  }
  const full = providerToolName(handle, local);
  if (full.length > TOOL_NAME_MAX) {
    problems.push(
      `"${full}" is ${full.length} characters; a full tool name is at most ${TOOL_NAME_MAX}`,
    );
  }
  if (isReservedToolName(full) || isReservedToolName(local)) {
    problems.push(`"${local}" is reserved for the MCP host's meta tools`);
  }
  return problems;
}

/** `{handle}__{tool}` → its two halves, or `null` for a name that is not one. */
export function parseProviderToolName(
  name: string,
): { readonly handle: string; readonly local: string } | null {
  const at = name.indexOf(PROVIDER_TOOL_SEPARATOR);
  if (at <= 0) return null;
  return { handle: name.slice(0, at), local: name.slice(at + PROVIDER_TOOL_SEPARATOR.length) };
}

/** `name` under a new handle, or `null` when it would break the cap. */
export function renamedProviderToolName(name: string, handle: string): string | null {
  const parsed = parseProviderToolName(name);
  if (!parsed) return null;
  const next = providerToolName(handle, parsed.local);
  return next.length > TOOL_NAME_MAX ? null : next;
}
