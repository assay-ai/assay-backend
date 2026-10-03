import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import {
  ConfigMcpSessionSource,
  McpCredentialSnapshot,
} from '@modules/mcp/services/config-mcp-session.source';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The credential check.
 *
 * Small, and the smallest thing in the milestone that must not fail open: every
 * tool call spends the balance this resolves to. The tests are all one shape —
 * *does it refuse* — because there is exactly one way to be right and many ways
 * to be accidentally permissive.
 */
describe('ConfigMcpSessionSource — the token decides whose balance is spent', () => {
  const SNAPSHOT: McpCredentialSnapshot = {
    tok_live_abc: {
      credentialId: 'cred-1',
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1' as AccountId,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId,
      label: 'research bot',
    },
  };

  const source = new ConfigMcpSessionSource(SNAPSHOT);

  it('resolves a configured token to its agent and account', async () => {
    const session = await source.resolve('tok_live_abc');

    expect(session).toEqual({
      credentialId: 'cred-1',
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1',
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      label: 'research bot',
    });
  });

  it('refuses an absent token', async () => {
    await expectErrorCodeAsync(() => source.resolve(null), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses an unknown token', async () => {
    await expectErrorCodeAsync(() => source.resolve('tok_live_xyz'), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses a token that is a prefix of a valid one', async () => {
    await expectErrorCodeAsync(() => source.resolve('tok_live_ab'), 'MCP_CREDENTIAL_INVALID');
  });

  it('refuses every token when nothing is configured', async () => {
    const empty = new ConfigMcpSessionSource({});

    await expectErrorCodeAsync(() => empty.resolve('tok_live_abc'), 'MCP_CREDENTIAL_INVALID');
  });
});
