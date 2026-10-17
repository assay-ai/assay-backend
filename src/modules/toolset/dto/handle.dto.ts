import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class ClaimHandleBodyDto {
  @ApiProperty({
    example: 'acme',
    description:
      'Your public name: 3–24 characters, lowercase letters, digits and "-", starting with a ' +
      'letter. Free to change until your first shared tool set.',
  })
  @IsString()
  @MaxLength(25)
  handle: string;
}

export class OrgHandleDto {
  @ApiProperty({ nullable: true })
  handle: string | null;

  @ApiProperty({ nullable: true, enum: ['ACTIVE', 'FROZEN'] })
  status: string | null;

  @ApiProperty({ nullable: true, description: 'Set by the first shared tool set' })
  lockedAt: string | null;

  @ApiProperty({ description: 'It can be claimed or changed here (not locked or frozen)' })
  canChange: boolean;
}
