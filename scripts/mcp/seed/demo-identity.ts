/**
 * The identity the public live demo calls as.
 *
 * ```bash
 * yarn demo:identity --expires-in-days=365            # mint; store it in DEMO_MCP_TOKEN
 * yarn demo:identity --expires-in-days=365            # again: refreshes the key's expiry
 * yarn demo:identity --expires-in-days=365 --rotate   # mint a new token, revoking nothing else
 * ```
 *
 * ## The demo key expires, and this script refreshes it
 *
 * Every key expires (at most `CREDENTIAL_MAX_LIFETIME_DAYS`), the demo's too,
 * so `--expires-in-days` is required: there is no default and no "never".
 * Re-running the script on a stack that already has the demo key does not
 * mint a new token (it cannot be recovered, and `DEMO_MCP_TOKEN` would have to
 * change): it moves the SAME key's expiry to now + that many days. Re-run it
 * before the printed expiry, or the homepage demo stops answering with
 * `MCP_CREDENTIAL_INVALID` on that day.
 *
 * ## A real credential, not a constructed session
 *
 * `McpToolCallService.call` takes the session as a plain parameter and
 * `McpSession` is a data interface, so a public endpoint could simply build one
 * and skip authentication entirely. **It must not.** `McpSessionPort.resolve`
 * has no null branch *on purpose* — its own doc comment: *"There is no
 * 'anonymous session': the return type has no null branch precisely so that no
 * caller can accidentally treat an unauthenticated request as a cheap one and
 * let it through to a code path that spends money."* A marketing page is not a
 * reason to grow one.
 *
 * So this writes a real organization, a real agent and a real
 * `agent_credentials` row. The demo endpoint reads the token out of config and
 * hands it to `resolve()` like every other caller. Nothing about the path is
 * special-cased, which is the whole architectural claim of the page.
 *
 * ## Deployment constraint, which is real and worth stating
 *
 * The credential lives in the **database**, so `AUTH_SESSION_SOURCE` must
 * include `db` — that is `db` or `both`. On a `config`-only deployment
 * `CompositeMcpSessionSource` never reaches the database and the demo token
 * resolves to nothing. `.env.example` says so beside `DEMO_MCP_TOKEN`.
 *
 * ## The spend policy IS the budget
 *
 * `SpendPolicyEnforcementService` is already in `McpToolCallService`'s
 * constructor, so it already gates this agent's calls. No second counter is
 * written here, and none should be: a second budget mechanism drifts from the
 * first, and the drift is discovered as an unbounded bill.
 *
 * The token is printed **once**, at mint. Only its SHA-256 digest is stored
 * (`agent_credentials.token_hash`), so a lost token is re-minted rather than
 * recovered — the same property a real user's credential has.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';

import { AgentCredentialEntity } from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import {
  agentCredentialHint,
  agentCredentialLast4,
  AGENT_CREDENTIAL_TOKEN_PREFIX,
} from '@modules/account/constants/agent-credential-token.constants';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { CREDENTIAL_MAX_LIFETIME_DAYS } from '@modules/account/constants/credential-expiry.constants';
import { DEFAULT_AGENT_SCOPES } from '@shared/auth/agent-scope';
import { digestToken } from '@shared/crypto/token-digest';

/** Stable across runs, so `.env` does not need editing on a re-seed. */
const DEMO_ORG_ID = '3d1f7c28-9a54-4c66-8b21-5f0e7a9c4d13';
const DEMO_AGENT_ID = '5c2b8e41-7d36-4a19-9e84-1b6f3c0a72d5';
const DEMO_CREDENTIAL_NAME = 'public live demo';

function mintToken(): string {
  return `${AGENT_CREDENTIAL_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

/**
 * `--expires-in-days=N`, required: 1 to `CREDENTIAL_MAX_LIFETIME_DAYS`, the
 * same bound a key minted through the API has.
 */
function expiryFromArgs(argv: readonly string[]): Date {
  const arg = argv.find((a) => a.startsWith('--expires-in-days='));
  const days = arg ? Number(arg.slice('--expires-in-days='.length)) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > CREDENTIAL_MAX_LIFETIME_DAYS) {
    throw new Error(
      `--expires-in-days=N is required, 1 to ${CREDENTIAL_MAX_LIFETIME_DAYS}: every key expires, ` +
        'the demo key too. Re-run this script before that day to refresh it.',
    );
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const rotate = process.argv.includes('--rotate');
  const expiresAt = expiryFromArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });

  try {
    const organizations = app.get(OrganizationRepository);
    const agents = app.get(AgentRepository);
    const credentials = app.get(AgentCredentialRepository);

    // ── The organization ─────────────────────────────────────────────────
    let org = await organizations.findOne({ where: { id: DEMO_ORG_ID } });
    if (!org) {
      org = new OrganizationEntity();
      Object.assign(org, { id: DEMO_ORG_ID, name: 'Assay public demo' });
      org = await organizations.save(org);
    }

    // ── The agent ────────────────────────────────────────────────────────
    //
    // `primaryAccountId` and `chainId` are not decoration: the DB session
    // source throws `walletNotLinked` without them, because the account is the
    // ledger balance a call is charged to. The demo spends from this account,
    // so it must be one the platform actually funds.
    let agent = await agents.findOne({ where: { id: DEMO_AGENT_ID, organizationId: DEMO_ORG_ID } });
    if (!agent) {
      const source = await agents.findOne({
        where: { organizationId: DEMO_ORG_ID },
      });
      agent = source ?? new AgentEntity();
      Object.assign(agent, {
        id: DEMO_AGENT_ID,
        organizationId: DEMO_ORG_ID,
        privyUserId: `demo:${DEMO_AGENT_ID}`,
        label: 'public live demo',
        status: 'ACTIVE',
      });
      agent = await agents.save(agent);
    }

    // `--account solana:<chain>:<address>` links the ledger account the demo
    // spends from. Deliberately an argument rather than a default: the account
    // is where real money leaves, and a seeder that picked one would be
    // choosing whose balance pays for a public page.
    const accountArg = process.argv.find((arg) => arg.startsWith('--account='));
    if (accountArg && !agent.primaryAccountId) {
      const account = accountArg.slice('--account='.length);
      const [namespace, reference] = account.split(':');
      await agents.linkPrimaryAccount(agent.id, account, `${namespace}:${reference}`);
      agent = (await agents.findOne({ where: { id: DEMO_AGENT_ID } })) ?? agent;
    }

    if (!agent.primaryAccountId || !agent.chainId) {
      throw new Error(
        `Demo agent ${DEMO_AGENT_ID} has no linked wallet (primaryAccountId / chainId). ` +
          'The DB session source refuses such an agent with WALLET_NOT_LINKED, because the ' +
          'account is the ledger balance the demo spends from. Link one and re-run (a ' +
          'wallet is proved by a signature, as at login). Pass ' +
          '--account=solana:<chain>:<address> to link one here.\n\n' +
          'NOTE: this script deliberately does NOT invent a balance. Crediting ' +
          'the demo agent without a matching on-chain deposit would add a ledger ' +
          'liability with no vault money behind it, which is precisely what the ' +
          'proof-of-reserves page reports as a shortfall. Fund it like any ' +
          'other agent, or use `yarn mcp:ledger fund` on a dev stack.',
      );
    }

    // ── The credential ───────────────────────────────────────────────────
    const existing = (await credentials.findBy({ organizationId: DEMO_ORG_ID })).find(
      (row) => row.name === DEMO_CREDENTIAL_NAME && !row.revokedAt,
    );

    if (existing && !rotate) {
      // The same key, a later expiry: DEMO_MCP_TOKEN stays as it is.
      await credentials.update({ organizationId: DEMO_ORG_ID, id: existing.id }, { expiresAt });
      // eslint-disable-next-line no-console
      console.log(
        [
          `organization ${DEMO_ORG_ID}`,
          `agent        ${DEMO_AGENT_ID} (${agent.primaryAccountId})`,
          `credential   ${existing.id} ${agentCredentialHint(existing.tokenLast4) ?? ''} (already minted)`,
          `expires      ${expiresAt.toISOString()} (refreshed; re-run before then)`,
          '',
          'The token itself is not recoverable — only its digest is stored.',
          'Re-run with --rotate to mint a new one.',
        ].join('\n'),
      );
      return;
    }

    const token = mintToken();
    const credential = new AgentCredentialEntity();
    Object.assign(credential, {
      id: randomUUID(),
      organizationId: DEMO_ORG_ID,
      agentId: DEMO_AGENT_ID,
      name: DEMO_CREDENTIAL_NAME,
      tokenLast4: agentCredentialLast4(token),
      tokenHash: digestToken(token),
      scopes: [...DEFAULT_AGENT_SCOPES],
      expiresAt,
    });
    await credentials.save(credential);

    // eslint-disable-next-line no-console
    console.log(
      [
        `organization  ${DEMO_ORG_ID}`,
        `agent         ${DEMO_AGENT_ID} (${agent.primaryAccountId})`,
        `credential    ${credential.id}`,
        `expires       ${expiresAt.toISOString()} (re-run this script before then to refresh it)`,
        '',
        'Put this in the API process environment. It is printed once:',
        '',
        `  DEMO_MCP_TOKEN=${token}`,
        `  DEMO_ORGANIZATION_ID=${DEMO_ORG_ID}`,
        '',
        'AUTH_SESSION_SOURCE must include `db` (that is `db` or `both`), or the',
        'composite session source never reaches this credential.',
      ].join('\n'),
    );
  } finally {
    // See `demo-broken-binding.ts` — the context does not always go quiet.
    await app.close().catch(() => undefined);
  }
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
