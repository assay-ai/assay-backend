import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { BindingPauseReason } from '@modules/tool/ports/tool.types';

import { SavedToolBindingDto } from './save-tool-binding.dto';

/**
 * `POST /providers/me/tool-bindings/:id/pause`.
 *
 * The body carries a **note**, not the stored reason. `pause_reason` is always
 * `PROVIDER_REQUESTED` on this route and a provider must not be able to write
 * `HEALTH` or `PLATFORM` — those are the platform's own findings about them,
 * and a column a provider can set is a column that cannot be evidence.
 */
export class PauseToolBindingBodyDto {
  @ApiPropertyOptional({
    description:
      'Free text for support and the provider\'s own audit trail — "upstream maintenance ' +
      'window", "rotating an API key". Not the stored reason: that is always ' +
      'PROVIDER_REQUESTED on this route.',
    maxLength: 280,
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

/**
 * A binding plus the two columns a pause moves.
 *
 * They travel together because they are only ever true together — the
 * biconditional CHECK on the row says so — and a console rendering "paused" from
 * `status` while reading "why" from a second request could show the two out of
 * step for exactly as long as the second request takes.
 */
export class PausedToolBindingDto extends SavedToolBindingDto {
  @ApiProperty({
    enum: BindingPauseReason,
    nullable: true,
    description: 'Who stopped the traffic. `null` on a binding that is serving.',
  })
  pauseReason: BindingPauseReason | null;

  @ApiProperty({ nullable: true, description: 'When the pause began. Cleared by a resume.' })
  pausedAt: Date | null;
}
