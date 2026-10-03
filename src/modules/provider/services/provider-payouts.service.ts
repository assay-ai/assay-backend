import { Injectable } from '@nestjs/common';

import { LedgerEntryRepository } from '@database/postgres/repositories/ledger-entry.repository';
import { LedgerEntryEntity } from '@database/postgres/entities/ledger-entry.entity';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { CursorPageDto, ListSpec, asInstant, paginate } from '@shared/api';

import { ListProviderPayoutsQueryDto, ProviderPayoutDto } from '../dto/get-provider-payouts.dto';

/**
 * The list spec for `PAYOUT` entries — one `createdAt` sort, `entry.id` tiebreak.
 * See `docs/api-list-contract.md` rule 2: needs an index ending in the tiebreak,
 * added in this module's migration as `idx_ledger_entries_org_type_created`.
 */
const PROVIDER_PAYOUT_LIST: ListSpec = {
  alias: 'entry',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'entry.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: LedgerEntryEntity) => row.createdAt),
    },
  },
};

/**
 * `GET /providers/me/payouts`.
 *
 * **Not** cross-organization: a `PAYOUT` entry credits/debits the provider's
 * own ledger account, so it is written (once the verification worker writes
 * it) under the provider's own `organization_id`, exactly
 * like every other row this provider's own ledger owns. A normal
 * organization-scoped query.
 */
@Injectable()
export class ProviderPayoutsService {
  constructor(private readonly ledgerEntries: LedgerEntryRepository) {}

  async listPayouts(
    organizationId: string,
    query: ListProviderPayoutsQueryDto,
  ): Promise<CursorPageDto<ProviderPayoutDto>> {
    const qb = this.ledgerEntries
      .createQueryBuilder('entry')
      .where('entry.organizationId = :organizationId', { organizationId })
      .andWhere('entry.entryType = :entryType', { entryType: LedgerEntryType.PAYOUT })
      .andWhere('entry.batchId IS NOT NULL');

    const page = await paginate(qb, query, PROVIDER_PAYOUT_LIST);
    return page.map(toPayoutDto);
  }
}

function toPayoutDto(row: LedgerEntryEntity): ProviderPayoutDto {
  return {
    id: row.id,
    batchId: row.batchId as string,
    amount: { amount: row.amount, asset: row.assetId, decimals: row.decimals },
    chainTxRef: row.chainTxRef,
    createdAt: row.createdAt,
  };
}
