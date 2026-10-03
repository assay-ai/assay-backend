import { ApiProperty } from '@nestjs/swagger';

import { PublicReservesState } from '../domain/public-reserves';

/**
 * The wire contract of `GET /api/v1/public/reserves` (the proof-of-reserves page,
 * one entry per chain).
 *
 * **The response is `{ chains: [...] }` and carries no total.** Balances
 * are a list, never a sum. Money on 46630 does not back a liability on Solana,
 * so a combined figure would be a number nobody could act on — and one that
 * only becomes visibly wrong on the day the two chains diverge, which is the
 * first day anybody needs this page. A reader who wants a sum computes it and
 * owns the assumption.
 *
 * Every money figure is a **string of minor units**, matching the rest of this
 * API and `numeric(78,0)` in the database. A JSON number would lose precision
 * above 2^53 and would quietly round a reserves figure, which on this page is
 * the one thing that must never happen. The client formats using `decimals`.
 *
 * `null` is a real value throughout and means *not known*, never *zero*.
 */

export class PublicReservesStakeDto {
  @ApiProperty({ description: 'Σ bonded across every provider, in minor units.' })
  bondedTotal: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty({ description: 'CAIP-19 of the settlement program stake mint.' })
  asset: string;

  @ApiProperty({ description: 'How many providers hold a stake account.' })
  providerCount: number;

  @ApiProperty({
    description:
      'When the CHAIN was read for this figure — a different cron from the ' +
      'reconciliation, so this is deliberately not `reconciledAt`.',
  })
  readAt: Date;
}

export class PublicReservesHistoryRowDto {
  @ApiProperty()
  checkedAt: Date;

  @ApiProperty({ nullable: true, type: String })
  vaultBalance: string | null;

  @ApiProperty({ nullable: true, type: String })
  totalLiabilities: string | null;

  @ApiProperty({ nullable: true, type: String })
  difference: string | null;

  @ApiProperty({ nullable: true, type: String })
  vaultSlot: string | null;

  @ApiProperty({ description: 'The run could not read the chain. Listed, not hidden.' })
  failed: boolean;
}

export class PublicReservesChainDto {
  @ApiProperty({ description: 'CAIP-2 of the chain this panel is about. Never null.' })
  chainId: string;

  @ApiProperty({ description: 'CAIP-19 of the asset this panel is about. Never null.' })
  asset: string;

  @ApiProperty({
    enum: PublicReservesState,
    description:
      'NORMAL — the figures are a completed check. NO_RECONCILIATION — none has ' +
      'ever run here, so the figures are absent rather than zero. ' +
      'LAST_CHECK_FAILED — the most recent check could not read the chain, so ' +
      'nothing current can be published.',
  })
  state: PublicReservesState;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Ticker from the asset registry. Null rather than guessed.',
  })
  assetSymbol: string | null;

  @ApiProperty({ nullable: true, type: Number })
  decimals: number | null;

  @ApiProperty({ nullable: true, type: String })
  vaultAccount: string | null;

  @ApiProperty({ nullable: true, type: String })
  vaultBalance: string | null;

  @ApiProperty({ nullable: true, type: String })
  totalLiabilities: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Signed. Negative is a shortfall, positive a surplus.',
  })
  difference: string | null;

  @ApiProperty({ nullable: true, type: Number })
  accounts: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The slot the vault balance was true at. Null for every run recorded ' +
      'before this column existed; never invented.',
  })
  vaultSlot: string | null;

  @ApiProperty({ nullable: true, type: Date })
  reconciledAt: Date | null;

  @ApiProperty({
    nullable: true,
    type: PublicReservesStakeDto,
    description:
      'The fleet stake snapshot, present only on the chain it was read from. ' +
      'Repeating it under every panel would claim one chain’s stake backs ' +
      'another chain’s liabilities.',
  })
  stake: PublicReservesStakeDto | null;

  @ApiProperty({ type: [PublicReservesHistoryRowDto] })
  history: PublicReservesHistoryRowDto[];
}

export class GetPublicReservesResponseDto {
  @ApiProperty({
    type: [PublicReservesChainDto],
    description:
      'One panel per chain this deployment reconciles, in the order ENABLED_CHAINS ' +
      'names them. There is deliberately NO field that adds them together.',
  })
  chains: PublicReservesChainDto[];
}
