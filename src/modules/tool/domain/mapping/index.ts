/**
 * The binding mapping engine.
 *
 * ```text
 * tool input ──mapRequest──▶ UpstreamRequest ──▶ the provider's existing endpoint
 *                                                          │
 * tool output ◀──mapResponse── the provider's native JSON ◀─┘
 * ```
 *
 * Both directions are driven by **data** — selectors, named transforms and
 * constants stored in `tool_bindings.request_mapping` / `.response_mapping` —
 * because the provider writes these themselves in the console, and a
 * mapping that needs a deploy to change is a mapping the provider cannot own.
 *
 * The whole engine is pure. Nothing here performs I/O, reads a clock or
 * touches a database, which is what makes a mapping testable against a saved
 * sample response before it is ever published (the mapping tester).
 */

export * from './mapping.types';
export * from './json-path';
export * from './transforms';
export * from './normalize';
export * from './schema-validator';
export * from './evaluate';
export * from './request-mapper';
export * from './response-mapper';
export * from './mapping-validator';
export * from './contract-check';
export * from './mapping-fault';
