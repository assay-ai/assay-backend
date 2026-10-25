import {
  ConstNode,
  EmptyPolicy,
  FromNode,
  HttpMethod,
  JsonObject,
  JsonValue,
  MappingNode,
  NullPolicy,
  ObjectNode,
  PathNode,
  RawMappingNode,
  RequestMappingSpec,
  ResponseMappingSpec,
  TransformStep,
} from './mapping.types';

/**
 * Normalisation — provider shorthand in, canonical mapping out.
 *
 * A mapping is naturally written the terse way, and the terse way is right for
 * a human typing into a form:
 *
 * ```jsonc
 * { "q": "$.query", "limit": "$.maxResults", "lang": "en" }
 * ```
 *
 * The rule is positional — a string beginning `$.` is a selector, everything
 * else is a constant — and it is ambiguous for exactly one input: a constant
 * that genuinely starts with `$.`. That ambiguity is cheap to live with while
 * a person is typing and expensive to live with once the value is in a
 * `jsonb` column being read by a router, a validator, a diff view and a
 * dispute six months later.
 *
 * So the shorthand survives exactly one function call. `normalizeMappingNode`
 * resolves it, the binding editor stores the canonical form, and nothing
 * downstream re-derives the question. The escape hatch for the ambiguous case
 * is to write the canonical form directly: `{ "$const": "$.not a path" }`.
 */

const PATH_PREFIXES = ['$.', '$[', '@.', '@['] as const;
const ROOT_SELECTORS = ['$', '@'] as const;

/** Every reserved key. A `$`-prefixed key that is not here is a spec error. */
export const DIRECTIVES = [
  '$const',
  '$path',
  '$default',
  '$optional',
  '$onNull',
  '$transform',
  '$from',
  '$item',
  '$onEmpty',
] as const;

export type Directive = (typeof DIRECTIVES)[number];

export class NormalizeError extends Error {
  constructor(
    message: string,
    /** JSON-pointer-ish location inside the spec, so the console can highlight it. */
    readonly pointer: string,
  ) {
    super(message);
  }
}

/** `true` when a bare string should be read as a selector rather than a constant. */
export function looksLikeSelector(value: string): boolean {
  return (
    PATH_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    ROOT_SELECTORS.includes(value as (typeof ROOT_SELECTORS)[number])
  );
}

export function isConstNode(node: MappingNode): node is ConstNode {
  return typeof node === 'object' && node !== null && '$const' in node;
}

export function isPathNode(node: MappingNode): node is PathNode {
  return typeof node === 'object' && node !== null && '$path' in node;
}

export function isFromNode(node: MappingNode): node is FromNode {
  return typeof node === 'object' && node !== null && '$from' in node;
}

export function isObjectNode(node: MappingNode): node is ObjectNode {
  return !isConstNode(node) && !isPathNode(node) && !isFromNode(node);
}

/**
 * Widens one raw node into canonical form.
 *
 * Recursive: an object's values are normalised too, so a spec is canonical all
 * the way down after a single call at the root.
 */
/**
 * Hard ceiling on mapping nesting. Without it a self-inflicted deeply-nested
 * mapping recurses until the stack overflows — a 500 on the caller's own save
 * (own-tenant only, but it should be a clean 4xx, not a crashed request).
 */
const MAX_MAPPING_DEPTH = 64;

export function normalizeMappingNode(raw: RawMappingNode, pointer = '', depth = 0): MappingNode {
  if (depth > MAX_MAPPING_DEPTH) {
    throw new NormalizeError(`Mapping nested deeper than ${MAX_MAPPING_DEPTH} levels`, pointer);
  }
  if (typeof raw === 'string') {
    return looksLikeSelector(raw) ? { $path: raw } : { $const: raw };
  }

  // A bare number, boolean or null in a mapping can only be a constant —
  // there is no shorthand it could be confused with.
  if (raw === null || typeof raw === 'number' || typeof raw === 'boolean') {
    return { $const: raw as JsonValue };
  }

  if (Array.isArray(raw)) {
    // An array literal is a constant. Collections are built with `$from`,
    // which is a projection, not a literal — conflating them would make
    // `["a", "b"]` mean two different things depending on its neighbours.
    return { $const: raw as JsonValue };
  }

  if (typeof raw !== 'object') {
    throw new NormalizeError(`Unsupported mapping node of type ${typeof raw}`, pointer);
  }

  const source = raw as Record<string, unknown>;
  const directives = Object.keys(source).filter((key) => key.startsWith('$'));

  for (const key of directives) {
    if (!(DIRECTIVES as readonly string[]).includes(key)) {
      throw new NormalizeError(`Unknown directive "${key}"`, joinPointer(pointer, key));
    }
  }

  if (directives.length === 0) {
    return normalizeObjectNode(source, pointer, depth);
  }

  if ('$from' in source) {
    return normalizeFromNode(source, pointer, depth);
  }

  if ('$const' in source) {
    assertOnlyDirectives(source, ['$const'], pointer);
    return { $const: source.$const as JsonValue };
  }

  if ('$path' in source) {
    return normalizePathNode(source, pointer);
  }

  throw new NormalizeError(
    `Node carries directives (${directives.join(', ')}) but none of $const, $path or $from`,
    pointer,
  );
}

function normalizeObjectNode(
  source: Record<string, unknown>,
  pointer: string,
  depth: number,
): ObjectNode {
  const result: Record<string, MappingNode> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = normalizeMappingNode(
      value as RawMappingNode,
      joinPointer(pointer, key),
      depth + 1,
    );
  }
  return result;
}

function normalizePathNode(source: Record<string, unknown>, pointer: string): PathNode {
  if (typeof source.$path !== 'string') {
    throw new NormalizeError('$path must be a string selector', joinPointer(pointer, '$path'));
  }

  const node: {
    $path: string;
    $default?: JsonValue;
    $optional?: boolean;
    $onNull?: NullPolicy;
    $transform?: readonly TransformStep[];
  } = { $path: source.$path };

  if ('$default' in source) {
    node.$default = source.$default as JsonValue;
  }

  if ('$optional' in source) {
    if (typeof source.$optional !== 'boolean') {
      throw new NormalizeError(
        '$optional must be true or false',
        joinPointer(pointer, '$optional'),
      );
    }
    node.$optional = source.$optional;
  }

  if ('$onNull' in source) {
    node.$onNull = normalizeEnum(
      source.$onNull,
      NullPolicy,
      '$onNull',
      joinPointer(pointer, '$onNull'),
    );

    // `DEFAULT` names a fallback that does not exist. Accepting it would leave
    // the engine to invent one at runtime, which is the moment a policy the
    // author never wrote starts deciding what an agent receives.
    if (node.$onNull === NullPolicy.DEFAULT && !('$default' in source)) {
      throw new NormalizeError(
        '$onNull: DEFAULT requires a $default to fall back to',
        joinPointer(pointer, '$onNull'),
      );
    }
  }

  if ('$transform' in source) {
    node.$transform = normalizeTransforms(source.$transform, joinPointer(pointer, '$transform'));
  }

  return node;
}

/**
 * Normalises a projection, accepting the sibling-key sugar.
 *
 * The terse form writes the item template as siblings of `$from`:
 *
 * ```jsonc
 * { "$from": "$.data.items[*]", "url": "$.link", "title": "$.title" }
 * ```
 *
 * which reads well and stores badly — directives and data share a namespace,
 * so a provider whose response has a field called `$item` has a problem, and a
 * console rendering the node has to know which keys are structural. The sugar
 * is accepted and immediately rewritten to the explicit `$item` form.
 */
function normalizeFromNode(
  source: Record<string, unknown>,
  pointer: string,
  depth: number,
): FromNode {
  if (typeof source.$from !== 'string') {
    throw new NormalizeError('$from must be a string selector', joinPointer(pointer, '$from'));
  }

  const siblings = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith('$')),
  );
  const hasExplicitItem = '$item' in source;

  if (hasExplicitItem && Object.keys(siblings).length > 0) {
    throw new NormalizeError(
      `Projection declares $item and also carries sibling keys (${Object.keys(siblings).join(', ')}); use one form or the other`,
      pointer,
    );
  }

  const rawItem = hasExplicitItem ? source.$item : siblings;
  if (!hasExplicitItem && Object.keys(siblings).length === 0) {
    throw new NormalizeError(
      '$from has no item mapping: add $item, or sibling keys describing each element',
      pointer,
    );
  }

  const node: { $from: string; $item: MappingNode; $onEmpty?: EmptyPolicy } = {
    $from: source.$from,
    $item: normalizeMappingNode(
      rawItem as RawMappingNode,
      joinPointer(pointer, '$item'),
      depth + 1,
    ),
  };

  if ('$onEmpty' in source) {
    node.$onEmpty = normalizeEnum(
      source.$onEmpty,
      EmptyPolicy,
      '$onEmpty',
      joinPointer(pointer, '$onEmpty'),
    );
  }

  return node;
}

/** Parameterless steps may be bare strings; both forms become `{ name, args }`. */
export function normalizeTransformStep(
  raw: unknown,
  pointer: string,
): { readonly name: string; readonly args: JsonObject } {
  if (typeof raw === 'string') {
    return { name: raw, args: {} };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NormalizeError('A transform step must be a name or { name, args }', pointer);
  }

  const step = raw as Record<string, unknown>;
  if (typeof step.name !== 'string' || step.name.length === 0) {
    throw new NormalizeError('A transform step must carry a non-empty "name"', pointer);
  }

  const args = step.args;
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    throw new NormalizeError('Transform "args" must be an object', pointer);
  }

  return { name: step.name, args: (args as JsonObject | undefined) ?? {} };
}

function normalizeTransforms(raw: unknown, pointer: string): readonly TransformStep[] {
  const steps = Array.isArray(raw) ? raw : [raw];
  return steps.map((step, index) => normalizeTransformStep(step, `${pointer}/${index}`));
}

function normalizeEnum<T extends Record<string, string>>(
  raw: unknown,
  values: T,
  name: string,
  pointer: string,
): T[keyof T] {
  const allowed = Object.values(values);
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new NormalizeError(
      `${name} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(raw)}`,
      pointer,
    );
  }
  return raw as T[keyof T];
}

function assertOnlyDirectives(
  source: Record<string, unknown>,
  allowed: readonly string[],
  pointer: string,
): void {
  const extra = Object.keys(source).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new NormalizeError(
      `${allowed[0]} cannot be combined with ${extra.join(', ')}`,
      joinPointer(pointer, extra[0]),
    );
  }
}

function joinPointer(pointer: string, key: string): string {
  return `${pointer}/${key}`;
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST'];

/** Normalises the whole request side of a binding. */
export function normalizeRequestMapping(raw: unknown): RequestMappingSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NormalizeError('A request mapping must be an object', '');
  }

  const source = raw as Record<string, unknown>;
  const method = source.method;
  if (typeof method !== 'string' || !HTTP_METHODS.includes(method as HttpMethod)) {
    throw new NormalizeError(
      `method must be one of ${HTTP_METHODS.join(' | ')}, got ${JSON.stringify(method)}`,
      '/method',
    );
  }

  if (source.path !== undefined && typeof source.path !== 'string') {
    throw new NormalizeError('path must be a string', '/path');
  }

  const spec: {
    method: HttpMethod;
    path?: string;
    query?: ObjectNode;
    headers?: ObjectNode;
    body?: MappingNode;
  } = { method: method as HttpMethod };

  if (source.path !== undefined) spec.path = source.path as string;
  if (source.query !== undefined) spec.query = normalizeFlatObject(source.query, '/query');
  if (source.headers !== undefined) spec.headers = normalizeFlatObject(source.headers, '/headers');
  if (source.body !== undefined) {
    spec.body = normalizeMappingNode(source.body as RawMappingNode, '/body');
  }

  return spec;
}

/**
 * Query strings and headers are flat by nature — a nested object has no
 * meaning in either, and accepting one would only defer the failure to the
 * HTTP client.
 */
function normalizeFlatObject(raw: unknown, pointer: string): ObjectNode {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NormalizeError(`${pointer.slice(1)} must be an object`, pointer);
  }

  const result: Record<string, MappingNode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const node = normalizeMappingNode(value as RawMappingNode, joinPointer(pointer, key));
    if (isFromNode(node) || isObjectNode(node)) {
      throw new NormalizeError(
        `${pointer.slice(1)} values must be scalars: "${key}" maps to a ${isFromNode(node) ? 'projection' : 'nested object'}`,
        joinPointer(pointer, key),
      );
    }
    result[key] = node;
  }
  return result;
}

/** Normalises the whole response side of a binding. */
export function normalizeResponseMapping(raw: unknown): ResponseMappingSpec {
  if (raw === undefined) {
    throw new NormalizeError('A response mapping is required', '');
  }
  return normalizeMappingNode(raw as RawMappingNode, '');
}
