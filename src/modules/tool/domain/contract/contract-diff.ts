import { JsonSchema } from '../mapping/schema-validator';
import { VersionBump, maxBump } from './semver';

/**
 * The schema diff the contract editor shows, and the bump it implies (design
 * spec §7.5 "Version rules"). Pure.
 *
 * | Change                                                  | Bump  |
 * |---------------------------------------------------------|-------|
 * | summary, description, examples, schema annotations only | PATCH |
 * | an optional input or output field added                 | MINOR |
 * | verification policy or tier changed                     | MINOR |
 * | a field promoted to core (or demoted), removed, renamed | MAJOR |
 * | a type changed; a core field added; `required` changed  | MAJOR |
 *
 * A "field" is a top-level property of the input or output schema; the core
 * fields are the properties not listed as optional. A rename is a removal and
 * an addition, and reads as both. A new property that is not declared
 * optional is a core field every binding must serve, so it is breaking. The
 * policy and tier change no binding's mapping, but they change how its
 * answers are judged, so they are never a silent patch.
 */

/** The parts of a version the diff compares. */
export interface ContractShape {
  readonly summary: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly optionalInputFields: readonly string[];
  readonly optionalOutputFields: readonly string[];
  readonly examples: readonly unknown[];
  readonly verificationPolicyId: string | null;
  readonly tier: string | null;
}

export enum ContractChangeKind {
  /** Summary, description, examples or schema annotations (`description`, `title`). */
  DOCS_CHANGED = 'DOCS_CHANGED',
  FIELD_ADDED_OPTIONAL = 'FIELD_ADDED_OPTIONAL',
  FIELD_ADDED_CORE = 'FIELD_ADDED_CORE',
  FIELD_REMOVED = 'FIELD_REMOVED',
  /** An optional field became core. */
  FIELD_PROMOTED = 'FIELD_PROMOTED',
  /** A core field became optional: buyers lose a guarantee. */
  FIELD_DEMOTED = 'FIELD_DEMOTED',
  /** A field's `required` membership changed. */
  FIELD_REQUIRED_CHANGED = 'FIELD_REQUIRED_CHANGED',
  /** A field's schema changed beyond its annotations. */
  TYPE_CHANGED = 'TYPE_CHANGED',
  /** A top-level schema keyword other than `properties` changed. */
  SCHEMA_CHANGED = 'SCHEMA_CHANGED',
  /** Verification policy or tier. */
  POLICY_CHANGED = 'POLICY_CHANGED',
}

export type ContractSide = 'input' | 'output';

export interface ContractChange {
  readonly kind: ContractChangeKind;
  readonly side: ContractSide | null;
  readonly field: string | null;
  readonly bump: VersionBump;
  readonly detail: string;
}

export interface ContractDiff {
  /** `null` when nothing changed. */
  readonly bump: VersionBump | null;
  readonly changes: readonly ContractChange[];
}

/** Keywords that document a schema rather than constrain it. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment']);

export function diffContracts(before: ContractShape | null, after: ContractShape): ContractDiff {
  if (!before) return { bump: null, changes: [] };

  const changes: ContractChange[] = [];
  const docs = (detail: string) =>
    changes.push({
      kind: ContractChangeKind.DOCS_CHANGED,
      side: null,
      field: null,
      bump: VersionBump.PATCH,
      detail,
    });

  if (before.summary !== after.summary) docs('summary changed');
  if (before.description !== after.description) docs('description changed');
  if (stable(before.examples) !== stable(after.examples)) docs('examples changed');

  if (
    (before.verificationPolicyId ?? null) !== (after.verificationPolicyId ?? null) ||
    (before.tier ?? null) !== (after.tier ?? null)
  ) {
    changes.push({
      kind: ContractChangeKind.POLICY_CHANGED,
      side: null,
      field: null,
      bump: VersionBump.MINOR,
      detail: 'verification policy or tier changed',
    });
  }

  changes.push(
    ...diffSide(
      'input',
      before.inputSchema,
      after.inputSchema,
      before.optionalInputFields,
      after.optionalInputFields,
    ),
    ...diffSide(
      'output',
      before.outputSchema,
      after.outputSchema,
      before.optionalOutputFields,
      after.optionalOutputFields,
    ),
  );

  const bump = changes.reduce<VersionBump | null>((acc, change) => maxBump(acc, change.bump), null);
  return { bump, changes };
}

function diffSide(
  side: ContractSide,
  before: JsonSchema,
  after: JsonSchema,
  optionalBefore: readonly string[],
  optionalAfter: readonly string[],
): ContractChange[] {
  const changes: ContractChange[] = [];
  const change = (
    kind: ContractChangeKind,
    field: string | null,
    bump: VersionBump,
    detail: string,
  ) => changes.push({ kind, side, field, bump, detail });

  const topBefore = stable(withoutKeys(before, ['properties', 'required']), true);
  const topAfter = stable(withoutKeys(after, ['properties', 'required']), true);
  if (topBefore !== topAfter) {
    change(
      ContractChangeKind.SCHEMA_CHANGED,
      null,
      VersionBump.MAJOR,
      `${side} schema keywords changed`,
    );
  } else if (
    stable(withoutKeys(before, ['properties', 'required'])) !==
    stable(withoutKeys(after, ['properties', 'required']))
  ) {
    change(
      ContractChangeKind.DOCS_CHANGED,
      null,
      VersionBump.PATCH,
      `${side} schema annotations changed`,
    );
  }

  const propsBefore = before.properties ?? {};
  const propsAfter = after.properties ?? {};
  const requiredBefore = new Set(before.required ?? []);
  const requiredAfter = new Set(after.required ?? []);
  const fields = [...new Set([...Object.keys(propsBefore), ...Object.keys(propsAfter)])].sort();

  for (const field of fields) {
    const had = Object.prototype.hasOwnProperty.call(propsBefore, field);
    const has = Object.prototype.hasOwnProperty.call(propsAfter, field);
    const wasOptional = optionalBefore.includes(field);
    const isOptional = optionalAfter.includes(field);

    if (had && !has) {
      change(
        ContractChangeKind.FIELD_REMOVED,
        field,
        VersionBump.MAJOR,
        `${side} field ${field} removed`,
      );
      continue;
    }
    if (!had && has) {
      if (isOptional && !requiredAfter.has(field)) {
        change(
          ContractChangeKind.FIELD_ADDED_OPTIONAL,
          field,
          VersionBump.MINOR,
          `optional ${side} field ${field} added`,
        );
      } else {
        change(
          ContractChangeKind.FIELD_ADDED_CORE,
          field,
          VersionBump.MAJOR,
          `core ${side} field ${field} added`,
        );
      }
      continue;
    }

    if (wasOptional && !isOptional) {
      change(
        ContractChangeKind.FIELD_PROMOTED,
        field,
        VersionBump.MAJOR,
        `${side} field ${field} promoted to core`,
      );
    } else if (!wasOptional && isOptional) {
      change(
        ContractChangeKind.FIELD_DEMOTED,
        field,
        VersionBump.MAJOR,
        `${side} field ${field} made optional`,
      );
    }
    if (requiredBefore.has(field) !== requiredAfter.has(field)) {
      change(
        ContractChangeKind.FIELD_REQUIRED_CHANGED,
        field,
        VersionBump.MAJOR,
        `${side} field ${field} is ${requiredAfter.has(field) ? 'now' : 'no longer'} required`,
      );
    }

    const shapeBefore = stable(propsBefore[field], true);
    const shapeAfter = stable(propsAfter[field], true);
    if (shapeBefore !== shapeAfter) {
      change(
        ContractChangeKind.TYPE_CHANGED,
        field,
        VersionBump.MAJOR,
        `${side} field ${field} changed type`,
      );
    } else if (stable(propsBefore[field]) !== stable(propsAfter[field])) {
      change(
        ContractChangeKind.DOCS_CHANGED,
        field,
        VersionBump.PATCH,
        `${side} field ${field} annotations changed`,
      );
    }
  }
  return changes;
}

function withoutKeys(schema: JsonSchema, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema ?? {})) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Canonical JSON, keys sorted. With `stripAnnotations` the value is a schema
 * and every annotation keyword is dropped at every depth, so only what
 * constrains a value compares; a field *named* `title` in a `properties` map
 * is a field, not an annotation, and is kept.
 */
function stable(value: unknown, stripAnnotations = false): string {
  return canonical(stripAnnotations ? stripSchema(value) : value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Keywords whose value is a map of name → schema. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
/** Keywords whose value is a schema or a list of schemas. */
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'not', 'anyOf', 'oneOf', 'allOf']);

function stripSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [
          name,
          stripSchema(child),
        ]),
      );
    } else if (SCHEMA_VALUES.has(key)) {
      out[key] = stripSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
