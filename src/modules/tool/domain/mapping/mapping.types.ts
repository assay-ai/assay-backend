/**
 * The mapping format.
 *
 * A binding translates between the tool contract the agent sees and whatever
 * shape the provider's existing API already speaks. The translation is
 * **data**, not code: JSONPath-style selectors, named transforms, and
 * constants. That is not a stylistic preference — the provider
 * writes this format themselves in the console, so it has to be storable,
 * editable, diffable and testable without a deploy. A mapping expressed as
 * TypeScript would make every new provider a pull request.
 *
 * The other constraint is a founding requirement: *the provider does
 * not need to know x402, does not need an SDK, and changes nothing on their
 * side.* The mapper therefore only ever produces a request the provider's
 * endpoint already accepts, and only ever reads a response the provider
 * already returns. There is no place in this format to require a header, a
 * status code or a body field that the provider does not already serve — by
 * construction, because a mapping cannot ask for anything, it can only
 * rearrange.
 */

/** JSON, as a type. Everything crossing the mapping boundary is one of these. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Which side of a binding a mapping runs on.
 *
 * Carried on every mapping error, because the same failure means opposite
 * things in the two directions: a missing required field on the way *out* is
 * the agent's malformed call, the same thing on the way *back* is a response
 * that did not honour the tool contract.
 */
export enum MappingDirection {
  /** Tool input → the shape the provider's endpoint already accepts. */
  REQUEST = 'REQUEST',
  /** The provider's native response → the tool's `outputSchema`. */
  RESPONSE = 'RESPONSE',
}

/**
 * Who the engine believes is at fault, as a *hint* for the response
 * classifier — never as the classification itself. The engine
 * reports; the classifier decides, and only `DATA_FAIL` reaches settlement.
 *
 * The line between `PLATFORM` and `PROVIDER` is easy to get wrong, so it is
 * drawn explicitly:
 *
 * - The selector **does not resolve at all** → `PLATFORM`. The mapping points
 *   at a field this provider never had. The provider served a response; we
 *   failed to read it. `SYSTEM_ERROR`, no strike, no slash.
 * - The selector **resolves and the data is wrong** — null where a value is
 *   required, a string where a number belongs, an empty collection where the
 *   contract promises results → `PROVIDER`. The mapping was right and the
 *   payload was not.
 *
 * Collapsing these two into one bucket is what makes a mapping bug look
 * exactly like a provider returning garbage, which is the failure to avoid.
 */
export enum MappingFault {
  /** The agent's arguments did not satisfy the tool's `inputSchema`. */
  AGENT = 'AGENT',
  /** Our mapping, or our spec, is wrong. Never a strike against the provider. */
  PLATFORM = 'PLATFORM',
  /** The mapping was right; the provider's payload was not. */
  PROVIDER = 'PROVIDER',
}

// ---------------------------------------------------------------------------
// Value nodes — the leaves of a mapping
// ---------------------------------------------------------------------------

/**
 * A named transform, applied left to right after the selector reads a value.
 *
 * Named rather than inline, so the binding editor can offer a dropdown, and
 * so a stored mapping can never contain executable anything. Parameterless
 * transforms may be written as a bare string; `normalizeTransformStep`
 * canonicalises both forms.
 */
export type TransformStep = string | { readonly name: string; readonly args?: JsonObject };

/** A literal, carried through untouched. The escape hatch for a constant that looks like a path. */
export interface ConstNode {
  readonly $const: JsonValue;
}

/** Read one value from the source document. */
export interface PathNode {
  readonly $path: string;
  /** Used when the selector resolves to nothing at all (`MISSING`). */
  readonly $default?: JsonValue;
  /**
   * Declares that this field may legitimately be absent: a selector that
   * resolves to nothing omits the field instead of failing.
   *
   * **Optionality is a declaration, never an inference.** Without this flag a
   * selector that resolves to nothing raises `TOOL_MAPPING_PATH_NOT_FOUND`,
   * because writing a selector *is* the assertion that the field is there. The
   * alternative — quietly dropping whatever did not resolve — means a typo
   * (`$.tiitle`) produces a document missing a field, no error anywhere, and an
   * agent paying full price for a half-empty answer. That failure is invisible
   * in exactly the way the format exists to prevent, and it would be authored
   * by a provider in a console with no reviewer.
   *
   * So a mapping says which fields are allowed to go missing, and the console
   * renders it as a checkbox.
   */
  readonly $optional?: boolean;
  /**
   * How to treat a selector that resolves to an explicit `null`.
   *
   * `null` and absent are different facts about an upstream, and conflating
   * them loses the only evidence that distinguishes "the provider has no
   * value for this" from "our selector is wrong". Default is `PASS`: a
   * provider's explicit `null` is data, and it is the *schema* that decides
   * whether the tool contract tolerates it.
   */
  readonly $onNull?: NullPolicy;
  readonly $transform?: readonly TransformStep[];
}

export enum NullPolicy {
  /** Carry the `null` through. The schema decides whether that is acceptable. */
  PASS = 'PASS',
  /** Treat it as absent and fall back to `$default`. */
  DEFAULT = 'DEFAULT',
  /** Raise `TOOL_MAPPING_NULL_VALUE` at this site. */
  ERROR = 'ERROR',
}

/** Project a collection: select many, map each through `$item`. */
export interface FromNode {
  readonly $from: string;
  /** The per-element mapping. Selectors inside are relative to the element. */
  readonly $item: MappingNode;
  /**
   * What an empty result means *here*.
   *
   * Deliberately a per-site decision. "Zero results" is a legitimate answer
   * for a search and a broken one for a price feed, and the difference is not
   * something the engine can infer. Default is `PASS` — the verification
   * vocabulary has `EMPTY_CONFIRMED` precisely because an honest empty answer
   * is not a failure.
   */
  readonly $onEmpty?: EmptyPolicy;
}

export enum EmptyPolicy {
  /** An empty collection maps to `[]`. */
  PASS = 'PASS',
  /** Raise `TOOL_MAPPING_EMPTY_COLLECTION`. */
  ERROR = 'ERROR',
}

/** An object built literally, key by key, from other nodes. */
export type ObjectNode = { readonly [key: string]: MappingNode };

/**
 * Any node of a mapping.
 *
 * The shorthand a provider actually types — a bare string — is not in this
 * union on purpose. `normalizeMappingNode` widens
 * {@link RawMappingNode} into this type once, at save time, so nothing
 * downstream has to re-derive whether `"en"` was a path or a constant.
 */
export type MappingNode = ConstNode | PathNode | FromNode | ObjectNode;

/**
 * What a provider writes, before normalisation.
 *
 * A bare string is the terse form: it is a **selector**
 * when it starts with `$.` or `$[`, and a **constant** otherwise. That rule is
 * convenient to type and ambiguous to store, which is why it survives exactly
 * one function call — `normalizeMappingNode` resolves it and the canonical
 * form is what the console persists. A constant that genuinely begins with
 * `$.` is written `{ "$const": "$.literally this" }`.
 *
 * `{ "$from": ..., <siblings> }` is likewise accepted as sugar for
 * `{ "$from": ..., "$item": { <siblings> } }`.
 */
export type RawMappingNode = string | JsonValue | { readonly [key: string]: unknown };

// ---------------------------------------------------------------------------
// The two mappings a binding carries
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST';

/**
 * Tool input → the provider's existing endpoint.
 *
 * `path` is a template over the tool input (`/v1/cities/{$.cityId}`) so a
 * provider whose API is path-addressed needs no change either. Nothing here
 * can add an x402 header, a callback URL or a platform-specific field: the
 * platform pays the provider off-ledger, out of band, and the provider's
 * endpoint sees an ordinary request from an ordinary client.
 */
export interface RequestMappingSpec {
  readonly method: HttpMethod;
  /** Appended to the binding's `endpoint`. May contain `{$.selector}` segments. */
  readonly path?: string;
  readonly query?: ObjectNode;
  readonly headers?: ObjectNode;
  readonly body?: MappingNode;
}

/** The provider's native response → the tool's `outputSchema`. */
export type ResponseMappingSpec = MappingNode;

/** Either mapping, as stored in `tool_bindings.request_mapping` / `.response_mapping`. */
export type MappingSpec = RequestMappingSpec | ResponseMappingSpec;

/**
 * What the request mapper produces: an ordinary HTTP request.
 *
 * Note what is *not* here — no auth scheme the provider must implement, no
 * signature, no payment field. Whatever credential the binding needs is the
 * provider's own, injected by the caller into `headers`.
 */
export interface UpstreamRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

/** Identifies the binding a mapping failure came from, for the receipt and the alert. */
export interface MappingContext {
  readonly toolId?: string;
  readonly bindingId?: string;
  readonly providerId?: string;
}
