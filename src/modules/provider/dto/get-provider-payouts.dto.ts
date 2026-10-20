import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * No resource-specific filters — `from`/`to`/`cursor`/`limit`/`sort` from
 * `ListQueryDto` are enough. `[from, to)` windows a redemption on its first
 * credit.
 */
export class ListProviderPayoutsQueryDto extends ListQueryDto {}

/** How a payment reached the provider's wallet. */
export enum ProviderPaymentKind {
  /** A rail-B redemption: the buyer's escrow paid on chain, one transaction. */
  REDEMPTION = 'REDEMPTION',
}

/**
 * One payment sent to the provider's wallet (D18).
 *
 * A **REDEMPTION** row is one redemption transaction: the `PROVIDER_CREDIT`
 * entries carrying its `chainTxRef`, summed. A credit whose ref is synthetic
 * (`unobserved:` / `held_collected:`, no signature seen) is a payment of its
 * own with `chainTxRef: null`. A legacy platform absorb is not a payment
 * (nobody paid it) and is never listed.
 */
export class ProviderPayoutDto {
  @ApiProperty({
    description: 'The lowest ledger entry id in the transaction',
  })
  id: string;

  @ApiProperty({ enum: ProviderPaymentKind })
  kind: ProviderPaymentKind;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'On-chain transaction reference, once sent. `null` for a redemption whose transaction ' +
      'signature was not observed (its ledger ref is synthetic, not a transaction)',
  })
  chainTxRef: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Calls this payment paid for: the redeemed calls',
  })
  calls: number | null;

  @ApiProperty({ description: 'When the money was sent (a redemption: its last credit)' })
  createdAt: Date;
}
