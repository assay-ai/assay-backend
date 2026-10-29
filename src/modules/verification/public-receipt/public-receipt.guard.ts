import {
  NOT_CHARGED_REASON_TEXT,
  NotChargedReason,
} from '@modules/catalogue/domain/not-charged-reason';

import { STAGE_STATUS_LABEL, StageStatus, VerificationStage } from '../domain/stage';
import { PUBLIC_RECEIPT_STATUSES } from './public-receipt.dto';

/**
 * The last check before a public receipt leaves the process. It knows the complete
 * allowed shape and refuses anything else: an unknown key, a wrong type, an
 * enum value out of range, a string that is too long or off its pattern, or
 * free text that looks like a wallet address or a hash.
 *
 * It cannot be talked around by the value it checks: only own, plain data
 * properties count (`Object.hasOwn`, never `in`), every own key is visited
 * (`Reflect.ownKeys`, so a symbol key is refused), an object must be a plain
 * object or a null-prototype one and an array a plain array, and a getter is
 * refused (it could answer the guard and `JSON.stringify` differently).
 *
 * It is **fail closed**: a violation throws, the route answers 500, and nothing
 * is sent. The message carries key names and paths, never values.
 */
export class PublicReceiptShapeError extends Error {}

type Spec =
  | { t: 'string'; max: number; pattern?: RegExp }
  | { t: 'int' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'null'; of: Spec }
  | { t: 'object'; keys: Readonly<Record<string, Spec>> }
  | { t: 'array'; of: Spec; length: number };

const str = (max: number, pattern?: RegExp): Spec => ({ t: 'string', max, pattern });
const oneOf = (values: readonly string[]): Spec => ({ t: 'enum', values });
const nullable = (of: Spec): Spec => ({ t: 'null', of });
const obj = (keys: Record<string, Spec>): Spec => ({ t: 'object', keys });

// The asset id names a token contract (CAIP-19, e.g. eip155:4663/erc20:0x...): public by nature, so it is
// held to its exact shape instead of the free-text rules. A token address is 40 hex digits; a longer
// hex run (a 64-hex hash or key) is refused even inside a well-formed id.
const CAIP19_ASSET =
  /^(?!.*[0-9a-fA-F]{41})[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UTC, rounded down to the minute: seconds and milliseconds are always zero. */
const ISO_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const MONEY = obj({
  amount: str(40, /^[0-9]{1,40}$/),
  asset: str(120, CAIP19_ASSET),
  decimals: { t: 'int' },
});
const NAMED = obj({ id: str(36, UUID), name: str(80) });

/** The allowed stage names and statuses, listed here once (the mapper's own code may not iterate keys). */
export const STAGE_VALUES: readonly string[] = Object.values(VerificationStage);
export const STAGE_STATUS_VALUES: readonly string[] = Object.values(StageStatus);

export const PUBLIC_RECEIPT_SPEC: Spec = obj({
  status: oneOf(PUBLIC_RECEIPT_STATUSES),
  tool: nullable(NAMED),
  provider: nullable(NAMED),
  listedPrice: MONEY,
  chargedPrice: MONEY,
  notCharged: nullable(
    obj({
      reason: oneOf(Object.values(NotChargedReason)),
      text: oneOf(Object.values(NOT_CHARGED_REASON_TEXT)),
    }),
  ),
  stages: {
    t: 'array',
    length: 4,
    of: obj({
      stage: oneOf(STAGE_VALUES),
      status: oneOf(STAGE_STATUS_VALUES),
      label: oneOf(Object.values(STAGE_STATUS_LABEL)),
    }),
  },
  sampling: nullable(str(120)),
  createdAt: str(24, ISO_MINUTE),
  settledAt: nullable(str(24, ISO_MINUTE)),
});

/** The exact top-level key list, for the pinned test. */
export const PUBLIC_RECEIPT_KEYS = Object.keys((PUBLIC_RECEIPT_SPEC as { keys: object }).keys);

/**
 * A wallet address, a hash, a key or a signature has no place in free text (a name, the
 * sampling sentence): an EVM-style 0x run, a long bare hex run, or a long base58 run (Solana).
 */
const ADDRESS_OR_HASH: readonly RegExp[] = [
  /0x[0-9a-fA-F]{40,}/,
  /[0-9a-fA-F]{32,}/,
  /[1-9A-HJ-NP-Za-km-z]{32,}/,
];

/** True when free text would pass the guard's address/hash rules (the mapper uses it to drop a name). */
export function isSafeFreeText(value: string): boolean {
  return !ADDRESS_OR_HASH.some((pattern) => pattern.test(value));
}

/**
 * `Object.hasOwn` (Node 16.9+). The compiler lib predates ES2022, so it is typed here;
 * an own-property test that a `hasOwnProperty` key on the value cannot shadow.
 */
const hasOwn = (Object as unknown as { hasOwn(o: object, key: PropertyKey): boolean }).hasOwn;

function fail(path: string, why: string): never {
  throw new PublicReceiptShapeError(`${path || '$'}: ${why}`);
}

/** The value of an own data property; an accessor (getter/setter) is refused. */
function ownValue(holder: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (!descriptor || !hasOwn(descriptor, 'value')) return fail(path, 'not a data property');
  return descriptor.value as unknown;
}

function check(spec: Spec, value: unknown, path: string): void {
  switch (spec.t) {
    case 'string':
      if (typeof value !== 'string') return fail(path, 'not a string');
      // Counted in code points, the unit the mapper truncates by.
      if (Array.from(value).length > spec.max) return fail(path, 'too long');
      if (spec.pattern) {
        if (!spec.pattern.test(value)) return fail(path, 'does not match its shape');
        return;
      }
      if (!isSafeFreeText(value)) return fail(path, 'looks like an address or a hash');
      return;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return fail(path, 'not an integer');
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value))
        return fail(path, 'not an allowed value');
      return;
    case 'null':
      if (value === null) return;
      return check(spec.of, value, path);
    case 'array': {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        return fail(path, 'not a plain array');
      if (value.length !== spec.length) return fail(path, 'wrong array length');
      // Only the indexes and `length`: no extra or symbol key on the array itself.
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return fail(path, 'symbol key is not allowed');
        if (key === 'length') continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= spec.length)
          return fail(`${path}.${key}`, 'key is not allowed');
      }
      for (let i = 0; i < spec.length; i++) {
        check(spec.of, ownValue(value, String(i), `${path}[${i}]`), `${path}[${i}]`);
      }
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return fail(path, 'not an object');
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return fail(path, 'not a plain object');
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return fail(path, 'symbol key is not allowed');
        if (!hasOwn(spec.keys, key)) return fail(`${path}.${key}`, 'key is not allowed');
      }
      for (const key of Object.keys(spec.keys)) {
        if (!hasOwn(value, key)) return fail(`${path}.${key}`, 'key is missing');
        check(spec.keys[key], ownValue(value, key, `${path}.${key}`), `${path}.${key}`);
      }
    }
  }
}

/** True when `{ id, name }` would pass the guard as a tool or provider (the mapper nulls it otherwise). */
export function isPublicNamed(value: { id: string; name: string }): boolean {
  if (value.name.length === 0) return false;
  try {
    check(NAMED, value, '');
    return true;
  } catch (error) {
    if (error instanceof PublicReceiptShapeError) return false;
    throw error;
  }
}

export function assertPublicReceiptShape(value: unknown): void {
  check(PUBLIC_RECEIPT_SPEC, value, '');
}
