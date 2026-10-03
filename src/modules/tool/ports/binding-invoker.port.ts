import { ProviderResponse } from '../domain/classification/classification.types';
import { JsonObject } from '../domain/mapping/mapping.types';
import { Tool, ToolBinding } from './tool.types';

/**
 * One attempt against one binding — the seam between *deciding* and *dialling*.
 *
 * The router owns selection, the deadline and the failover rule; this owns the
 * socket. Separating them is what lets every routing behaviour —
 * failover on `SYSTEM_ERROR`, no failover on `REQUEST_ERROR`, the stake gate,
 * the traffic split — be tested without a provider, a network or a fixture
 * server, which in turn is what lets those tests run on every commit.
 */
export interface BindingInvocation {
  readonly tool: Tool;
  readonly binding: ToolBinding;
  /** The agent's arguments, before `requestMapping` runs. */
  readonly input: JsonObject;
  /**
   * The value sent upstream as `X-X402-Call-Id`.
   *
   * **Non-optional, deliberately.** "Every request upstream carries this
   * header" is a guarantee, and `callId?: string` is a guarantee a future
   * caller can forget to honour — the type is what makes forgetting it a
   * compile error instead of a silent gap in a provider's reconciliation.
   * Minted once per *tool call* by `McpToolCallService`, not once per
   * attempt: failover excludes the whole provider
   * (`ProviderRouterService`'s own doc comment explains why), so a given
   * provider sees at most one request per call, and this is the id that
   * request carries.
   */
  readonly callId: string;
  /**
   * The budget for **this attempt**, already reconciled against the request's
   * total deadline — so it may be shorter than `binding.timeoutMs` on a later
   * failover, and never longer.
   *
   * An implementation is expected to abort its own socket at this figure. The
   * router enforces it a second time as a backstop, because an implementation
   * that ignores it would otherwise hang the call an agent is blocked on.
   */
  readonly timeoutMs: number;
}

export interface BindingInvokerPort {
  /**
   * Call the provider and return what came back.
   *
   * Expected to **resolve, not reject**, for anything that happened on the wire
   * — a timeout, a refused connection, a 500 — by returning a
   * {@link ProviderResponse} carrying a `transportError` or the status. That is
   * not defensive style: classification is the only thing allowed to decide
   * what a failure *means*, and an implementation that threw would be
   * making that decision by choosing which exception to throw.
   *
   * A rejection is still handled — the router recognises a mapping fault and
   * otherwise runs `classifyTransportError` — but it is the fallback path, not
   * the contract.
   */
  invoke(invocation: BindingInvocation): Promise<ProviderResponse>;
}

/** DI token for the bound {@link BindingInvokerPort}. */
export const BINDING_INVOKER = 'BINDING_INVOKER';
