import { ToolErrors } from '../../errors/tool.errors';
import { PathRead, readCollection, readPath } from './json-path';
import {
  EmptyPolicy,
  JsonObject,
  JsonValue,
  MappingContext,
  MappingDirection,
  MappingFault,
  MappingNode,
  NullPolicy,
} from './mapping.types';
import { isConstNode, isFromNode, isPathNode, normalizeTransformStep } from './normalize';
import { TransformError, applyTransform } from './transforms';

/**
 * The evaluator — one recursive walk shared by both directions.
 *
 * There is exactly one of these on purpose. A request mapping and a response
 * mapping are the same operation pointed the other way: read a value out of a
 * document with a selector, transform it, place it in a new document. Two
 * evaluators would drift, and the drift would show up as the round trip
 * failing to preserve meaning — the property the whole binding model rests on.
 *
 * What differs between the directions is not the walk but the *fault*: the
 * caller supplies it, and every error raised here carries it through to the
 * classifier.
 */

export interface EvaluateOptions {
  readonly direction: MappingDirection;
  /** Fault attributed to data that resolved but was wrong. */
  readonly fault: MappingFault;
  readonly context?: MappingContext;
}

/** A value that resolved to nothing, at a site where absence is allowed. */
export const ABSENT: unique symbol = Symbol('mapping.absent');

export type Evaluated = JsonValue | typeof ABSENT;

/**
 * Evaluates one node against `source`.
 *
 * Returns {@link ABSENT} rather than `undefined` when a selector misses and
 * the site tolerates it. `undefined` would be indistinguishable from a JSON
 * `null` after a round trip through `JSON.parse`, and telling those apart is
 * the point of half this file.
 */
export function evaluateNode(
  node: MappingNode,
  source: JsonValue,
  pointer: string,
  options: EvaluateOptions,
): Evaluated {
  if (isConstNode(node)) {
    return node.$const;
  }

  if (isPathNode(node)) {
    return evaluatePath(node, source, pointer, options);
  }

  if (isFromNode(node)) {
    return evaluateProjection(node, source, pointer, options);
  }

  const result: JsonObject = {};
  for (const [key, child] of Object.entries(node)) {
    const value = evaluateNode(child, source, `${pointer}/${key}`, options);
    // An absent optional field is left out of the document entirely rather
    // than written as `null`. Writing `null` would assert the provider said
    // "no value" when it said nothing at all, and a downstream schema check
    // would then raise the wrong one of two codes.
    if (value !== ABSENT) {
      result[key] = value;
    }
  }
  return result;
}

function evaluatePath(
  node: Extract<MappingNode, { $path: string }>,
  source: JsonValue,
  pointer: string,
  options: EvaluateOptions,
): Evaluated {
  const read: PathRead = readPath(source, node.$path);
  const onNull = node.$onNull ?? NullPolicy.PASS;
  const hasDefault = '$default' in node;

  if (read.kind === 'MISSING') {
    if (hasDefault) return applyTransforms(node, node.$default as JsonValue, pointer, options);
    if (node.$optional === true) return ABSENT;

    // A selector with neither a default nor `$optional` is an assertion that
    // the field is there. Returning "nothing" here instead would be the one
    // silent failure in the engine — a mistyped selector would produce a
    // document quietly missing a field, no error raised anywhere, and an agent
    // charged in full for it.
    throw ToolErrors.mappingPathNotFound({
      pointer: pointer || '/',
      path: node.$path,
      direction: options.direction,
      // The selector did not resolve at all: our mapping is aimed at a field
      // this document does not have. Never the provider's strike.
      fault: MappingFault.PLATFORM,
      ...options.context,
    });
  }

  if (read.kind === 'NULL') {
    if (onNull === NullPolicy.ERROR) {
      throw ToolErrors.mappingNullValue({
        pointer: pointer || '/',
        path: node.$path,
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }
    // `DEFAULT` without a `$default` is rejected at Save, so the fallback is
    // always there by the time a spec runs.
    if (onNull === NullPolicy.DEFAULT && hasDefault) {
      return applyTransforms(node, node.$default as JsonValue, pointer, options);
    }
    // PASS: a provider's explicit `null` is data, and it is carried through
    // untransformed — running `toNumber` on "no value" would turn a truthful
    // null into a transform failure.
    return null;
  }

  return applyTransforms(node, read.value, pointer, options);
}

function applyTransforms(
  node: Extract<MappingNode, { $path: string }>,
  value: JsonValue,
  pointer: string,
  options: EvaluateOptions,
): JsonValue {
  let current = value;

  for (const [index, rawStep] of (node.$transform ?? []).entries()) {
    const step = normalizeTransformStep(rawStep, `${pointer}/$transform/${index}`);
    try {
      current = applyTransform(step.name, current, step.args);
    } catch (error) {
      // A transform that failed is never passed through. Silence here is the
      // failure mode that makes a mapping look correct and a receipt lie.
      throw ToolErrors.mappingTransformFailed({
        pointer: pointer || '/',
        transform: step.name,
        path: node.$path,
        detail: error instanceof TransformError ? error.message : 'transform threw',
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }
  }

  return current;
}

function evaluateProjection(
  node: Extract<MappingNode, { $from: string }>,
  source: JsonValue,
  pointer: string,
  options: EvaluateOptions,
): Evaluated {
  const read = readCollection(source, node.$from);
  const onEmpty = node.$onEmpty ?? EmptyPolicy.PASS;

  if (read.kind === 'MISSING') {
    throw ToolErrors.mappingPathNotFound({
      pointer: pointer || '/',
      path: node.$from,
      direction: options.direction,
      // A collection selector that resolves to nothing at all is our mapping
      // aimed at a branch this provider does not have. It is never the
      // provider's strike.
      fault: MappingFault.PLATFORM,
      ...options.context,
    });
  }

  if (read.kind === 'NULL') {
    // The branch exists and the provider put `null` there. That is the
    // provider's data, and it is the same statement as an empty list — so it
    // takes the empty-collection path, not the missing-path one.
    if (onEmpty === EmptyPolicy.ERROR) {
      throw ToolErrors.mappingEmptyCollection({
        pointer: pointer || '/',
        path: node.$from,
        detail: 'collection is null',
        direction: options.direction,
        fault: options.fault,
        ...options.context,
      });
    }
    return [];
  }

  if (read.kind === 'NOT_ARRAY') {
    throw ToolErrors.mappingTypeMismatch({
      pointer: pointer || '/',
      path: node.$from,
      expected: 'array',
      actual: Array.isArray(read.value) ? 'array' : typeof read.value,
      direction: options.direction,
      fault: options.fault,
      ...options.context,
    });
  }

  if (read.items.length === 0 && onEmpty === EmptyPolicy.ERROR) {
    throw ToolErrors.mappingEmptyCollection({
      pointer: pointer || '/',
      path: node.$from,
      direction: options.direction,
      fault: options.fault,
      ...options.context,
    });
  }

  return read.items.map((item, index) => {
    const mapped = evaluateNode(node.$item, item, `${pointer}/${index}`, options);
    // An element that maps to nothing at all becomes `null` rather than
    // vanishing: dropping it would silently change the length of the
    // collection, and a count is something an agent may have paid for.
    return mapped === ABSENT ? null : mapped;
  });
}

/**
 * Evaluates a node that must produce a value, raising
 * `TOOL_MAPPING_PATH_NOT_FOUND` when it does not.
 *
 * The strict reading, used where the shape of the request is not negotiable —
 * a path segment, for instance, cannot be quietly omitted.
 */
export function evaluateRequired(
  node: MappingNode,
  source: JsonValue,
  pointer: string,
  options: EvaluateOptions,
  selector?: string,
): JsonValue {
  const value = evaluateNode(node, source, pointer, options);
  if (value === ABSENT) {
    throw ToolErrors.mappingPathNotFound({
      pointer: pointer || '/',
      path: selector ?? (isPathNode(node) ? node.$path : undefined),
      direction: options.direction,
      fault: MappingFault.PLATFORM,
      ...options.context,
    });
  }
  return value;
}
