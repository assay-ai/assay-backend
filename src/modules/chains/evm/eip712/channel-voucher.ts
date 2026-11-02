import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  toBytes,
  TypedDataDomain,
} from 'viem';

import { recoverEvmSigner } from '../secp256k1-recover';

/**
 * The channel door's cumulative voucher (assay-evm `src/Types.sol`,
 * `ChannelVoucher`; spec P2 v3.1 §3.2, W1 commit 6e36571).
 *
 * A buyer (or one of its delegates) signs a RUNNING TOTAL per channel:
 * `cumulative` and `calls` only ever grow, and one settlement charges the
 * step from what the chain already settled. The voucher binds no request and
 * no resource: which calls a step pays for is this backend's record, and the
 * contract bounds what it can charge by the signed total (I2) and by the
 * average per-call cap (`charge ≤ Δcalls · maxVoucherAmount`, I3).
 *
 * **THE ORDER OF THESE FIELDS IS THE TYPEHASH**, as for `VOUCHER_TYPES`.
 */
export interface ChannelVoucherMessage {
  readonly payer: `0x${string}`;
  readonly provider: `0x${string}`;
  readonly channelId: `0x${string}`;
  readonly cumulative: bigint;
  readonly calls: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

export const CHANNEL_VOUCHER_TYPES = {
  ChannelVoucher: [
    { name: 'payer', type: 'address' },
    { name: 'provider', type: 'address' },
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulative', type: 'uint64' },
    { name: 'calls', type: 'uint32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export const CHANNEL_VOUCHER_PRIMARY_TYPE = 'ChannelVoucher';

/** `cumulative` is a u56 in the channel slot. */
export const CHANNEL_MAX_CUMULATIVE = (1n << 56n) - 1n;
/** `calls` is a u24 in the channel slot: it must stay below this. */
export const CHANNEL_CALLS_LIMIT = 1 << 24;
/** A bucket amount is a u48. */
export const CHANNEL_MAX_BUCKET = (1n << 48n) - 1n;
/** The contract's maturity grid (`ChannelDoor.GRID`). */
export const CHANNEL_GRID_SECONDS = 3_600;

export function channelVoucherTypedData(message: ChannelVoucherMessage, domain: TypedDataDomain) {
  return {
    domain,
    types: CHANNEL_VOUCHER_TYPES,
    primaryType: CHANNEL_VOUCHER_PRIMARY_TYPE,
    message: { ...message, calls: message.calls },
  } as const;
}

export function hashChannelVoucher(
  message: ChannelVoucherMessage,
  domain: TypedDataDomain,
): `0x${string}` {
  return hashTypedData(channelVoucherTypedData(message, domain));
}

/** The signer, with the contract's checks (low s, v ∈ {27, 28}); `null` when none. */
export function recoverChannelSigner(
  message: ChannelVoucherMessage,
  domain: TypedDataDomain,
  signature: string,
): `0x${string}` | null {
  const recovered = recoverEvmSigner(hashChannelVoucher(message, domain), signature);
  return recovered === null ? null : (recovered as `0x${string}`);
}

/**
 * `keccak256(abi.encode(payer, signer, provider, channelId))` (I1); `signer`
 * is the payer itself when the payer signed, never `address(0)`.
 */
export function channelKeyOf(
  payer: `0x${string}`,
  signer: `0x${string}`,
  provider: `0x${string}`,
  channelId: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [getAddress(payer), getAddress(signer), getAddress(provider), channelId],
    ),
  );
}

/** One channel's packed slot (`ChannelDoor.unpack`). Maturities are hours since the epoch. */
export interface ChannelSlot {
  readonly settled: bigint;
  readonly calls: number;
  readonly h1: bigint;
  readonly m1: number;
  readonly r1: number;
  readonly h2: bigint;
  readonly m2: number;
  readonly r2: number;
}

export const EMPTY_SLOT: ChannelSlot = Object.freeze({
  settled: 0n,
  calls: 0,
  h1: 0n,
  m1: 0,
  r1: 0,
  h2: 0n,
  m2: 0,
  r2: 0,
});

/** `settled` u56 | `calls` u24 | h1 u48 | m1 u24 | r1 u16 | h2 u48 | m2 u24 | r2 u16. */
export function unpackChannelSlot(word: bigint): ChannelSlot {
  const bits = (shift: bigint, width: bigint) => (word >> shift) & ((1n << width) - 1n);
  return {
    settled: bits(0n, 56n),
    calls: Number(bits(56n, 24n)),
    h1: bits(80n, 48n),
    m1: Number(bits(128n, 24n)),
    r1: Number(bits(152n, 16n)),
    h2: bits(168n, 48n),
    m2: Number(bits(216n, 24n)),
    r2: Number(bits(240n, 16n)),
  };
}

export function packChannelSlot(slot: ChannelSlot): bigint {
  return (
    slot.settled |
    (BigInt(slot.calls) << 56n) |
    (slot.h1 << 80n) |
    (BigInt(slot.m1) << 128n) |
    (BigInt(slot.r1) << 152n) |
    (slot.h2 << 168n) |
    (BigInt(slot.m2) << 216n) |
    (BigInt(slot.r2) << 240n)
  );
}

/** A bucket's on-chain name, `maturityHour << 16 | takeRateBps` (refund and events). */
export function bucketId(maturityHour: number, takeRateBps: number): number {
  return maturityHour * 65_536 + takeRateBps;
}

export function bucketOf(id: number | bigint): { maturityHour: number; takeRateBps: number } {
  const value = Number(id);
  return { maturityHour: Math.floor(value / 65_536), takeRateBps: value % 65_536 };
}

/** The settle skip reasons, by their enum index (`ChannelDoor.SettleSkip`, append-only). */
export const SETTLE_SKIP_REASONS = [
  'Expired',
  'NotYetValid',
  'BaseMismatch',
  'Authority',
  'Calls',
  'Blocked',
  'PerCallCap',
  'EscrowWindow',
  'DelegateWindow',
  'Stake',
  'Balance',
  'NoBucket',
  // A malformed buyer signature skips its item instead of reverting the batch.
  'BadSignature',
] as const;
export type SettleSkipReason = (typeof SETTLE_SKIP_REASONS)[number];

/** The refund skip reasons (`ChannelDoor.RefundSkip`, append-only). */
export const REFUND_SKIP_REASONS = [
  'NoSuchBucket',
  'Insufficient',
  'WindowClosed',
  // The item's `refundId` was already used on this lane: the refund landed before.
  'AlreadyRefunded',
] as const;
export const REFUND_ALREADY_REFUNDED = 'AlreadyRefunded';

/**
 * The `refundId` of a channel call's refund: `keccak256(toBytes(intentId))`.
 * Deterministic per call, so every send (and re-send) of the same call's
 * refund carries the same id and the chain refunds it at most once
 * (sec-audit 2026-11-01 M-1).
 */
export function channelRefundId(intentId: string): `0x${string}` {
  return keccak256(toBytes(intentId));
}

/**
 * The `refundId` of piece `index` of a channel call's refund (final review
 * 2026-11-01 MF-1 / X-1). A collect pays oldest first, so the money a dispute
 * keeps can sit partly in each bucket; the refund is then sent as several
 * pieces, one bucket each, one piece per transaction, and each piece needs
 * its own id (an id is usable once per lane). Piece 0 is the single-piece id
 * {@link channelRefundId} (`keccak256(utf8(intentId))`, unchanged); piece
 * `k ≥ 1` is `keccak256(utf8(intentId) ‖ uint32be(k))`. Deterministic per
 * (call, piece): a re-send of the same piece carries the same id, so the
 * chain refunds it at most once.
 */
export function channelRefundPieceId(intentId: string, index: number): `0x${string}` {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`refund piece index out of range: ${index}`);
  }
  if (index === 0) return channelRefundId(intentId);
  return keccak256(concat([toBytes(intentId), toBytes(index, { size: 4 })]));
}
export const COLLECT_SKIP_REASONS = ['Blocked'] as const;

export function settleSkipReason(index: number): SettleSkipReason | `Unknown(${number})` {
  return SETTLE_SKIP_REASONS[index] ?? `Unknown(${index})`;
}

/** What the client sends inside `_meta["assay/channelVoucher"].voucher` (API-W2 §1.3). */
export interface ChannelVoucherWire {
  readonly payer: string;
  readonly provider: string;
  readonly channelId: string;
  readonly cumulative: string;
  readonly calls: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CHANNEL_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,17})$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/** A shape or range refusal: the field and why (`PAYMENT_VOUCHER_MALFORMED`). */
export class ChannelVoucherShapeError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'ChannelVoucherShapeError';
  }
}

/**
 * Parses the wire voucher into the signed message, refusing anything the
 * contract would revert on (calldata-only conditions, §3.3) or that does not
 * have one canonical reading. Times are checked by {@link assertChannelTimes}.
 */
export function parseChannelVoucher(wire: unknown, signature: unknown): ChannelVoucherMessage {
  if (!wire || typeof wire !== 'object') {
    throw new ChannelVoucherShapeError('voucher', 'not an object');
  }
  const v = wire as Record<string, unknown>;
  for (const field of ['payer', 'provider'] as const) {
    if (typeof v[field] !== 'string' || !ADDRESS_RE.test(v[field] as string)) {
      throw new ChannelVoucherShapeError(field, 'not a 20-byte hex address');
    }
  }
  if (typeof v.channelId !== 'string' || !CHANNEL_ID_RE.test(v.channelId)) {
    throw new ChannelVoucherShapeError('channelId', 'not 0x + 64 hex characters');
  }
  if (/^0x0{64}$/.test(v.channelId)) {
    throw new ChannelVoucherShapeError('channelId', 'zero');
  }
  if (typeof v.cumulative !== 'string' || !DECIMAL_RE.test(v.cumulative)) {
    throw new ChannelVoucherShapeError('cumulative', 'not a decimal string');
  }
  const cumulative = BigInt(v.cumulative);
  if (cumulative <= 0n || cumulative > CHANNEL_MAX_CUMULATIVE) {
    throw new ChannelVoucherShapeError('cumulative', 'outside 1..2^56-1');
  }
  if (
    typeof v.calls !== 'number' ||
    !Number.isInteger(v.calls) ||
    v.calls < 1 ||
    v.calls >= CHANNEL_CALLS_LIMIT
  ) {
    throw new ChannelVoucherShapeError('calls', 'not an integer in 1..2^24-1');
  }
  for (const field of ['issuedAt', 'expiresAt'] as const) {
    if (!Number.isSafeInteger(v[field]) || (v[field] as number) <= 0) {
      throw new ChannelVoucherShapeError(field, 'not a positive unix-seconds integer');
    }
  }
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    throw new ChannelVoucherShapeError('signature', 'not 65 bytes of hex');
  }
  return {
    payer: getAddress(v.payer as string),
    provider: getAddress(v.provider as string),
    channelId: (v.channelId as string).toLowerCase() as `0x${string}`,
    cumulative,
    calls: v.calls,
    issuedAt: BigInt(v.issuedAt as number),
    expiresAt: BigInt(v.expiresAt as number),
  };
}

/** Admission's time rules (v3 §5.3.1, SPEC-W2 §4), all in seconds. */
export interface ChannelTimeRules {
  readonly maxLifeSeconds: number; // 300 (the contract)
  readonly minRemainingSeconds: number; // 60
  readonly maxFutureIssueSeconds: number; // 60 (the contract allows 120)
}

export const CHANNEL_TIME_RULES: ChannelTimeRules = Object.freeze({
  maxLifeSeconds: 300,
  minRemainingSeconds: 60,
  maxFutureIssueSeconds: 60,
});

/** `null` when the voucher's times pass at `now`; otherwise the failing field and why. */
export function channelTimeRefusal(
  message: ChannelVoucherMessage,
  now: number,
  rules: ChannelTimeRules = CHANNEL_TIME_RULES,
): { field: string; reason: string; expired?: boolean } | null {
  const issued = Number(message.issuedAt);
  const expires = Number(message.expiresAt);
  if (expires <= issued) return { field: 'expiresAt', reason: 'not after issuedAt' };
  if (expires - issued > rules.maxLifeSeconds) {
    return { field: 'expiresAt', reason: `more than ${rules.maxLifeSeconds}s after issuedAt` };
  }
  if (issued > now + rules.maxFutureIssueSeconds) {
    return { field: 'issuedAt', reason: `more than ${rules.maxFutureIssueSeconds}s in the future` };
  }
  if (expires <= now) return { field: 'expiresAt', reason: 'expired', expired: true };
  if (expires - now < rules.minRemainingSeconds) {
    return {
      field: 'expiresAt',
      reason: `less than ${rules.minRemainingSeconds}s left (minimum voucher life)`,
      expired: true,
    };
  }
  return null;
}

/** `waived = cumulative − previous cumulative − charge` (W1 slim `ChannelSettled`). */
export function waivedOf(cumulative: bigint, previous: bigint, charge: bigint): bigint {
  const waived = cumulative - previous - charge;
  if (waived < 0n) {
    throw new Error(
      `channel settlement charges more than its step: ${charge} > ${cumulative} - ${previous}`,
    );
  }
  return waived;
}

/** EIP-55 spelling of a 20-byte address (the channel door's addresses are signed as such). */
export function checksumAddress(address: string): `0x${string}` {
  return getAddress(address);
}
