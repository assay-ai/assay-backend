import { ApiProperty } from '@nestjs/swagger';

import { WithheldBucket } from '@modules/ledger/domain/withheld';

import { NotChargedReason } from '../domain/not-charged-reason';
import { PublicMoneyDto } from './public-catalogue.dto';

/**
 * `GET /public/not-charged` — proof, readable without an account, that the
 * platform does not charge for results nobody can use.
 *
 * ## What is on the wire, and what never is
 *
 * Each recent row is the tool, the provider's registered name, the listed
 * price, why it was not charged, and the UTC day it happened — published only
 * once at least 24 h old. There is no intent id, call id, buyer organization,
 * agent, account, hold, request or response body, and no transaction
 * reference.
 *
 * ## k-anonymity
 *
 * A buyer counts only when its organization is at least 7 days old and has a
 * charged paid call. Each tool's published rows must come from at least
 * `minBuyers` such buyers, counted on the rows actually published; an asset's
 * totals are counted only when `minBuyers` such buyers made paid calls in it.
 * Totals cover complete UTC days only. Whatever falls below the floor is left
 * out, and `withheldForPrivacy` says so. The rule is documented in full on
 * `PublicNotChargedService`.
 */
export class PublicNotChargedCallDto {
  @ApiProperty({
    description: 'Catalogue tool id — the same id `GET /public/catalogue/tools` lists.',
  })
  toolId: string;

  @ApiProperty({ example: 'get_weather', description: 'The tool name; the tool id when unknown.' })
  toolName: string;

  @ApiProperty({
    description:
      'The serving provider’s registered name. Rows whose provider is not on the public ' +
      'provider list are not published at all.',
  })
  providerName: string;

  @ApiProperty({ type: PublicMoneyDto, description: 'The listed price that was not charged.' })
  price: PublicMoneyDto;

  @ApiProperty({ enum: NotChargedReason, description: 'Stable key for the reason.' })
  reason: NotChargedReason;

  @ApiProperty({ description: 'One plain sentence saying why.' })
  reasonText: string;

  @ApiProperty({
    enum: WithheldBucket,
    description:
      'FAILED_VERIFICATION is the guarantee firing; PROVIDER_OR_PLATFORM_ERROR is a call that ' +
      'never produced usable data, or whose payment the provider could not collect ' +
      '(NOT_COLLECTED). Never merge the two.',
  })
  bucket: WithheldBucket;

  @ApiProperty({
    example: '2026-10-14',
    description: 'UTC day the call was made. Rows are published only once at least 24 h old.',
  })
  day: string;
}

export class PublicNotChargedTotalsDto {
  @ApiProperty({
    description:
      'Paid calls that reached a final outcome in the window — charged or not. Free calls are ' +
      'not counted.',
  })
  callsChecked: number;

  @ApiProperty({
    description:
      'Of those, calls that ended without a charge and are not owed: refunded, voided, ' +
      'expired, or served but never collected (forfeited, voided debt). An open or ' +
      'written-off buyer debt is owed and is not counted here.',
  })
  callsNotCharged: number;

  @ApiProperty({ description: 'Of the not-charged calls, those whose result failed verification.' })
  callsFailedCheck: number;

  @ApiProperty({
    type: [PublicMoneyDto],
    description: 'Listed value not charged, one entry per asset — a list, never a sum.',
  })
  amountNotCharged: PublicMoneyDto[];
}

export class PublicNotChargedResponseDto {
  @ApiProperty({ example: 30, description: 'Length of the totals window, in days.' })
  windowDays: number;

  @ApiProperty({ description: 'Start of the totals window: a UTC midnight, ISO-8601.' })
  since: string;

  @ApiProperty({
    description:
      'End of the totals window (exclusive): the start of today, UTC. Totals cover complete ' +
      'days only, so they change once a day.',
  })
  until: string;

  @ApiProperty({
    example: 5,
    description:
      'The k-anonymity floor: a tool’s calls are listed, and an asset’s totals counted, only ' +
      'when at least this many different buyers stand behind them.',
  })
  minBuyers: number;

  @ApiProperty({
    description:
      'True when some activity in the window was left out under the minBuyers rule — so a ' +
      'short list or a zero is not read as "nothing happened".',
  })
  withheldForPrivacy: boolean;

  @ApiProperty({ type: PublicNotChargedTotalsDto })
  totals: PublicNotChargedTotalsDto;

  @ApiProperty({
    type: [PublicNotChargedCallDto],
    description: 'The most recent not-charged paid calls in the window, newest first.',
  })
  recent: PublicNotChargedCallDto[];
}
