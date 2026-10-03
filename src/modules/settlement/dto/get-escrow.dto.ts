import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

/**
 * `GET /escrow` — everything a console needs to
 * render the buyer's escrow: balance, both brakes, the window meter and any
 * pending withdrawal as a server-supplied instant.
 *
 * **`chainReadable` is the difference between a zero and an unknown.** Every
 * chain-derived field here is nullable, and a `null` means two different
 * things depending on that flag: with `chainReadable: true` it is the chain's
 * own answer (no escrow at those seeds, no withdrawal standing); with
 * `chainReadable: false` it is *unknown*, and a console that renders it as
 * `0` is telling a buyer their escrow is empty on the strength of a read that
 * never happened. Same idiom, same word, as the provider capital screen's
 * `chainReadable`.
 */
export class GetEscrowResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Whether this buyer's escrow has ever been opened. Absent is not zero — a buyer with no " +
      'escrow needs one opened (a deposit does this); a buyer with an empty one needs money. ' +
      '`null` when `chainReadable` is false: "we could not look" is not "there is nothing there".',
  })
  exists: boolean | null;

  @ApiProperty({
    description:
      'False when the chain could not be read on this request, in which case every ' +
      'chain-derived field on this response is `null` because it is **unknown** — not zero, ' +
      'and not "no escrow yet". `account`, `escrowPda`, `escrowTokenAccount` and `nextSeq` are ' +
      'database facts and are unaffected. True with `exists: false` is the chain answering that ' +
      'there is no escrow at those seeds, which is a different thing and must render ' +
      'differently. The same `chainReadable: false` idiom the provider capital screen uses.',
  })
  chainReadable: boolean;

  @ApiProperty({ description: "This buyer's CAIP-10 account." })
  account: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Base58. Read from this platform's own mirror row, not from the chain, so it survives " +
      '`chainReadable: false`. `null` when no deposit has ever opened this escrow.',
  })
  escrowPda: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Base58. The ATA the balance actually sits in. A mirror-row fact like `escrowPda`, and ' +
      '`null` under the same condition.',
  })
  escrowTokenAccount: string | null;

  @ApiPropertyOptional({ type: MoneyDto, nullable: true, description: '`escrow_ata.amount`.' })
  balance: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Σ amount over every OPEN ledger hold against this escrow.',
  })
  openHolds: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: '`balance − openHolds`, floored at zero.',
  })
  spendable: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'What the buyer has asked to take out. `0` when no request stands.',
  })
  withdrawRequested: MoneyDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'ISO-8601. A SERVER-SUPPLIED INSTANT, never a delay — `null` when nothing is pending. ' +
      'Frozen by the program at request time; render a countdown against this and `serverTime`, ' +
      'never `now + withdrawDelaySeconds`.',
  })
  withdrawAvailableAt: string | null;

  @ApiProperty({
    description:
      "The server's own clock at the moment it answered, so a countdown does not inherit a skewed browser clock.",
  })
  serverTime: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'How long a NEW `request_withdraw` would wait, in seconds. Information about the next ' +
      'request, never the input to a countdown for one already standing. `null` only when the ' +
      'chain could not even say which delay applies — on both live chains this is a program ' +
      'constant, so an unreadable `Config` does not take it with it.',
  })
  withdrawDelaySeconds: number | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'The most any single voucher may take from this escrow. **`0` means refuse every ' +
      'redeem, not "unlimited"** — a buyer who wants no ceiling has `u64::MAX` here.',
  })
  maxVoucherAmount: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'The most that may be redeemed in a rolling window. Same "0 means refuse" rule.',
  })
  maxPerWindow: MoneyDto | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'How much of `maxPerWindow` has been spent in the current window.',
  })
  spentInWindow: MoneyDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601. When the current window started. `null` until the first redemption.',
  })
  windowStartedAt: string | null;

  @ApiProperty({
    description: 'The width of the rolling window, in seconds. Fixed on the program.',
  })
  windowSeconds: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'A decimal `u64` string. `BuyerEscrow.seq_high` — the highest sequence number ever ' +
      'redeemed. `0` means none; `null` means the chain could not be read, which is not `0`.',
  })
  seqHigh: string | null;

  @ApiProperty({
    description: 'A decimal `u64` string. The next voucher `seq` this platform would issue.',
  })
  nextSeq: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'ISO-8601. When this reading was taken from the chain. `null` when there was no reading ' +
      'to take (`chainReadable: false`).',
  })
  observedAt: string | null;
}
