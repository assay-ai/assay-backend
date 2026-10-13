import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

/** At most this many ids per lookup — a page of the on-chain list, with room. */
export const SLASH_REQUEST_LOOKUP_MAX = 200;

export class LookupSlashRequestsBodyDto {
  @ApiProperty({
    isArray: true,
    type: String,
    maxItems: SLASH_REQUEST_LOOKUP_MAX,
    description: 'On-chain slash request ids: `0x` + 32 bytes of hex, any case',
    example: ['0x' + '0'.repeat(64)],
  })
  @IsArray()
  @ArrayMaxSize(SLASH_REQUEST_LOOKUP_MAX)
  @IsString({ each: true })
  @Matches(/^0x[0-9a-fA-F]{64}$/, { each: true, message: 'each requestId must be 0x + 64 hex' })
  requestIds: string[];
}

export class SlashRequestMatchDto {
  @ApiProperty({ description: 'The request id, `0x` + lower-case hex' })
  requestId: string;

  @ApiProperty({ description: 'The Assay case it belongs to' })
  proposalId: string;

  @ApiPropertyOptional({
    description: 'Set when the id is one agent’s pro-rata part of the case, not the case itself',
  })
  partId?: string;
}

export class LookupSlashRequestsResponseDto {
  @ApiProperty({
    type: [SlashRequestMatchDto],
    description:
      'One entry per requested id that belongs to a case of yours. An id that does not — ' +
      'unknown, or another provider’s — is absent, with nothing to tell the two apart.',
  })
  matches: SlashRequestMatchDto[];
}
