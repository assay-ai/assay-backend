import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';
import { McpCallerKind } from '@modules/mcp/ports/mcp-session.port';
import {
  ConfigMcpSessionSource,
  McpCredentialSnapshot,
  loadMcpCredentials,
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
    tok_live_person: {
      credentialId: 'cred-2',
      organizationId: 'org-1',
      agentId: 'agent-1',
      agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1' as AccountId,
      chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId,
      label: 'dashboard',
      kind: 'human',
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
      // Review A-2: a config token is a machine unless its record says a
      // person uses it, so an agent process handed one is not a person.
      callerKind: McpCallerKind.AGENT,
    });
  });

  it('resolves a record marked "kind": "human" as a person', async () => {
    const session = await source.resolve('tok_live_person');

    expect(session.callerKind).toBe(McpCallerKind.CONFIG);
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

/**
 * Review A-2: the committed demo file is short, readable tokens trusted as a
 * person. The loader keeps any credentials file out of production and weak
 * tokens out of everything but a development stack.
 */
describe('loadMcpCredentials — what a credentials file may hold, and where', () => {
  const STRONG = 'k'.repeat(32);
  const RECORD = {
    credentialId: 'cred-1',
    organizationId: 'org-1',
    agentId: 'agent-1',
    agentAccount: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/agent-1',
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  };

  function file(content: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'mcp-credentials-')), 'credentials.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('loads nothing when no file is named, in production too', () => {
    expect(loadMcpCredentials(undefined, 'production')).toEqual({});
  });

  it('refuses any credentials file in production', () => {
    expect(() => loadMcpCredentials(file({ [STRONG]: RECORD }), 'production')).toThrow(
      /production/,
    );
  });

  it.each(['staging', 'qa'])('refuses a token under 32 characters (NODE_ENV=%s)', (env) => {
    expect(() => loadMcpCredentials(file({ short_demo_token: RECORD }), env)).toThrow(/32/);
  });

  it('accepts a token of 32 characters', () => {
    expect(Object.keys(loadMcpCredentials(file({ [STRONG]: RECORD }), 'staging'))).toEqual([
      STRONG,
    ]);
  });

  // The committed seed file drives the local stack, which runs as development.
  it.each(['development', 'local', 'test'])('admits short demo tokens on a %s stack', (env) => {
    expect(Object.keys(loadMcpCredentials(file({ short_demo_token: RECORD }), env))).toEqual([
      'short_demo_token',
    ]);
  });

  it('refuses a kind other than "human", rather than reading a typo as a machine', () => {
    expect(() =>
      loadMcpCredentials(file({ [STRONG]: { ...RECORD, kind: 'Human' } }), 'development'),
    ).toThrow(/kind/);
  });
});
