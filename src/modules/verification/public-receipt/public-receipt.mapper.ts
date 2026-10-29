import type { PublicReceiptRow } from '@database/postgres/repositories/public-receipt-read.repository';
import {
  NOT_CHARGED_REASON_TEXT,
  notChargedReason,
} from '@modules/catalogue/domain/not-charged-reason';
import { CollectionState, collectionStateOf } from '@modules/payment/domain/collection';
import {
  DEBT_VOIDED_PREFIX,
  PROVIDER_FORFEIT_PREFIX,
  UNCOLLECTED_PREFIX,
} from '@modules/payment/constants/voucher-redemption.constants';

import { STAGE_STATUS_LABEL, StageStatus, VERIFICATION_PIPELINE } from '../domain/stage';
import { isPublicNamed, STAGE_STATUS_VALUES, STAGE_VALUES } from './public-receipt.guard';
import type {
  PublicReceiptMoneyDto,
  PublicReceiptNamedDto,
  PublicReceiptResponseDto,
  PublicReceiptStatus,
  PublicReceiptStageDto,
} from './public-receipt.dto';

/**
 * Builds the public receipt **field by field**. No spread, no `Object.assign`,
 * no `Omit`: a value reaches the response only because it is written below.
 * (ESLint forbids the shortcuts in this folder, and `assertPublicReceiptShape`
 * checks the result again.)
 */

const MINUTE_MS = 60_000;
const NAME_MAX = 80;
const STATUSES_IN_PROGRESS: ReadonlySet<string> = new Set([
  'CREATED',
  'FUNDS_SECURED',
  'PROVIDER_EXECUTING',
  'VERIFYING',
]);
const STAGE_BY_NAME: ReadonlySet<string> = new Set(STAGE_VALUES);
const STAGE_STATUSES: ReadonlySet<string> = new Set(STAGE_STATUS_VALUES);
/** The published sampling sentence ("1 in 125 calls at this price"): plain words and numbers only. */
const SAMPLING_SHAPE = /^[A-Za-z0-9 ,.%'-]{1,120}$/;

const CAUSE_TO_PREFIX = {
  FORFEITED: PROVIDER_FORFEIT_PREFIX,
  WRITTEN_OFF: UNCOLLECTED_PREFIX,
  VOIDED_REFUND: DEBT_VOIDED_PREFIX,
  VOIDED_VOID: DEBT_VOIDED_PREFIX,
} as const;

export interface PublicNames {
  readonly providerNames: ReadonlyMap<string, string>;
  readonly toolNames: ReadonlyMap<string, string>;
}

/** Control, invisible and bidirectional-format characters, by code point (so no such character sits in this file). */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`,
  'g',
);

/** UTC, rounded down to the minute: never the exact instant of a call. */
export function roundedToMinute(date: Date): string {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** A name written by a provider: text only, no control or invisible characters, capped in code points. */
export function cleanName(value: string): string {
  const stripped = value.replace(INVISIBLE, '').trim();
  // By code point, so a cut never splits a surrogate pair.
  return Array.from(stripped).slice(0, NAME_MAX).join('').trim();
}

/**
 * A tool or provider as the public sees it, or `null` when its cleaned name is empty
 * or would fail the guard (an address- or hash-like name): that one object is
 * dropped instead of failing the whole receipt.
 */
function named(id: string | null, rawName: string | undefined): PublicReceiptNamedDto | null {
  if (id === null || id === '' || rawName === undefined) return null;
  const candidate = { id, name: cleanName(rawName) };
  return isPublicNamed(candidate) ? candidate : null;
}

function money(amount: string, row: PublicReceiptRow): PublicReceiptMoneyDto {
  return { amount, asset: row.asset, decimals: row.decimals };
}

function stages(row: PublicReceiptRow): PublicReceiptStageDto[] {
  const byStage = new Map<string, StageStatus>();
  for (const entry of row.stages) {
    if (typeof entry.stage === 'string' && STAGE_BY_NAME.has(entry.stage)) {
      const status =
        typeof entry.status === 'string' && STAGE_STATUSES.has(entry.status)
          ? (entry.status as StageStatus)
          : StageStatus.NOT_REACHED;
      byStage.set(entry.stage, status);
    }
  }
  // Always all four, in pipeline order: a missing one is "not reached", never a tick.
  return VERIFICATION_PIPELINE.map((stage) => {
    const status = byStage.get(stage) ?? StageStatus.NOT_REACHED;
    return { stage, status, label: STAGE_STATUS_LABEL[status] };
  });
}

/** The collection state, from the same predicate every other receipt surface uses, fed fixed labels. */
function collectionOf(row: PublicReceiptRow): CollectionState {
  return collectionStateOf({
    redemptionLastError: row.collectionCause ? CAUSE_TO_PREFIX[row.collectionCause] : null,
    redemptionLapsedAt: row.lapsed ? new Date(0) : null,
    holdReleasedAt: row.holdReleased ? new Date(0) : null,
  });
}

export function toPublicReceipt(
  row: PublicReceiptRow,
  names: PublicNames,
): PublicReceiptResponseDto {
  const listed = row.providerId !== null && names.providerNames.has(row.providerId);
  const providerName =
    listed && row.providerId !== null ? names.providerNames.get(row.providerId) : undefined;
  const toolName = listed ? names.toolNames.get(row.toolId) : undefined;

  const collection = collectionOf(row);
  const settled = row.status === 'SETTLED';
  const charged =
    settled &&
    (collection === CollectionState.NORMAL || collection === CollectionState.DEBT_OUTSTANDING);

  let status: PublicReceiptStatus;
  let notCharged: PublicReceiptResponseDto['notCharged'] = null;
  const outcome = notChargedReason({
    status: row.status,
    classification: row.classification,
    verificationVerdict: row.verificationVerdict,
    // Only the two causes the public explorer also publishes; a written-off debt is never "not charged".
    settledCause:
      row.collectionCause === 'FORFEITED' ||
      row.collectionCause === 'VOIDED_REFUND' ||
      row.collectionCause === 'VOIDED_VOID'
        ? row.collectionCause
        : null,
  });
  if (STATUSES_IN_PROGRESS.has(row.status)) {
    status = 'IN_PROGRESS';
  } else if (charged) {
    status = 'CHARGED';
  } else if (outcome && row.hasHold) {
    status = 'NOT_CHARGED';
    notCharged = { reason: outcome.reason, text: NOT_CHARGED_REASON_TEXT[outcome.reason] };
  } else {
    // Written-off or otherwise closed without a public meaning: say nothing about why.
    status = 'CLOSED';
  }

  const sampling =
    row.sampleDisplay !== null && SAMPLING_SHAPE.test(row.sampleDisplay) ? row.sampleDisplay : null;

  return {
    status,
    tool: named(row.toolId, toolName),
    provider: named(row.providerId, providerName),
    listedPrice: money(row.priceAmount, row),
    chargedPrice: money(charged ? row.priceAmount : '0', row),
    notCharged,
    stages: stages(row),
    sampling,
    createdAt: roundedToMinute(row.createdAt),
    settledAt: row.settledAt ? roundedToMinute(row.settledAt) : null,
  };
}
