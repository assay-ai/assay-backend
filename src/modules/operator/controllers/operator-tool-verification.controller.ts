import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequestContext } from '@shared/observability';
import { CurrentOperator, OperatorAuthGuard, OperatorRolesGuard, RequireRoles } from '@shared/auth';

import { Override, OverrideExempt } from '../decorators/override.decorator';
import { OperatorRole } from '../domain/override-register';
import { ApprovalQueuedDto } from '../dto/operator-approval.dto';
import { ContractActionBodyDto, ToolIdParamDto } from '../dto/operator-contracts.dto';
import {
  LabelRecordBodyDto,
  ListTrialRecordsQueryDto,
  OperatorToolVerificationDto,
  PolicyVersionParamDto,
  RecordIdParamDto,
  RegisterPolicyBodyDto,
  TrialRecordDto,
  TrialRecordPageDto,
  WithdrawPolicyBodyDto,
} from '../dto/operator-verification.dto';
import { OperatorOverrideGuard } from '../guards/operator-override.guard';
import { OperatorSession } from '../ports/operator-session.port';
import { OperatorToolVerificationService } from '../services/operator-tool-verification.service';
import { answerOrQueued } from './approval-response';

const LABEL_EXEMPTION =
  'a trial label moves no money and changes no policy; the promotion that reads labels is two-person (P-1)';

/** Who reads trial calls and labels them (owner decision: the policy's author may not). */
const LABELLERS = [OperatorRole.POL, OperatorRole.POLA, OperatorRole.ADJ, OperatorRole.ADJL];

/**
 * A tool's verification policies (operator console): the serving version and
 * every version's measured evidence, a trial policy for a standard tool
 * (P-2), the labelling queue, switching a policy on (P-1, two-person) and the
 * kill switch (P-3). Same three guards as every operator controller that writes.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard)
@Controller('operator')
export class OperatorToolVerificationController {
  constructor(private readonly verification: OperatorToolVerificationService) {}

  @Get('tools/:id/verification')
  @ApiOperation({
    summary:
      'A tool’s verification policies: the serving one, every version with evidence measured ' +
      'from its trial calls and a preview of the promotion gate, and the gate itself',
  })
  @ApiResponse({ status: 200, type: OperatorToolVerificationDto })
  async get(@Param() params: ToolIdParamDto): Promise<OperatorToolVerificationDto> {
    return this.verification.get(params.id);
  }

  @Post('tools/:id/verification')
  @HttpCode(201)
  @Override('P-2')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Register the next version of a standard tool’s policy, in SHADOW (trial: judged and ' +
      'recorded, no effect on the charge). The previous trial version is archived',
  })
  @ApiResponse({ status: 201, type: OperatorToolVerificationDto })
  @ApiResponse({ status: 400, description: 'VERIFICATION_POLICY_RULES_INVALID, every problem' })
  @ApiResponse({ status: 409, description: 'TOOL_CONTRACT_STATE (provider tool, removed tool)' })
  async register(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: ToolIdParamDto,
    @Body() body: RegisterPolicyBodyDto,
  ): Promise<OperatorToolVerificationDto> {
    return this.verification.register(operator, params.id, body, requestIdOf());
  }

  @Get('tools/:id/verification/versions/:version/records')
  @RequireRoles(...LABELLERS)
  @ApiOperation({
    summary:
      'Trial calls of one policy version, in a fixed pseudo-random order, with their verdict, ' +
      'stages and label (25 a page)',
  })
  @ApiResponse({ status: 200, type: TrialRecordPageDto })
  async records(
    @Param() params: PolicyVersionParamDto,
    @Query() query: ListTrialRecordsQueryDto,
  ): Promise<TrialRecordPageDto> {
    return this.verification.listRecords(params.id, Number(params.version), query);
  }

  @Post('verification-records/:recordId/label')
  @HttpCode(200)
  @OverrideExempt(LABEL_EXEMPTION)
  @RequireRoles(...LABELLERS)
  @ApiOperation({
    summary:
      'Label a trial call: was the policy right? Refused once the version left SHADOW, for the ' +
      'policy’s author, and over another operator’s label',
  })
  @ApiResponse({ status: 200, type: TrialRecordDto })
  @ApiResponse({ status: 409, description: 'VERIFICATION_LABEL_REFUSED, with the reason' })
  async label(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: RecordIdParamDto,
    @Body() body: LabelRecordBodyDto,
  ): Promise<TrialRecordDto> {
    return this.verification.label(operator, params.recordId, body);
  }

  @Post('tools/:id/verification/versions/:version/promote')
  @HttpCode(200)
  @Override('P-1')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA)
  @ApiOperation({
    summary:
      'Ask to switch a SHADOW policy on (two-person, approver POLA). The gate runs on evidence ' +
      'the server counts, now and again on approval; the approver must be neither the ' +
      'requester nor the policy’s author',
  })
  @ApiResponse({ status: 200, type: OperatorToolVerificationDto })
  @ApiResponse({
    status: 202,
    type: ApprovalQueuedDto,
    description: 'Queued for a second operator',
  })
  @ApiResponse({
    status: 409,
    description: 'VERIFICATION_POLICY_PROMOTION_REFUSED with every failure in `context.failures`',
  })
  async promote(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: PolicyVersionParamDto,
    @Body() body: ContractActionBodyDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return answerOrQueued(
      response,
      await this.verification.promote(
        operator,
        params.id,
        Number(params.version),
        body,
        requestIdOf(),
      ),
    );
  }

  @Post('tools/:id/verification/versions/:version/withdraw')
  @HttpCode(200)
  @Override('P-3')
  @RequireRoles(OperatorRole.POL, OperatorRole.POLA, OperatorRole.SRE)
  @ApiOperation({
    summary:
      'Withdraw an ACTIVE or SHADOW policy (kill switch, one operator, reviewed after the ' +
      'fact). It comes back only as a new trial version',
  })
  @ApiResponse({ status: 200, type: OperatorToolVerificationDto })
  async withdraw(
    @CurrentOperator() operator: OperatorSession,
    @Param() params: PolicyVersionParamDto,
    @Body() body: WithdrawPolicyBodyDto,
  ): Promise<OperatorToolVerificationDto> {
    return this.verification.withdraw(
      operator,
      params.id,
      Number(params.version),
      body,
      requestIdOf(),
    );
  }
}

function requestIdOf(): string | null {
  return RequestContext.getServerRequestId();
}
