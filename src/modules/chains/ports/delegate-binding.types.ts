import { AccountId } from './caip.types';

/**
 * What an agent signs, WITH THE DELEGATE KEY, to prove it holds that key before
 * its credential is bound to it (agent payment delegation).
 *
 * A proof pair of its own, beside the payout and stake-authority ones, for the
 * reason they give: a proof collected for one claim must not satisfy another.
 * It names the credential it binds, a single-use nonce and an expiry, and it is
 * a typed struct no escrow door accepts — so a binding proof can never also be
 * a voucher, a delegation or a limits change.
 */
export interface DelegateBindingChallenge {
  /** The `agent_credentials.id` being bound. */
  readonly credentialId: string;
  /** CAIP-10: the delegate key's account, on the agent's chain. */
  readonly delegate: AccountId;
  readonly nonce: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/**
 * The EIP-712 request the delegate key signs. Its domain is the binding's own
 * (`{name, version, chainId}`, no `verifyingContract`), never the escrow's.
 */
export interface DelegateBindingTypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: string };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, string>;
}
