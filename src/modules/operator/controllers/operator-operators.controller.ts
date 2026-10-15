import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  AddOperatorBodyDto,
  ChangeOperatorBodyDto,
  ListOperatorsQueryDto,
  OperatorDirectoryEntryDto,
  RemoveOperatorBodyDto,
} from '../dto/operator-directory.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorDirectoryService } from '../services/operator-directory.service';
import { answerOrQueued } from './approval-response';

/**
 * The operator directory: `A-12` add, `A-13` change, `A-14` remove, all by
 * `OPS_ADMIN`. The list is readable by any operator, like the override log.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/operators')
export class OperatorOperatorsController {
  constructor(private readonly directory: OperatorDirectoryService) {}

  @Get()
  @ApiOperation({ summary: 'Operators, newest first' })
  @ApiCursorPage(OperatorDirectoryEntryDto)
  async list(
    @Query() query: ListOperatorsQueryDto,
  ): Promise<CursorPageDto<OperatorDirectoryEntryDto>> {
    return this.directory.list(query);
  }

  /** Two-person: always queued for a second `OPS_ADMIN`. */
  @Post()
  @Override('A-12')
  @RequireRoles(OperatorRole.OPS_ADMIN)
  @ApiOperation({ summary: 'Add an operator by wallet address (queued for approval)' })
  @ApiResponse({ status: 202, type: ApprovalQueuedDto })
  @ApiResponse({ status: 409, description: 'OPERATOR_ALREADY_EXISTS' })
  async add(
    @CurrentOperator() operator: OperatorSession,
    @Body() body: AddOperatorBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    return answerOrQueued(response, await this.directory.add(operator, body, requestIdOf()));
  }

  /** Lowering applies at once (200); adding a role or raising the limit is queued (202). */
  @Patch(':operatorId')
  @Override('A-13')
  @RequireRoles(OperatorRole.OPS_ADMIN)
  @ApiOperation({ summary: 'Change an operator’s roles or authority limit' })
  @ApiResponse({ status: 200, type: OperatorDirectoryEntryDto })
  @ApiResponse({ status: 202, type: ApprovalQueuedDto })
  @ApiResponse({ status: 403, description: 'OPERATOR_SELF_CHANGE_REFUSED' })
  async change(
    @CurrentOperator() operator: OperatorSession,
    @Param('operatorId', ParseUUIDPipe) operatorId: string,
    @Body() body: ChangeOperatorBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    return answerOrQueued(
      response,
      await this.directory.change(operator, operatorId, body, requestIdOf()),
    );
  }

  /**
   * Single-person (200) and ends every session the operator holds at once;
   * removing an `OPS_ADMIN` is queued for another one (202).
   */
  @Post(':operatorId/remove')
  @HttpCode(200)
  @Override('A-14')
  @RequireRoles(OperatorRole.OPS_ADMIN)
  @ApiOperation({ summary: 'Remove an operator' })
  @ApiResponse({ status: 200, type: OperatorDirectoryEntryDto })
  @ApiResponse({ status: 202, type: ApprovalQueuedDto })
  @ApiResponse({ status: 403, description: 'OPERATOR_SELF_CHANGE_REFUSED' })
  async remove(
    @CurrentOperator() operator: OperatorSession,
    @Param('operatorId', ParseUUIDPipe) operatorId: string,
    @Body() body: RemoveOperatorBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OperatorDirectoryEntryDto | ApprovalQueuedDto> {
    return answerOrQueued(
      response,
      await this.directory.remove(operator, operatorId, body, requestIdOf()),
    );
  }
}

function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
