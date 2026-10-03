import { ToolErrors } from '../../errors/tool.errors';
import { ABSENT, EvaluateOptions, evaluateNode, evaluateRequired } from './evaluate';
import {
  JsonObject,
  MappingContext,
  MappingDirection,
  MappingFault,
  ObjectNode,
  RequestMappingSpec,
  UpstreamRequest,
} from './mapping.types';
import { JsonSchema, validateAgainstSchema } from './schema-validator';

/**
 * Tool input → the request the provider's endpoint already accepts.
 *
 * This is the direction that carries a founding requirement: *the
 * provider does not need to know x402, does not need an SDK, and changes
 * nothing.* Read what this function can produce — a method, a path, a query
 * string, headers and a JSON body, all derived from the agent's arguments and
 * the binding's constants. There is no field in which the platform could
 * require the provider to accept a payment header, echo a request id, or
 * implement a callback. The design is right precisely because it *cannot*
 * express such a demand, not because we have agreed not to make one.
 *
 * The provider is paid off this path entirely: the platform holds the agent's
 * funds in the ledger, settles to the provider's payout account after
 * verification, and the endpoint sees an ordinary client. Any credential the
 * endpoint needs is the provider's own, injected by the caller into
 * `headers` — a secret never belongs in a mapping, which is stored in a
 * `jsonb` column and shown in a console.
 */

const PATH_INTERPOLATION = /\{(\$[^}]*)\}/g;

export interface MapRequestOptions {
  /** The tool's `inputSchema`. Validated before mapping — see below. */
  readonly inputSchema?: JsonSchema;
  readonly context?: MappingContext;
}

/**
 * Maps tool input to an upstream request.
 *
 * Input is validated **before** the mapping runs, not after. An agent that
 * omitted a required argument gets `TOOL_MAPPING_REQUIRED_FIELD_MISSING`
 * attributed to `AGENT` — a `REQUEST_ERROR` in the classifier's vocabulary, which
 * settles nothing and slashes nobody. Validating afterwards would surface the
 * same fault as a mapping failure and put it on the platform's ledger of bugs,
 * or worse, on the provider's record.
 */
export function mapRequest(
  spec: RequestMappingSpec,
  input: JsonObject,
  options: MapRequestOptions = {},
): UpstreamRequest {
  validateAgainstSchema(input, options.inputSchema, {
    direction: MappingDirection.REQUEST,
    fault: MappingFault.AGENT,
    context: options.context,
  });

  const evaluateOptions: EvaluateOptions = {
    direction: MappingDirection.REQUEST,
    fault: MappingFault.AGENT,
    context: options.context,
  };

  const path = interpolatePath(spec.path ?? '', input, evaluateOptions);
  const query = flatten(spec.query, input, '/query', evaluateOptions);
  const headers = flatten(spec.headers, input, '/headers', evaluateOptions);

  const body =
    spec.body === undefined ? undefined : evaluateNode(spec.body, input, '/body', evaluateOptions);

  return {
    method: spec.method,
    path,
    query,
    headers,
    ...(body === undefined || body === ABSENT ? {} : { body }),
  };
}

/**
 * Substitutes `{$.selector}` segments in the path template.
 *
 * A path segment that resolves to nothing cannot be omitted — the resulting
 * URL would address a different resource, or none — so this is the one site in
 * the request direction that reads strictly.
 */
function interpolatePath(template: string, input: JsonObject, options: EvaluateOptions): string {
  if (!template.includes('{')) return template;

  return template.replace(PATH_INTERPOLATION, (_match, selector: string) => {
    const value = evaluateRequired(
      { $path: selector },
      input,
      `/path${selector}`,
      options,
      selector,
    );

    if (value === null || typeof value === 'object') {
      throw ToolErrors.mappingTypeMismatch({
        pointer: `/path${selector}`,
        path: selector,
        expected: 'a scalar for a path segment',
        actual: value === null ? 'null' : Array.isArray(value) ? 'array' : 'object',
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }

    return encodeURIComponent(String(value));
  });
}

/**
 * Evaluates a flat object of nodes into strings.
 *
 * Query parameters and headers are strings on the wire whatever the mapping
 * says, so the conversion happens here where it can still be explained,
 * rather than in the HTTP client where a `[object Object]` would reach the
 * provider and look like a bad request from us.
 *
 * A parameter that resolves to nothing is **omitted**. That is not the same as
 * sending it empty: `?limit=` and no `limit` at all mean different things to
 * most APIs, and the mapping has no way to know which the provider wants, so
 * the honest move is to send only what we actually have.
 */
function flatten(
  node: ObjectNode | undefined,
  input: JsonObject,
  pointer: string,
  options: EvaluateOptions,
): Readonly<Record<string, string>> {
  if (!node) return {};

  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(node)) {
    const value = evaluateNode(child, input, `${pointer}/${key}`, options);
    if (value === ABSENT) continue;

    if (value === null) {
      // An explicit `null` is a value the provider's data model may not have a
      // wire form for. Omitting it silently would hide a real mapping decision.
      throw ToolErrors.mappingNullValue({
        pointer: `${pointer}/${key}`,
        direction: options.direction,
        fault: options.fault,
        detail: 'null has no wire form in a query string or header',
        ...options.context,
      });
    }

    if (typeof value === 'object') {
      throw ToolErrors.mappingTypeMismatch({
        pointer: `${pointer}/${key}`,
        expected: 'a scalar',
        actual: Array.isArray(value) ? 'array' : 'object',
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }

    result[key] = String(value);
  }
  return result;
}
