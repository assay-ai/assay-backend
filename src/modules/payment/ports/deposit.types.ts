import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';

/**
 * A deposit intent — the record behind a rail-A `exact` payment into
 * the treasury vault.
 *
 * **Not a `PaymentIntent`.** A `PaymentIntent` prices one paid tool call
 * against a provider and a fee split; a deposit has no provider, no tool and
 * no split — it is an agent funding their own ledger balance. Forcing it into
 * `payment_intents` would mean every column that names a provider, a tool or
 * a fee becomes nullable for exactly one kind of row, which is how a table
 * stops being able to say what it means. `deposit_intents` is its own table,
 * its own state machine (`domain/deposit-intent-transitions.ts`), and its own
 * repository — deliberately parallel to `PaymentIntentEntity`, not a subtype
 * of it.
 */
export enum DepositIntentStatus {
  CREATED = 'CREATED',
  SETTLING = 'SETTLING',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

export interface DepositIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly status: DepositIntentStatus;
  readonly statusReason: string | null;

  readonly agentId: string;
  /** CAIP-10. The ledger account credited once settlement is observed. */
  readonly agentAccount: AccountId;

  /** What the `402` requirements advertised. Always the chain's registered USDC. */
  readonly requestedAmount: Money;
  /**
   * What actually landed, once observed on chain. May exceed
   * `requestedAmount` — the SVM `exact` scheme tolerates overpayment and the
   * difference belongs to the agent. `null` until settlement is observed.
   */
  readonly settledAmount: Money | null;

  readonly chainId: ChainId;
  /** The settlement transaction signature, once known. */
  readonly chainTxRef: string | null;

  /**
   * Short-lived, and chain-dependent (`DEPOSIT_INTENT_TTL_MS`): 90 s on Solana,
   * bounded by the blockhash the client's transaction is signed over; 10 min on
   * eip155, where the buyer signs two wallet prompts and nothing on chain expires.
   */
  readonly expiresAt: Date;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateDepositIntentInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: AccountId;
  /** Asset must be the chain's registered USDC — refused before anything else, see `assertUsdc`. */
  readonly requestedAmount: Money;
  readonly chainId: ChainId;
  /** Defaults to `depositIntentTtlMs(chainId)` from now. */
  readonly expiresAt?: Date;
}

export interface DepositIntentTransitionContext {
  readonly reason?: string;
  readonly settledAmount?: Money;
  readonly chainTxRef?: string;
}
