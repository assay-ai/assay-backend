import { EndpointKind, viewFilterRecord } from './mcp-url';
import { McpEndpointView } from './view';

/**
 * Which URL a call came through, as `payment_intents` and `tool_call_records`
 * store it (design spec §7.8). Recorded on every call, refused ones included,
 * because past calls cannot be attributed later.
 */
export interface CallAttribution {
  readonly endpointKind: EndpointKind;
  readonly toolsetId: string | null;
  /** `null` with a toolset: the Draft. */
  readonly toolsetVersion: number | null;
  readonly endpointHandle: string | null;
  readonly viewFilter: Record<string, unknown> | null;
}

export function attributionOf(view: McpEndpointView): CallAttribution {
  return {
    endpointKind: view.kind,
    toolsetId: view.toolset?.id ?? null,
    toolsetVersion: view.toolset?.version ?? null,
    endpointHandle: view.handle,
    viewFilter: viewFilterRecord(view.filter),
  };
}

/** The layer that refused a call (`tool_call_records.refusal_layer`). */
export enum RefusalLayer {
  /** The URL: the tool is not served there, or the platform could not serve it. */
  SERVER = 'SERVER',
  /** The agent's own limits: its access policy, its rules, its spend policy. */
  AGENT_LIMITS = 'AGENT_LIMITS',
  /** The rules of the toolset the URL serves. */
  TOOLSET_RULES = 'TOOLSET_RULES',
}
