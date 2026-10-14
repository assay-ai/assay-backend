import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { answerOrQueued } from './approval-response';
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
   * `A-10` — two-person. Queued with 202 `{approvalId}`; a second operator
   * holding `ADJL` approves it with their own session.
   */
  @Post(':blockId/unblock')
  @HttpCode(200)
  @Override('A-10')
  @RequireRoles(OperatorRole.ADJL, OperatorRole.SRE)
  @ApiOperation({ summary: 'Lift a block' })
  @ApiResponse({ status: 200, type: AccountBlockDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({ status: 409, description: 'The block is already lifted' })
  async unblock(
    @CurrentOperator() operator: OperatorSession,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() body: UnblockAccountBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccountBlockDto | ApprovalQueuedDto> {
    return answerOrQueued(
      response,
      await this.blocks.unblock(operator, blockId, body, requestIdOf()),
    );
  }
}

/** The server-minted request id, never the caller's — see `OperatorProvidersController`. */
function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
