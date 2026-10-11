import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  LinkedAccount,
  resolveDepositChain,
  sessionAccounts,
} from '@modules/payment/domain/deposit-chain';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';

import { expectErrorCode } from '../helpers/expect-error-code';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

const DEVNET_ACCOUNT: AccountId = toAccountId(
  DEVNET,
  'AgentAccount1111111111111111111111111111111',
);
const MAINNET_ACCOUNT: AccountId = toAccountId(
  MAINNET,
  'AgentAccount2222222222222222222222222222222',
);

const ONE: readonly LinkedAccount[] = [{ chainId: DEVNET, accountId: DEVNET_ACCOUNT }];
const TWO: readonly LinkedAccount[] = [
  { chainId: DEVNET, accountId: DEVNET_ACCOUNT },
  { chainId: MAINNET, accountId: MAINNET_ACCOUNT },
];

describe('resolveDepositChain — chainId required only with two or more accounts', () => {
  it('infers the chain when the buyer has exactly one account and named none', () => {
    expect(resolveDepositChain(ONE, undefined)).toEqual({
      chainId: DEVNET,
      accountId: DEVNET_ACCOUNT,
    });
  });

  it('accepts a chainId that agrees with the one account', () => {
    expect(resolveDepositChain(ONE, DEVNET)).toEqual({
      chainId: DEVNET,
      accountId: DEVNET_ACCOUNT,
    });
  });

  it('refuses a chainId the buyer has no account on, even with one account', () => {
    // A deposit is irreversible and, with no cross-chain transfer, unbridgeable. A deposit to a
    // chain with no linked account is money nobody can ever withdraw.
    expectErrorCode(
      () => resolveDepositChain(ONE, MAINNET),
      PaymentErrorCode.PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED,
    );
  });

  it('requires a chainId once the buyer has two accounts', () => {
    // Required only when they have two. This is the whole difference between
    // the relaxed rule and an "always required" one.
    expectErrorCode(
      () => resolveDepositChain(TWO, undefined),
      PaymentErrorCode.PAYMENT_DEPOSIT_CHAIN_REQUIRED,
    );
  });

  it('picks the named account when the buyer has two — and not the first one', () => {
    // The loser, asserted. A resolver that returned `accounts[0]` whenever a
    // chainId was present would pass a test that only ever asked for devnet.
    expect(resolveDepositChain(TWO, MAINNET)).toEqual({
      chainId: MAINNET,
      accountId: MAINNET_ACCOUNT,
    });
    expect(resolveDepositChain(TWO, DEVNET)).toEqual({
      chainId: DEVNET,
      accountId: DEVNET_ACCOUNT,
    });
  });

  it('refuses a malformed chainId rather than treating it as absent', () => {
    // "not-a-caip-2" must not fall through to inference. An unparseable value
    // is a caller error, and silently inferring would deposit somewhere the
    // caller did not ask for.
    expectErrorCode(
      () => resolveDepositChain(ONE, 'mainnet'),
      PaymentErrorCode.PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED,
    );
  });

  it('refuses when the buyer has no linked account at all', () => {
    expectErrorCode(
      () => resolveDepositChain([], undefined),
      PaymentErrorCode.PAYMENT_DEPOSIT_ACCOUNT_NOT_LINKED,
    );
  });
});

describe('sessionAccounts', () => {
  it('yields exactly one entry today, built from the session’s own two fields', () => {
    // `agent_accounts` does not exist yet. This function is the seam: when the table lands,
    // its body changes and nothing above it does.
    const session: McpSession = {
      credentialId: 'cred-1',
      organizationId: '11111111-1111-1111-1111-111111111111',
      agentId: '22222222-2222-2222-2222-222222222222',
      agentAccount: DEVNET_ACCOUNT,
      chainId: DEVNET,
      label: 'buyer',
      callerKind: McpCallerKind.CONFIG,
    };

    expect(sessionAccounts(session)).toEqual([{ chainId: DEVNET, accountId: DEVNET_ACCOUNT }]);
  });
});
