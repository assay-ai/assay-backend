import { AccountId, ChainId } from './caip.types';
import { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from './x402.types';

/**
 * The x402 facilitator — `/verify`, `/settle`, `/supported`.
 *
 * One implementation wraps our self-hosted Kora service on Solana;
 * another wraps a third-party HTTP facilitator. The domain never learns which,
 * and never learns whether settlement was a Solana transaction or an EVM one.
 */
export interface FacilitatorPort {
  readonly name: string;

  supports(chainId: ChainId, scheme: string): Promise<boolean>;

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;

  /**
   * The account that will act as fee payer. SVM has to advertise this in
   * `extra.feePayer` so the client leaves the slot free and does not sign over
   * an account the facilitator must occupy.
   */
  getFeePayer(chainId: ChainId): Promise<AccountId>;
}

/** DI token for the facilitator a chain resolves to. */
export const FACILITATOR_PORT = 'FACILITATOR_PORT';
