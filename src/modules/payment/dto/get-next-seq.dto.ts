import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /escrow/next-seq` — the sequence number the client's next
 * voucher must carry, plus the addresses that voucher has to name.
 */
export class GetNextSeqResponseDto {
  /**
   * A `u64`, and JSON has no such number — so it is a decimal string, the same
   * treatment `SolanaUnsignedTransactionDto.lastValidBlockHeight` already gets.
   * Parsing it into a JavaScript `number` rounds above 2^53, and a rounded seq
   * either repeats one the chain has redeemed (dead on arrival,
   * `VoucherSeqNotIncreasing`) or skips ahead of one still in flight, killing
   * that one instead.
   */
  @ApiProperty({ example: '42', description: 'The voucher `seq` to sign. Decimal u64.' })
  seq: string;

  @ApiProperty({
    example: '9xGuGHFYb4KysmNbZpvHEUJYwxC8zwFhP1GT2apAyCjj',
    description:
      "Put this in the voucher's `pay_to`; the program compares it against the escrow it " +
      'derives from your own pubkey.',
  })
  payTo: string;

  @ApiProperty({
    example: 'AmZv6ZumyEsHtD29eZ6gzNHB7X7ai3eyuy5pRXqo19Df',
    description: 'The escrow ATA the balance actually sits in.',
  })
  escrowTokenAccount: string;
}
