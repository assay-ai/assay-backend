import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ListQueryDto } from '@shared/api';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/** No resource-specific filters — `from`/`to`/`cursor`/`limit`/`sort` from `ListQueryDto` are enough. */
export class ListProviderPayoutsQueryDto extends ListQueryDto {}

/**
 * One `PAYOUT` ledger entry — a line in a payout batch.
 *
 * `docs/api-list-contract.md`'s row-level cursor requires a stable, `NOT NULL`,
 * indexed sort column; `ledger_entries` has no "batch" row, only entries, so
 * this list paginates entries (one row per `PAYOUT` entry) rather than a
 * server-side `GROUP BY batch_id`. In practice a payout run writes at most one
 * `PAYOUT` entry per asset per provider, so this is one row per batch for any
 * provider dealing in a single asset; a provider paid out in two assets in the
 * same run sees two rows sharing one `batchId`, which is the honest ledger
 * shape rather than a synthetic merge.
 */
export class ProviderPayoutDto {
  @ApiProperty({ description: 'The ledger entry id' })
  id: string;

  @ApiProperty({ description: 'The payout run this entry belongs to' })
  batchId: string;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiPropertyOptional({ nullable: true, description: 'On-chain transaction reference, once sent' })
  chainTxRef: string | null;

  @ApiProperty()
  createdAt: Date;
}
