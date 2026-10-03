import { Type } from 'class-transformer';
import { IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

import { ChainId } from '../../ports/caip.types';
import { PaymentPayload, PaymentRequirements } from '../../ports/x402.types';
import { FacilitatorRequestBody } from '../facilitator.wire';

/**
 * The one request-body shape both `POST /verify` and `POST /settle` accept —
 * `facilitator.wire.ts` defines a single `FacilitatorRequestBody` for both, so
 * one DTO file covers both endpoints rather than the usual one-file-per-action
 * split (`docs/architecture.md` §DTO Pattern).
 *
 * Validation here is deliberately shallow: it enforces that the request
 * *describes a payment at all* (the wire contract's bar for a 4xx). Whether
 * that payment is a good one — a valid transaction, the right amount, the
 * right mint — is not a shape question; it is answered by `X402SvmVerifierService`
 * and returned as `isValid: false` / `success: false`, a 200, never a
 * validation error.
 */
export class PaymentPayloadDto implements PaymentPayload {
  @IsNumber()
  x402Version: number;

  @IsString()
  scheme: string;

  @IsString()
  network: ChainId;

  // Chain-specific and opaque by design (`x402.types.ts`) — only the
  // corresponding `ChainAdapter`/facilitator rule may look inside it.
  @IsObject()
  payload: Record<string, unknown>;
}

export class PaymentRequirementsDto implements PaymentRequirements {
  @IsString()
  scheme: string;

  @IsString()
  network: ChainId;

  @IsString()
  amount: string;

  @IsString()
  asset: string;

  @IsString()
  payTo: string;

  @IsString()
  resource: string;

  @IsNumber()
  maxTimeoutSeconds: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}

export class FacilitatorRequestBodyDto implements FacilitatorRequestBody {
  @IsNumber()
  x402Version: number;

  @ValidateNested()
  @Type(() => PaymentPayloadDto)
  paymentPayload: PaymentPayloadDto;

  @ValidateNested()
  @Type(() => PaymentRequirementsDto)
  paymentRequirements: PaymentRequirementsDto;
}
