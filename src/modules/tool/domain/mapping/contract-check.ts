import { ToolErrors } from '../../errors/tool.errors';
import { JsonSchema, validateAgainstSchema } from './schema-validator';
import {
  ConstNode,
  MappingContext,
  MappingDirection,
  MappingFault,
  MappingNode,
  ResponseMappingSpec,
} from './mapping.types';
import { isConstNode, isFromNode, isPathNode } from './normalize';

/**
 * Save-time checking of a response mapping **against the tool contract**.
 *
 * `mapping-validator.ts` answers "is this spec well-formed" and stops there,
 * deliberately: it cannot tell you whether a mapping is *correct*, because
 * only a real response can. But there is a third question in between — check
 * types and required fields as you type, not at submit:
 *
 * > Is this mapping **incapable** of satisfying the contract, whatever the
 * > provider's endpoint returns?
 *
 * Two cases are decidable without a response, and both are certainties rather
 * than guesses:
 *
 * 1. **A `required` key the mapping never writes.** The mapped document is
 *    built key by key from the spec; a top-level key absent from an object
 *    mapping cannot appear in the output, so `TOOL_MAPPING_REQUIRED_FIELD_MISSING`
 *    is guaranteed on the first live call.
 * 2. **A constant of the wrong JSON type.** `{ "$const": "5" }` at an
 *    `integer` site fails every time, and it fails at 3am on somebody's
 *    request rather than in the editor.
 *
 * Everything else is left to the tester. A selector might resolve to the right
 * type or the wrong one and this function has no way to know — flagging it
 * would train providers to ignore the editor, which is worse than saying
 * nothing.
 *
 * Applied to the **response** mapping only. The request mapping's target is
 * the provider's own API, which the platform has no schema for; `mapRequest`
 * validates the tool *input* against `inputSchema` at call time and that is a
 * different check on a different document.
 */
export function checkResponseAgainstSchema(
  spec: ResponseMappingSpec,
  outputSchema: JsonSchema | undefined,
  context?: MappingContext,
): void {
  if (!outputSchema) return;
  checkNode(spec, outputSchema, '', context);
}

function checkNode(
  node: MappingNode,
  schema: JsonSchema,
  pointer: string,
  context: MappingContext | undefined,
): void {
  if (isConstNode(node)) {
    checkConst(node, schema, pointer, context);
    return;
  }

  // A selector's value is unknown until a response arrives. That is the
  // tester's question, not this one's.
  if (isPathNode(node)) return;

  if (isFromNode(node)) {
    // A projection produces an array; its element mapping is checked against
    // `items` when the schema says what an element looks like.
    if (schema.items) checkNode(node.$item, schema.items, `${pointer}/$item`, context);
    return;
  }

  checkObject(node, schema, pointer, context);
}

function checkObject(
  node: Record<string, MappingNode>,
  schema: JsonSchema,
  pointer: string,
  context: MappingContext | undefined,
): void {
  for (const field of schema.required ?? []) {
    const child = node[field];

    if (child === undefined) {
      throw ToolErrors.mappingRequiredFieldMissing({
        pointer: `${pointer}/${field}`,
        field,
        detail: 'the mapping never writes this field, so no response can satisfy the contract',
        ...context,
      });
    }

    // `$optional` says "omit this when the selector finds nothing", which at a
    // `required` site is a declaration that the document may legally be
    // invalid. With a `$default` it cannot be — the field is always written.
    if (isPathNode(child) && child.$optional === true && child.$default === undefined) {
      throw ToolErrors.mappingRequiredFieldMissing({
        pointer: `${pointer}/${field}`,
        field,
        detail: '$optional at a required field — give it a $default, or drop $optional',
        ...context,
      });
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(node)) {
    const childSchema = properties[key];
    if (childSchema) checkNode(child, childSchema, `${pointer}/${key}`, context);
  }
}

/**
 * A constant is a value we already have, so it is checked with the engine's
 * own validator rather than a second implementation of "wrong type".
 *
 * `fault: PLATFORM` — a constant that cannot satisfy the contract is a fact
 * about the stored mapping, not about anything the provider's endpoint did.
 * Nothing rides on it at save time; it is set correctly so that the error
 * reads the same way here as it would from the call path.
 */
function checkConst(
  node: ConstNode,
  schema: JsonSchema,
  pointer: string,
  context: MappingContext | undefined,
): void {
  validateAgainstSchema(node.$const, schema, {
    direction: MappingDirection.RESPONSE,
    fault: MappingFault.PLATFORM,
    context,
    pointer,
  });
}
