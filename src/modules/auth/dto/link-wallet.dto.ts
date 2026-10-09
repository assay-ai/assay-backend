import { ApiProperty } from '@nestjs/swagger';

/**
 * `POST /api/v1/auth/wallet/link` — the answer, which is a *fact about our own
 * row*, not an echo of anything the caller sent.
 *
 * There is no request DTO on purpose. The obvious design has the browser post
 * the address it can see, and it is the wrong one: an address off the wire is
 * an address the caller chose, and `primary_account_id` is what a call is
 * charged to. So the request carries nothing — it is a *trigger*, and the
 * address written still comes from Privy's own user record, exactly as it does
 * on the login path.
 */
export class LinkWalletResponseDto {
  @ApiProperty({
    description: 'Whether this agent now has a CAIP-10 account to spend from.',
    example: true,
  })
  linked!: boolean;

  @ApiProperty({
    description: 'The linked CAIP-10 account, or null while none is linked.',
    nullable: true,
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:6dauQmUxQCWRyDtQyczEk4rkmtjHEdh9kP82x8B6zeD4',
  })
  account!: string | null;

  @ApiProperty({
    description: 'CAIP-2 chain the account settles on, or null while none is linked.',
    nullable: true,
    example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  })
  chainId!: string | null;
}
