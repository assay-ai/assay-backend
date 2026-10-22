import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiCursorPage, CursorPageDto } from '@shared/api';
import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { OverrideExempt } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import {
  ApprovalDecisionDto,
  ListOperatorApprovalsQueryDto,
  OperatorApprovalDto,
} from '../dto/operator-approval.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorApprovalService } from '../services/operator-approval.service';

/**
 * The approvals inbox: two-person actions waiting for their second person.
 *
 * Readable by any operator. Approving re-runs the queued action, which writes
 * its own register entry naming both people — so the approve route itself is
 * exempt from the register rather than writing a second entry for one act.
 * Which roles may approve a given row is that row's register code's
 * `approverRoles`, checked by the service; the route-level roles below are
 * only the union of them (plus, for reject, the requester roles that may
 * withdraw their own request).
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator/approvals')
export class OperatorApprovalsController {
  constructor(private readonly approvals: OperatorApprovalService) {}

  @Get()
  @ApiOperation({ summary: 'Queued two-person actions, newest first' })
  @ApiCursorPage(OperatorApprovalDto)
  async list(
    @Query() query: ListOperatorApprovalsQueryDto,
  ): Promise<CursorPageDto<OperatorApprovalDto>> {
    return this.approvals.list(query);
  }

  @Get(':approvalId')
  @ApiOperation({ summary: 'One queued action' })
  @ApiResponse({ status: 200, type: OperatorApprovalDto })
  async get(@Param('approvalId', ParseUUIDPipe) approvalId: string): Promise<OperatorApprovalDto> {
    return this.approvals.get(approvalId);
  }

  @Post(':approvalId/approve')
  @HttpCode(200)
  @OverrideExempt(
    'Re-runs the queued action, which writes its own register entry naming both the requester ' +
      'and this approver',
  )
  @RequireRoles(
    OperatorRole.ADJ,
    OperatorRole.ADJL,
    OperatorRole.TRE,
    OperatorRole.OPS_ADMIN,
    // The approver of the policy rows (P-10, P-11) and of nothing else: the
    // service checks the row's own `approverRoles` (BUG-OPS-CORE-01).
    OperatorRole.POLA,
    // The second approver of A-22 (handle reassignment) alongside ADJL, and of
    // nothing else: the same per-row check limits it to that row.
    OperatorRole.CMP,
  )
  @ApiOperation({ summary: 'Approve, as a second operator: runs the action now' })
  @ApiResponse({ status: 200, type: ApprovalDecisionDto })
  @ApiResponse({ status: 403, description: 'Approver role or limit insufficient' })
  @ApiResponse({ status: 409, description: 'Self-approval, or no longer pending' })
  async approve(
    @CurrentOperator() operator: OperatorSession,
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
  ): Promise<ApprovalDecisionDto> {
    return this.approvals.approve(approvalId, operator, RequestContext.getServerRequestId());
  }

  @Post(':approvalId/reject')
  @HttpCode(200)
  @OverrideExempt('Closes a queued action without running it; nothing but the approval row changes')
  @RequireRoles(
    OperatorRole.ADJ,
    OperatorRole.ADJL,
    OperatorRole.SRE,
    OperatorRole.TRE,
    OperatorRole.OPS_ADMIN,
    // POL withdraws its own policy request; POLA also turns down someone
    // else's. The service allows only that (BUG-OPS-CORE-01).
    OperatorRole.POL,
    OperatorRole.POLA,
    // CMP turns down an A-22 request (or withdraws its own); nothing else.
    OperatorRole.CMP,
  )
  @ApiOperation({ summary: 'Reject (or, as the requester, withdraw) a queued action' })
  @ApiResponse({ status: 200, type: ApprovalDecisionDto })
  async reject(
    @CurrentOperator() operator: OperatorSession,
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
  ): Promise<ApprovalDecisionDto> {
    return this.approvals.reject(approvalId, operator);
  }
}
