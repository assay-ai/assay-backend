# Binding mapping format

The format a provider writes in the console, stored in
`tool_bindings.request_mapping` and `.response_mapping`, executed by
`src/modules/tool/domain/mapping/`.

Those columns were added together with `binding_versions` and
`binding_test_runs` in migration `1756900000000`. What a provider types goes
through `POST /providers/me/tool-bindings/validate-mapping` while they type and
through the same functions again at Save.

## Why the format is data

A mapping is JSON: selectors, named transforms, constants. It contains no code
and evaluates no expressions. Three consequences, and each of them is the
reason for a rule further down:

- **A provider owns it.** A provider writes their own mapping in the binding
  editor and publishes it. A mapping expressed in TypeScript would make every listing a
  pull request, and onboarding would end there.
- **It changes without a deploy.** Wrong field name at 2am is an edit, not a
  release.
- **It is safe to execute.** Every mapping ever stored can only name behaviour
  that already shipped. This holds only while the transform registry stays
  closed — the moment one entry evaluates an expression, the property is gone
  for every mapping in the table.

## The provider changes nothing

A core requirement is that the provider does not need to know x402,
does not need an SDK, and changes nothing on their side.

That is not a promise the code makes — it is a shape the code *cannot violate*.
A request mapping can produce a method, a path, a query string, headers and a
JSON body, all derived from the agent's arguments and the binding's own
constants. There is no field in which the platform could require the provider
to accept a payment header, echo a request id, or serve a callback. The
provider's endpoint sees an ordinary client.

Money never touches this path. The platform holds the agent's funds (the ledger),
verifies the result (the verification pipeline) and settles to the provider's
payout account on chain (the settlement program). If a design ever requires the provider to change
their endpoint, the design is wrong.

Credentials the endpoint needs are the provider's own and are injected into
`headers` by the caller. **A secret never belongs in a mapping** — a mapping
lives in a `jsonb` column and is rendered in a console.

## Selectors

A deliberately small subset of JSONPath. Small enough to learn from three
examples, complete enough to address any real provider response.

```text
$                       the root of the document
$.a.b.c                 member access, any depth
$['a-b']  $["a b"]      bracketed member access, for keys a dot cannot spell
$.items[0]              array index
$.items[*]              wildcard — every element (only inside $from)
@                       inside $item, the current element
```

Not supported, on purpose: filters `[?(@.x > 1)]`, slices, recursive descent
`..`, and expressions. Each turns a selector into a small program, and the
premise is that a mapping is data. Need a filter? That is a transform, and
transforms are named.

A wildcard at a scalar site is **rejected at Save**. It reads many values where
one belongs, and taking the first match silently is the guess that works
against the sample response a provider tested with and fails on the second page
of results.

## Nodes

Every leaf of a mapping is one of four things.

### Constant

```jsonc
{ "$const": "en" }
```

### Read a value

```jsonc
{
  "$path": "$.data.title",
  "$default": null,                  // used when the selector resolves to nothing
  "$optional": false,                // may this field legitimately be absent?
  "$onNull": "PASS",                 // PASS (default) | DEFAULT | ERROR
  "$transform": ["trim", "lowercase"]
}
```

**Writing a selector is an assertion that the field is there.** A selector that
resolves to nothing, with neither `$default` nor `$optional: true`, raises
`TOOL_MAPPING_PATH_NOT_FOUND`.

That is the single most important default in the format. The alternative —
quietly dropping whatever did not resolve — means a typo (`$.tiitle`) produces
a document missing a field, no error anywhere, and an agent paying full price
for a half-empty answer. The mapping is authored by a provider in a console
with no reviewer, so the format has to make that mistake loud.

Optionality is therefore a **declaration**, never an inference: `$optional:
true` says "this may be absent, omit it", and the console renders it as a
checkbox.

### Project a collection

```jsonc
{
  "$from": "$.data.items[*]",
  "$item": { "url": "$.link", "title": "$.title" },   // selectors are relative to the element
  "$onEmpty": "PASS"                                   // PASS (default) | ERROR
}
```

### Object

Any object whose keys are not `$`-prefixed. Values are nodes, all the way down.

```jsonc
{ "query": "$.request.q", "results": { "$from": "…", "$item": { … } } }
```

## Shorthand

What a provider actually types, and what the console resolves before storing.

| Typed | Stored |
|---|---|
| `"$.query"` | `{ "$path": "$.query" }` |
| `"en"` | `{ "$const": "en" }` |
| `10`, `true`, `null`, `["a"]` | `{ "$const": … }` |
| `{"$from": "…", "url": "$.link"}` | `{"$from": "…", "$item": {"url": {"$path": "$.link"}}}` |

The rule for a bare string: it is a **selector** when it starts with `$.`,
`$[`, `@.` or `@[`, and a **constant** otherwise. That is convenient to type
and ambiguous to store — a constant that genuinely begins with `$.` has two
readings.

So the shorthand survives exactly one function call. `normalizeMappingNode`
resolves it, the console persists the canonical form, and nothing downstream —
router, validator, diff view, dispute — re-derives the question. The escape
hatch is the canonical form itself: `{ "$const": "$.literally this" }`.

Normalisation is idempotent, so a stored mapping round-trips through an editor
unchanged.

## Request mapping

```jsonc
{
  "method": "POST",                      // GET | POST
  "path": "/v1/cities/{$.cityId}/now",   // appended to the binding's endpoint
  "query":   { "hl": "$.language" },
  "headers": { "accept": "application/json" },
  "body":    { "q": "$.query", "num": { "$path": "$.maxResults", "$default": 10 } }
}
```

- `path` interpolates `{$.selector}` segments, URL-encoded. A path segment
  that resolves to nothing is an error — the resulting URL would address a
  different resource, or none.
- `query` and `headers` are flat and stringified. A parameter marked
  `$optional: true` whose selector resolves to nothing is **omitted**, not sent
  empty: `?limit=` and no `limit` mean different things to most APIs and the
  mapping cannot know which the provider wants. Without `$optional` it is an
  error, like anywhere else.
- Tool input is validated against the tool's `inputSchema` **before** mapping,
  so a malformed call is the agent's `REQUEST_ERROR` and never lands as our
  mapping bug or the provider's strike.

## Response mapping

```jsonc
{
  "query": "$.request.q",
  "results": {
    "$from": "$.data.items[*]",
    "url":         "$.link",
    "title":       "$.title",
    "snippet":     { "$path": "$.description", "$onNull": "PASS" },
    "publishedAt": { "$path": "$.ts", "$transform": ["epochSecondsToIso"], "$default": null }
  }
}
```

The mapped document is validated against the tool's `outputSchema`. **That
schema is the contract** — it is what lets the router substitute one provider
for another mid-request without the agent noticing, and a tool whose
`outputSchema` is loose is a tool that cannot be routed on quality.

## Transforms

Closed registry. Named, pure, and total: each returns a value or raises
`TOOL_MAPPING_TRANSFORM_FAILED`. None passes its input through on failure — a
transform that degrades quietly makes the mapping look correct, the contract
break downstream, and the receipt point at the wrong step.

| Name | Effect |
|---|---|
| `trim` `lowercase` `uppercase` | String hygiene |
| `toString` `toNumber` `toInteger` `toBoolean` | Scalar coercion; rejects partial parses rather than rounding or defaulting |
| `epochSecondsToIso` `epochMillisToIso` `isoDate` | Timestamps → ISO 8601 |
| `jsonParse` | For providers that nest JSON inside a string field |
| `split` `join` | Arguments: `{ "separator": "," }` |
| `first` | First element; rejects an empty array rather than nulling it |
| `coalesceEmptyToNull` | `""` → `null`, for providers that spell "no value" that way |

Parameterless steps may be written as a bare string; the canonical form is
`{ "name": "split", "args": { "separator": "," } }`.

Adding a transform is a deploy, and it should be: it is new behaviour every
stored mapping can suddenly reach.

## `null` is not `missing`

The sharpest rule in the format, and the one most engines collapse.

A provider returning `{"publishedAt": null}` is saying *it has no publication
date for this item*. A response with no `publishedAt` key at all may be saying
the same thing — or may be saying *our selector is pointed at the wrong field*.
Only the second is evidence about our mapping, and an engine that returns
`undefined` for both throws the distinction away at the one moment it is free
to keep.

`readPath` therefore has three outcomes — `FOUND`, `NULL`, `MISSING` — and they
produce different error codes:

| Situation | `$onNull` | Result |
|---|---|---|
| Key absent, no `$default`, no `$optional` | any | `TOOL_MAPPING_PATH_NOT_FOUND`, `fault: PLATFORM` |
| Key absent, `$optional: true` | any | field omitted from the document |
| Key absent, `$default` set | any | the default |
| Value `null` | `PASS` (default) | `null` carried through; nullable schema accepts, non-nullable → `TOOL_MAPPING_NULL_VALUE` |
| Value `null` | `DEFAULT` | the default |
| Value `null` | `ERROR` | `TOOL_MAPPING_NULL_VALUE` |

An `$optional` field that is absent is **left out** of the mapped document
rather than written as `null`. Writing `null` would assert the provider said
"no value" when it said nothing at all, and the schema check would then raise
the wrong one of two codes.

A missing selector stays `PLATFORM`'s fault even when the target key is
`required` in the tool's `outputSchema`. That schema states what the *tool
contract* needs, not what the *provider promised*; a selector that does not
resolve is indistinguishable from our mapping being aimed at the wrong field,
and reclassifying it as the provider's fault would push an unprovable
attribution in the direction that ends in strikes.

## Empty collections

A `$from` that resolves to zero elements maps to `[]` and is **not** an error
by default. That is deliberate: the verdict vocabulary has `EMPTY_CONFIRMED`
precisely because an honest empty answer is a real answer, and
charging a provider for one would be the wrong economics.

"Zero results" is legitimate for a search and broken for a price feed, and
nothing in the engine can infer which. So it is a declaration, in either of two
places:

- `"$onEmpty": "ERROR"` on the projection, or
- `minItems: 1` on the tool's `outputSchema`.

Both raise `TOOL_MAPPING_EMPTY_COLLECTION` — its own code, distinct from a
missing path and from a type mismatch.

A `$from` pointing at an explicit `null` takes the same path as an empty list:
the branch exists and the provider put nothing in it.

## Errors

Every failure has its own code. Nothing is swallowed, and there is no
catch-all.

| Code | Raised when | HTTP |
|---|---|---|
| `TOOL_MAPPING_INVALID` | The spec is malformed — unknown directive or transform, bad selector, `$from` with no item mapping. Save-time. | 400 |
| `TOOL_MAPPING_PATH_NOT_FOUND` | A selector resolved to nothing at a site that requires a value | 500 |
| `TOOL_MAPPING_REQUIRED_FIELD_MISSING` | A schema-`required` field is absent from the mapped document | 400 |
| `TOOL_MAPPING_TYPE_MISMATCH` | Present, wrong JSON type | 400 |
| `TOOL_MAPPING_NULL_VALUE` | Explicit `null` where the contract requires a value | 400 |
| `TOOL_MAPPING_EMPTY_COLLECTION` | Zero elements where results are declared mandatory | 400 |
| `TOOL_MAPPING_TRANSFORM_FAILED` | A named transform rejected its input | 500 |

Each carries `direction` (`REQUEST` | `RESPONSE`), `fault`, `pointer`
(`/results/0/url`) and the selector.

### Fault attribution

Fault attribution is easy to get wrong and expensive when it is: a mapping bug
looks exactly like a provider returning malformed data. The line drawn here:

| Situation | `fault` | Meaning |
|---|---|---|
| Tool input fails `inputSchema` | `AGENT` | `REQUEST_ERROR`. Nothing settles, nobody is slashed. |
| A selector resolves to **nothing** | `PLATFORM` | Our mapping points at a field this provider never had. `SYSTEM_ERROR`, no strike. |
| A required field is absent from the mapped response | `PLATFORM` | The provider was never asked for it. |
| A selector resolves and the **data is wrong** — null at a required site, wrong type, empty where results are mandatory | `PROVIDER` | The mapping was right; the payload was not. |

The engine only *reports* this. The response classifier decides the class, and
only a `DATA_FAIL` verdict from verification ever reaches settlement. **Nothing
in the mapping engine can cause a slash**, which is the point.

## Save-time checking against the contract

Three questions, and only the first two can be answered without a live call:

| Question | Where | When |
|---|---|---|
| Is the spec well-formed? | `mapping-validator.ts` | every keystroke, and Save |
| Can it *ever* satisfy `outputSchema`? | `contract-check.ts` | every keystroke, and Save |
| Is it actually right? | the mapping tester | on demand, against the real endpoint |

The middle one runs in the binding editor and it refuses only certainties — a `required` key
the mapping never writes, `$optional` at a `required` site with no `$default`,
a `$const` of the wrong JSON type. A selector's value is unknown until a
response arrives, so nothing is said about one: an editor that guessed would
teach providers to ignore it.

## Versioning

`ToolBinding.version` records which stored revision of the mappings served a
call. The column is `tool_bindings.mapping_version` — `version` is taken
platform-wide by TypeORM's optimistic lock, and the two numbers move for
unrelated reasons.

Every save that changes the endpoint, either mapping, the price, the asset, the
pricing mode or the timeout raises it and writes a `binding_versions` snapshot.
Raising it also **invalidates any green mapping-tester run**, because the
publish gate requires a passing run at the current revision — which is what
stops a mapping edited after the tester went green from reaching traffic. A verdict has to be re-evaluable against the mapping that was in force at
the time (`binding_versions`) — without it, a
provider who edits a mapping mid-window and a platform disputing a result have
no way to agree on which version produced the response, and the dispute is
unwinnable in both directions.
