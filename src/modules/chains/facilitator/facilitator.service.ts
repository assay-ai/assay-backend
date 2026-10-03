import { Inject, Injectable, Logger } from '@nestjs/common';

import { FeePayerSignerPort, FEE_PAYER_SIGNER } from './signing/fee-payer-signer.port';
import {
  SettleResponseBody,
  SupportedResponseBody,
  VerifyResponseBody,
  X402_VERSION,
} from './facilitator.wire';
import { FacilitatorRequestBodyDto } from './dto/facilitator-request.dto';
import {
  SOLANA_EXACT_SCHEME,
  SUPPORTED_SVM_NETWORKS,
} from './verification/facilitator-policy.constants';
import { X402SvmVerifierService } from './verification/x402-svm-verifier.service';

/**
 * Thin orchestration between `FacilitatorController` and
 * `X402SvmVerifierService` — the controller stays a pure HTTP adapter
 * (`docs/architecture.md` §Controller Pattern), and `/supported` lives here
 * because it needs the fee payer's address from the signer, not from the
 * verifier.
 */
@Injectable()
export class FacilitatorService {
  private readonly logger = new Logger(FacilitatorService.name);

  constructor(
    private readonly verifier: X402SvmVerifierService,
    @Inject(FEE_PAYER_SIGNER) private readonly signer: FeePayerSignerPort,
  ) {}

  async verify(body: FacilitatorRequestBodyDto): Promise<VerifyResponseBody> {
    const result = await this.verifier.verify(body.paymentPayload, body.paymentRequirements);
    if (!result.isValid) {
      this.logger.debug(`verify rejected: ${result.invalidReason}`);
    }
    return result;
  }

  async settle(body: FacilitatorRequestBodyDto): Promise<SettleResponseBody> {
    const result = await this.verifier.settle(body.paymentPayload, body.paymentRequirements);
    if (result.success) {
      this.logger.log(`settled ${result.transaction} on ${result.network}`);
    } else {
      this.logger.debug(`settle refused: ${result.errorReason}`);
    }
    return result;
  }

  /**
   * `extra.feePayer` is why this endpoint exists at all — an SVM client
   * cannot leave the right account slot unsigned without knowing which
   * account that is (`facilitator.wire.ts`'s `SupportedKind` doc comment).
   */
  async supported(): Promise<SupportedResponseBody> {
    const feePayer = await this.signer.getFeePayerAddress();
    return {
      kinds: SUPPORTED_SVM_NETWORKS.map((network) => ({
        x402Version: X402_VERSION,
        scheme: SOLANA_EXACT_SCHEME,
        network,
        extra: { feePayer, paymentFlow: 'upfront' },
      })),
    };
  }
}
