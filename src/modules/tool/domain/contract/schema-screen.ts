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
  /** A keyword outside {@link SUPPORTED_SCHEMA_KEYWORDS}. */
  SCHEMA_KEYWORD_UNSUPPORTED = 'SCHEMA_KEYWORD_UNSUPPORTED',
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

/**
 * Zero-width, joining, bidirectional, variation-selector, filler, tag and
 * private-use characters a reviewer cannot see, by code point range. Built at
 * load rather than written as a literal: several are combining characters,
 * which a character-class literal would misread.
 */
export const HIDDEN_CODE_POINTS: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180e], // Mongolian variation selectors, vowel separator
  [0x200b, 0x200f], // zero-width space, joiners, LRM, RLM
  [0x2028, 0x202e], // line and paragraph separators, bidi embeddings
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x206f], // bidi isolates, deprecated format characters
  [0x3164, 0x3164], // Hangul filler
  [0xe000, 0xf8ff], // private use
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark
  [0xffa0, 0xffa0], // half-width Hangul filler
  [0xe0000, 0xe007f], // tags
  [0xe0100, 0xe01ef], // variation selectors supplement
];

const ESCAPE = String.fromCharCode(92);
const codePoint = (value: number) => `${ESCAPE}u{${value.toString(16)}}`;
const HIDDEN_SOURCE = HIDDEN_CODE_POINTS.map(([from, to]) =>
  from === to ? codePoint(from) : `${codePoint(from)}-${codePoint(to)}`,
).join('');

const HIDDEN_CHARACTERS_RE = new RegExp(`[${HIDDEN_SOURCE}]`, 'u');

/** Every hidden character, globally: removed before matching, so it cannot split a word. */
const HIDDEN_CHARACTERS_GLOBAL = new RegExp(`[${HIDDEN_SOURCE}]`, 'gu');

/**
 * Letters that read as Latin ones (Cyrillic, Greek and a few IPA forms),
 * folded to them before the patterns run: `іgnоre` matches like `ignore`.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  '\u0501': 'd',
  '\u051B': 'q',
  '\u051D': 'w',
  '\u04BB': 'h',
  '\u04CF': 'l',
  '\u0491': 'r',
  '\u0432': 'b',
  '\u043A': 'k',
  '\u043C': 'm',
  '\u043D': 'h',
  '\u0442': 't',
  '\u0457': 'i',
  '\u04AF': 'y',
  '\u03B1': 'a',
  '\u03BF': 'o',
  '\u03C1': 'p',
  '\u03BD': 'v',
  '\u03B9': 'i',
  '\u03BA': 'k',
  '\u03C4': 't',
  '\u03C5': 'u',
  '\u03C7': 'x',
  '\u03B5': 'e',
  '\u03B7': 'n',
  '\u03C9': 'w',
  '\u0251': 'a',
  '\u0261': 'g',
  '\u0131': 'i',
  '\u0237': 'j',
  '\u026A': 'i',
  '\u0274': 'n',
  '\u0280': 'r',
  '\u028F': 'y',
  '\u1D00': 'a',
  '\u1D04': 'c',
  '\u1D07': 'e',
  '\u1D0F': 'o',
  '\u1D1B': 't',
  '\u1D1C': 'u',
  '\u1D20': 'v',
  '\u1D21': 'w',
  '\u1D22': 'z',
  '\u0410': 'a',
  '\u0412': 'b',
  '\u0415': 'e',
  '\u041A': 'k',
  '\u041C': 'm',
  '\u041D': 'h',
  '\u041E': 'o',
  '\u0420': 'p',
  '\u0421': 'c',
  '\u0422': 't',
  '\u0425': 'x',
  '\u0423': 'y',
  '\u0406': 'i',
  '\u0408': 'j',
  '\u0405': 's',
  '\u0391': 'a',
  '\u0392': 'b',
  '\u0395': 'e',
  '\u0396': 'z',
  '\u0397': 'h',
  '\u0399': 'i',
  '\u039A': 'k',
  '\u039C': 'm',
  '\u039D': 'n',
  '\u039F': 'o',
  '\u03A1': 'p',
  '\u03A4': 't',
  '\u03A5': 'y',
  '\u03A7': 'x',
};

/**
 * The skeleton patterns are matched against: compatibility forms folded
 * (NFKC: full-width, ligatures, math letters), marks stripped, look-alike
 * letters folded to Latin, hidden characters removed, line and paragraph
 * separators read as newlines, lowercased.
 */
export function confusableSkeleton(text: string): string {
  const folded = text
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\u2028\u2029\u0085]/g, '\n')
    .replace(HIDDEN_CHARACTERS_GLOBAL, '');
  let out = '';
  for (const char of folded) out += CONFUSABLES[char] ?? char;
  return out.toLowerCase();
}

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

  const budget: Budget = { schemaNodes: 0, dataNodes: 0, reported: new Set() };
  walkSchema(findings, 'inputSchema', shape.inputSchema, 0, budget, 'input');
  walkSchema(findings, 'outputSchema', shape.outputSchema, 0, budget, 'output');
  if (
    Buffer.byteLength(JSON.stringify(shape.outputSchema ?? null), 'utf8') > OUTPUT_SCHEMA_MAX_BYTES
  ) {
    findings.push({
      code: ScreenFindingCode.TEXT_TOO_LONG,
      location: 'outputSchema',
      detail: `the output schema is larger than ${OUTPUT_SCHEMA_MAX_BYTES} bytes`,
    });
  }

  // Every string and key of every example, at any depth (their size cap,
  // EXAMPLE_MAX_BYTES, is contractProblems').
  (Array.isArray(shape.examples) ? shape.examples : []).forEach((example, index) =>
    walkData(findings, `examples/${index}`, example, 0, budget),
  );

  return { passed: findings.length === 0, findings: dedupe(findings) };
}

function screenText(findings: ScreenFinding[], location: string, text: string): void {
  if (typeof text !== 'string' || text.length === 0) return;
  if (HIDDEN_CHARACTERS_RE.test(text)) {
    findings.push({
      code: ScreenFindingCode.HIDDEN_CHARACTERS,
      location,
      detail: 'contains invisible, joining or direction-changing characters',
    });
  }
  const plain = text.normalize('NFKC').replace(/[\u2028\u2029\u0085]/g, '\n');
  const ids = new Set([
    ...instructionPatternsIn(plain),
    ...instructionPatternsIn(confusableSkeleton(text)),
  ]);
  for (const id of ids) {
    findings.push({
      code: ScreenFindingCode.INSTRUCTION_PATTERN,
      location,
      detail: `reads as an instruction to a model (${id}); describe what the tool does instead`,
    });
  }
}

/**
 * The JSON Schema keywords a provider contract may use. Anything else is
 * refused, not skipped: an unknown keyword (`x-instructions`,
 * `contentSchema`, `dependencies` …) is text some client may show a model,
 * and a screen that only reads the keywords it knows is a screen with a door.
 */
export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  // structure
  'type',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  // text
  'description',
  'title',
  '$comment',
  // values
  'enum',
  'const',
  'default',
  'examples',
  // constraints
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'nullable',
  'readOnly',
  'writeOnly',
  'deprecated',
  '$schema',
]);

const SCHEMA_CHILD_KEYS = ['items', 'additionalProperties', 'not'] as const;
const SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;
const SCHEMA_MAP_KEYS = ['properties', '$defs', 'definitions'] as const;
const TEXT_KEYS = ['description', 'title', '$comment'] as const;
const DATA_KEYS = ['enum', 'const', 'default', 'examples'] as const;
const NUMBER_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const;
const BOOLEAN_KEYS = ['uniqueItems', 'nullable', 'readOnly', 'writeOnly', 'deprecated'] as const;
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** A field name, at every depth: ASCII only. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A `$defs` key: ASCII only. */
const DEF_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** The output schema's cap, like the input schema's. */
export const OUTPUT_SCHEMA_MAX_BYTES = 16_384;
/** Nesting inside a value (`default`, `enum`, an example): refused past this. */
export const DATA_MAX_DEPTH = 16;
/** Values (strings, keys, numbers) across one contract's data: refused past this. */
export const DATA_MAX_NODES = 5_000;

interface Budget {
  schemaNodes: number;
  dataNodes: number;
  /** One finding per exceeded cap, not one per node past it. */
  readonly reported: Set<string>;
}

function overBudget(
  findings: ScreenFinding[],
  budget: Budget,
  key: 'schema' | 'data',
  location: string,
): boolean {
  const over =
    key === 'schema' ? budget.schemaNodes > SCHEMA_MAX_NODES : budget.dataNodes > DATA_MAX_NODES;
  if (over && !budget.reported.has(key)) {
    budget.reported.add(key);
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location,
      detail:
        key === 'schema'
          ? `the schemas hold more than ${SCHEMA_MAX_NODES} nodes`
          : `the contract's values hold more than ${DATA_MAX_NODES} entries`,
    });
  }
  return over;
}

function walkSchema(
  findings: ScreenFinding[],
  location: string,
  node: unknown,
  depth: number,
  budget: Budget,
  side: 'input' | 'output',
): void {
  if (typeof node === 'boolean') return; // `additionalProperties: false`, `items: true`
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    findings.push({
      code: ScreenFindingCode.CONTRACT_INVALID,
      location,
      detail: 'a schema must be an object',
    });
    return;
  }
  budget.schemaNodes += 1;
  if (overBudget(findings, budget, 'schema', location)) return;
  if (depth > SCHEMA_MAX_DEPTH) {
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location,
      detail: `nested deeper than ${SCHEMA_MAX_DEPTH} levels`,
    });
    return;
  }

  const schema = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(schema)) {
    const at = `${location}/${key}`;
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      findings.push({
        code: ScreenFindingCode.SCHEMA_KEYWORD_UNSUPPORTED,
        location: at,
        detail: `"${key.slice(0, 64)}" is not a supported JSON Schema keyword`,
      });
      screenText(findings, at, key);
      continue;
    }

    if ((TEXT_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'string') {
        findings.push({
          code: ScreenFindingCode.CONTRACT_INVALID,
          location: at,
          detail: 'must be a string',
        });
        continue;
      }
      const cap = key === 'title' ? SCHEMA_TITLE_MAX_LENGTH : SCHEMA_DESCRIPTION_MAX_LENGTH;
      if (value.length > cap) {
        findings.push({
          code: ScreenFindingCode.TEXT_TOO_LONG,
          location: at,
          detail: `longer than ${cap} characters`,
        });
      }
      screenText(findings, at, value);
      continue;
    }

    if ((DATA_KEYS as readonly string[]).includes(key)) {
      if (key === 'enum' && Array.isArray(value) && value.length > SCHEMA_ENUM_MAX) {
        findings.push({
          code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
          location: at,
          detail: `more than ${SCHEMA_ENUM_MAX} values`,
        });
      }
      walkData(findings, at, value, 0, budget);
      continue;
    }

    if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        findings.push({
          code: ScreenFindingCode.CONTRACT_INVALID,
          location: at,
          detail: 'must be a number',
        });
      }
      continue;
    }
    if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') {
        findings.push({
          code: ScreenFindingCode.CONTRACT_INVALID,
          location: at,
          detail: 'must be true or false',
        });
      }
      continue;
    }

    switch (key) {
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (
          types.length === 0 ||
          !types.every((type) => typeof type === 'string' && JSON_TYPES.has(type))
        ) {
          findings.push({
            code: ScreenFindingCode.CONTRACT_INVALID,
            location: at,
            detail: 'not a JSON type',
          });
        }
        break;
      }
      case 'required':
        if (
          !Array.isArray(value) ||
          !value.every((name) => typeof name === 'string' && FIELD_NAME_RE.test(name))
        ) {
          findings.push({
            code: ScreenFindingCode.CONTRACT_INVALID,
            location: at,
            detail: 'required names fields: ASCII letters, digits and "_"',
          });
        }
        break;
      case '$ref':
        if (typeof value !== 'string' || !/^#(\/[A-Za-z0-9_$-]{1,64}){0,8}$/.test(value)) {
          findings.push({
            code: ScreenFindingCode.REMOTE_REF,
            location: at,
            detail: 'a $ref must point inside the schema (#/$defs/…)',
          });
        }
        break;
      case '$schema':
      case 'format':
      case 'pattern':
        if (typeof value !== 'string') {
          findings.push({
            code: ScreenFindingCode.CONTRACT_INVALID,
            location: at,
            detail: 'must be a string',
          });
          break;
        }
        if (value.length > SCHEMA_STRING_MAX_LENGTH) {
          findings.push({
            code: ScreenFindingCode.TEXT_TOO_LONG,
            location: at,
            detail: `longer than ${SCHEMA_STRING_MAX_LENGTH} characters`,
          });
        }
        screenText(findings, at, value);
        if (key === 'format' && value === 'password' && side === 'input') {
          findings.push({
            code: ScreenFindingCode.SECRET_INPUT,
            location,
            detail: 'an input marked as a password collects a secret',
          });
        }
        break;
      case 'items':
        if (Array.isArray(value)) {
          value.forEach((child, index) =>
            walkSchema(findings, `${at}/${index}`, child, depth + 1, budget, side),
          );
          break;
        }
        walkSchema(findings, at, value, depth + 1, budget, side);
        break;
      default:
        if ((SCHEMA_CHILD_KEYS as readonly string[]).includes(key)) {
          walkSchema(findings, at, value, depth + 1, budget, side);
        } else if ((SCHEMA_LIST_KEYS as readonly string[]).includes(key)) {
          if (!Array.isArray(value)) {
            findings.push({
              code: ScreenFindingCode.CONTRACT_INVALID,
              location: at,
              detail: 'must be a list',
            });
            break;
          }
          value.forEach((child, index) =>
            walkSchema(findings, `${at}/${index}`, child, depth + 1, budget, side),
          );
        } else if ((SCHEMA_MAP_KEYS as readonly string[]).includes(key)) {
          walkSchemaMap(findings, at, key, value, depth, budget, side);
        }
    }
  }

  if (side === 'input' && schema.writeOnly === true) {
    findings.push({
      code: ScreenFindingCode.SECRET_INPUT,
      location,
      detail: 'an input marked write-only collects a secret',
    });
  }
}

function walkSchemaMap(
  findings: ScreenFinding[],
  at: string,
  key: string,
  value: unknown,
  depth: number,
  budget: Budget,
  side: 'input' | 'output',
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({
      code: ScreenFindingCode.CONTRACT_INVALID,
      location: at,
      detail: 'must be an object',
    });
    return;
  }
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const childAt = `${at}/${name.slice(0, 64)}`;
    const nameRe = key === 'properties' ? FIELD_NAME_RE : DEF_NAME_RE;
    if (!nameRe.test(name)) {
      findings.push({
        code: ScreenFindingCode.CONTRACT_INVALID,
        location: childAt,
        detail: 'a field name is 1–64 ASCII letters, digits and "_", starting with a letter or "_"',
      });
    }
    screenText(findings, childAt, name.replace(/[_-]+/g, ' '));
    if (key === 'properties' && side === 'input' && isSecretFieldName(name)) {
      findings.push({
        code: ScreenFindingCode.SECRET_INPUT,
        location: childAt,
        detail: `"${name.slice(0, 64)}" would collect a secret; the platform holds provider credentials, never the buyer`,
      });
    }
    walkSchema(findings, childAt, child, depth + 1, budget, side);
  }
}

/**
 * Every string and every key inside a value, at any depth: screened, and
 * capped. Past the depth or the size cap the contract is refused — nothing
 * past a cap goes unread.
 */
function walkData(
  findings: ScreenFinding[],
  location: string,
  value: unknown,
  depth: number,
  budget: Budget,
): void {
  budget.dataNodes += 1;
  if (overBudget(findings, budget, 'data', location)) return;
  if (depth > DATA_MAX_DEPTH) {
    findings.push({
      code: ScreenFindingCode.SCHEMA_TOO_COMPLEX,
      location,
      detail: `a value nested deeper than ${DATA_MAX_DEPTH} levels`,
    });
    return;
  }
  if (typeof value === 'string') {
    if (value.length > SCHEMA_STRING_MAX_LENGTH && !location.startsWith('examples/')) {
      findings.push({
        code: ScreenFindingCode.TEXT_TOO_LONG,
        location,
        detail: `longer than ${SCHEMA_STRING_MAX_LENGTH} characters`,
      });
    }
    screenText(findings, location, value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkData(findings, `${location}/${index}`, item, depth + 1, budget),
    );
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const at = `${location}/${key.slice(0, 64)}`;
    budget.dataNodes += 1;
    if (overBudget(findings, budget, 'data', at)) return;
    screenText(findings, at, key.replace(/[_-]+/g, ' '));
    walkData(findings, at, item, depth + 1, budget);
  }
}

/** A short label a model may read (a tag): hidden characters and instruction patterns. */
export function screenLabel(location: string, text: string): ScreenFinding[] {
  const findings: ScreenFinding[] = [];
  screenText(findings, location, text.replace(/[_-]+/g, ' '));
  return findings;
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
