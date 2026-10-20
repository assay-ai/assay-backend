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
    description: "The agent's label, as its owner named it; for display only.",
  })
  agentLabel: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'CAIP-10 of the bound delegate key, or null when none is bound.',
  })
  delegate: string | null;

  @ApiPropertyOptional({ nullable: true })
  boundAt: string | null;
}

/** Where the bound delegate key stands on chain (spec §7.10 item 1, R-PAY-3). */
export enum PaidCallsStatus {
  /** The key is bound here, but the payer has no standing authorisation of it on chain. */
  NONE = 'NONE',
  ACTIVE = 'ACTIVE',
  /** Past `validUntil`; renewable on the enable-paid page. */
  EXPIRED = 'EXPIRED',
  /**
   * Reserved by the spec; not emitted. A revoked key leaves the escrow's
   * `delegatesOf`, through which the status is read, so it reads as `NONE` —
   * and the user's next step (run enable-paid) is the same for both.
   */
  REVOKED = 'REVOKED',
}

/** The bound delegate's on-chain authorisation: public chain data, for UX only. */
export class PaidCallsDto {
  @ApiProperty({
    enum: PaidCallsStatus,
    description:
      '`NONE` when the bound key has no standing authorisation on chain — never authorised, ' +
      'or revoked: a revoked key reads as `NONE`, and `REVOKED` is not emitted today.',
  })
  status: PaidCallsStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units of the escrow asset: the most one voucher may move. Null on NONE.',
    example: '500000',
  })
  maxVoucherAmount: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units: the most the key may sign for in one window. Null on NONE.',
    example: '5000000',
  })
  maxPerWindow: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Atomic units: what the key signed in the current window, decayed to now.',
    example: '0',
  })
  spentInWindow: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601. The authorisation lapses after this instant. Null on NONE.',
  })
  validUntil: string | null;
}

/** `GET /agents/me/delegate` */
export class AgentDelegateStatusDto extends AgentDelegateBindingDto {
  @ApiPropertyOptional({
    type: PaidCallsDto,
    nullable: true,
    description:
      "The bound delegate key's on-chain authorisation, read from the chain; null when no " +
      'delegate is bound, or when the chain could not be read (then `paidCallsUnknown` is ' +
      'true). The local proxy uses it for display only: its guards read the chain.',
  })
  paidCalls: PaidCallsDto | null;

  @ApiProperty({
    description:
      'True when a delegate is bound but the chain read failed: `paidCalls` is null because ' +
      'its standing is unknown, not because there is none. The stored binding is still returned.',
  })
  paidCallsUnknown: boolean;
}
