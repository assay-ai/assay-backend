import { ApiProperty } from '@nestjs/swagger';

import { AccountBlockStatusDto } from '@modules/account/dto/account-block-status.dto';
import { UnreadCountResponseDto } from '@modules/account/dto/unread-count.dto';
import { GetBuyerDebtsResponseDto } from '@modules/payment/dto/buyer-debt.dto';

/**
 * `GET /me/status` — the three things the buyer shell polls, in one read. A
 * part that could not be read is `null`; the others are still answered.
 */
export class MeStatusResponseDto {
  @ApiProperty({
    type: AccountBlockStatusDto,
    nullable: true,
    description: '`GET /account/block-status`; null when it could not be read',
  })
  blockStatus: AccountBlockStatusDto | null;

  @ApiProperty({
    type: UnreadCountResponseDto,
    nullable: true,
    description: '`GET /notifications/unread-count`; null when it could not be read',
  })
  unreadCount: UnreadCountResponseDto | null;

  @ApiProperty({
    type: GetBuyerDebtsResponseDto,
    nullable: true,
    description:
      '`GET /escrow/debts` — the whole list: the banner and the settle sheet read its rows; ' +
      'null when it could not be read',
  })
  debts: GetBuyerDebtsResponseDto | null;
}
