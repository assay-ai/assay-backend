import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@shared/api/dto/list-query.dto';

import { OPERATOR_CASE_STATUSES, OperatorCaseStatus } from '../domain/operator-case-status';

/**
 * `GET /operator/cases`.
 *
 * Its own class rather than `ListQueryDto`: this list has one fixed order
 * (next deadline, then amount — see the repository), so `sort`, `order`,
 * `from`, `to` and `search` are not accepted at all rather than accepted and
 * ignored. With `forbidNonWhitelisted`, an unknown parameter is a 400.
 */
export class ListOperatorCasesQueryDto {
  @ApiPropertyOptional({
    description:
      'Comma-separated statuses to include, e.g. `CHAIN_DISPUTED,CANCEL_REQUESTED`. Omit for all.',
    enum: OperatorCaseStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(OPERATOR_CASE_STATUSES.length)
  @IsIn(OPERATOR_CASE_STATUSES, { each: true })
  status?: OperatorCaseStatus[];

  @ApiPropertyOptional({ description: 'Only this provider’s penalties' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    description: 'Opaque cursor from the previous page’s `pageInfo.nextCursor`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === '' ? DEFAULT_PAGE_SIZE : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;
}

/**
 * One row of the Penalties list.
 *
 * An allowlist, built field by field in `OperatorCaseListService` — never an
 * entity spread. What it deliberately leaves out: the beneficiary account,
 * chain request id and transaction signatures, the operators who decided, the
 * root-cause key, chain errors, and anything of the binding but its tool's
 * name (its endpoint URL and mappings are the provider's private
 * configuration). The full brief stays behind `GET /operator/cases/:id`.
 */
export class OperatorCaseListRowDto {
  @ApiProperty()
  proposalId: string;

  @ApiProperty()
  providerId: string;

  @ApiProperty({ description: 'The provider’s legal name, or its id when the row is gone' })
  providerName: string;

  @ApiPropertyOptional({ nullable: true, description: 'The catalogue tool’s name' })
  toolName: string | null;

  @ApiProperty({ type: MoneyDto, description: 'The penalty as proposed' })
  amount: MoneyDto;

  @ApiProperty({ description: 'CAIP-2 chain the penalty stands on' })
  chainId: string;

  @ApiProperty({ enum: OperatorCaseStatus })
  status: OperatorCaseStatus;

  @ApiProperty()
  proposedAt: Date;

  @ApiPropertyOptional({ nullable: true, description: 'When the provider disputed it on chain' })
  disputedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The next instant the penalty moves on its own: a dispute lapses, a cancel must be ' +
      'signed by, or it becomes executable. Null once closed.',
  })
  nextDeadline: Date | null;
}
