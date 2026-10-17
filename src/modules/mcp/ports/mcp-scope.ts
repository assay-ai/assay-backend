import { CallAttribution } from '@modules/toolset/domain/attribution';
import { ResolvedAccess, accessAllows } from '@modules/toolset/domain/access';
import { McpEndpointView, contractRequestOf } from '@modules/toolset/domain/view';
import { RoutingRules } from '@modules/tool/domain/routing';
import { ContractRequest } from '@modules/tool/domain/contract/contract-versions';
import { Tool } from '@modules/tool/ports/tool.types';

/**
 * What one MCP request may see and call: the URL's view and the caller's
 * access, resolved by the controller before the server is built (design spec
 * §7.3).
 *
 * ```text
 * listed tools = view ∩ access
 * a call       = in view (else TOOL_NOT_IN_TOOLSET) → allowed (else TOOL_NOT_ALLOWED)
 *                → routed under the entry's rules ∧ the agent's rules
 * ```
 *
 * The list is a convenience; every call is checked again on the server
 * (NFR-3), so a stale list in a client can never grant anything.
 */
export interface McpScope {
  readonly view: McpEndpointView;
  readonly access: ResolvedAccess;
  readonly attribution: CallAttribution;
}

/** The URL's toolset, which `viaUrlOnly` access entries are matched against. */
export function urlToolsetIdOf(scope: McpScope): string | null {
  return scope.view.toolset?.id ?? null;
}

export function scopeAllows(scope: McpScope, toolId: string): boolean {
  return accessAllows(scope.access, toolId, urlToolsetIdOf(scope));
}

/** The rules a call of `toolId` through this URL is routed under. */
export function rulesFor(scope: McpScope, toolId: string): RoutingRules {
  return {
    agent: scope.access.rules,
    entry: scope.view.entryRules.get(toolId) ?? null,
  };
}

/**
 * What a call of `tool` through this URL asks of the contract (T3): the
 * entry's range and required outputs, narrowed by a `?tools=name@N` pin.
 */
export function contractFor(scope: McpScope, tool: Pick<Tool, 'id' | 'name'>): ContractRequest {
  return contractRequestOf(scope.view, tool);
}

/** Whether every call through this URL is forced into the FREE call class (`?free=1`). */
export function forcesFree(scope: McpScope | null | undefined): boolean {
  return scope?.view.filter.free === true;
}
