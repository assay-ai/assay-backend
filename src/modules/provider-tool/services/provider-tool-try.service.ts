import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import { ProviderEgressLimiter } from '@modules/provider/services/provider-egress-limiter.service';
import { ProviderResponse, ResponseBodyKind } from '@modules/tool/domain/classification';
import { CredentialRedactor } from '@modules/tool/domain/egress/credential-redaction';
import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { BINDING_INVOKER, BindingInvokerPort } from '@modules/tool/ports/binding-invoker.port';
import { BindingAuthMode, Tool, ToolBinding, ToolTier } from '@modules/tool/ports/tool.types';
import { AuditLogWriter, auditActorOf } from '@shared/audit';
import { isBlockedAddress, isDeniedHost, isIpLiteralHost } from '@shared/network/egress';

import {
  TryParseError,
  TryPlan,
  TryWarning,
  TryWarningCode,
  exampleOf,
  outputOf,
  planFromCurl,
  planFromOpenApi,
} from '../domain/try-endpoint';
import { ProviderToolTryResultDto, TryProviderToolBodyDto } from '../dto/provider-tools.dto';
import { ProviderToolErrors } from '../errors/provider-tool.errors';

const DEFAULT_TIMEOUT_MS = 10_000;
const JSON_ECHO_LIMIT = 32 * 1024;
const TEXT_ECHO_LIMIT = 4 * 1024;

/**
 * `POST /provider/tools/try` (design spec §7.10, "Try your endpoint"): one
 * real call to the endpoint a provider pasted, as curl or OpenAPI, and the
 * draft's schemas, first example and binding mapping inferred from it.
 *
 * ## It is any other outbound call to a provider URL
 *
 * The request goes through `BINDING_INVOKER` — the router's own invoker — as
 * a throwaway binding whose mapping is the pasted request, constants only. So
 * it takes the same path every paid call takes: `EgressHttpClient` under
 * `UNTRUSTED_EGRESS_POLICY` (https only in production, every resolved address
 * checked against the private and reserved ranges, redirects re-checked, the
 * egress relay when one is configured), the Assay request signature, and the
 * same header rules (`x-assay-*` is the platform's). An IP literal in a
 * blocked range is refused before anything is dialled. Runs share the mapping
 * tester's {@link ProviderEgressLimiter} budget.
 *
 * ## It stores nothing
 *
 * No binding, run, tool or log row is written: the plan and the answer live
 * for this request only. The call still carries a fresh `X-Assay-Call-Id`,
 * which resolves to nothing on our side — by design, since nothing is kept.
 * Credentials pasted with it are sent once, redacted from every echo, and
 * never suggested as inputs or mapping constants.
 *
 * Provider accounts only, person sessions only (the controller's guards).
 */
@Injectable()
export class ProviderToolTryService {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly bindings: ToolBindingRepository,
    private readonly limiter: ProviderEgressLimiter,
    private readonly audit: AuditLogWriter,
    @Inject(BINDING_INVOKER) private readonly invoker: BindingInvokerPort,
  ) {}

  async try(session: McpSession, body: TryProviderToolBodyDto): Promise<ProviderToolTryResultDto> {
    const organizationId = session.organizationId;
    const provider = await this.providers.findOne({ where: { organizationId } });
    if (!provider || provider.status !== ProviderStatus.ACTIVE) {
      throw ProviderToolErrors.notAllowed({ reason: 'NOT_PROVIDER' });
    }
    assertOneSource(body);
    // Parsing runs inside the limiter's slot: a document is bounded
    // (`TRY_LIMITS`), and how often one organization may send one is too.
    return this.limiter.run(organizationId, async () => {
      const plan = planOf(body);
      assertDialable(plan.url);
      if (!plan.runnable) return resultOf(plan, null, 0, []);

      // Signed only towards the organization's own binding origins: the
      // signature tells an endpoint "this is Assay calling for a binding of
      // yours", and a provider must not obtain that for another's endpoint.
      const origin = new URL(plan.url).origin;
      const signed = (await this.ownOrigins(organizationId)).has(origin);
      const warnings: TryWarning[] = signed
        ? []
        : [
            {
              code: TryWarningCode.UNSIGNED_FOREIGN_ORIGIN,
              detail:
                `${origin} is not the origin of one of your bindings, so the test was sent ` +
                'without the Assay request signature: an endpoint that checks it will refuse ' +
                'this test. Save a binding with this endpoint to test it signed.',
            },
          ];
      const callId = randomUUID();
      const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // The one record of a try run: who, where, which call id, signed or
      // not. Never a header, a query value or a body.
      await this.audit.recordAfterCommit({
        organizationId,
        actor: auditActorOf(session),
        action: 'provider_tool.try_run',
        resourceType: 'endpoint_origin',
        resourceId: origin,
        after: { origin, method: plan.method, callId, signed, source: plan.source },
      });
      const started = Date.now();
      const response = await this.invoker.invoke({
        tool: throwawayTool(),
        binding: throwawayBinding(organizationId, plan, timeoutMs),
        input: {},
        callId,
        timeoutMs,
        // No vault: the throwaway binding has no credentials of its own.
        omit: { credentials: true, signature: !signed },
      });
      const redacted = new CredentialRedactor(plan.secrets).response(response);
      return resultOf(plan, redacted, Date.now() - started, warnings);
    });
  }

  /** The origins of every binding this organization holds, whatever its status. */
  private async ownOrigins(organizationId: string): Promise<Set<string>> {
    const rows = await this.bindings.find({
      where: { organizationId },
      select: { id: true, endpoint: true },
    });
    const origins = new Set<string>();
    for (const row of rows) {
      try {
        origins.add(new URL(row.endpoint).origin);
      } catch {
        // A stored endpoint that does not parse names no origin.
      }
    }
    return origins;
  }
}

function assertOneSource(body: TryProviderToolBodyDto): void {
  if ((body.curl === undefined) === (body.openapi === undefined)) {
    throw ProviderToolErrors.invalid({ problems: ['send exactly one of curl and openapi'] });
  }
  if (body.curl !== undefined && (body.headers || body.input || body.operationId)) {
    // A curl command carries its own headers; two sources of one header
    // would need a merge rule nobody can see on the screen.
    throw ProviderToolErrors.invalid({
      problems: ['headers, input and operationId go with openapi; put them in the curl command'],
    });
  }
}

function planOf(body: TryProviderToolBodyDto): TryPlan {
  const headers = body.headers ?? {};
  if (Object.values(headers).some((value) => typeof value !== 'string')) {
    throw ProviderToolErrors.invalid({ problems: ['every header value is a string'] });
  }
  try {
    return body.curl !== undefined
      ? planFromCurl(body.curl)
      : planFromOpenApi(body.openapi as string, {
          operationId: body.operationId,
          input: body.input,
          headers: body.headers,
        });
  } catch (error) {
    if (error instanceof TryParseError) {
      throw ProviderToolErrors.invalid({ problems: [...error.problems] });
    }
    throw error;
  }
}

/**
 * Defence in depth before the egress client's own checks: `localhost`, an IP
 * literal in a blocked range and one of Assay's own hosts are refused without
 * a socket. A host name is
 * resolved and checked by the egress client, every hop.
 */
function assertDialable(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIpLiteralHost(host) && isBlockedAddress(host))
  ) {
    throw ProviderToolErrors.invalid({
      problems: [
        'the endpoint is a private or reserved address; only public endpoints can be tried',
      ],
    });
  }
  if (isDeniedHost(host)) {
    throw ProviderToolErrors.invalid({
      problems: ["the endpoint points at one of Assay's own hosts; it cannot be tried"],
    });
  }
}

/** A permissive contract: the throwaway mapping has constants only, so no input reaches it. */
function throwawayTool(): Tool {
  return {
    id: 'try',
    name: 'try',
    description: '',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    verificationPolicyId: 'try',
    tier: ToolTier.UNVERIFIED,
  } as unknown as Tool;
}

/** The pasted request as a binding: endpoint = the full URL, every part a constant. */
function throwawayBinding(organizationId: string, plan: TryPlan, timeoutMs: number): ToolBinding {
  const target = new URL(plan.url);
  const endpoint = `${target.origin}${target.pathname}`;
  const query: Record<string, JsonValue> = {};
  for (const [name, value] of target.searchParams) query[name] = { $const: value };
  const headers: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(plan.headers)) headers[name] = { $const: value };
  return {
    id: randomUUID(),
    toolId: 'try',
    providerId: organizationId,
    endpoint,
    requestMapping: {
      method: plan.method,
      query,
      headers,
      ...(plan.body !== undefined ? { body: { $const: plan.body } } : {}),
    },
    responseMapping: {},
    timeoutMs,
    authMode: BindingAuthMode.NONE,
  } as unknown as ToolBinding;
}

function resultOf(
  plan: TryPlan,
  response: ProviderResponse | null,
  latencyMs: number,
  extra: readonly TryWarning[],
): ProviderToolTryResultDto {
  const warnings: TryWarning[] = [...plan.warnings, ...extra];
  const answer =
    response && response.status >= 200 && response.status < 300 && !response.transportError
      ? response.body.kind === ResponseBodyKind.JSON
        ? response.body.value
        : undefined
      : undefined;
  if (response && answer === undefined) {
    warnings.push({
      code: TryWarningCode.NO_JSON_RESPONSE,
      detail: 'the endpoint did not answer 2xx JSON, so the output was not inferred',
    });
  }
  const output =
    answer !== undefined
      ? outputOf(answer, plan.outputSchema)
      : plan.outputSchema
        ? outputOf({}, plan.outputSchema)
        : null;
  const { example, trimmed } = exampleOf(plan.arguments, answer);
  if (trimmed) {
    warnings.push({
      code: TryWarningCode.EXAMPLE_TOO_LARGE,
      detail: 'the answer exceeds the 2 KB example cap; the example has no result',
    });
  }
  const shown = new URL(plan.url);
  for (const name of plan.secretQueryNames) {
    if (shown.searchParams.has(name)) shown.searchParams.set(name, '***');
  }
  return {
    source: plan.source,
    ran: response !== null,
    passed: answer !== undefined,
    request: { method: plan.method, url: shown.href, headerNames: Object.keys(plan.headers) },
    upstream: response ? upstreamOf(response, latencyMs) : null,
    inferred: {
      endpoint: plan.endpoint,
      inputSchema: plan.inputSchema,
      outputSchema: output?.outputSchema ?? null,
      examples: [example],
      requestMapping: plan.requestMapping,
      responseMapping: output?.responseMapping ?? null,
      operationId: plan.operationId,
    },
    warnings: warnings.map((warning) => ({ ...warning })),
    ranAt: new Date(),
  };
}

function upstreamOf(response: ProviderResponse, latencyMs: number) {
  const body = response.body;
  let echoed: unknown = null;
  if (body.kind === ResponseBodyKind.JSON) {
    const text = JSON.stringify(body.value);
    const bytes = Buffer.byteLength(text, 'utf8');
    echoed =
      bytes <= JSON_ECHO_LIMIT
        ? body.value
        : { truncated: true, bytes, head: text.slice(0, JSON_ECHO_LIMIT) };
  } else if (body.kind === ResponseBodyKind.NON_JSON) {
    echoed = body.raw.slice(0, TEXT_ECHO_LIMIT);
  }
  return {
    status: response.status,
    latencyMs,
    contentType: response.headers?.['content-type'] ?? null,
    bodyKind: body.kind,
    body: echoed,
    transportError: response.transportError
      ? { kind: response.transportError.kind, detail: response.transportError.detail ?? null }
      : null,
  };
}
