import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Shorter than the 128-character column: a label is read in a sheet title. */
export const AGENT_LABEL_MAX_LENGTH = 64;

/**
 * No control, format, surrogate or private-use characters (`\p{C}`), and no
 * line or paragraph separators. That refuses newlines and tabs, and the
 * zero-width and bidi-override characters that make one label look like
 * another.
 */
const AGENT_LABEL_RE = /^[^\p{C}\p{Zl}\p{Zp}]+$/u;

/**
 * `PATCH /api/v1/agents/:agentId`. The label is the only field: under the
 * app's `forbidNonWhitelisted` pipe any other field is a 400, so a rename can
 * change nothing else about the agent.
 */
export class UpdateAgentBodyDto {
  @ApiProperty({
    description: 'Shown in the dashboard and in Connect. Trimmed; no control characters.',
    example: 'Research bot',
    maxLength: AGENT_LABEL_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_LABEL_MAX_LENGTH)
  @Matches(AGENT_LABEL_RE, { message: 'label must not contain control characters' })
  label: string;
}
