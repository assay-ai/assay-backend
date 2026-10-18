import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { ListQueryDto } from '@shared/api';

import { ReviewDisplayState, ReviewKind, ReviewStatus } from '../domain/review';

const CATEGORY_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * What a provider writes for one version of its own contract (design spec
 * §7.6): the summary an agent reads in `tools/list`, the full description
 * `get_tool` returns, both schemas, the optional fields, examples, and the
 * verification rules it declares. Everything here reaches a model, so all
 * of it goes through the schema screen at the publish gate.
 */
export class ProviderToolContractBodyDto {
  @ApiProperty({
    maxLength: 200,
    description: 'One line of plain text; the only text in tools/list',
  })
  @IsString()
  @MaxLength(200)
  summary: string;

  @ApiProperty({ maxLength: 8000, description: 'Full documentation, returned by get_tool' })
  @IsString()
  @MaxLength(8000)
  description: string;

  @ApiProperty({ type: Object, description: 'JSON Schema, type "object"; at most 16 KB' })
  @IsObject()
  inputSchema: Record<string, unknown>;

  @ApiProperty({
    type: Object,
    description: 'JSON Schema, type "object"; every property required or listed optional',
  })
  @IsObject()
  outputSchema: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], description: 'Inputs a call may leave out' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  optionalInputFields?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Outputs a call may not return' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  optionalOutputFields?: string[];

  @ApiPropertyOptional({
    type: [Object],
    description: '`[{ title?, arguments, result? }]`, at most 10, each at most 2 KB',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  examples?: Record<string, unknown>[];

  @ApiPropertyOptional({
    type: [Object],
    description:
      'Verification rules in the existing dialect: MIN_ARRAY_LENGTH, REQUIRED_FIELDS, ' +
      'FRESHNESS, VALUE_RANGE, VALID_URL, NO_DUPLICATES. Judged on every call in shadow.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  rules?: Record<string, unknown>[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changelog?: string;

  @ApiPropertyOptional({
    description:
      'Draft a change to an older major: the newest version of that major. Default: the newest version.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  baseVersion?: number;
}

export class CreateProviderToolBodyDto extends ProviderToolContractBodyDto {
  @ApiProperty({
    example: 'search_posts',
    description:
      'The {tool} half of `{handle}__{tool}`: `^[a-z][a-z0-9_]{1,39}$`, no "__". The full name is at most 48 characters.',
  })
  @IsString()
  @MaxLength(40)
  name: string;

  @ApiProperty({ example: 'social' })
  @Matches(CATEGORY_RE)
  category: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(TAG_RE, { each: true })
  tags?: string[];
}

export class UpdateProviderToolBodyDto {
  @ApiPropertyOptional({ example: 'social' })
  @IsOptional()
  @Matches(CATEGORY_RE)
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(TAG_RE, { each: true })
  tags?: string[];
}

export class ShareProviderToolBodyDto {
  @ApiProperty({
    enum: ['UNLISTED'],
    description:
      'UNLISTED: "Anyone with the link" — reachable through your own link-only tool sets. ' +
      'LISTED goes through review: POST …/review.',
  })
  @IsIn(['UNLISTED'])
  visibility: 'UNLISTED';
}

export class DeprecateProviderToolMajorBodyDto {
  @ApiProperty({ format: 'date-time', description: 'At least 90 days from now (UTC)' })
  @IsISO8601({ strict: true })
  sunsetAt: string;
}

export class SetReplacementBodyDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'A LISTED standard tool, or null to clear',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  replacementToolId: string | null;
}

export class ProviderToolIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class ProviderToolVersionParamDto extends ProviderToolIdParamDto {
  @ApiProperty()
  @Matches(/^[1-9][0-9]{0,8}$/)
  version: string;
}

export class InvitationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  standardToolId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceToolId: string;
}

export class ListProviderToolsQueryDto extends ListQueryDto {}

// ── Responses ────────────────────────────────────────────────────────────

export class ProviderToolReviewDto {
  @ApiProperty({ enum: ReviewStatus })
  status: ReviewStatus;

  @ApiProperty({ enum: ReviewDisplayState })
  state: ReviewDisplayState;

  @ApiProperty({ example: 'Changes in review; v1.0.0 still serving' })
  label: string;

  @ApiProperty({ enum: ReviewKind, nullable: true, description: 'Of the pending or last review' })
  kind: ReviewKind | null;

  @ApiProperty({ nullable: true, description: 'The version under review, or last decided' })
  reviewVersion: number | null;

  @ApiProperty({ nullable: true })
  reviewSemver: string | null;

  @ApiProperty({ nullable: true, description: 'Shown when REJECTED: why, and what to fix' })
  note: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  submittedAt: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  decidedAt: Date | null;

  @ApiProperty({ nullable: true, description: 'The newest approved version' })
  approvedVersion: number | null;

  @ApiProperty({ nullable: true })
  approvedSemver: string | null;
}

export class ProviderToolSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'acme__search_posts', description: 'What an agent calls' })
  name: string;

  @ApiProperty({ example: 'search_posts' })
  localName: string;

  @ApiProperty({ example: 'acme' })
  handle: string;

  @ApiProperty({
    example: 'mcp__acme__acme__search_posts',
    description: 'The name as a model sees it behind a client prefix, for a 4-letter server name',
  })
  preview: string;

  @ApiProperty()
  category: string;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ enum: ['PRIVATE', 'UNLISTED', 'LISTED'] })
  visibility: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED', 'REMOVED'] })
  status: string;

  @ApiProperty({ nullable: true, example: '1.2.0' })
  currentSemver: string | null;

  @ApiProperty({ nullable: true })
  currentVersion: number | null;

  @ApiProperty()
  hasDraft: boolean;

  @ApiProperty({ description: 'The "Not reviewed" badge: no version approved yet' })
  notReviewed: boolean;

  @ApiProperty({ type: ProviderToolReviewDto })
  review: ProviderToolReviewDto;

  @ApiProperty({ nullable: true, format: 'uuid' })
  replacementToolId: string | null;

  @ApiProperty({ nullable: true })
  replacementName: string | null;

  @ApiProperty({ nullable: true, format: 'date-time', description: 'Set when taken down' })
  removedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class ScreenFindingDto {
  @ApiProperty({
    enum: [
      'CONTRACT_INVALID',
      'TEXT_TOO_LONG',
      'INSTRUCTION_PATTERN',
      'HIDDEN_CHARACTERS',
      'SECRET_INPUT',
      'REMOTE_REF',
      'SCHEMA_TOO_COMPLEX',
      'EXAMPLE_MISMATCH',
      'RULES_INVALID',
    ],
  })
  code: string;

  @ApiProperty({ example: 'inputSchema/properties/q/description' })
  location: string;

  @ApiProperty()
  detail: string;
}

export class ProviderToolVersionDto {
  @ApiProperty()
  version: number;

  @ApiProperty({ example: '1.0.0' })
  semver: string;

  @ApiProperty()
  major: number;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED'] })
  status: string;

  @ApiProperty()
  summary: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ type: Object })
  inputSchema: unknown;

  @ApiProperty({ type: Object })
  outputSchema: unknown;

  @ApiProperty({ type: [String] })
  optionalInputFields: string[];

  @ApiProperty({ type: [String] })
  optionalOutputFields: string[];

  @ApiProperty({ type: [Object] })
  examples: unknown[];

  @ApiProperty({ type: [Object] })
  rules: unknown[];

  @ApiProperty({
    enum: ['UNVERIFIED', 'VERIFIED'],
    description: 'Set by the reviewer; never GUARANTEED',
  })
  tier: string;

  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  sunsetAt: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  publishedAt: Date | null;

  @ApiProperty()
  isCurrent: boolean;

  @ApiProperty({
    description: 'An operator approved it (LISTED surfaces serve approved versions only)',
  })
  approved: boolean;
}

export class ProviderToolDraftDto extends ProviderToolVersionDto {
  @ApiProperty({ nullable: true })
  baseSemver: string | null;

  @ApiProperty({ enum: ['MAJOR', 'MINOR', 'PATCH'], nullable: true })
  bump: string | null;

  @ApiProperty({ type: [Object], description: 'The schema diff against the base version' })
  changes: unknown[];

  @ApiProperty({ type: [String], description: 'What stops it from being published at all' })
  problems: string[];

  @ApiProperty({
    type: [ScreenFindingDto],
    description: 'What the publish gate’s schema screen would refuse',
  })
  screen: ScreenFindingDto[];

  @ApiProperty({ description: 'Frozen: a review of this draft is pending' })
  inReview: boolean;
}

export class ProviderToolBindingRefDto {
  @ApiProperty({ format: 'uuid' })
  bindingId: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'SUSPENDED'] })
  status: string;

  @ApiProperty()
  mappingVersion: number;

  @ApiProperty({ nullable: true })
  publishedVersion: number | null;
}

export class ProviderToolMcpUrlsDto {
  @ApiProperty({
    nullable: true,
    example: 'https://mcp.assay.ai/@acme',
    description: 'Serves every LISTED tool of your public name; null until one is LISTED',
  })
  handle: string | null;
}

export class ProviderToolQualityDto {
  @ApiProperty({ example: 30 })
  windowDays: number;

  @ApiProperty({ description: 'Paid calls resolved in the window' })
  calls: number;

  @ApiProperty({ description: 'Answers that broke the output schema (refunded)' })
  schemaFailures: number;

  @ApiProperty({ nullable: true })
  schemaPassRate: number | null;

  @ApiProperty({ description: 'Calls the declared rules judged, in shadow' })
  rulesJudged: number;

  @ApiProperty()
  rulesFailed: number;

  @ApiProperty({ nullable: true })
  rulesPassRate: number | null;

  @ApiProperty({ description: 'Verified calls in closed SLA windows' })
  slaVerifiedCalls: number;

  @ApiProperty()
  slaFailedCalls: number;

  @ApiProperty({ nullable: true })
  slaFailureRate: number | null;

  @ApiProperty({ nullable: true, description: 'Null until buyer disputes are measured' })
  disputesDecided: number | null;

  @ApiProperty({ nullable: true })
  disputesUpheld: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Share of calls with no schema failure, no failed declared rule and no upheld dispute; ' +
      'null with no calls. No cross-provider check exists for a provider tool.',
  })
  quality: number | null;

  @ApiProperty({ enum: ['UNVERIFIED', 'VERIFIED'], description: 'Never GUARANTEED' })
  maxTier: string;
}

export class ProviderToolDto extends ProviderToolSummaryDto {
  @ApiProperty({ type: [ProviderToolVersionDto], description: 'Published versions, newest first' })
  versions: ProviderToolVersionDto[];

  @ApiProperty({ type: ProviderToolDraftDto, nullable: true })
  draft: ProviderToolDraftDto | null;

  @ApiProperty({
    type: ProviderToolBindingRefDto,
    nullable: true,
    description:
      'Your binding: the only implementation. Create it with POST /providers/me/tool-bindings',
  })
  binding: ProviderToolBindingRefDto | null;

  @ApiProperty({ type: ProviderToolMcpUrlsDto })
  mcpUrls: ProviderToolMcpUrlsDto;

  @ApiProperty({ type: ProviderToolQualityDto })
  quality: ProviderToolQualityDto;
}

export class ProviderToolGateRequirementDto {
  @ApiProperty({
    enum: [
      'PROVIDER_ACTIVE',
      'HANDLE_ACTIVE',
      'PUBLISHED_VERSION',
      'BINDING_PUBLISHED',
      'TESTER_RUN',
      'TESTER_PASSED',
      'PAYOUT_ACCOUNT',
      'STAKE_AT_MINIMUM_ON_EVERY_CHAIN',
      'SCHEMA_SCREEN',
      'EXAMPLES_MATCH_SCHEMA',
    ],
  })
  requirement: string;

  @ApiProperty()
  met: boolean;

  @ApiProperty({ nullable: true })
  code: string | null;

  @ApiProperty({ nullable: true })
  detail: string | null;
}

export class ProviderToolScreenDto {
  @ApiProperty()
  version: number;

  @ApiProperty()
  semver: string;

  @ApiProperty({ type: [ScreenFindingDto] })
  findings: ScreenFindingDto[];
}

export class ProviderToolGateDto {
  @ApiProperty()
  passed: boolean;

  @ApiProperty({ type: [ProviderToolGateRequirementDto], description: 'Stable order' })
  requirements: ProviderToolGateRequirementDto[];

  @ApiProperty({ type: [ProviderToolScreenDto], description: 'One per screened version' })
  screen: ProviderToolScreenDto[];
}

export class BindingPrefillDto {
  @ApiProperty()
  endpoint: string;

  @ApiProperty({ type: Object })
  requestMapping: unknown;

  @ApiProperty({ type: Object })
  responseMapping: unknown;

  @ApiProperty()
  pricingMode: string;

  @ApiProperty()
  priceAmount: string;

  @ApiProperty()
  assetId: string;

  @ApiProperty({ type: [String] })
  settlementChains: string[];

  @ApiProperty()
  timeoutMs: number;
}

export class PromotionInvitationDto {
  @ApiProperty({ format: 'uuid' })
  standardToolId: string;

  @ApiProperty({ example: 'search_posts' })
  standardToolName: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED', 'REMOVED'] })
  standardToolStatus: string;

  @ApiProperty({ format: 'uuid', description: 'Your provider tool it was drafted from or matched' })
  sourceToolId: string;

  @ApiProperty()
  sourceToolName: string;

  @ApiProperty({ format: 'date-time' })
  invitedAt: Date;

  @ApiProperty({ description: 'You already have a binding for the standard tool' })
  bound: boolean;

  @ApiProperty({
    type: BindingPrefillDto,
    nullable: true,
    description:
      'The test console prefill: your provider tool binding’s endpoint, mappings and price, to ' +
      'start a binding of the standard tool from (POST /providers/me/tool-bindings)',
  })
  prefill: BindingPrefillDto | null;
}

export class PromotionInvitationListDto {
  @ApiProperty({ type: [PromotionInvitationDto] })
  invitations: PromotionInvitationDto[];
}
