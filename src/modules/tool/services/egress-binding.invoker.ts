import { Injectable } from '@nestjs/common';

import { EgressHttpClient } from '@shared/network/egress/egress-http.client';
import { isEgressError } from '@shared/network/egress/egress.errors';
import { UNTRUSTED_EGRESS_POLICY, withLimits } from '@shared/network/egress/egress.policy';

import {
  ProviderResponse,
  ResponseBodyKind,
  classifyTransportError,
  readResponseBody,
} from '../domain/classification';
import { UpstreamRequest, mapRequest } from '../domain/mapping';
import { BindingInvocation, BindingInvokerPort } from '../ports/binding-invoker.port';

/**
 * The production {@link BindingInvokerPort} — the call path the mapping engine
 * and the classifier were both written against.
 *
 * ```text
 * tool input ──mapRequest──▶ UpstreamRequest ──EgressHttpClient──▶ provider
 *                                                                     │
 *                        ProviderResponse ◀──readResponseBody────◀─────┘
 * ```
 *
 * Three things it is careful about:
 *
 * 1. **It does not classify.** It returns what happened — a status and a body,
 *    or a `transportError` — and the classifier decides what that means. An invoker
 *    that decided would be a second opinion on whether a provider's stake is
 *    reachable, in a file nobody looks at when auditing that question.
 * 2. **It lets a mapping fault propagate.** `mapRequest` throws with
 *    `fault: AGENT` when the agent's arguments fail the tool's `inputSchema`,
 *    and that must reach the router as a fault rather than be flattened into a
 *    transport failure — the two produce opposite failover decisions.
 * 3. **It goes through `EgressHttpClient`.** Provider endpoints are URLs typed
 *    by strangers (open registration with no approval), which makes
 *    every one of these calls an SSRF vector. `UNTRUSTED_EGRESS_POLICY` is the
 *    default and is not relaxed here.
 */
@Injectable()
export class EgressBindingInvoker implements BindingInvokerPort {
  constructor(private readonly http: EgressHttpClient) {}

  async invoke(invocation: BindingInvocation): Promise<ProviderResponse> {
    const { tool, binding, input, timeoutMs, callId } = invocation;

    // Outside the try. A failure here is the agent's arguments or our mapping,
    // not the provider's endpoint, and converting it into a `transportError`
    // would file it against the provider's availability record for a call that
    // never left this process.
    const upstream = mapRequest(binding.requestMapping, input, {
      inputSchema: tool.inputSchema,
      context: { toolId: tool.id, bindingId: binding.id, providerId: binding.providerId },
    });

    const body = upstream.body === undefined ? undefined : JSON.stringify(upstream.body);

    try {
      const response = await this.http.request({
        url: buildUrl(binding.endpoint, upstream),
        method: upstream.method,
        // `x-x402-call-id` is spread in *last*, after `upstream.headers` — a
        // binding is a provider-authored mapping, and a provider
        // that could set this header itself could spoof the correlation id
        // the whole point of the call id is to make unforgeable. `EgressHttpClient`
        // lower-cases every header name before it sends anything
        // (`normalizeHeaders`), so this also wins against a differently-cased
        // duplicate (`X-X402-Call-Id`) coming out of `upstream.headers` — the
        // last write for a given lower-cased key is the one that reaches the
        // wire, and this object literal places it last either way.
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...upstream.headers,
          'x-x402-call-id': callId,
        },
        body,
        // Every deadline collapses to the attempt's budget. The per-hop figures
        // exist so a redirect chain cannot multiply the wait, and the router
        // has already reconciled `timeoutMs` against the request's total — so
        // the correct value for all three is the same one.
        policy: withLimits(UNTRUSTED_EGRESS_POLICY, {
          headersTimeoutMs: timeoutMs,
          bodyTimeoutMs: timeoutMs,
          totalTimeoutMs: timeoutMs,
        }),
      });

      return {
        status: response.status,
        headers: response.headers,
        body: readResponseBody(response.body, response.headers['content-type']),
      };
    } catch (error) {
      // Resolve, do not reject — see `BindingInvokerPort.invoke`. The bytes
      // that arrived before the failure are carried for diagnostics and are
      // never parsed: a truncated body is byte-identical to a provider
      // answering half a question, and only one of those readings can cost them
      // their stake.
      const partialBody = isEgressError(error) ? error.partialBody : null;

      return {
        status: 0,
        body: { kind: ResponseBodyKind.EMPTY },
        transportError: classifyTransportError(error, partialBody),
      };
    }
  }
}

/**
 * `binding.endpoint` + the mapped path and query.
 *
 * The endpoint is the provider's own URL, unchanged, and may itself carry a
 * path prefix (`https://api.example.com/v2`). Joining with `new URL(path,
 * base)` would discard that prefix whenever the mapped path began with `/`,
 * which is the form every mapping in `docs/mapping-format.md` uses — so the
 * join is done on the string, before parsing.
 */
function buildUrl(endpoint: string, upstream: UpstreamRequest): string {
  const base = endpoint.replace(/\/+$/, '');
  const path = upstream.path ? `/${upstream.path.replace(/^\/+/, '')}` : '';
  const url = new URL(`${base}${path}`);

  for (const [name, value] of Object.entries(upstream.query)) {
    url.searchParams.set(name, value);
  }

  return url.href;
}
