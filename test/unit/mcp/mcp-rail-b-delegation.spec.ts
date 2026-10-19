import { getAddress } from 'viem';

import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  ASSAY_APP_SENTENCE,
  VoucherRequirement,
  checksummedRequirement,
  delegationHint,
  delegationTerms,
  paymentKeyNotice,
} from '@modules/mcp/services/mcp-tool-call.service';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';

const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
const PAYER = `${EVM}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId;
const DELEGATE = `${EVM}:0x5555555555555555555555555555555555555555` as AccountId;

const session = (overrides: Partial<McpSession> = {}): McpSession => ({
  credentialId: 'cred-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: PAYER,
  chainId: EVM,
  label: null,
  callerKind: McpCallerKind.AGENT,
  paymentsAllowed: true,
  storedCredential: true,
  ...overrides,
});

const WEB = 'https://app.assay.test';
const CREDENTIAL = '7b0c5f8e-3d2a-4b6c-9e1f-0a1b2c3d4e5f';

/**
 * PAYMENT_REQUIRED on eip155 tells the agent who may sign: the payer (the
 * user's escrow), a delegate the payer authorised on chain, or the payer's
 * EIP-1271 wallet — and which delegate key is bound to this credential.
 */
describe('rail-B PAYMENT_REQUIRED — agent payment delegation', () => {
  it('names the accepted signers and the bound delegate on eip155', () => {
    expect(delegationTerms(session({ delegateAccount: DELEGATE }))).toEqual({
      signers: ['payer', 'delegate'],
      delegate: DELEGATE,
    });
    expect(delegationHint(session({ delegateAccount: DELEGATE }))).toContain(DELEGATE);
    expect(delegationHint(session({ delegateAccount: DELEGATE }))).toContain(PAYER);
  });

  it('says how to bind a delegate when none is bound', () => {
    expect(delegationTerms(session())).toEqual({
      signers: ['payer', 'delegate'],
      delegate: null,
    });
    expect(delegationHint(session())).toContain('POST /agents/me/delegate');
  });

  it('adds nothing on Solana, whose escrow has no delegation', () => {
    const solana = session({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      agentAccount:
        `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(delegationTerms(solana)).toEqual({});
    expect(delegationHint(solana)).toBe('');
  });
});

/**
 * The enable-paid link on PAYMENT_REQUIRED (spec §7.10 item 2, R-PAY-4, H2):
 * only on eip155, only with no delegate bound, and only for a payment client.
 */
describe('rail-B PAYMENT_REQUIRED — the enable-paid fixUrl', () => {
  it('payment client, no delegate → fixUrl exact and sentence appended', () => {
    const notice = paymentKeyNotice(session({ credentialId: CREDENTIAL }), WEB);
    const fixUrl = `${WEB}/agents/enable-paid?credential=${CREDENTIAL}`;
    expect(notice).toEqual({
      fixUrl,
      sentence: ` Paid calls need a payment key on your computer: ${fixUrl}`,
    });
  });

  it('third-party grant → no fixUrl, "Paid tools need the Assay app on your computer."', () => {
    const notice = paymentKeyNotice(
      session({ credentialId: CREDENTIAL, paymentsAllowed: false }),
      WEB,
    );
    expect(notice).toEqual({
      fixUrl: null,
      sentence: ' Paid tools need the Assay app on your computer.',
    });
    expect(ASSAY_APP_SENTENCE).toBe(' Paid tools need the Assay app on your computer.');
  });

  it('fails closed: paymentsAllowed missing or not exactly true → no fixUrl', () => {
    for (const paymentsAllowed of [undefined, 'true', 1, null]) {
      const notice = paymentKeyNotice(
        session({ credentialId: CREDENTIAL, paymentsAllowed: paymentsAllowed as never }),
        WEB,
      );
      expect(notice).toEqual({ fixUrl: null, sentence: ASSAY_APP_SENTENCE });
    }
  });

  it('no stored credential (a person or config session) or no WEB_APP_URL → no fixUrl', () => {
    expect(paymentKeyNotice(session({ storedCredential: undefined }), WEB).fixUrl).toBeNull();
    expect(paymentKeyNotice(session({ credentialId: CREDENTIAL }), undefined).fixUrl).toBeNull();
  });

  it('delegate bound → no fixUrl and no sentence, for any client', () => {
    for (const paymentsAllowed of [true, false]) {
      expect(
        paymentKeyNotice(session({ delegateAccount: DELEGATE, paymentsAllowed }), WEB),
      ).toEqual({ fixUrl: null, sentence: '' });
    }
  });

  it('nothing on Solana', () => {
    const solana = session({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      agentAccount:
        `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(paymentKeyNotice(solana, WEB)).toEqual({ fixUrl: null, sentence: '' });
  });

  it('no chain adapter call on this path (spy)', () => {
    const list = jest.spyOn(EscrowDelegationService.prototype, 'list');
    try {
      paymentKeyNotice(session({ credentialId: CREDENTIAL }), WEB);
      paymentKeyNotice(session({ paymentsAllowed: false }), WEB);
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
  });
});

/**
 * Every eip155 address an agent is asked to sign is EIP-55: `assay-mcp`'s
 * signer accepts no other spelling (Task 2.3, M5).
 */
describe('rail-B PAYMENT_REQUIRED — EIP-55 addresses', () => {
  const lower = (account: string) => account.toLowerCase();
  const ASSET = `${EVM}/erc20:0x915e5d10c1b03b4f4c7e1f1d3b2a8c6f7e9d0a1b`;
  const requirement = (overrides: Partial<VoucherRequirement> = {}): VoucherRequirement => ({
    rail: 'B',
    scheme: 'voucher',
    network: EVM,
    payer: lower(PAYER) as AccountId,
    payTo: `${EVM}:0x8ba1f109551bd432803012645ac136ddd64dba72` as AccountId,
    provider: `${EVM}:0xab5801a7d398351b8be11c439e05c5b3259aec9b` as AccountId,
    providerId: 'provider-1',
    amount: { amount: '1000', asset: ASSET as never, decimals: 6 },
    resource: '/mcp/tools/get_weather',
    requestHash: `sha256:${'0'.repeat(64)}`,
    seq: '7',
    maxTimeoutSeconds: 300,
    signers: ['payer', 'delegate'],
    delegate: lower(DELEGATE) as AccountId,
    ...overrides,
  });

  it('checksums payTo, asset, payer, provider and delegate', () => {
    expect(checksummedRequirement(requirement())).toEqual({
      ...requirement(),
      payer: PAYER,
      payTo: `${EVM}:0x8ba1f109551bD432803012645Ac136ddd64DBA72`,
      provider: `${EVM}:0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B`,
      amount: {
        amount: '1000',
        asset: `${EVM}/erc20:${getAddress('0x915e5d10c1b03b4f4c7e1f1d3b2a8c6f7e9d0a1b')}`,
        decimals: 6,
      },
      delegate: DELEGATE,
    });
  });

  it('keeps the asset namespace lower case and a null delegate null', () => {
    const out = checksummedRequirement(requirement({ delegate: null }));
    expect(out.delegate).toBeNull();
    expect(out.amount.asset).toMatch(/\/erc20:0x/);
  });

  it('is idempotent on checksummed input', () => {
    const once = checksummedRequirement(requirement());
    expect(checksummedRequirement(once)).toEqual(once);
  });

  it('leaves a Solana requirement unchanged', () => {
    const solana = requirement({
      network: CHAIN_IDS.SOLANA_DEVNET,
      payer: `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(checksummedRequirement(solana)).toBe(solana);
  });
});
