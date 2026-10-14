import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength } from 'class-validator';

import { OperatorDto } from './operator-console.dto';

export class OperatorChallengeBodyDto {
  @ApiProperty({ description: 'The EVM address that will sign, any case', example: '0x…' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'address must be a 0x-prefixed 20-byte hex address' })
  address: string;
}

export class OperatorChallengeDto {
  @ApiProperty({ description: 'The EIP-4361 message to sign with personal_sign, verbatim' })
  message: string;

  @ApiProperty()
  nonce: string;

  @ApiProperty({ description: 'When the message stops being accepted (five minutes)' })
  expiresAt: Date;
}

export class OperatorVerifyBodyDto {
  @ApiProperty({ description: 'The message from the challenge, unchanged' })
  @IsString()
  @MaxLength(2048)
  message: string;

  @ApiProperty({ description: 'The personal_sign signature, 0x hex' })
  @IsString()
  @Length(4, 1024)
  signature: string;
}

export class OperatorSignInDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`. Shown once.' })
  token: string;

  @ApiProperty()
  expiresAt: Date;

  @ApiProperty({ type: OperatorDto })
  operator: OperatorDto;
}
