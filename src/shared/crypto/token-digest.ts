import { createHash } from 'node:crypto';

/**
 * The one-line hash every bearer-token source must agree on.
 *
 * MCP session lookup and agent-credential issuance both index tokens by this
 * digest rather than by the plaintext value, and a future session source that
 * authenticates against `agent_credentials.token_hash` will need to reproduce
 * it exactly. If the two copies of this line ever drift apart, a token minted
 * on one path silently stops authenticating on the other — so it is written
 * once, here, and every call site imports it.
 */
export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
