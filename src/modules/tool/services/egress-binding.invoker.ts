import { Injectable } from '@nestjs/common';

import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { originOf } from '@modules/provider/credentials/credential-rules';
import { EgressHttpClient } from '@shared/network/egress/egress-http.client';
import {
  EgressError,
  EgressFailureKind,
  isEgressError,
} from '@shared/network/egress/egress.errors';
import {
  EgressPolicy,
  UNTRUSTED_EGRESS_POLICY,
  bindingEndpointProtocols,
  withLimits,
} from '@shared/network/egress/egress.policy';

import {
  ProviderResponse,
  ResponseBodyKind,
  classifyTransportError,
  platformUnavailable,
  readResponseBody,
} from '../domain/classification';
import { UpstreamRequest, mapRequest } from '../domain/mapping';
import { BindingInvocation, BindingInvokerPort } from '../ports/binding-invoker.port';
import { RequestSignerService } from '../request-auth/request-signer.service';

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
 *
 * It also authenticates the call both ways: the binding's vault credential
 * headers (for exactly the request's origin) and the Assay request signature.
 * Header order on the wire:
 *
 * ```text
 * defaults → mapping headers → credential headers → x-assay-call-id
 *          → content-digest / signature-input / signature
 * ```
 *
 * A vault failure is a platform fault: the call is not sent and the outcome is
 * a `PLATFORM_UNAVAILABLE` transport error, never counted against the provider.
 */
@Injectable()
export class EgressBindingInvoker implements BindingInvokerPort {
  constructor(
    private readonly http: EgressHttpClient,
    private readonly vault: CredentialVaultService,
    private readonly signer: RequestSignerService,
  ) {}

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

    let url: string;
    try {
      url = buildUrl(binding.endpoint, upstream);
    } catch (error) {
      return transportFailure(error);
    }

    // Preparing the call: the vault lookup for exactly this URL's origin, and
    // the signature over exactly what is handed to `EgressHttpClient` — the
    // same URL string (the client sends `pathname + search` of `new URL(url)`,
    // the same parse the signer uses), method, headers and body. A failure
    // here means Assay could not prepare the call: our fault, never the
    // provider's, and nothing is sent.
    const method = upstream.method.toUpperCase();
    let headers: Record<string, string>;
    try {
      const credentials = await this.vault.headersFor(
        binding.providerId,
        binding.id,
        originOf(url),
      );
      headers = outboundHeaders(upstream.headers, credentials, callId, body !== undefined);
      const signature = await this.signer.sign({ method, url, headers, body });
      for (const [name, value] of Object.entries(signature)) setHeader(headers, name, value);
    } catch (error) {
      return {
        status: 0,
        body: { kind: ResponseBodyKind.EMPTY },
        transportError: platformUnavailable(error),
      };
    }

    try {
      const response = await this.http.request({
        url,
        method,
        headers,
        body,
        // Every deadline collapses to the attempt's budget. The per-hop figures
        // exist so a redirect chain cannot multiply the wait, and the router
        // has already reconciled `timeoutMs` against the request's total — so
        // the correct value for all three is the same one.
        policy: withLimits(bindingPolicy(), {
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
      return transportFailure(error);
    }
  }
}

/**
 * Resolve, do not reject — see `BindingInvokerPort.invoke`. The bytes that
 * arrived before the failure are carried for diagnostics and are never parsed:
 * a truncated body is byte-identical to a provider answering half a question,
 * and only one of those readings can cost them their stake.
 */
function transportFailure(error: unknown): ProviderResponse {
  const partialBody = isEgressError(error) ? error.partialBody : null;
  return {
    status: 0,
    body: { kind: ResponseBodyKind.EMPTY },
    transportError: classifyTransportError(error, partialBody),
  };
}

/**
 * The request headers, lower-cased, in wire order: defaults → mapping →
 * credentials → `x-assay-call-id`. The signature headers are appended after.
 *
 * Every write removes the name first, so a later layer wins against an
 * earlier one whatever its case, and lands in its own layer's position.
 * `x-assay-call-id` is written last: a binding is a provider-authored mapping
 * and its credentials are provider-supplied, and neither may spoof the
 * correlation id the call id exists to make unforgeable. (Credential names
 * starting `x-assay-` are also refused at write time.)
 */
function outboundHeaders(
  mapped: Readonly<Record<string, string>>,
  credentials: ReadonlyArray<{ name: string; value: string }>,
  callId: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (hasBody) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(mapped)) setHeader(headers, name, value);
  for (const { name, value } of credentials) setHeader(headers, name, value);
  setHeader(headers, 'x-assay-call-id', callId);
  return headers;
}

/** Sets `name` (lower-cased) at the end of `headers`, replacing any same-named entry. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const key = name.toLowerCase();
  delete headers[key];
  headers[key] = value;
}

/**
 * `UNTRUSTED_EGRESS_POLICY`, narrowed to https in production. Read per call so
 * the rule covers rows saved before it existed, not just new DTOs: such a row
 * fails with `TRANSPORT_HTTPS_REQUIRED`, and
 * `scripts/deploy/list-http-bindings.sql` lists them.
 */
function bindingPolicy(): EgressPolicy {
  return Object.freeze({
    ...UNTRUSTED_EGRESS_POLICY,
    allowedProtocols: Object.freeze([...bindingEndpointProtocols()]),
  });
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

  // Dot segments are resolved by `new URL`, so a mapped path can climb out of
  // the endpoint's prefix while still carrying the provider's credentials.
  // `interpolatePath` refuses `.`/`..` values; this is the backstop for any
  // other route to the same place.
  const prefix = new URL(base).pathname.replace(/\/+$/, '');
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new EgressError(
      EgressFailureKind.URL_INVALID,
      `the mapped path leaves the endpoint's path prefix "${prefix}"`,
      { url: url.href },
    );
  }

  for (const [name, value] of Object.entries(upstream.query)) {
    url.searchParams.set(name, value);
  }

  return url.href;
}
