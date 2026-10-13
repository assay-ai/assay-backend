import { ApiProperty } from '@nestjs/swagger';

import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';

/**
 * One block that applies to the caller.
 *
 * What the account holder is told is the fact, the kind and the date — never
 * the operator's note or who wrote it. The note is an internal record and may
 * name an investigation; `reasonCode` is the short, closed-list reason.
 */
export class AccountBlockStatusEntryDto {
  @ApiProperty({
    enum: BlockedRole,
    description: 'ORGANIZATION (this tenant), PAYER (its wallet) or DELEGATE (its delegate key)',
  })
  role: BlockedRole;

  @ApiProperty({ enum: BlockSubjectKind })
  subjectKind: BlockSubjectKind;

  @ApiProperty({ description: 'The organization id or the CAIP-10 account that is blocked' })
  subject: string;

  @ApiProperty({ description: 'e.g. LEAKED_KEY' })
  reasonCode: string;

  @ApiProperty()
  blockedAt: Date;
}

export class AccountBlockStatusDto {
  @ApiProperty({
    description: 'True when anything below applies; every write is then refused',
  })
  blocked: boolean;

  @ApiProperty({ type: [AccountBlockStatusEntryDto] })
  blocks: AccountBlockStatusEntryDto[];
}
