import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The demo credentials, read from the same file the server reads.
 *
 * Read rather than duplicated: a script that hard-coded the token would keep
 * working after the server's credential file changed, and would then be
 * demonstrating a session that no longer exists.
 */
export const SEED_DIR = join(__dirname, 'seed');

export interface DemoCredential {
  readonly token: string;
  readonly credentialId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: string;
  readonly label: string;
  /** The funded agent. The other one exists to demonstrate the refusal. */
  readonly fundable: boolean;
}

export const DEMO_CREDENTIALS: readonly DemoCredential[] = Object.entries(
  JSON.parse(
    readFileSync(process.env.MCP_CREDENTIALS_FILE ?? join(SEED_DIR, 'credentials.json'), 'utf8'),
  ) as Record<string, Omit<DemoCredential, 'token' | 'fundable'>>,
).map(([token, record]) => ({
  ...record,
  token,
  fundable: !token.endsWith('_broke'),
}));

export const FUNDED = DEMO_CREDENTIALS.find((credential) => credential.fundable) as DemoCredential;
export const UNFUNDED = DEMO_CREDENTIALS.find(
  (credential) => !credential.fundable,
) as DemoCredential;

export const MCP_URL = process.env.MCP_DEMO_URL ?? 'http://127.0.0.1:3200/';
