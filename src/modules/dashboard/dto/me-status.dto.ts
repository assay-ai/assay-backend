import { ApiProperty } from '@nestjs/swagger';

import { AccountBlockStatusDto } from '@modules/account/dto/account-block-status.dto';
import { UnreadCountResponseDto } from '@modules/account/dto/unread-count.dto';
import { GetBuyerDebtsResponseDto } from '@modules/payment/dto/buyer-debt.dto';

/** `GET /me/status` — the three things the buyer shell polls, in one read. */
export class MeStatusResponseDto {
  @ApiProperty({ type: AccountBlockStatusDto, description: '`GET /account/block-status`' })
  blockStatus: AccountBlockStatusDto;

  @ApiProperty({ type: UnreadCountResponseDto, description: '`GET /notifications/unread-count`' })
  unreadCount: UnreadCountResponseDto;

  @ApiProperty({
    type: GetBuyerDebtsResponseDto,
    description:
      '`GET /escrow/debts` — the whole list: the banner and the settle sheet read its rows',
  })
  debts: GetBuyerDebtsResponseDto;
}
