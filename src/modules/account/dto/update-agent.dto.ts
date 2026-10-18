import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

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
 * At least one character that shows: a letter, digit, punctuation or symbol
 * that is not one of the blank fillers (Hangul fillers, Braille blank).
 * Combining marks and spaces alone draw nothing.
 */
const VISIBLE_RE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const BLANK_FILLERS_RE = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

/** Whether a label has something a reader can see. */
export function hasVisibleCharacter(label: string): boolean {
  return VISIBLE_RE.test(label.replace(BLANK_FILLERS_RE, ''));
}

@ValidatorConstraint({ name: 'visibleLabel', async: false })
class VisibleLabel implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && hasVisibleCharacter(value);
  }

  defaultMessage(): string {
    return 'label must have at least one visible character';
  }
}

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
  @Validate(VisibleLabel)
  label: string;
}
