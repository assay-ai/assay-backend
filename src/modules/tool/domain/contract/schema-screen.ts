import { ContractShape } from './contract-diff';
import {
  SCHEMA_DESCRIPTION_MAX_LENGTH,
  SCHEMA_TITLE_MAX_LENGTH,
  contractProblems,
} from './contract-shape';

/**
 * The schema screen of the provider tool publish gate (design spec §7.6, §9
 * "Prompt injection through tool text", "Collecting secrets through inputs").
 * Pure: returns findings, the gate decides.
 *
 * A provider writes every word a model reads about its tool — the summary in
 * `tools/list`, the description and examples in `get_tool`, and every
 * `description`, `title`, `enum`, `default` and `const` inside both schemas.
 * Each of those is a place to tell a model what to do. The screen:
 *
 * 1. applies the contract caps (`contractProblems`: summary ≤ 200 characters
 *    and one line, each schema `description` ≤ 300 and `title` ≤ 60, each
 *    example ≤ 2 KB, the input schema ≤ 16 KB);
 * 2. caps every other string a schema carries, its depth and its size;
 * 3. refuses text that reads as an instruction to a model rather than as a
 *    description of a tool (a fixed pattern list, below);
 * 4. refuses invisible and direction-changing characters, which hide text
 *    from the person reviewing it but not from the model reading it;
 * 5. refuses inputs that collect secrets (`api_key`, `password`, a private
 *    key, a seed phrase, `format: password`, `writeOnly`) at any depth;
 * 6. refuses `$ref`s that leave the document.
 *
 * Patterns can be evaded; that is why LISTED also needs a person (§7.6
 * review checklist), and why a pattern hit is a refusal rather than a
 * warning: a false positive costs the provider a rewording, a false negative
 * costs a buyer's agent.
 */

export enum ScreenFindingCode {
  CONTRACT_INVALID = 'CONTRACT_INVALID',
  TEXT_TOO_LONG = 'TEXT_TOO_LONG',
  INSTRUCTION_PATTERN = 'INSTRUCTION_PATTERN',
  HIDDEN_CHARACTERS = 'HIDDEN_CHARACTERS',
  SECRET_INPUT = 'SECRET_INPUT',
  REMOTE_REF = 'REMOTE_REF',
  SCHEMA_TOO_COMPLEX = 'SCHEMA_TOO_COMPLEX',
}

export interface ScreenFinding {
  readonly code: ScreenFindingCode;
  /** Where: `summary`, `description`, `inputSchema/properties/q/description`, `examples/0`. */
  readonly location: string;
  readonly detail: string;
}

export interface ScreenResult {
  readonly passed: boolean;
  readonly findings: readonly ScreenFinding[];
}

/** Any other string inside a schema (`enum`, `default`, `const`, `pattern`, `examples`). */
export const SCHEMA_STRING_MAX_LENGTH = 300;
/** Nesting below the root schema. */
export const SCHEMA_MAX_DEPTH = 8;
/** Schema nodes across both schemas. */
export const SCHEMA_MAX_NODES = 500;
/** `enum` entries per node. */
export const SCHEMA_ENUM_MAX = 100;

/**
 * Text that addresses a model instead of describing a tool. Each is a
 * phrase a tool description has no reason to contain.
 */
export const INSTRUCTION_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  {
    id: 'override-instructions',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(instructions?|prompts?|rules|guidelines|guardrails|context|messages?)\b/i,
  },
  {
    id: 'system-prompt',
    re: /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  },
  { id: 'role-marker', re: /(^|\n)\s*(system|assistant|user|human)\s*:/i },
  {
    id: 'chat-template-token',
    re: /<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(system|instructions?|important|admin|prompt)>/i,
  },
  {
    id: 'tool-steering',
    re: /\b(always|must|should|first)\s+(call|use|invoke|run|prefer|choose|select)\b[^.\n]{0,30}\b(this|these|tool|tools|function)\b/i,
  },
  {
    id: 'tool-shadowing',
    re: /\b(instead of|rather than|before using|do not use|don't use|never use)\b[^.\n]{0,40}\b(other|another|any)\s+(tools?|functions?|servers?)\b/i,
  },
  {
    id: 'conceal-from-user',
    re: /\b(do not|don't|never|without)\s+(tell|telling|inform|informing|mention|mentioning|reveal|revealing|show|showing|asking|notify|notifying)\b[^.\n]{0,20}\b(the\s+)?(user|human|operator|owner)\b/i,
  },
  {
    id: 'exfiltration',
    re: /\b(send|forward|post|upload|exfiltrate|copy|include|append|attach)\b[^.\n]{0,40}\b(conversation|chat history|message history|previous messages|system prompt|credentials?|api keys?|secrets?|private keys?|tokens?|passwords?|env(ironment)? variables?)\b/i,
  },
  {
    id: 'reveal-secrets',
    re: /\b(reveal|print|output|leak|disclose|repeat)\b[^.\n]{0,30}\b(system prompt|your instructions|hidden instructions|secrets?|api keys?|private keys?)\b/i,
  },
  {
    id: 'persona',
    re: /\b(you are now|from now on,? you|act as (an?|the) |pretend (to be|you)|jailbreak|developer mode|DAN mode)\b/i,
  },
  {
    id: 'local-files',
    re: /(~\/\.|\.ssh\b|id_rsa|\.env\b|\/etc\/passwd|mcp\.json|\.aws\/credentials|keychain)/i,
  },
];

/** Zero-width, bidirectional and other format characters a reviewer cannot see. */
const HIDDEN_CHARACTERS_RE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uE000-\uF8FF]|[\u{E0000}-\u{E007F}]/u;

/** Words of an input field name that make it a secret. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'pwd',
  'secret',
  'secrets',
  'apikey',
  'mnemonic',
  'seedphrase',
  'privatekey',
  'credential',
  'credentials',
  'cvv',
  'cvc',
  'ssn',
  'pin',
  'otp',
  'totp',
  'bearer',
  'cookie',
]);

/** Pairs of adjacent words that make a field name a secret: `api_key`, `access_token`. */
const SECRET_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['api', 'token'],
  ['api', 'secret'],
  ['access', 'key'],
  ['access', 'token'],
  ['auth', 'token'],
  ['auth', 'key'],
  ['refresh', 'token'],
  ['session', 'token'],
  ['session', 'id'],
  ['bearer', 'token'],
  ['client', 'secret'],
  ['private', 'key'],
  ['secret', 'key'],
  ['signing', 'key'],
  ['seed', 'phrase'],
  ['recovery', 'phrase'],
  ['card', 'number'],
  ['credit', 'card'],
  ['security', 'code'],
];

/** Snake, kebab and camel case → lowercase words: `apiKey` → `api`, `key`. */
export function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** Whether an input field named `name` would collect a secret. */
export function isSecretFieldName(name: string): boolean {
  const words = fieldWords(name);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  const joined = words.join('');
  if (SECRET_WORDS.has(joined)) return true;
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (SECRET_PAIRS.some(([a, b]) => words[i] === a && words[i + 1] === b)) return true;
  }
  return false;
}

/** The instruction patterns `text` matches, by id. */
export function instructionPatternsIn(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter((pattern) => pattern.re.test(text)).map((p) => p.id);
}

/** What a provider writes: the contract, plus where it is reported from. */
export type ScreenedContract = Pick<
  ContractShape,
  | 'summary'
  | 'description'
  | 'inputSchema'
  | 'outputSchema'
  | 'optionalInputFields'
  | 'optionalOutputFields'
  | 'examples'
  | 'verificationPolicyId'
  | 'tier'
>;

/** Screen one contract version. */
export function screenContract(shape: ScreenedContract): ScreenResult {
  const findings: ScreenFinding[] = [];

  for (const problem of contractProblems(shape as ContractShape)) {
    findings.push({
      code:
        problem.includes('longer than') || problem.includes('larger than')
          ? ScreenFindingCode.TEXT_TOO_LONG
          : ScreenFindingCode.CONTRACT_INVALID,
      location: 'contract',
      detail: problem,
    });
  }

  screenText(findings, 'summary', shape.summary ?? '');
  screenText(findings, 'description', shape.description ?? '');

  const budget = { nodes: 0 };
  walkSchema(findings, 'inputSchema', shape.inputSchema, 0, budget, 'input');
  walkSchema(findings, 'outputSchema', shape.outputSchema, 0, budget, 'output');

  (Array.isArray(shape.examples) ? shape.examples : []).forEach((example, index) => {
    const location = `examples/${index}`;
    // The size cap (EXAMPLE_MAX_BYTES) is contractProblems'; the words are ours.
    for (const [path, text] of stringsOf(example, location)) screenText(findings, path, text);
  });

  return { passed: findings.length === 0, findings: dedupe(findings) };
}

function screenText(findings: ScreenFinding[], location: string, text: string): void {
  if (typeof text !== 'string' || text.length === 0) return;
  if (HIDDEN_CHARACTERS_RE.test(text)) {
    findings.push({
      code: ScreenFindingCode.HIDDEN_CHARACTERS,
      location,
      detail: 'contains invisible or direction-changing characters',
    });
  }
  const normalised = text.normalize('NFKC');
  for (const id of instructionPatternsIn(normalised)) {
    findings.push({
      code: ScreenFindingCode.INSTRUCTION_PATTERN,
      location,
      detail: `reads as an instruction to a model (${id}); describe what the tool does instead`,
    });
  }
}

const SUBSCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;
const SUBSCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;
const SUBSCHEMA_MAP_KEYS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
] as const;

function walkSchema(
  findings: ScreenFinding[],
  location: string,
  node: unknown,
  depth: number,
  budget: { nodes: number },
  side: 'input' | 'output',
): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    // `items: [ … ]` (tuple form).
    node.forEach((child, index) =>
      walkSchema(findings, `${location}/${index}`, child, depth + 1, budget, side),
    );
    return;
  }
  budget.nodes += 1;
  if (budget.nodes === SCHEMA_MAX_NODES + 1) {
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location,
      detail: `the schemas hold more than ${SCHEMA_MAX_NODES} nodes`,
    });
  }
  if (budget.nodes > SCHEMA_MAX_NODES) return;
  if (depth > SCHEMA_MAX_DEPTH) {
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location,
      detail: `nested deeper than ${SCHEMA_MAX_DEPTH} levels`,
    });
    return;
  }

  const schema = node as Record<string, unknown>;

  if (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#')) {
    findings.push({
      code: ScreenFindingCode.REMOTE_REF,
      location: `${location}/$ref`,
      detail: 'a $ref must point inside the schema',
    });
  }
  if (typeof schema.description === 'string') {
    // Length is contractProblems' at the top level; nested ones are capped here.
    if (depth > 0 && schema.description.length > SCHEMA_DESCRIPTION_MAX_LENGTH) {
      findings.push({
        code: ScreenFindingCode.TEXT_TOO_LONG,
        location: `${location}/description`,
        detail: `longer than ${SCHEMA_DESCRIPTION_MAX_LENGTH} characters`,
      });
    }
    screenText(findings, `${location}/description`, schema.description);
  }
  if (typeof schema.title === 'string') {
    if (depth > 0 && schema.title.length > SCHEMA_TITLE_MAX_LENGTH) {
      findings.push({
        code: ScreenFindingCode.TEXT_TOO_LONG,
        location: `${location}/title`,
        detail: `longer than ${SCHEMA_TITLE_MAX_LENGTH} characters`,
      });
    }
    screenText(findings, `${location}/title`, schema.title);
  }
  if (typeof schema.$comment === 'string')
    screenText(findings, `${location}/$comment`, schema.$comment);

  if (Array.isArray(schema.enum) && schema.enum.length > SCHEMA_ENUM_MAX) {
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location: `${location}/enum`,
      detail: `more than ${SCHEMA_ENUM_MAX} values`,
    });
  }
  for (const key of ['enum', 'const', 'default', 'examples', 'pattern'] as const) {
    if (!(key in schema)) continue;
    for (const [path, text] of stringsOf(schema[key], `${location}/${key}`)) {
      if (text.length > SCHEMA_STRING_MAX_LENGTH) {
        findings.push({
          code: ScreenFindingCode.TEXT_TOO_LONG,
          location: path,
          detail: `longer than ${SCHEMA_STRING_MAX_LENGTH} characters`,
        });
      }
      screenText(findings, path, text);
    }
  }

  if (side === 'input') {
    if (schema.format === 'password' || schema.writeOnly === true) {
      findings.push({
        code: ScreenFindingCode.SECRET_INPUT,
        location,
        detail: 'an input marked as a password or write-only collects a secret',
      });
    }
  }

  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, child] of Object.entries(map as Record<string, unknown>)) {
      const childLocation = `${location}/${key}/${name}`;
      if (key === 'properties' || key === 'patternProperties') {
        if (name.length > 64) {
          findings.push({
            code: ScreenFindingCode.TEXT_TOO_LONG,
            location: childLocation,
            detail: 'a field name is at most 64 characters',
          });
        }
        screenText(findings, childLocation, name.replace(/[_-]+/g, ' '));
        if (side === 'input' && isSecretFieldName(name)) {
          findings.push({
            code: ScreenFindingCode.SECRET_INPUT,
            location: childLocation,
            detail: `"${name}" would collect a secret; the platform holds provider credentials, never the buyer`,
          });
        }
      }
      walkSchema(findings, childLocation, child, depth + 1, budget, side);
    }
  }
  for (const key of SUBSCHEMA_KEYS) {
    if (key in schema)
      walkSchema(findings, `${location}/${key}`, schema[key], depth + 1, budget, side);
  }
  for (const key of SUBSCHEMA_LIST_KEYS) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    list.forEach((child, index) =>
      walkSchema(findings, `${location}/${key}/${index}`, child, depth + 1, budget, side),
    );
  }
}

/** Every string inside `value` (keys included), with its path; bounded. */
function stringsOf(value: unknown, location: string, depth = 0): [string, string][] {
  if (depth > 12) return [];
  if (typeof value === 'string') return [[location, value]];
  if (!value || typeof value !== 'object') return [];
  const out: [string, string][] = [];
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item, index) => {
      out.push(...stringsOf(item, `${location}/${index}`, depth + 1));
    });
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    out.push([`${location}/${key}`, key.replace(/[_-]+/g, ' ')]);
    out.push(...stringsOf(item, `${location}/${key}`, depth + 1));
  }
  return out;
}

function dedupe(findings: readonly ScreenFinding[]): ScreenFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}|${finding.location}|${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
