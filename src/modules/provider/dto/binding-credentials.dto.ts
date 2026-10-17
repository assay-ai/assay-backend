import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, ValidateNested } from 'class-validator';

/** One header of a credential set, as written. Never returned. */
export class CredentialHeaderInputDto {
  @ApiProperty({ example: 'X-Provider-Key' })
  @IsString()
  @MaxLength(256)
  name: string;

  @ApiProperty({ description: 'Write-only. Never returned by any route.' })
  @IsString()
  @MaxLength(16384)
  value: string;
}

/** `PUT providers/me/tool-bindings/:id/credentials` — replaces the whole set for one origin. */
export class PutBindingCredentialsBodyDto {
  @ApiProperty({
    example: 'https://api.provider.example',
    description:
      "Scheme + host + port of the binding's draft or published endpoint. " +
      'The set is sent only to this origin.',
  })
  @IsString()
  @MaxLength(2048)
  origin: string;

  @ApiProperty({ type: [CredentialHeaderInputDto] })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => CredentialHeaderInputDto)
  headers: CredentialHeaderInputDto[];
}

export class DeleteBindingCredentialsQueryDto {
  @ApiProperty({ example: 'https://api.provider.example' })
  @IsString()
  @MaxLength(2048)
  origin: string;
}

export class CredentialHeaderSummaryDto {
  @ApiProperty()
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Last 4 characters, only for values of 16 characters or more; otherwise null.',
  })
  hint: string | null;
}

/** What a stored set looks like from outside: names and hints, never values. */
export class CredentialSetSummaryDto {
  @ApiProperty()
  origin: string;

  @ApiProperty({ type: [CredentialHeaderSummaryDto] })
  headers: CredentialHeaderSummaryDto[];

  @ApiProperty()
  updatedAt: Date;
}
