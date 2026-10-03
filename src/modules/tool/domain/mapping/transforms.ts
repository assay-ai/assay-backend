import { JsonObject, JsonValue } from './mapping.types';

/**
 * The transform registry.
 *
 * Every transform is **named**, **pure**, and **total** — it returns a value or
 * it throws {@link TransformError}; it never returns `undefined` and never
 * quietly passes its input through on failure. A transform that silently
 * degrades is the worst possible member of this registry: the mapping appears
 * to work, the tool contract is violated somewhere downstream, and the receipt
 * points at the wrong step.
 *
 * The registry is closed. A provider writing a mapping in the binding editor
 * picks from this list; they cannot supply an expression, a lambda or a
 * template. That is the whole reason a stored mapping is safe to execute — it
 * contains no code, only the *name* of code that already shipped. Adding a
 * transform is a deploy, and it should be: it is new behaviour that every
 * stored mapping can suddenly reach.
 *
 * Kept small on purpose. Each entry earns its place by appearing in a real
 * provider API shape — epoch timestamps, comma-joined lists, numbers sent as
 * strings. Anything more ambitious belongs upstream of the mapping, not inside
 * it.
 */

export class TransformError extends Error {}

export interface TransformDefinition {
  readonly name: string;
  /** Human-readable, shown next to the name in the console's dropdown. */
  readonly description: string;
  /** Argument names this transform accepts. Anything else is a spec error. */
  readonly args?: readonly string[];
  readonly apply: (input: JsonValue, args: JsonObject) => JsonValue;
}

function requireString(input: JsonValue, name: string): string {
  if (typeof input !== 'string') {
    throw new TransformError(`${name} expects a string, got ${describe(input)}`);
  }
  return input;
}

function describe(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function stringArg(args: JsonObject, key: string, fallback: string): string {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new TransformError(`Argument "${key}" must be a string, got ${describe(value)}`);
  }
  return value;
}

function toIsoFromEpoch(input: JsonValue, multiplier: number, name: string): string {
  const numeric = typeof input === 'string' ? Number(input) : input;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new TransformError(`${name} expects a finite epoch number, got ${describe(input)}`);
  }
  const date = new Date(numeric * multiplier);
  if (Number.isNaN(date.getTime())) {
    throw new TransformError(`${name} produced an invalid date from ${numeric}`);
  }
  return date.toISOString();
}

const DEFINITIONS: readonly TransformDefinition[] = [
  {
    name: 'trim',
    description: 'Remove leading and trailing whitespace.',
    apply: (input) => requireString(input, 'trim').trim(),
  },
  {
    name: 'lowercase',
    description: 'Lowercase a string.',
    apply: (input) => requireString(input, 'lowercase').toLowerCase(),
  },
  {
    name: 'uppercase',
    description: 'Uppercase a string.',
    apply: (input) => requireString(input, 'uppercase').toUpperCase(),
  },
  {
    name: 'toString',
    description: 'Render a scalar as a string. Rejects objects and arrays.',
    apply: (input) => {
      if (input === null || typeof input === 'object') {
        throw new TransformError(`toString expects a scalar, got ${describe(input)}`);
      }
      return String(input);
    },
  },
  {
    name: 'toNumber',
    description: 'Parse a number, or accept one. Rejects anything that is not fully numeric.',
    apply: (input) => {
      if (typeof input === 'number') return input;
      const text = requireString(input, 'toNumber').trim();
      // `Number('')` is 0 and `Number('12abc')` is NaN; both are wrong answers
      // to "is this a number", so the string is checked before it is parsed.
      if (text.length === 0 || !Number.isFinite(Number(text))) {
        throw new TransformError(`toNumber cannot parse "${text}"`);
      }
      return Number(text);
    },
  },
  {
    name: 'toInteger',
    description: 'Parse an integer. Rejects fractional input rather than rounding it.',
    apply: (input) => {
      const numeric = typeof input === 'number' ? input : Number(requireString(input, 'toInteger'));
      if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        throw new TransformError(`toInteger cannot parse ${JSON.stringify(input)}`);
      }
      return numeric;
    },
  },
  {
    name: 'toBoolean',
    description: 'Accept a boolean, or the strings true/false/1/0/yes/no.',
    apply: (input) => {
      if (typeof input === 'boolean') return input;
      const text = requireString(input, 'toBoolean').trim().toLowerCase();
      if (['true', '1', 'yes'].includes(text)) return true;
      if (['false', '0', 'no'].includes(text)) return false;
      throw new TransformError(`toBoolean cannot parse "${text}"`);
    },
  },
  {
    name: 'epochSecondsToIso',
    description: 'Unix seconds → ISO 8601.',
    apply: (input) => toIsoFromEpoch(input, 1000, 'epochSecondsToIso'),
  },
  {
    name: 'epochMillisToIso',
    description: 'Unix milliseconds → ISO 8601.',
    apply: (input) => toIsoFromEpoch(input, 1, 'epochMillisToIso'),
  },
  {
    name: 'isoDate',
    description: 'Normalise any parseable date string to ISO 8601.',
    apply: (input) => {
      const text = requireString(input, 'isoDate');
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) {
        throw new TransformError(`isoDate cannot parse "${text}"`);
      }
      return date.toISOString();
    },
  },
  {
    name: 'jsonParse',
    description: 'Parse a JSON string. For providers that nest JSON inside a string field.',
    apply: (input) => {
      const text = requireString(input, 'jsonParse');
      try {
        return JSON.parse(text) as JsonValue;
      } catch (error) {
        throw new TransformError(
          `jsonParse failed: ${error instanceof Error ? error.message : 'invalid JSON'}`,
        );
      }
    },
  },
  {
    name: 'split',
    description: 'Split a string into an array. Argument: separator (default ",").',
    args: ['separator'],
    apply: (input, args) => requireString(input, 'split').split(stringArg(args, 'separator', ',')),
  },
  {
    name: 'join',
    description: 'Join an array of scalars into a string. Argument: separator (default ",").',
    args: ['separator'],
    apply: (input, args) => {
      if (!Array.isArray(input)) {
        throw new TransformError(`join expects an array, got ${describe(input)}`);
      }
      const separator = stringArg(args, 'separator', ',');
      return input
        .map((element) => {
          if (element === null || typeof element === 'object') {
            throw new TransformError(`join expects scalars, got ${describe(element)}`);
          }
          return String(element);
        })
        .join(separator);
    },
  },
  {
    name: 'first',
    description:
      'Take the first element of an array. Rejects an empty array rather than nulling it.',
    apply: (input) => {
      if (!Array.isArray(input)) {
        throw new TransformError(`first expects an array, got ${describe(input)}`);
      }
      if (input.length === 0) {
        // Returning null here would turn an empty collection into a null
        // value, which is a different fact and a different error code.
        throw new TransformError('first cannot take an element from an empty array');
      }
      return input[0];
    },
  },
  {
    name: 'coalesceEmptyToNull',
    description: 'An empty string becomes null. For providers that use "" to mean "no value".',
    apply: (input) => (typeof input === 'string' && input.trim().length === 0 ? null : input),
  },
];

export const TRANSFORMS: Readonly<Record<string, TransformDefinition>> = Object.freeze(
  Object.fromEntries(DEFINITIONS.map((definition) => [definition.name, definition])),
);

/** The names the binding editor offers, sorted for a stable dropdown. */
export const TRANSFORM_NAMES: readonly string[] = Object.keys(TRANSFORMS).sort();

export function isKnownTransform(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRANSFORMS, name);
}

/** Applies one named transform. Throws {@link TransformError}; the caller attaches the site. */
export function applyTransform(name: string, input: JsonValue, args: JsonObject = {}): JsonValue {
  const definition = TRANSFORMS[name];
  if (!definition) {
    throw new TransformError(`Unknown transform "${name}"`);
  }
  return definition.apply(input, args);
}
