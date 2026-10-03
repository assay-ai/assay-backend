import { ABSENT, EvaluateOptions, evaluateNode } from './evaluate';
import {
  JsonValue,
  MappingContext,
  MappingDirection,
  MappingFault,
  ResponseMappingSpec,
} from './mapping.types';
import { JsonSchema, validateAgainstSchema } from './schema-validator';

/**
 * The provider's native response → the tool's `outputSchema`.
 *
 * This is the half that makes routing possible at all. The tool's
 * `outputSchema` is the contract every binding must satisfy, so an agent that
 * calls `search_web` sees one shape regardless of which of eight providers
 * served it. Without that, "route to the best provider" is not implementable —
 * the agent would need per-provider handling, which is the coupling the
 * platform exists to remove.
 *
 * Validation runs **after** mapping, against the mapped document. Validating
 * the provider's raw response would be meaningless: there is no schema for it,
 * that is the whole reason a mapping exists.
 */

export interface MapResponseOptions {
  /** The tool's `outputSchema` — the contract. Skipping it makes the mapping unenforced. */
  readonly outputSchema?: JsonSchema;
  readonly context?: MappingContext;
}

/**
 * Maps an upstream response into the tool contract.
 *
 * Fault attribution on this side is the subtle part, and getting it wrong is
 * easy and expensive: *a mapping bug looks exactly like a provider returning
 * malformed data.* The rule applied here:
 *
 * - A selector that resolves to nothing → `PLATFORM`. Our mapping points at a
 *   field this provider never had. `SYSTEM_ERROR`, no strike.
 * - A selector that resolves to the wrong thing — null at a required site, a
 *   string where the contract says number, an empty list where the contract
 *   says results — → `PROVIDER`. The mapping was right; the payload was not.
 *
 * The engine only *reports* this. The classifier decides the class,
 * and only a `DATA_FAIL` verdict from verification ever reaches settlement.
 * Nothing in this file can cause a slash, which is the point.
 */
export function mapResponse(
  spec: ResponseMappingSpec,
  upstream: JsonValue,
  options: MapResponseOptions = {},
): JsonValue {
  const evaluateOptions: EvaluateOptions = {
    direction: MappingDirection.RESPONSE,
    fault: MappingFault.PROVIDER,
    context: options.context,
  };

  const mapped = evaluateNode(spec, upstream, '', evaluateOptions);

  // A mapping whose every field resolved to nothing produced no document at
  // all. Reporting `{}` would let a schema with no `required` fields pass an
  // empty answer off as a successful call.
  const document: JsonValue = mapped === ABSENT ? {} : mapped;

  validateAgainstSchema(document, options.outputSchema, {
    direction: MappingDirection.RESPONSE,
    fault: MappingFault.PROVIDER,
    context: options.context,
  });

  return document;
}
