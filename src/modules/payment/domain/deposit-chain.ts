import { AccountId, ChainId, isChainId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { PaymentErrors } from '../errors/payment.errors';

/**
 * Which chain a `POST /deposits` is for.
 *
 * ## The rule
 *
 * `chainId` is inferred from the session while the buyer has one account, and
 * required only once they have two. It is deliberately not "always required,
 * no default, no inference from the session".
 *
 * The principle is parity with what Solana does today: a
 * session carries one account on one chain and the deposit follows it. Making
 * the field unconditionally required would break every existing caller to solve
 * a problem no buyer has yet — and the problem it solves (money deposited to
 * the wrong chain, irreversibly, with no bridge between chains) only exists once a
 * buyer holds two accounts. At that moment the field becomes required, loudly.
 *
 * ## Why a domain function and not a controller branch
 *
 * `test/unit/shared/api/surface-consistency.spec.ts` enforces *"no controller
 * throws — errors come from services, via a domain catalog."* A narrowing that
 * refuses is a domain rule about what a value must be, so it belongs here
 * beside `readRequiredExtra` and `asPayloadChainId` (`domain/deposit-wire.ts`).
 *
 * ## The seam for multi-account buyers
 *
 * {@link sessionAccounts} is the only function here that knows a session has
 * one account. `agent_accounts` and `McpSession.accounts` do not exist yet;
 * when they land, that function's body changes and
 * {@link resolveDepositChain} — which is already written for N — does not.
 */

/** One chain the buyer can be paid back on, and the account on it. */
export interface LinkedAccount {
  readonly chainId: ChainId;
  readonly accountId: AccountId;
}

/**
 * Every chain this session can deposit on.
 *
 * **Exactly one entry today.** `McpSession` carries `agentAccount` and
 * `chainId`, singular, because that is what `agents.primary_account_id` and
 * `agents.chain_id` hold. Replacing this body with a read of `agent_accounts`
 * returns N; nothing that calls it changes.
 */
export function sessionAccounts(session: McpSession): readonly LinkedAccount[] {
  return [{ chainId: session.chainId, accountId: session.agentAccount }];
}

/**
 * The account this deposit credits, or a refusal.
 *
 * ```text
 * 0 accounts                     → PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED (409)
 * 1 account,  no chainId         → that account
 * 1 account,  chainId matches    → that account
 * 1 account,  chainId is other   → PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED (409)
 * N accounts, no chainId         → PAYMENT_DEPOSIT_CHAIN_REQUIRED     (400)
 * N accounts, chainId matches    → that account
 * N accounts, chainId is other   → PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED (409)
 * ```
 *
 * A malformed `chainId` takes the `NOT_LINKED` branch: it matches no linked
 * account, and that is the honest answer. It deliberately does **not** fall
 * through to inference — silently inferring past a value the caller typed is
 * how money lands on a chain nobody asked for.
 */
export function resolveDepositChain(
  accounts: readonly LinkedAccount[],
  requested: string | undefined,
): LinkedAccount {
  const chains = accounts.map((account) => account.chainId).join(', ');

  if (requested === undefined) {
    if (accounts.length === 1) {
      return accounts[0];
    }
    if (accounts.length === 0) {
      throw PaymentErrors.depositAccountNotLinked({ chains });
    }
    throw PaymentErrors.depositChainRequired({ chains });
  }

  const match = isChainId(requested)
    ? accounts.find((account) => account.chainId === requested)
    : undefined;

  if (!match) {
    throw PaymentErrors.depositAccountNotLinked({ chainId: requested, chains });
  }
  return match;
}
