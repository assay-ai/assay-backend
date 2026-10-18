import { ApiProperty } from '@nestjs/swagger';

import { ReviewKind, ReviewStatus } from '../domain/review';
import {
  ProviderToolDto,
  ProviderToolGateDto,
  ProviderToolVersionDto,
  ScreenFindingDto,
} from './provider-tools.dto';

export class ReviewQueueItemDto {
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

  @ApiProperty({ enum: ['PRIVATE', 'UNLISTED', 'LISTED'] })
  visibility: string;

  @ApiProperty({ enum: ReviewStatus })
  status: ReviewStatus;

  @ApiProperty({
    enum: ReviewKind,
    description: 'FIRST: never approved. CHANGE: a listed tool’s new version',
  })
  kind: ReviewKind;

  @ApiProperty({ nullable: true })
  reviewVersion: number | null;

  @ApiProperty({ nullable: true })
  reviewSemver: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  submittedAt: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  decidedAt: Date | null;
}

export class ReviewChecklistItemDto {
  @ApiProperty({
    enum: [
      'NO_IMPERSONATION',
      'NO_MODEL_INSTRUCTIONS',
      'NO_SECRET_INPUTS',
      'EXAMPLES_MATCH_SCHEMA',
      'PRICING_CLEAR',
    ],
  })
  item: string;

  @ApiProperty({
    enum: ['PASS', 'FAIL', 'CHECK'],
    description: 'PASS/FAIL: the screen decided. CHECK: the operator decides.',
  })
  automated: 'PASS' | 'FAIL' | 'CHECK';

  @ApiProperty()
  detail: string;

  @ApiProperty({ type: [ScreenFindingDto] })
  findings: ScreenFindingDto[];
}

export class ReviewDetailDto {
  @ApiProperty({ type: ProviderToolDto })
  tool: ProviderToolDto;

  @ApiProperty({ enum: ReviewKind })
  kind: ReviewKind;

  @ApiProperty({ description: 'A decision can be made: the review is PENDING' })
  pending: boolean;

  @ApiProperty({
    description:
      'SHA-256 of the content under review now. Send it back with the decision; a decision for ' +
      'another hash is refused (TOOL_REVIEW_STALE).',
  })
  contentHash: string;

  @ApiProperty({
    type: [ProviderToolVersionDto],
    description: 'FIRST: every version the tool serves. CHANGE: the draft submitted.',
  })
  covered: ProviderToolVersionDto[];

  @ApiProperty({
    type: [Object],
    description: 'CHANGE: the schema diff against the approved version',
  })
  changes: unknown[];

  @ApiProperty({ type: [ReviewChecklistItemDto], description: '§7.6 review checklist' })
  checklist: ReviewChecklistItemDto[];

  @ApiProperty({ type: ProviderToolGateDto, description: 'The publish gate as it stands now' })
  gate: ProviderToolGateDto;
}
