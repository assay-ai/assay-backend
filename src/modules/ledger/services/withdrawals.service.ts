import { Injectable } from '@nestjs/common';

import { BuyerEscrowRepository } from '@database/postgres/repositories/buyer-escrow.repository';
import {
  EscrowBuyerKey,
  EscrowWithdrawalEventRepository,
} from '@database/postgres/repositories/escrow-withdrawal-event.repository';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import {
  AssetId,
  ChainNamespace,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';

import { foldWithdrawals, WithdrawalRecord } from '../domain/withdrawal-history';
import { ListWithdrawalsResponseDto, WithdrawalDto } from '../dto/list-withdrawals.dto';
import { MoneyDto } from '../dto/get-balances.dto';

/** The history is short by nature (one open request per escrow); a page is enough. */
export const WITHDRAWALS_LIMIT = 100;

/** An organization's EVM escrows, keyed the way the withdrawal index stores them. */
export interface OrganizationEscrow extends EscrowBuyerKey {
  readonly accountId: string;
  readonly assetId: AssetId;
  readonly decimals: number;
}

/**
 * `GET /withdrawals` (B7): the buyer's withdrawal history, folded from the
 * indexed `WithdrawRequested` / `EscrowWithdrawn` logs of the organization's
 * own escrows. Read-only reporting, like `GET /deposits`: it moves nothing
 * and nothing decides on it. Only eip155 escrows are indexed.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly escrows: BuyerEscrowRepository,
    private readonly events: EscrowWithdrawalEventRepository,
  ) {}

  async list(organizationId: string): Promise<ListWithdrawalsResponseDto> {
    const escrows = await this.organizationEscrows(organizationId);
    const rows = await this.events.listForBuyers(escrows);
    const records = foldWithdrawals(
      rows.map((row) => ({
        id: row.id,
        chainId: row.chainId,
        buyerAddress: row.buyerAddress,
        kind: row.kind,
        amount: BigInt(row.amount),
        requested: row.requested === null ? null : BigInt(row.requested),
        availableAt: row.availableAt,
        transactionHash: row.transactionHash,
        blockTime: row.blockTime,
      })),
    );
    const byKey = new Map(escrows.map((escrow) => [keyOf(escrow), escrow]));
    return {
      items: records.slice(0, WITHDRAWALS_LIMIT).flatMap((record) => {
        const escrow = byKey.get(keyOf(record));
        return escrow ? [toDto(record, escrow)] : [];
      }),
    };
  }

  /** The organization's escrows the index covers. */
  async organizationEscrows(organizationId: string): Promise<OrganizationEscrow[]> {
    const rows = await this.escrows.listForOrganization(organizationId);
    return rows.flatMap((row) => {
      if (namespaceOf(row.accountId as never) !== ChainNamespace.EIP155) return [];
      const { chainId, address } = parseAccountId(row.accountId);
      const assetId = row.assetId as AssetId;
      return [
        {
          chainId,
          buyerAddress: address.toLowerCase(),
          accountId: row.accountId,
          assetId,
          decimals: getAssetMetadata(assetId).decimals,
        },
      ];
    });
  }
}

function keyOf(key: { chainId: string; buyerAddress: string }): string {
  return `${key.chainId}:${key.buyerAddress.toLowerCase()}`;
}

function money(amount: bigint | null, escrow: OrganizationEscrow): MoneyDto | null {
  return amount === null
    ? null
    : { amount: amount.toString(), asset: escrow.assetId, decimals: escrow.decimals };
}

function toDto(record: WithdrawalRecord, escrow: OrganizationEscrow): WithdrawalDto {
  return {
    id: record.id,
    chainId: record.chainId,
    account: escrow.accountId,
    status: record.status,
    requested: money(record.requested, escrow),
    received: money(record.received, escrow),
    requestedAt: record.requestedAt?.toISOString() ?? null,
    claimableAt: record.claimableAt?.toISOString() ?? null,
    closedAt: record.closedAt?.toISOString() ?? null,
    requestTransactionHash: record.requestTransactionHash,
    closeTransactionHash: record.closeTransactionHash,
  };
}
