import { Inject, Injectable } from '@nestjs/common';

import { PaymentPayload, PaymentRequirements, TxRef } from '../../ports/x402.types';
import {
  SettleResponseBody,
  VerifyResponseBody,
  X402InvalidReason,
  X402_INVALID_REASON,
} from '../facilitator.wire';
import { FACILITATOR_SOLANA_RPC } from '../facilitator.tokens';
import { FEE_PAYER_SIGNER, FeePayerSignerPort } from '../signing/fee-payer-signer.port';
import { decodeSvmPayload, FacilitatorSvmRpcClient } from './decode-svm-payload';
import { DuplicateSettlementGuard } from './duplicate-settlement.guard';
import { extractPayerAddress } from './extract-payer';
import { SOLANA_EXACT_SCHEME, SUPPORTED_SVM_NETWORKS } from './facilitator-policy.constants';
import { checkComputeBudget } from './rules/compute-budget.rule';
import { checkFeePayerIsolation } from './rules/fee-payer-isolation.rule';
import { checkInstructionLayout } from './rules/instruction-layout.rule';
import { checkMemo } from './rules/memo.rule';
import { checkSignatures } from './rules/signature-validity.rule';
import { checkTransferCorrectness } from './rules/transfer-correctness.rule';
import { DecodedSvmPayload } from './svm-instruction.types';

/**
 * String discriminant (`status`), not boolean: see the identical note on
 * `DecodeSvmPayloadResult` in `decode-svm-payload.ts` — `strictNullChecks:
 * false` (`tsconfig.json`) leaves a `{ ok: true } | { ok: false }` union
 * unnarrowed after `if (!x.ok)`.
 */
type Evaluation =
  | { readonly status: 'accepted'; readonly decoded: DecodedSvmPayload; readonly payer?: string }
  | { readonly status: 'rejected'; readonly invalidReason: X402InvalidReason };

/**
 * The x402 wrapper's SVM `exact` pipeline — the piece that is ours, Kora being
 * everything beneath it. `FacilitatorController` calls this; this calls the
 * six rules (plus signature validity, `rules/signature-validity.rule.ts`) and,
 * for `/settle` only, the duplicate-settlement guard and the fee-payer signer.
 *
 * `/verify` and `/settle` share the same evaluation up to the point of
 * deciding the payload is good — `evaluate()` is that shared path, so a rule
 * added here is added to both endpoints by construction rather than by
 * remembering to update two call sites.
 */
@Injectable()
export class X402SvmVerifierService {
  constructor(
    @Inject(FACILITATOR_SOLANA_RPC) private readonly rpc: FacilitatorSvmRpcClient,
    @Inject(FEE_PAYER_SIGNER) private readonly signer: FeePayerSignerPort,
    private readonly duplicateSettlementGuard: DuplicateSettlementGuard,
  ) {}

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponseBody> {
    const outcome = await this.evaluate(payload, requirements);
    if (outcome.status === 'rejected') {
      return { isValid: false, invalidReason: outcome.invalidReason };
    }
    return { isValid: true, ...(outcome.payer ? { payer: outcome.payer } : {}) };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponseBody> {
    const network = requirements.network;
    const outcome = await this.evaluate(payload, requirements);
    if (outcome.status === 'rejected') {
      return { success: false, errorReason: outcome.invalidReason, network };
    }

    // Reserved only once the payload is known-good: a flood of malformed
    // payloads should not spend the 120s dedup window on garbage, and a
    // caller who fixes a rejected payload gets a real attempt, not a "you
    // already tried this" bounce for a transaction that never had a chance.
    const reserved = await this.duplicateSettlementGuard.reserve(
      outcome.decoded.rawTransactionBase64,
    );
    if (!reserved) {
      return { success: false, errorReason: X402_INVALID_REASON.DUPLICATE_SETTLEMENT, network };
    }

    const { signature } = await this.signer.signAndSend(outcome.decoded.rawTransactionBase64);
    return {
      success: true,
      network,
      transaction: signature as TxRef,
      ...(outcome.payer ? { payer: outcome.payer } : {}),
    };
  }

  private async evaluate(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Evaluation> {
    const schemeReason = checkSchemeAndNetwork(payload, requirements);
    if (schemeReason) {
      return { status: 'rejected', invalidReason: schemeReason };
    }

    const decoded = await decodeSvmPayload(payload, this.rpc);
    if (decoded.status === 'rejected') {
      return { status: 'rejected', invalidReason: decoded.invalidReason };
    }

    const feePayer = await this.signer.getFeePayerAddress();
    if (decoded.payload.feePayer !== feePayer) {
      return {
        status: 'rejected',
        invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER,
      };
    }

    const reason =
      checkSignatures(decoded.payload) ??
      checkInstructionLayout(decoded.payload.instructions) ??
      checkComputeBudget(decoded.payload.instructions) ??
      checkFeePayerIsolation(decoded.payload.instructions, decoded.payload.feePayer) ??
      checkTransferCorrectness(decoded.payload.instructions, requirements) ??
      checkMemo(decoded.payload.instructions, requirements);

    if (reason) {
      return { status: 'rejected', invalidReason: reason };
    }

    return {
      status: 'accepted',
      decoded: decoded.payload,
      payer: extractPayerAddress(decoded.payload.instructions),
    };
  }
}

function checkSchemeAndNetwork(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): X402InvalidReason | null {
  if (requirements.scheme !== SOLANA_EXACT_SCHEME) {
    return X402_INVALID_REASON.UNSUPPORTED_SCHEME;
  }
  if (!SUPPORTED_SVM_NETWORKS.includes(requirements.network)) {
    return X402_INVALID_REASON.INVALID_NETWORK;
  }
  if (payload.scheme !== requirements.scheme) {
    return X402_INVALID_REASON.INVALID_SCHEME;
  }
  if (payload.network !== requirements.network) {
    return X402_INVALID_REASON.INVALID_NETWORK;
  }
  return null;
}
