import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** `POST /agents/me/delegate/challenge` */
export class CreateDelegateChallengeBodyDto {
  @ApiProperty({
    description:
      "The delegate key's 0x address — the key this agent holds and will sign vouchers with.",
    example: '0x5555555555555555555555555555555555555555',
  })
  @IsString()
  @Matches(ADDRESS, { message: 'delegate must be a 20-byte 0x address' })
  delegate: string;
}

export class DelegateChallengeResponseDto {
  @ApiProperty({ description: 'Single use. Present it back with the signature.' })
  challengeId: string;

  @ApiProperty({ description: 'CAIP-10 of the delegate the proof is for.' })
  delegate: string;

  @ApiProperty({ description: 'ISO-8601. The challenge is refused after this instant.' })
  expiresAt: string;

  @ApiProperty({
    description:
      'The EIP-712 request the DELEGATE key signs (`DelegateBinding`). No escrow door accepts ' +
      'this type, so the proof can never authorise a payment.',
  })
  typedData: Record<string, unknown>;
}

/** `POST /agents/me/delegate` */
export class BindDelegateBodyDto {
  @ApiProperty()
  @IsUUID()
  challengeId: string;

  @ApiProperty({ description: 'The delegate key’s EIP-712 signature: `r || s || v`, 65 bytes.' })
  @IsString()
  @Matches(SIGNATURE, { message: 'signature must be 65 bytes of hex (r || s || v)' })
  signature: string;
}

export class AgentDelegateBindingDto {
  @ApiProperty({ description: 'The agent credential this binding belongs to.' })
  credentialId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'CAIP-10 of the bound delegate key, or null when none is bound.',
  })
  delegate: string | null;

  @ApiPropertyOptional({ nullable: true })
  boundAt: string | null;
}
