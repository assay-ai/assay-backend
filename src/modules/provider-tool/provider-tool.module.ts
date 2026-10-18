import { Module } from '@nestjs/common';

import { McpModule } from '@modules/mcp/mcp.module';
import { ProviderApiModule } from '@modules/provider/provider-api.module';
import { ToolModule } from '@modules/tool/tool.module';
import { ToolsetModule } from '@modules/toolset/toolset.module';
import { VerificationModule } from '@modules/verification/verification.module';
import { AuditLogModule } from '@shared/audit';

import { ProviderToolsController } from './controllers/provider-tools.controller';
import { NO_UPHELD_DISPUTES, UPHELD_DISPUTES } from './ports/upheld-disputes.port';
import { ProviderToolGateService } from './services/provider-tool-gate.service';
import { ProviderToolPolicyService } from './services/provider-tool-policy.service';
import { ProviderToolQualityService } from './services/provider-tool-quality.service';
import { ProviderToolReviewService } from './services/provider-tool-review.service';
import { ProviderToolsService } from './services/provider-tools.service';
import { ToolPromotionService } from './services/tool-promotion.service';

/**
 * Provider tools (design spec §7.6, phase T4): the provider's REST surface,
 * the publish gate, the review the operator module decides, and promotion.
 *
 * `ProviderApiModule` supplies `BindingPublishService`: the tool's gate is
 * its binding's publish gate, not a copy. `ToolsetModule` supplies handles
 * and the view epochs; `VerificationModule` the policy service the declared
 * rules register through. `UPHELD_DISPUTES` is the seam buyer disputes
 * (G3.B1) plug into; until then nothing is measured.
 */
@Module({
  imports: [
    AuditLogModule,
    McpModule,
    ToolModule,
    ToolsetModule,
    VerificationModule,
    ProviderApiModule,
  ],
  controllers: [ProviderToolsController],
  providers: [
    { provide: UPHELD_DISPUTES, useValue: NO_UPHELD_DISPUTES },
    ProviderToolsService,
    ProviderToolGateService,
    ProviderToolPolicyService,
    ProviderToolQualityService,
    ProviderToolReviewService,
    ToolPromotionService,
  ],
  exports: [ProviderToolsService, ProviderToolReviewService, ToolPromotionService],
})
export class ProviderToolModule {}
