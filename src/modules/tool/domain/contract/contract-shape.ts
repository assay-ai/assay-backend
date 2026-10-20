import { JsonSchema } from '../mapping/schema-validator';
import { ContractShape } from './contract-diff';
import { SUMMARY_MAX_LENGTH } from './contract-versions';

/**
 * What a contract version must be before it can be saved as a draft or
 * published (design spec §7.2, §7.5, §9 "Prompt injection through tool
 * text"). Pure: returns the problems, the caller decides how to refuse.
 */

export const DESCRIPTION_MAX_LENGTH = 8_000;
export const EXAMPLES_MAX = 10;
export const EXAMPLE_MAX_BYTES = 2_048;
export const INPUT_SCHEMA_MAX_BYTES = 16_384;
export const SCHEMA_DESCRIPTION_MAX_LENGTH = 300;
export const SCHEMA_TITLE_MAX_LENGTH = 60;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function contractProblems(shape: ContractShape): string[] {
  const problems: string[] = [];

  const summary = shape.summary ?? '';
  if (summary.trim().length === 0) problems.push('summary is empty');
  if (summary.length > SUMMARY_MAX_LENGTH) {
    problems.push(`summary is longer than ${SUMMARY_MAX_LENGTH} characters`);
  }
  if (/[\r\n]/.test(summary)) problems.push('summary must be one line of plain text');
  if ((shape.description ?? '').trim().length === 0) problems.push('description is empty');
  if ((shape.description ?? '').length > DESCRIPTION_MAX_LENGTH) {
    problems.push(`description is longer than ${DESCRIPTION_MAX_LENGTH} characters`);
  }

  problems.push(
    ...sideProblems('input', shape.inputSchema, shape.optionalInputFields),
    ...sideProblems('output', shape.outputSchema, shape.optionalOutputFields),
  );
  if (bytes(shape.inputSchema) > INPUT_SCHEMA_MAX_BYTES) {
    problems.push(`input schema is larger than ${INPUT_SCHEMA_MAX_BYTES} bytes`);
  }

  if (!Array.isArray(shape.examples)) {
    problems.push('examples must be a list');
  } else {
    if (shape.examples.length > EXAMPLES_MAX) problems.push(`more than ${EXAMPLES_MAX} examples`);
    shape.examples.forEach((example, index) => {
      const value = example as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`example ${index + 1} is not an object`);
        return;
      }
      if (
        !value.arguments ||
        typeof value.arguments !== 'object' ||
        Array.isArray(value.arguments)
      ) {
        problems.push(`example ${index + 1} has no arguments object`);
      }
      if (bytes(value) > EXAMPLE_MAX_BYTES) {
        problems.push(`example ${index + 1} is larger than ${EXAMPLE_MAX_BYTES} bytes`);
      }
    });
  }
  return problems;
}

function sideProblems(
  side: 'input' | 'output',
  schema: JsonSchema,
  optional: readonly string[],
): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${side} schema is not an object`];
  }
  if (schema.type !== 'object') problems.push(`${side} schema must have type "object"`);
  const properties = schema.properties ?? {};
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    problems.push(`${side} schema properties must be an object`);
    return problems;
  }
  for (const name of Object.keys(properties)) {
    if (!FIELD_NAME_RE.test(name)) problems.push(`${side} field name "${name}" is not allowed`);
  }
  const required = new Set(schema.required ?? []);
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      problems.push(`${side} schema requires "${name}", which it does not define`);
    }
  }
  if (!Array.isArray(optional)) return [...problems, `optional ${side} fields must be a list`];
  if (new Set(optional).size !== optional.length) {
    problems.push(`optional ${side} fields are listed twice`);
  }
  for (const name of optional) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      problems.push(`optional ${side} field "${name}" is not in the ${side} schema`);
    } else if (required.has(name)) {
      problems.push(`optional ${side} field "${name}" cannot also be required`);
    }
  }
  // Core means required (review P1-2): an output field is either one every
  // binding must return, or optional and opt-in. A third kind — core but
  // allowed to be missing — is a promise nobody is held to, and a toolset
  // entry that requires it would pay for an answer without it.
  if (side === 'output') {
    for (const name of Object.keys(properties)) {
      if (!required.has(name) && !optional.includes(name)) {
        problems.push(
          `output field "${name}" is neither required nor optional: make it required, or list it in optionalOutputFields`,
        );
      }
    }
  }
  problems.push(...annotationProblems(side, schema, ''));
  return problems;
}

/** The caps on every `description` and `title` a model reads (§9). */
function annotationProblems(side: string, schema: unknown, pointer: string): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const problems: string[] = [];
  const node = schema as Record<string, unknown>;
  if (
    typeof node.description === 'string' &&
    node.description.length > SCHEMA_DESCRIPTION_MAX_LENGTH
  ) {
    problems.push(
      `${side} schema description at ${pointer || '/'} is longer than ${SCHEMA_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  if (typeof node.title === 'string' && node.title.length > SCHEMA_TITLE_MAX_LENGTH) {
    problems.push(
      `${side} schema title at ${pointer || '/'} is longer than ${SCHEMA_TITLE_MAX_LENGTH} characters`,
    );
  }
  const properties = node.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      problems.push(...annotationProblems(side, child, `${pointer}/${name}`));
    }
  }
  if (node.items) problems.push(...annotationProblems(side, node.items, `${pointer}/items`));
  return problems;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}
