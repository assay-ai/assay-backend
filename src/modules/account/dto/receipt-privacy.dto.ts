import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ReceiptPrivacyDto {
  @ApiProperty({
    description:
      'Whether anyone who has a call id may open its public receipt. On by default. Off: the public receipt answers 404.',
  })
  receiptsPublic: boolean;
}

export class SetReceiptPrivacyBodyDto {
  @ApiProperty()
  @IsBoolean()
  receiptsPublic: boolean;
}
