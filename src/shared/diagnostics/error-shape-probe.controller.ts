import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import { LedgerErrors } from '@modules/ledger/errors/ledger.errors';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';
import { VerificationErrors } from '@modules/verification/errors/verification.errors';
import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';

/**
 * Raises a real error from each domain catalog, so the single error shape can
 * be checked against a running server rather than only in a unit test.
 *
 * The unit test asserts the filter's output object; this asserts what actually
 * comes off the wire, after the interceptor chain, the validation pipe and
 * Express have all had their say. Those are different claims, and only the
 * second one is what a client sees.
 *
 * Mounted only when `DiagnosticsModule` is imported — off in production.
 */
const PROBES = {
  payment: () => PaymentErrors.paymentIntentNotFound({ id: 'probe-intent' }),
  ledger: () => LedgerErrors.insufficientAvailableBalance({ accountId: 'probe-account' }),
  tool: () => ToolErrors.toolNotFound({ toolId: 'probe-tool' }),
  provider: () => ProviderErrors.stakeBelowMinimum({ staked: '0', minimum: '100000000' }),
  verification: () => VerificationErrors.policyNotFound({ toolId: 'probe-tool' }),
  settlement: () => SettlementErrors.slashNotPermitted({ classification: 'SYSTEM_ERROR' }),
  mcp: () => McpErrors.credentialInvalid(),
} as const;

type ProbeDomain = keyof typeof PROBES;

@ApiTags('Diagnostics')
@Controller('diagnostics')
export class ErrorShapeProbeController {
  @Get('errors/:domain')
  @ApiOperation({
    summary: 'Raise a real error from one domain catalog, to verify the error contract',
  })
  @ApiParam({ name: 'domain', enum: Object.keys(PROBES) })
  @ApiResponse({
    status: 404,
    description: 'Every response is an ErrorResponse — that is the point',
  })
  raise(@Param('domain') domain: string): never {
    const probe = PROBES[domain as ProbeDomain];

    if (!probe) {
      // Also an ErrorResponse, via the framework branch of the filter.
      throw McpErrors.methodNotSupported({ method: `diagnostics/errors/${domain}` });
    }

    throw probe();
  }
}
