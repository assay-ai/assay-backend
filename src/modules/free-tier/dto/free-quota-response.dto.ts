import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /api/v1/free-quota`.
 *
 * One agent's own free-tier standing: the platform's two agent-scoped
 * ceilings (always answerable — they need no tool id), plus per-tool headroom
 * for whichever free/freemium tools this agent has actually called, since
 * that is the only set {@link PerToolFreeQuotaDto} can be built for without
 * asking "what is remaining against a tool nobody has called yet", a question
 * this endpoint does not need to answer.
 */
export class PlatformFreeQuotaDto {
  @ApiProperty({ description: 'Free calls left today, across every free tool' })
  remaining: number;

  @ApiProperty({ description: 'The platform-wide per-agent daily ceiling' })
  limit: number;

  @ApiProperty({ description: 'ISO-8601. When the daily ceiling resets (next UTC midnight).' })
  resetsAt: string;
}

export class RateLimitHeadroomDto {
  @ApiProperty({ description: 'Free calls left in the current one-minute window' })
  remaining: number;

  @ApiProperty({ description: 'Requests per minute the relay path allows' })
  limit: number;

  @ApiProperty({ description: 'ISO-8601. When the current window closes.' })
  resetsAt: string;
}

export class PerToolFreeQuotaDto {
  @ApiProperty()
  toolId: string;

  @ApiProperty({
    description:
      'The most generous honest figure across this tool’s free/freemium bindings ' +
      '— see FreeQuotaService.remainingForTool.',
  })
  remaining: number;

  @ApiProperty({
    description: "The binding's own per-agent daily limit (provider-set, or the platform default)",
  })
  limit: number;

  @ApiProperty({ description: 'ISO-8601. When this tool’s per-agent quota resets.' })
  resetsAt: string;
}

export class FreeQuotaResponseDto {
  @ApiProperty({ type: PlatformFreeQuotaDto })
  platform: PlatformFreeQuotaDto;

  @ApiProperty({ type: RateLimitHeadroomDto })
  rateLimit: RateLimitHeadroomDto;

  @ApiProperty({
    type: [PerToolFreeQuotaDto],
    description:
      'Per-tool headroom for the free/freemium tools this agent has called at least once',
  })
  tools: PerToolFreeQuotaDto[];
}
