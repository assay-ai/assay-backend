import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { ReviewReasonCode } from '../domain/review';

export class PromotionCandidateDto {
  @ApiProperty({ format: 'uuid' })
  toolId: string;

  @ApiProperty({ example: 'acme__search_posts' })
  name: string;

  @ApiProperty({ example: 'acme' })
  handle: string;

  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ enum: ['UNLISTED', 'LISTED'] })
  visibility: string;

  @ApiProperty({ example: '1.0.0' })
  semver: string;

  @ApiProperty()
  summary: string;

  @ApiProperty({ type: [String] })
  inputFields: string[];

  @ApiProperty({ type: [String] })
  outputFields: string[];

  @ApiProperty({ nullable: true, format: 'uuid', description: 'Already points to a standard tool' })
  replacementToolId: string | null;
}

export class SimilarityScoreDto {
  @ApiProperty({ description: '0.4 × name + 0.3 × inputs + 0.3 × outputs (Jaccard)' })
  score: number;

  @ApiProperty()
  name: number;

  @ApiProperty()
  inputs: number;

  @ApiProperty()
  outputs: number;
}

export class SimilarToolDto extends PromotionCandidateDto {
  @ApiProperty({ type: SimilarityScoreDto })
  similarity: SimilarityScoreDto;
}

export class PromotionGroupDto {
  @ApiProperty()
  category: string;

  @ApiProperty({
    type: [PromotionCandidateDto],
    description: 'Two or more tools doing the same job',
  })
  tools: PromotionCandidateDto[];
}

export class PromotionGroupListDto {
  @ApiProperty({ type: [PromotionGroupDto] })
  groups: PromotionGroupDto[];
}

export class SimilarToolListDto {
  @ApiProperty({ type: [SimilarToolDto] })
  tools: SimilarToolDto[];
}

export class PromotionInviteDto {
  @ApiProperty({ format: 'uuid' })
  standardToolId: string;

  @ApiProperty({ format: 'uuid' })
  sourceToolId: string;

  @ApiProperty()
  sourceToolName: string;

  @ApiProperty({ format: 'uuid', description: 'The provider invited' })
  organizationId: string;

  @ApiProperty({ format: 'date-time' })
  invitedAt: Date;

  @ApiProperty({ nullable: true, format: 'date-time' })
  dismissedAt: Date | null;

  @ApiProperty({ description: 'The provider has a binding for the standard tool' })
  bound: boolean;
}

export class PromotionInviteListDto {
  @ApiProperty({ type: [PromotionInviteDto] })
  invites: PromotionInviteDto[];
}

export class DraftPromotionBodyDto {
  @ApiProperty({ format: 'uuid', description: 'The provider tool the contract is drafted from' })
  @IsUUID()
  sourceToolId: string;

  @ApiProperty({
    example: 'search_posts',
    description: 'The standard tool’s name: snake_case, no "__"',
  })
  @Matches(/^[a-z][a-z0-9_]{1,47}$/)
  name: string;

  @ApiPropertyOptional({ description: 'Default: the source tool’s category' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]{1,63}$/)
  category?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Provider tools to invite besides the source (typically the similar ones)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  inviteToolIds?: string[];
}

export class InvitePromotionBodyDto {
  @ApiProperty({ type: [String], description: 'Provider tools whose providers are invited' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  toolIds: string[];
}

export class ReviewDecisionBodyDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @Matches(/^(APPROVE|REJECT)$/)
  decision: 'APPROVE' | 'REJECT';

  @ApiProperty({
    description: 'The `contentHash` of `GET /operator/reviews/:id`: what you read',
    example: 'f3b1…',
  })
  @Matches(/^[0-9a-f]{64}$/)
  contentHash: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Required to reject: the reason the provider sees, and what to fix',
  })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;

  @ApiPropertyOptional({ enum: ['UNVERIFIED', 'VERIFIED'], description: 'Never GUARANTEED (§7.6)' })
  @IsOptional()
  @Matches(/^(UNVERIFIED|VERIFIED)$/)
  tier?: 'UNVERIFIED' | 'VERIFIED';

  @ApiPropertyOptional({
    enum: ReviewReasonCode,
    description:
      'APPROVE: APPROVED (the default). REJECT: required, the §7.6 checklist item the tool ' +
      'fails: IMPERSONATION, MODEL_INSTRUCTIONS, SECRET_INPUTS, EXAMPLES_MISMATCH, ' +
      'PRICING_UNCLEAR',
  })
  @IsOptional()
  @IsEnum(ReviewReasonCode)
  reasonCode?: ReviewReasonCode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

export class ToolIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class StandardToolParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  standardToolId: string;
}
