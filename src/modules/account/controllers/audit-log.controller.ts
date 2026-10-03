import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import { AuditLogEntryDto, ListAuditLogQueryDto } from '../dto/list-audit-log.dto';
import { AuditLogService } from '../services/audit-log.service';

/**
 * Who did what, to which resource, when. Read only: the
 * table is append-only, and there is no write endpoint here.
 */
@ApiTags('AuditLog')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @ApiOperation({ summary: 'The audit trail, newest first' })
  @ApiCursorPage(AuditLogEntryDto)
  async list(
    @CurrentSession() session: McpSession,
    @Query() query: ListAuditLogQueryDto,
  ): Promise<CursorPageDto<AuditLogEntryDto>> {
    return this.auditLog.list(session.organizationId, query);
  }
}
