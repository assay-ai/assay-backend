import { isAccountId, parseAccountId } from '@modules/chains/ports/caip.types';

/**
 * The account blocklist, as pure functions.
 *
 * A block names one of two kinds of subject:
 *
 * - **An organization** — the tenant. Every session and machine credential of
 *   the tenant, every agent it owns and, when it is a provider, every binding
 *   it publishes are refused while the block stands.
 * - **A wallet** — a CAIP-10 account. Refused wherever it is the payer, the
 *   payee or the stake authority, whichever tenant presents it. This is the
 *   one for a leaked key: the key is compromised, not the tenant.
 *
 * ## A wallet block is matched across the chains of its namespace
 *
 * The stored subject is the CAIP-10 the operator gave, normalised. The match
 * key drops the chain reference: `eip155:8453:0xabc` and `eip155:84532:0xabc`
 * are one key, because a leaked private key signs on every EVM chain at once.
 * Blocking it on the one chain somebody happened to type would leave the same
 * key spending on the next one.
 *
 * EVM addresses are lower-cased (a checksummed and a lower-case spelling are
 * the same account). Solana addresses are base58 and case-sensitive, so they
 * are kept as written.
 */
export enum BlockSubjectKind {
  ORGANIZATION = 'ORGANIZATION',
  WALLET = 'WALLET',
}

/** Where a blocked subject was found, for the refusal and the log line. */
export enum BlockedRole {
  /** The tenant behind a session, a credential or an agent. */
  ORGANIZATION = 'ORGANIZATION',
  /** The account a call is charged to. */
  PAYER = 'PAYER',
  /** The account that receives the money — a provider's payout address. */
  PAYEE = 'PAYEE',
  /** The provider organization serving a call. */
  PROVIDER = 'PROVIDER',
  /** The delegate key that signed a voucher for the payer. */
  DELEGATE = 'DELEGATE',
  /** A provider's stake authority. */
  STAKE_AUTHORITY = 'STAKE_AUTHORITY',
}

/** One active block, as the hot path sees it. */
export interface BlockHit {
  readonly blockId: string;
  readonly subjectKind: BlockSubjectKind;
  readonly subject: string;
  readonly reasonCode: string;
  readonly blockedAt: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stored form of a subject, or `null` when it is not one.
 *
 * An organization is a uuid, lower-cased. A wallet is a CAIP-10 account, EVM
 * lower-cased.
 */
export function normalizeSubject(kind: BlockSubjectKind, subject: string): string | null {
  if (typeof subject !== 'string') return null;
  const value = subject.trim();
  if (kind === BlockSubjectKind.ORGANIZATION) {
    return UUID_RE.test(value) ? value.toLowerCase() : null;
  }
  if (!isAccountId(value)) return null;
  return value.startsWith('eip155:') ? value.toLowerCase() : value;
}

/**
 * The key a subject is matched by. See the module comment for why a wallet's
 * key has no chain reference.
 *
 * Returns `null` for anything that is not a subject of that kind, so a
 * malformed account on a payment path can never match — and never throw —
 * here; refusing it is the payment path's own job.
 */
export function subjectKey(kind: BlockSubjectKind, subject: string): string | null {
  const normalized = normalizeSubject(kind, subject);
  if (normalized === null) return null;
  if (kind === BlockSubjectKind.ORGANIZATION) return normalized;

  const { chainId, address } = parseAccountId(normalized);
  const namespace = chainId.slice(0, chainId.indexOf(':'));
  return `${namespace}:${address}`;
}
