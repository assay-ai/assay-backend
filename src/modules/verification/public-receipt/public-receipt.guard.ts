import { NotChargedReason } from '@modules/catalogue/domain/not-charged-reason';

import { StageStatus, VerificationStage } from '../domain/stage';
import { PUBLIC_RECEIPT_STATUSES } from './public-receipt.dto';

/**
 * The last check before a public receipt leaves the process. It knows the complete
 * allowed shape and refuses anything else: an unknown key, a wrong type, an
 * enum value out of range, a string that is too long, or text that looks like
 * a wallet address or a hash.
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
const nullable = (of: Spec): Spec => ({ t: 'null', of });
const obj = (keys: Record<string, Spec>): Spec => ({ t: 'object', keys });

// The asset id names a token contract (CAIP-19, e.g. eip155:4663/erc20:0x...): public by nature, so it is
// held to its exact shape instead of the "no long hex" rule that every other string gets.
const CAIP19_ASSET = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/;
const MONEY = obj({
  amount: str(40, /^[0-9]{1,40}$/),
  asset: str(120, CAIP19_ASSET),
  decimals: { t: 'int' },
});
const NAMED = obj({ id: str(36), name: str(80) });

export const PUBLIC_RECEIPT_SPEC: Spec = obj({
  status: { t: 'enum', values: PUBLIC_RECEIPT_STATUSES },
  tool: nullable(NAMED),
  provider: nullable(NAMED),
  listedPrice: MONEY,
  chargedPrice: MONEY,
  notCharged: nullable(
    obj({ reason: { t: 'enum', values: Object.values(NotChargedReason) }, text: str(200) }),
  ),
  stages: {
    t: 'array',
    length: 4,
    of: obj({
      stage: { t: 'enum', values: Object.values(VerificationStage) },
      status: { t: 'enum', values: Object.values(StageStatus) },
      label: str(40),
    }),
  },
  sampling: nullable(str(120)),
  createdAt: str(24),
  settledAt: nullable(str(24)),
});

/** The exact top-level key list, for the pinned test. */
export const PUBLIC_RECEIPT_KEYS = Object.keys((PUBLIC_RECEIPT_SPEC as { keys: object }).keys);

// A wallet address or a hash has no place in this response, whatever field it sits in.
const HEX_LONG = /0x[0-9a-fA-F]{40,}/;

function fail(path: string, why: string): never {
  throw new PublicReceiptShapeError(`${path || '$'}: ${why}`);
}

function check(spec: Spec, value: unknown, path: string): void {
  switch (spec.t) {
    case 'string':
      if (typeof value !== 'string') return fail(path, 'not a string');
      if (value.length > spec.max) return fail(path, 'too long');
      if (spec.pattern) {
        if (!spec.pattern.test(value)) return fail(path, 'does not match its shape');
        return;
      }
      if (HEX_LONG.test(value)) return fail(path, 'looks like an address or a hash');
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
      if (!Array.isArray(value) || value.length !== spec.length) return fail(path, 'wrong array');
      value.forEach((item, i) => check(spec.of, item, `${path}[${i}]`));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return fail(path, 'not an object');
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!(key in spec.keys)) return fail(`${path}.${key}`, 'key is not allowed');
      }
      for (const [key, sub] of Object.entries(spec.keys)) {
        if (!(key in record)) return fail(`${path}.${key}`, 'key is missing');
        check(sub, record[key], `${path}.${key}`);
      }
    }
  }
}

export function assertPublicReceiptShape(value: unknown): void {
  check(PUBLIC_RECEIPT_SPEC, value, '');
}
