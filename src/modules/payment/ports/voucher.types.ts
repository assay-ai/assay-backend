import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';

import { RequestCall } from '../domain/request-hash';

/**
 * Rail B — a signed off-chain promise to pay.
 *
 * The `Voucher` struct itself lives in `@modules/chains/ports/x402.types`
 * because the canonical byte encoding is a chain concern
 * (`ChainAdapter.buildVoucherMessage`). What lives here is what the *payment*
 * domain needs in order to decide whether a given voucher authorises a given
 * call.
 *
 * **The voucher layout is not final — see `x402.types.ts`.** v1's claim here
 * that it was turned out wrong once the on-chain channel program actually
 * existed: the payee and the buyer's sequence number both had to move
 * into the signed bytes, and a red team added `issued_at`. What is still true
 * is the shape of the guarantee: whatever the program verifies, this interface
 * is where the *payment* domain decides whether that signed struct authorises
 * the call in front of it.
 */
export interface SignedVoucher {
  readonly voucher: Voucher;
  /** base58 ed25519 signature over `ChainAdapter.buildVoucherMessage(voucher)`. */
  readonly signature: string;
}

/**
 * Everything needed to decide whether `signed` pays for this call.
 *
 * Every field except `signed` and `call` is what the *server* believes, from
 * the session and the tool catalogue — never from the request body. The whole
 * check is a comparison of what the agent signed against what the server
 * independently knows, and a value the client supplied on both sides of that
 * comparison would make it vacuous.
 */
export interface RedeemVoucherInput {
  readonly organizationId: string;

  readonly signed: SignedVoucher;
  /** The call being paid for. Hashed here; never taken from the voucher. */
  readonly call: RequestCall;

  readonly agentId: string;
  /** The authenticated caller. The voucher must name it as `payer`. */
  readonly agentAccount: AccountId;
  readonly providerId: string;
  readonly providerAccount: AccountId;
  readonly toolId: string;

  /** The x402 `resource` this tool is published under. */
  readonly resource: string;
  /**
   * This session's escrow PDA — `["escrow", agentAccount]` on the settlement
   * program. The voucher must name it as `payTo`.
   *
   * v1 named this `payTo` and compared it against the pooled platform vault;
   * there is no pooled vault on the paying path any more, and every buyer has
   * their own escrow. The program independently derives the same PDA from
   * `voucher.payer` and checks it there too, so a wrong value here can refuse
   * a good voucher but can never redirect a payment.
   */
  readonly escrowPda: AccountId;

  /**
   * What this call costs. **Exact**, not a ceiling — `redeem_voucher` moves
   * `voucher.amount` and nothing else, so the `upto` scheme (metering after
   * the fact) has no rail here.
   */
  readonly price: Money;
  readonly platformFee: Money;
  readonly chainId: ChainId;

  readonly idempotencyKey?: string | null;

  /**
   * The DELEGATE key bound to the calling agent credential (CAIP-10), or null.
   * A voucher signed by a delegate is accepted only from the credential that
   * proved possession of that key.
   */
  readonly boundDelegate?: AccountId | null;

  /** The agent credential that made the call, recorded on the intent. */
  readonly credentialId?: string | null;

  /**
   * The payer's escrow as the caller read it off the chain for THIS call, or
   * null when no escrow is open. Its own limits (`maxVoucherAmount`,
   * `maxPerWindow` and the window counter) bind every voucher at redemption,
   * so they are applied before the call is served (BUG-D1-03); `observedAt` is
   * what makes the window count exact (BUG-D1-02). Omitted, they are not
   * pre-checked.
   */
  readonly escrow?: EscrowChainBalance | null;

  /**
   * Awaited after every check and before the intent and its hold are written:
   * the MCP caller's spend-lock ownership check (round-two review N-4). A
   * rejection refuses the voucher with nothing recorded.
   */
  readonly beforeHold?: () => Promise<void>;
}
