/**
 * Tool names no tool may take: the MCP host's meta tools (design spec §7.4).
 *
 * `search_tools`, `get_tool` and `call_tool` are answered by the server itself
 * on every URL, so a catalogue tool under one of these names would be
 * unreachable, and a list holding both would offer a model two different
 * tools under one name. Refused wherever a tool name enters the platform: the
 * seed and every snapshot loaded from it, the `tools` upsert, and a CHECK on
 * `tools.name`.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_tools',
  'get_tool',
  'call_tool',
]);

export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name);
}

/** Throws when any of `names` is reserved; `source` says where it came from. */
export function assertNoReservedToolNames(names: Iterable<string>, source: string): void {
  for (const name of names) {
    if (isReservedToolName(name)) {
      throw new Error(
        `${source}: "${name}" is reserved for the MCP host's meta tools ` +
          `(${[...RESERVED_TOOL_NAMES].join(', ')}) and cannot name a tool`,
      );
    }
  }
}
