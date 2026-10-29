import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { NotChargedReason } from '@modules/catalogue/domain/not-charged-reason';

import { StageStatus, VerificationStage } from '../domain/stage';

/**
 * The wire shape of `GET /public/receipts/:id`: **the complete list of what
 * the public may see of one call**. It is written on its own, not derived from
 * `GetReceiptResponseDto` or an entity, so nothing is public unless it is named here.
 * `public-receipt.guard.ts` checks every response against this shape, and
 * `test/unit/.../public-receipt.test.ts` pins the key list.
 */
export const PUBLIC_RECEIPT_STATUSES = ['IN_PROGRESS', 'CHARGED', 'NOT_CHARGED', 'CLOSED'] as const;
export type PublicReceiptStatus = (typeof PUBLIC_RECEIPT_STATUSES)[number];

export class PublicReceiptMoneyDto {
  @ApiProperty({ description: 'Atomic units as a decimal integer string', example: '20000' })
  amount: string;

  @ApiProperty({ description: 'CAIP-19 asset id' })
  asset: string;

  @ApiProperty()
  decimals: number;
}

export class PublicReceiptNamedDto {
  @ApiProperty({ description: 'Catalogue id, for linking to the public catalogue' })
  id: string;

  @ApiProperty({ description: 'The listed name' })
  name: string;
}

export class PublicReceiptStageDto {
  @ApiProperty({ enum: VerificationStage })
  stage: VerificationStage;

  @ApiProperty({ enum: StageStatus })
  status: StageStatus;

  @ApiProperty({ description: 'Fixed label for the status, e.g. "passed"' })
  label: string;
}

export class PublicReceiptNotChargedDto {
  @ApiProperty({ enum: NotChargedReason })
  reason: NotChargedReason;

  @ApiProperty({ description: 'One fixed plain sentence per reason' })
  text: string;
}

export class PublicReceiptResponseDto {
  @ApiProperty({ enum: PUBLIC_RECEIPT_STATUSES })
  status: PublicReceiptStatus;

  @ApiPropertyOptional({
    type: PublicReceiptNamedDto,
    nullable: true,
    description: 'Null when the provider is not on the public provider list',
  })
  tool: PublicReceiptNamedDto | null;

  @ApiPropertyOptional({ type: PublicReceiptNamedDto, nullable: true })
  provider: PublicReceiptNamedDto | null;

  @ApiProperty({ type: PublicReceiptMoneyDto })
  listedPrice: PublicReceiptMoneyDto;

  @ApiProperty({ type: PublicReceiptMoneyDto, description: 'Zero unless the call was charged' })
  chargedPrice: PublicReceiptMoneyDto;

  @ApiPropertyOptional({ type: PublicReceiptNotChargedDto, nullable: true })
  notCharged: PublicReceiptNotChargedDto | null;

  @ApiProperty({ type: [PublicReceiptStageDto], description: 'Always the four pipeline stages' })
  stages: PublicReceiptStageDto[];

  @ApiPropertyOptional({ nullable: true, description: 'The published sampling sentence' })
  sampling: string | null;

  @ApiProperty({ description: 'UTC, rounded down to the minute' })
  createdAt: string;

  @ApiPropertyOptional({ nullable: true, description: 'UTC, rounded down to the minute' })
  settledAt: string | null;
}
