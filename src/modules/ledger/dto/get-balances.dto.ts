import { ApiProperty } from '@nestjs/swagger';

import { WithheldBucket } from '../domain/withheld';

/**
 * `Money` on the wire: atomic units as a decimal string, plus the asset that
 * gives the number meaning. Never a bare amount — see `chains/ports/money.types.ts`.
 */
export class MoneyDto {
  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '1000000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id', example: 'solana:5eykt.../token:EPjF...' })
  asset: string;

  @ApiProperty({ description: 'The scale `amount` is quoted in', example: 6 })
  decimals: number;
}

export class AccountBalanceDto {
  @ApiProperty({
    description:
      'CAIP-2. The chain this balance is held on and spent on. Balances are per chain and are ' +
      'NEVER combined: two chains are two rows, and there is deliberately no field that spans ' +
      'them — a total would imply the buyer can spend it on one call, and they cannot.',
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId: string;

  @ApiProperty({
    description:
      'CAIP-10. Which account this row is. Present because two rows for one asset were ' +
      'previously indistinguishable on the wire.',
  })
  accountId: string;

  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty()
  decimals: number;

  @ApiProperty({ type: MoneyDto, description: 'Spendable, and holdable against' })
  available: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Reserved against an in-flight call' })
  held: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Observed on-chain, not yet final' })
  pending: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'available + held + pending, WITHIN this one account and asset — therefore within this ' +
      'one chain. Not a cross-chain sum, and there must never be one.',
  })
  total: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Deposit intents still `CREATED`/`SETTLING` — money the agent has started sending but ' +
      'that has not yet been observed on chain. Distinct from `pending`, which is money that ' +
      'has been observed but is not yet final.',
  })
  pendingDeposits: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      '`escrow_ata.amount`, read straight off the chain (cached for 10s). `null` ' +
      'when the chain could not be read within the staleness ceiling, or when this account ' +
      'has no escrow yet — never zero, which would be indistinguishable from an empty escrow.',
  })
  chainBalance: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      '`chainBalance` minus every open ledger hold against this account and asset, ' +
      'floored at zero. `null` under the same conditions as `chainBalance`. This is what ' +
      "`EscrowSpendGateService.assertAffordable` compares a rail-B call's price against.",
  })
  spendable: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description:
      'What `POST /withdrawals` will actually move. With per-buyer escrows this is ' +
      '`chainBalance`, not `available` — `withdraw()` pays `min(requested, escrow_ata.amount)`, ' +
      'so the chain figure is the one the withdrawal actually respects. `null` under the same ' +
      'conditions as `chainBalance`. Before per-buyer escrows this equalled `available`; the ' +
      'schema still has no column for a promotional or card-restricted sub-balance, so nothing ' +
      'narrower is subtracted.',
  })
  withdrawable: MoneyDto | null;

  @ApiProperty({
    description:
      'Whether the chain was read for THIS row. False means `chainBalance`, `spendable` and ' +
      '`withdrawable` are `null` because they are **unknown** — not zero, and not "no escrow ' +
      'yet", which is what the same three nulls mean when this is true. Rendering an unknown ' +
      'as `$0.00` is the one wrong answer that actually misleads, and before this flag the ' +
      'wire could not tell the two apart. The row is per `(account, asset)`, so one unreadable ' +
      'escrow marks one row and never the list. Same idiom, same word, as the ' +
      "provider capital screen's `chainReadable`.",
  })
  chainReadable: boolean;

  @ApiProperty({
    description:
      'Whether this platform has asset metadata (symbol, peg) registered for `asset`. **False ' +
      'does not make this row less real**: `available`, `held`, `pending`, `total` and ' +
      "`pendingDeposits` are ledger facts quoted at the ledger's own `decimals` and are " +
      'reported in full. It means only that nothing here can name the token — a balance in a ' +
      'retired or de-listed mint. Such a row used to make the WHOLE response ' +
      '`400 CHAIN_ASSET_UNKNOWN`, so an organization with one historical row in a retired ' +
      'token saw none of its balances. Balances are a list, and a row that ' +
      'cannot be described is still a row that must be listed, because money that vanishes ' +
      'from a screen is worse than money labelled unknown.',
  })
  assetKnown: boolean;
}

export class WithheldBucketDto {
  @ApiProperty({ enum: WithheldBucket })
  bucket: WithheldBucket;

  @ApiProperty({
    description: 'Rendered identically on every surface — never re-worded per screen',
  })
  label: string;

  @ApiProperty({ description: 'Calls in this bucket. `withheld` is never a bare amount' })
  calls: number;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;
}

export class WithheldTotalDto {
  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty({ description: 'Calls across both buckets' })
  calls: number;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ type: [WithheldBucketDto], description: 'Always both buckets, zero-filled' })
  buckets: WithheldBucketDto[];
}

/**
 * The reconciliation `domain/withheld.ts` defines, on the wire: `withheld` is
 * checkable, not just claimed. `ok` is false exactly when `difference !== '0'`.
 */
export class WithheldReconciliationDto {
  @ApiProperty({ type: WithheldTotalDto, description: 'The intent side: Σ listed price' })
  withheld: WithheldTotalDto;

  @ApiProperty({ type: MoneyDto, description: 'The ledger side: Σ HOLD_RELEASE' })
  holdReleaseTotal: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description: 'Real HOLD_RELEASEs belonging to no withheld intent',
  })
  orphanedReleases: MoneyDto;

  @ApiProperty({ type: [String], description: 'At most the first 100; see orphanedHoldCount' })
  orphanedHoldIds: string[];

  @ApiProperty({ description: 'Every orphaned release, listed or not' })
  orphanedHoldCount: number;

  @ApiProperty({
    type: MoneyDto,
    description: 'Remainders returned on committed holds when a call was charged below its hold',
  })
  settlementRemainders: MoneyDto;

  @ApiProperty({
    description: 'holdReleaseTotal == withheld + settlementRemainders + orphanedReleases',
  })
  ok: boolean;

  @ApiProperty({ description: 'Signed atomic units. "0" when `ok`' })
  difference: string;
}

export class GetBalancesResponseDto {
  @ApiProperty({ type: [AccountBalanceDto] })
  balances: AccountBalanceDto[];

  @ApiProperty({
    type: [WithheldReconciliationDto],
    description:
      'One entry per asset that has ever had a balance in this organization — including an ' +
      'asset with `assetKnown: false`, which is reconciled off the ledger rows themselves and ' +
      'is therefore no less checkable than any other.',
  })
  withheld: WithheldReconciliationDto[];
}
