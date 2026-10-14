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
 * price, why it was not charged, and the minute it happened. There is no
 * intent id, call id, buyer organization, agent, account, hold, request or
 * response body, and no transaction reference — the repository does not even
 * select them. The timestamp is truncated to the minute so it cannot be joined
 * back to a buyer's own receipt by exact time.
 *
 * ## k-anonymity
 *
 * A row is listed only for a tool whose not-charged calls in the window came
 * from at least `minBuyers` different buyer organizations, and an asset's
 * totals are counted only when at least `minBuyers` buyers made paid calls in
 * it. Below that floor a single buyer's activity could be read off the feed,
 * so it is left out and `withheldForPrivacy` says so.
 */
export class PublicNotChargedCallDto {
  @ApiProperty({
    description: 'Catalogue tool id — the same id `GET /public/catalogue/tools` lists.',
  })
  toolId: string;

  @ApiProperty({ example: 'get_weather', description: 'The tool name; the tool id when unknown.' })
  toolName: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The serving provider’s registered name; null when no provider was named.',
  })
  providerName: string | null;

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
      'never produced usable data. Never merge the two.',
  })
  bucket: WithheldBucket;

  @ApiProperty({ description: 'When the call was made, ISO-8601 truncated to the minute (UTC).' })
  at: string;
}

export class PublicNotChargedTotalsDto {
  @ApiProperty({
    description:
      'Paid calls that reached a final outcome in the window — charged or not. Free calls are ' +
      'not counted.',
  })
  callsChecked: number;

  @ApiProperty({ description: 'Of those, calls that ended without a charge.' })
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

  @ApiProperty({ description: 'Start of the window, ISO-8601 truncated to the minute.' })
  since: string;

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
