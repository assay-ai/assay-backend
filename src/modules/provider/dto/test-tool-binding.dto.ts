import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, Min } from 'class-validator';

import {
  BindingTestLayer,
  BindingTestLayerStatus,
  BindingTestOutcome,
  BindingTestPolicySource,
  BindingTestWarningCode,
} from '../ports/binding-test.types';

/**
 * `POST /providers/me/tool-bindings/:id/test` — the mapping tester.
 *
 * The most important screen in the console, and the one this
 * endpoint feeds. The body is one thing: the arguments to call with.
 */
export class RunBindingTestBodyDto {
  @ApiProperty({
    description:
      'The tool arguments to call with. Validated against the tool’s inputSchema ' +
      'before anything is mapped, so a malformed sample is the caller’s error and ' +
      'never lands as the provider’s.',
    example: { query: 'container ships near Rotterdam', maxResults: 5 },
  })
  @IsObject()
  input: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 3,
    description:
      'The contract version (`tool_versions.version`) to test against, inside the ' +
      "binding's range. Defaults to the newest published version of the highest major " +
      'in the range. Publishing needs a green run per major.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  toolVersion?: number;
}

export class BindingTestLayerResultDto {
  @ApiProperty({ enum: BindingTestLayer })
  layer: BindingTestLayer;

  @ApiProperty({ enum: BindingTestLayerStatus })
  status: BindingTestLayerStatus;

  @ApiProperty({ nullable: true })
  code: string | null;

  @ApiProperty({ nullable: true })
  detail: string | null;

  @ApiProperty({
    nullable: true,
    description: 'AGENT | PLATFORM | PROVIDER — who the platform believes is at fault.',
  })
  fault: string | null;
}

export class BindingTestUpstreamDto {
  @ApiProperty({ description: '0 when no status was ever received.' })
  status: number;

  @ApiProperty()
  latencyMs: number;

  @ApiProperty({ nullable: true, description: 'The raw bytes, truncated. Panel one of three.' })
  rawBody: string | null;

  @ApiProperty()
  rawBodyTruncated: boolean;

  @ApiProperty({ nullable: true })
  contentType: string | null;

  @ApiPropertyOptional({ nullable: true })
  transportError: { kind: string; detail: string | null } | null;
}

export class BindingTestVerificationDto {
  @ApiProperty({
    enum: BindingTestPolicySource,
    description:
      'STORED_POLICY when this tool has a policy registered; TOOL_SCHEMA_ONLY when it ' +
      'does not, in which case production would settle such a call unverified and this ' +
      'run is stricter than production.',
  })
  policySource: BindingTestPolicySource;

  @ApiProperty({ nullable: true })
  policyId: string | null;

  @ApiProperty({ nullable: true })
  policyVersion: number | null;

  @ApiProperty({
    description:
      'One row per verification stage, in pipeline order. A stage after a failure is ' +
      'NOT_REACHED — never PASSED and never omitted.',
  })
  stages: readonly unknown[];

  @ApiProperty({ nullable: true, description: 'PASS | FAIL | EMPTY_CONFIRMED | MISAPPLIED | …' })
  verdict: string | null;
}

/**
 * One tester run, whole — the three panels (raw, mapped, checks), in one document.
 *
 * Returned to the console and stored on `binding_test_runs.report` unchanged,
 * so what a provider saw and what the publish gate read cannot drift apart.
 */
export class BindingTestReportDto {
  @ApiProperty({ description: 'The X-Assay-Call-Id this run actually sent upstream.' })
  callId: string;

  @ApiProperty({ enum: BindingTestOutcome })
  outcome: BindingTestOutcome;

  @ApiProperty({ enum: BindingTestLayer, nullable: true })
  failedLayer: BindingTestLayer | null;

  @ApiProperty({ description: 'Which revision of the mappings this run exercised.' })
  mappingVersion: number;

  @ApiProperty({ example: 2, description: 'The contract version this run was checked against.' })
  toolVersion: number;

  @ApiProperty({ example: '1.1.0' })
  toolVersionSemver: string;

  @ApiProperty({ type: [BindingTestLayerResultDto] })
  layers: BindingTestLayerResultDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'The request the mapping produced. Header names only — never values.',
  })
  request: {
    method: string;
    url: string;
    headerNames: readonly string[];
    body: unknown;
  } | null;

  @ApiPropertyOptional({ nullable: true, type: BindingTestUpstreamDto })
  upstream: BindingTestUpstreamDto | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The response classification of what came back: DATA_RESULT, SYSTEM_ERROR or REQUEST_ERROR.',
  })
  classification: unknown;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Panel two: the document the mapping produced.',
  })
  mapped: unknown;

  @ApiPropertyOptional({ nullable: true, type: BindingTestVerificationDto })
  verification: BindingTestVerificationDto | null;

  @ApiProperty({
    description:
      'Findings that never change the outcome, e.g. the endpoint accepted an unauthenticated probe. ' +
      'Always present; empty when none.',
    example: [
      {
        code: 'ACCEPTS_UNSIGNED',
        message: 'Your endpoint accepted a request without an Assay signature.',
      },
    ],
  })
  warnings: { code: BindingTestWarningCode; message: string }[];

  @ApiProperty()
  ranAt: Date;
}
