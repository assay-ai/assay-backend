import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { ListQueryDto } from '@shared/api/dto/list-query.dto';

import { OperatorRole } from '../domain/override-register';
import { OperatorDto, ReasonCode, Trimmed, TrimmedOrAbsent } from './operator-console.dto';

const MINOR_UNITS = /^(0|[1-9][0-9]{0,77})$/;

export class OperatorDirectoryEntryDto extends OperatorDto {
  @ApiProperty()
  email: string;

  @ApiPropertyOptional({ nullable: true })
  lastSeenAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

export class ListOperatorsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'REMOVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'REMOVED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
}

/** `A-12`. Two-person: always answered 202 `{approvalId}`. */
export class AddOperatorBodyDto {
  @ApiProperty({ description: 'The EVM address the operator will sign in with' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, {
    message: 'walletAddress must be a 0x-prefixed 20-byte hex address',
  })
  walletAddress: string;

  @ApiProperty({ description: 'A short unique handle, e.g. `dan@`' })
  @Trimmed()
  @IsString()
  @Length(1, 256)
  subject: string;

  @ApiPropertyOptional({ description: 'Defaults to the subject' })
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @Length(1, 128)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(256)
  email?: string;

  @ApiProperty({ enum: OperatorRole, isArray: true })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(16)
  @IsEnum(OperatorRole, { each: true })
  roles: OperatorRole[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Per-action ceiling in minor units of the platform asset. Absent: 0. Null: unbounded.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(MINOR_UNITS)
  authorityLimitMinor?: string | null;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 10 })
  @Trimmed()
  @IsString()
  @Length(10, 2048)
  note: string;
}

/**
 * `A-13`. Either field may be left out to keep it. Lowering is applied at
 * once; adding a role or raising the limit is answered 202 `{approvalId}`.
 */
export class ChangeOperatorBodyDto {
  @ApiPropertyOptional({ enum: OperatorRole, isArray: true, description: 'The full new set' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(16)
  @IsEnum(OperatorRole, { each: true })
  roles?: OperatorRole[];

  @ApiPropertyOptional({ nullable: true, description: 'Minor units, or null for unbounded' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(MINOR_UNITS)
  authorityLimitMinor?: string | null;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 10 })
  @Trimmed()
  @IsString()
  @Length(10, 2048)
  note: string;
}

/** `A-14`. Single-person; takes effect at once. */
export class RemoveOperatorBodyDto {
  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 10 })
  @Trimmed()
  @IsString()
  @Length(10, 2048)
  note: string;
}
