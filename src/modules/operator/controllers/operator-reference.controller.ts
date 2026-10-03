import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { OperatorAuthGuard } from '@shared/auth';

import { PlatformHealthDto } from '../dto/operator-console.dto';
import {
  EconomicParameterRowDto,
  OverrideRegisterRowDto,
  PolicyLifecycleRowDto,
  VerifierRegistryRowDto,
} from '../dto/operator-reference.dto';
import { PlatformHealthService } from '../services/platform-health.service';
import { OperatorReferenceService } from '../services/operator-reference.service';

/**
 * The read-only half of the operator console: the health
 * tiles and the three reference panels. Every route here is a `GET` — no
 * `@RequireRoles`, on purpose, matching `OperatorRolesGuard`'s own rule that a
 * read-only handler with no metadata is open to any authenticated operator.
 * `OperatorAuthGuard` alone is the whole authorization story for this
 * controller: it answers *which operator*, and being blocked from a list
 * would just be noise — see the guard's docstring.
 */
@ApiTags('Operator')
@ApiBearerAuth()
@UseGuards(OperatorAuthGuard)
@Controller('operator')
export class OperatorReferenceController {
  constructor(
    private readonly health: PlatformHealthService,
    private readonly reference: OperatorReferenceService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'The six platform-health tiles across the top of the console' })
  @ApiResponse({ status: 200, type: PlatformHealthDto })
  async getHealth(): Promise<PlatformHealthDto> {
    return this.health.getHealth();
  }

  @Get('policies')
  @ApiOperation({ summary: 'The verification policy lifecycle, one row per policy id' })
  @ApiResponse({ status: 200, type: [PolicyLifecycleRowDto] })
  async getPolicies(): Promise<PolicyLifecycleRowDto[]> {
    return this.reference.listPolicies();
  }

  @Get('verifiers')
  @ApiOperation({
    summary: 'The verifier signing keys this deployment knows, and their on-chain state',
  })
  @ApiResponse({ status: 200, type: [VerifierRegistryRowDto] })
  async getVerifiers(): Promise<VerifierRegistryRowDto[]> {
    return this.reference.listVerifiers();
  }

  @Get('economics')
  @ApiOperation({ summary: 'The economic parameters — take rate, stake, penalty split' })
  @ApiResponse({ status: 200, type: [EconomicParameterRowDto] })
  async getEconomics(): Promise<EconomicParameterRowDto[]> {
    return this.reference.listEconomicParameters();
  }

  @Get('override-register')
  @ApiOperation({ summary: 'OVERRIDE_REGISTER, listed — including rows with no code behind them' })
  @ApiResponse({ status: 200, type: [OverrideRegisterRowDto] })
  getOverrideRegister(): OverrideRegisterRowDto[] {
    return this.reference.listOverrideRegister();
  }
}
