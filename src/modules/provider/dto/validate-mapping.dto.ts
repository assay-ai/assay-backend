import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { MappingDirection } from '@modules/tool/domain/mapping/mapping.types';

/**
 * `POST /providers/me/tool-bindings/validate-mapping` — for the binding editor.
 *
 * The requirement is *"check types and required fields **as you type**, not
 * at submit"*. That is an endpoint, not a save: the console calls it on a
 * debounce with whatever is currently in the editor, and nothing is written.
 *
 * It answers the *only* question that can be answered without a real response
 * — is this spec well-formed — and it answers it with `validateRequestMapping`
 * / `validateResponseMapping`, the same functions Save runs and the same ones
 * the router runs. A separate lint that agreed with them "mostly" would be a
 * second definition of a valid mapping.
 */
export class ValidateMappingBodyDto {
  @ApiProperty({
    enum: MappingDirection,
    description: 'Which mapping this is. The two have different shapes and different faults.',
  })
  @IsIn(Object.values(MappingDirection))
  direction: MappingDirection;

  @ApiProperty({ description: 'The mapping as typed, shorthand and all.' })
  @IsObject()
  mapping: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'The tool being mapped, so the error carries the binding context it would live in.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  toolId?: string;
}

/**
 * What a well-formed mapping looks like from the outside.
 *
 * Invalid mappings do not come back here — they raise `TOOL_MAPPING_INVALID`
 * with a pointer, through the ordinary error filter, because a validation
 * endpoint that returns `200 { valid: false }` is one every caller eventually
 * forgets to branch on.
 */
export class ValidateMappingResponseDto {
  @ApiProperty({
    description:
      'The canonical form — shorthand resolved, exactly as Save would store it. ' +
      'Normalisation is idempotent, so an editor may round-trip through this.',
  })
  canonical: unknown;

  @ApiProperty({
    type: [String],
    description: 'Every selector the mapping reads, in document order. The tester’s field list.',
    example: ['$.data.items[*]', '$.link', '$.title'],
  })
  selectors: string[];

  @ApiProperty({
    type: [String],
    description: 'Every named transform used, deduplicated.',
    example: ['trim', 'epochSecondsToIso'],
  })
  transforms: string[];
}
