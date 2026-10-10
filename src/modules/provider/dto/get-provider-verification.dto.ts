import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { ProviderVerificationDto } from './provider-shared.dto';

/**
 * `GET /providers/:providerId/verification` — the catalogue's read of the
 * `verified` label. Wrapped with `providerId` and `legalName` because the catalogue
 * renders a name next to the badge; `ProviderVerificationDto` alone names
 * neither. Informational only — see `ProviderVerificationService`'s class
 * comment for why nothing gates on it.
 */
export class GetProviderVerificationResponseDto {
  @ApiProperty({ description: 'Same value as organizationId — see ProviderProfileService.' })
  providerId: string;

  @ApiProperty({ example: 'Example Vessel Data Ltd' })
  legalName: string;

  @ApiProperty({ type: ProviderVerificationDto })
  verification: ProviderVerificationDto;
}

export class GetProviderVerificationParamsDto {
  @ApiProperty({ description: 'The provider id — same value as the provider organization id.' })
  @IsUUID()
  providerId: string;
}
