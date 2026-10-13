import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import {
  AccountBlockDto,
  CreateAccountBlockBodyDto,
  ListAccountBlocksQueryDto,
  UnblockAccountBodyDto,
} from '../dto/operator-console.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorAccountBlockService } from '../services/operator-account-block.service';

/**
 * The account blocklist. `A-9` blocks, `A-10` lifts.
 *
 * Same three guards, in the same order, as every operator controller that
 * writes. Like the rest of this prefix it reads and writes across
 * organizations by construction: the subject of a block is never the caller.
 *
 * The list is readable by any operator, like the override log — support has
 * to be able to tell a customer that, and since when, they are blocked.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/blocks')
export class OperatorBlocksController {
  constructor(private readonly blocks: OperatorAccountBlockService) {}

  @Get()
  @ApiOperation({ summary: 'Blocks, newest first' })
  @ApiCursorPage(AccountBlockDto)
  async list(@Query() query: ListAccountBlocksQueryDto): Promise<CursorPageDto<AccountBlockDto>> {
    return this.blocks.list(query);
  }

  /** `A-9` — takes effect on this instance at once, on every other within seconds. */
  @Post()
  @Override('A-9')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({ summary: 'Block an organization or a wallet' })
  @ApiResponse({ status: 201, type: AccountBlockDto })
  @ApiResponse({ status: 409, description: 'The subject is already blocked' })
  async block(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: CreateAccountBlockBodyDto,
  ): Promise<AccountBlockDto> {
    return this.blocks.block(operator, body, requestIdOf());
  }

  /**
   * `A-10` — two-person. A second operator's token in `X-Operator-Approver`,
   * holding `ADJL`.
   */
  @Post(':blockId/unblock')
  @HttpCode(200)
  @Override('A-10')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({ summary: 'Lift a block' })
  @ApiResponse({ status: 200, type: AccountBlockDto })
  @ApiResponse({ status: 403, description: 'The second approver does not hold ADJL' })
  @ApiResponse({ status: 409, description: 'No second approver, or the block is already lifted' })
  async unblock(
    @CurrentOperator() operator: OperatorSession,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() body: UnblockAccountBodyDto,
    @Req() request: Request,
  ): Promise<AccountBlockDto> {
    return this.blocks.unblock(operator, blockId, body, request, requestIdOf());
  }
}

/** The server-minted request id, never the caller's — see `OperatorProvidersController`. */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
