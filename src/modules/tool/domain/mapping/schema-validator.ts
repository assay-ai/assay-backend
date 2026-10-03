import { ToolErrors } from '../../errors/tool.errors';
import { JsonValue, MappingContext, MappingDirection, MappingFault } from './mapping.types';

/**
 * Schema validation for the mapping boundary.
 *
 * A deliberately small subset of JSON Schema draft-07 — the keywords a tool
 * contract actually needs, implemented here rather than pulled in, for two
 * reasons that both matter more than the convenience of a library:
 *
 * 1. **Every failure needs its own error code.** A general validator reports a
 *    list of violations in its own vocabulary; this one raises
 *    `TOOL_MAPPING_REQUIRED_FIELD_MISSING`, `TOOL_MAPPING_TYPE_MISMATCH`,
 *    `TOOL_MAPPING_NULL_VALUE` and `TOOL_MAPPING_EMPTY_COLLECTION` as distinct
 *    codes, each carrying the direction, the fault hint and the pointer. Those
 *    codes are what the receipt shows, what the classifier reads, and
 *    what an alert routes on.
 * 2. **`null` is not a type error here.** Draft-07 treats `null` as just
 *    another type mismatch. In this system it is a distinct fact — a provider
 *    saying "I have no value" — and it earns its own code, because the
 *    difference between a provider with no data and a provider with wrong data
 *    is the difference between `EMPTY_CONFIRMED` and a strike.
 *
 * Supported: `type` (single or union), `required`, `properties`, `items`,
 * `enum`, `minItems`, `additionalProperties: false`, `nullable`. Anything else
 * in a schema is ignored rather than rejected — the tool catalogue is allowed
 * to carry richer schemas for the agent's benefit; this validator only
 * enforces what it understands, and says so.
 */

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly minItems?: number;
  readonly additionalProperties?: boolean;
  /** Draft-07 has no `nullable`; it is accepted as sugar for a `null` union member. */
  readonly nullable?: boolean;
  readonly [keyword: string]: unknown;
}

export interface SchemaValidationOptions {
  readonly direction: MappingDirection;
  /**
   * Fault for a violation of *data* — a wrong type, a null, an empty
   * collection at a required site. Absent structure is attributed separately;
   * see {@link faultForMissing}.
   */
  readonly fault: MappingFault;
  readonly context?: MappingContext;
  /** Root pointer, so a nested call can report `/results/0/url`. */
  readonly pointer?: string;
}

/**
 * Validates `value` against `schema`, raising on the first violation.
 *
 * First violation rather than a collected list, on purpose: this mirrors the
 * verification receipt rule — checking stops at the first failing
 * layer and later layers are recorded as *not reached*. A receipt that lists
 * six violations invites arguing about which one mattered.
 */
export function validateAgainstSchema(
  value: JsonValue | undefined,
  schema: JsonSchema | undefined,
  options: SchemaValidationOptions,
): void {
  if (!schema) return;
  validateNode(value, schema, options.pointer ?? '', options);
}

function validateNode(
  value: JsonValue | undefined,
  schema: JsonSchema,
  pointer: string,
  options: SchemaValidationOptions,
): void {
  const types = normalizeTypes(schema);

  if (value === undefined) {
    // Absence at the root of a call is reported by the parent's `required`
    // check, which knows the field name. Reaching here means an optional
    // field was absent, which is not a violation.
    return;
  }

  if (value === null) {
    if (acceptsNull(schema, types)) return;
    throw ToolErrors.mappingNullValue({
      pointer: pointer || '/',
      direction: options.direction,
      fault: options.fault,
      expected: types.join(' | ') || 'a value',
      ...options.context,
    });
  }

  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    throw ToolErrors.mappingTypeMismatch({
      pointer: pointer || '/',
      expected: types.join(' | '),
      actual: describeType(value),
      direction: options.direction,
      fault: options.fault,
      ...options.context,
    });
  }

  if (schema.enum && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    throw ToolErrors.mappingTypeMismatch({
      pointer: pointer || '/',
      expected: `one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`,
      actual: JSON.stringify(value),
      direction: options.direction,
      fault: options.fault,
      ...options.context,
    });
  }

  if (Array.isArray(value)) {
    validateArray(value, schema, pointer, options);
    return;
  }

  if (typeof value === 'object') {
    validateObject(value, schema, pointer, options);
  }
}

function validateArray(
  value: readonly JsonValue[],
  schema: JsonSchema,
  pointer: string,
  options: SchemaValidationOptions,
): void {
  // `minItems: 1` on a tool's output schema is how a tool says "an answer with
  // no results does not satisfy this contract". It gets the empty-collection
  // code rather than a generic constraint failure, because that is the
  // distinction the verdict vocabulary needs to tell a real empty answer from a broken one.
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    if (value.length === 0) {
      throw ToolErrors.mappingEmptyCollection({
        pointer: pointer || '/',
        minItems: schema.minItems,
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }
    throw ToolErrors.mappingTypeMismatch({
      pointer: pointer || '/',
      expected: `at least ${schema.minItems} items`,
      actual: `${value.length} items`,
      direction: options.direction,
      fault: options.fault,
      ...options.context,
    });
  }

  if (schema.items) {
    value.forEach((element, index) => {
      validateNode(element, schema.items as JsonSchema, `${pointer}/${index}`, options);
    });
  }
}

function validateObject(
  value: Readonly<Record<string, JsonValue>>,
  schema: JsonSchema,
  pointer: string,
  options: SchemaValidationOptions,
): void {
  for (const field of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw ToolErrors.mappingRequiredFieldMissing({
        pointer: `${pointer}/${field}`,
        field,
        direction: options.direction,
        fault: faultForMissing(options),
        ...options.context,
      });
    }
  }

  if (schema.additionalProperties === false && schema.properties) {
    const known = Object.keys(schema.properties);
    const extra = Object.keys(value).find((key) => !known.includes(key));
    if (extra !== undefined) {
      throw ToolErrors.mappingTypeMismatch({
        pointer: `${pointer}/${extra}`,
        expected: `one of ${known.join(', ')}`,
        actual: `unexpected property "${extra}"`,
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }
  }

  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    validateNode(value[field], fieldSchema, `${pointer}/${field}`, options);
  }
}

/**
 * A field the contract requires but the mapped document does not carry is a
 * structural gap, and on the response side that is the mapping's gap, not the
 * payload's: the provider was never asked for it. Attributing it to the
 * provider would be the classic mistake — a mapping bug indistinguishable from
 * a bad response.
 *
 * On the request side the structure comes from the agent's own arguments, so
 * the fault stays with the agent.
 */
function faultForMissing(options: SchemaValidationOptions): MappingFault {
  return options.direction === MappingDirection.REQUEST ? options.fault : MappingFault.PLATFORM;
}

function normalizeTypes(schema: JsonSchema): readonly JsonSchemaType[] {
  if (!schema.type) return [];
  const types = Array.isArray(schema.type) ? [...schema.type] : [schema.type];
  if (schema.nullable && !types.includes('null')) types.push('null');
  return types;
}

function acceptsNull(schema: JsonSchema, types: readonly JsonSchemaType[]): boolean {
  // A schema with no `type` at all constrains nothing, so it accepts `null`.
  return types.length === 0 || types.includes('null') || schema.nullable === true;
}

function matchesType(value: JsonValue, type: JsonSchemaType): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

export function describeType(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
