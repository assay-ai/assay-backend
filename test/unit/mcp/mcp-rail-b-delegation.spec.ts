import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { delegationHint, delegationTerms } from '@modules/mcp/services/mcp-tool-call.service';

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
  ...overrides,
});

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
