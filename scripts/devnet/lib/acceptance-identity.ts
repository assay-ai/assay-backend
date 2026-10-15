/**
 * Mints a working `Organization` + `Agent` + `AgentCredential` for the devnet
 * acceptance suite, without going through Privy.
 *
 * `bootIdentityContext()` boots against **this deployment's actual Postgres
 * database** — `DATABASE_*` from `.env.local` / `.env`, not a `*_test`
 * database — and `mintScriptIdentity()` writes real rows into it as normal
 * operation, exactly like `scripts/devnet/deposit.ts` and friends. There is
 * no separate database for this suite; running it means adding rows to the
 * same Postgres the live devnet API server reads.
 *
 * The minted agent is linked to a syntactically-valid but **fabricated**
 * CAIP-10 account (see `mintScriptIdentity`'s docstring for why) — there is
 * no real keypair behind it, and nothing downstream should ever expect it to
 * match a funded signer's address.
 *
 * `borrowOrganizationCredential()` is the one exception to "this file creates
 * what it uses": it mints a credential inside an organization that already
 * exists, so that a step can ask `/providers/me/*` a question about a provider
 * the run did not create. It hands back a `release()` that must be called.
 */
import { randomBytes } from 'node:crypto';
import { INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { databaseConfig } from '@config/database.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { type AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  AGENT_CREDENTIAL_STORED_PREFIX_LENGTH,
  AGENT_CREDENTIAL_TOKEN_PREFIX,
} from '@modules/account/constants/agent-credential-token.constants';
import { loadMcpCredentials } from '@modules/mcp/services/config-mcp-session.source';
import { digestToken } from '@shared/crypto/token-digest';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
  ],
})
class AcceptanceIdentityModule {}

export async function bootIdentityContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AcceptanceIdentityModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
}

export interface ScriptIdentity {
  organizationId: string;
  agentId: string;
  token: string; // bearer, use once — never logged in full
  /**
   * The agent's `primary_account_id` — the CAIP-10 its session carries as
   * `agentAccount`, and therefore **the ledger account every balance of this
   * identity lives on**: deposits credit it, holds are taken against it, and a
   * slash compensation is credited to it.
   *
   * Returned rather than left for a caller to re-read, because it is minted
   * here and there is no route that answers "which ledger account am I".
   * Fabricated in the sense that no keypair backs it (see the docstring
   * below) — but it is not a placeholder to the ledger, which knows accounts
   * only as strings and books real money against this one.
   */
  accountId: AccountId;
}

/**
 * A bearer token for an organization **this run did not create**, plus the way
 * to take it back.
 *
 * Separate from {@link ScriptIdentity} because the two have opposite
 * lifetimes. A minted identity is this run's own: its rows are the run's
 * evidence and they stay. This one borrows an organization that already
 * existed — its rows are scaffolding, and leaving a live credential behind on
 * somebody else's tenant is not scaffolding, it is a key.
 */
/**
 * How long a borrowed credential stays usable if nothing deletes it.
 *
 * See the `expiresAt` comment in {@link borrowOrganizationCredential} — this is
 * the SIGINT backstop, not the intended lifetime, which is one HTTP request.
 */
const BORROWED_CREDENTIAL_TTL_MS = 5 * 60_000;

export interface BorrowedScriptCredential {
  organizationId: string;
  agentId: string;
  token: string;
  /** Deletes the credential row this call added. Best-effort — never throws. */
  release(): Promise<void>;
}

/**
 * Mints a short-lived bearer credential **inside an organization that already
 * exists**, for the one case where a script has to speak as somebody else:
 * `/providers/me/*` is scoped by session, so a question about an *existing*
 * provider's stake cannot be asked from a freshly minted org.
 *
 * Everything about the token matches {@link mintScriptIdentity} — same recipe,
 * same session source — except that nothing new is created but the credential
 * row itself. It reuses an existing agent of that organization, and requires
 * one with a linked `primary_account_id`, because `DbCredentialMcpSessionSource`
 * 424s every authenticated call for an agent without one.
 *
 * **Call `release()` in a `finally`.** The row is a working bearer token on a
 * tenant this run does not own; it exists for the length of one HTTP request
 * and there is no reason for it to outlive that. `release()` swallows its own
 * failures deliberately — a credential that could not be cleaned up must not
 * replace the answer (or the error) the caller actually came for.
 *
 * The row also carries a short `expiresAt`, because a `finally` is not a
 * guarantee: it does not run on SIGINT. See the comment on that field.
 */
export async function borrowOrganizationCredential(
  app: INestApplicationContext,
  organizationId: string,
  label: string,
): Promise<BorrowedScriptCredential> {
  const agents = app.get(AgentRepository);
  const credentials = app.get(AgentCredentialRepository);

  const rows = await agents.find({ where: { organizationId } });
  if (rows.length === 0) {
    throw new Error(
      `organization ${organizationId} has no agent row, so no credential can be minted for it. ` +
        `A row in "providers" alone is not enough — some provider rows in this database were ` +
        `seeded without an organization or an agent behind them.`,
    );
  }

  const agent = rows.find((row) => row.primaryAccountId);
  if (!agent) {
    throw new Error(
      `none of the ${rows.length} agent(s) of organization ${organizationId} has a linked ` +
        `primary_account_id, and DbCredentialMcpSessionSource refuses every authenticated call ` +
        `(424 AUTH_WALLET_NOT_LINKED) for an agent without one`,
    );
  }

  const token = `${AGENT_CREDENTIAL_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const credential = await credentials.save(
    credentials.create({
      organizationId,
      agentId: agent.id,
      name: `devnet-acceptance-${label}`,
      prefix: token.slice(0, AGENT_CREDENTIAL_STORED_PREFIX_LENGTH),
      tokenHash: digestToken(token),
      scopes: [],
      // A backstop for the one path `release()` cannot cover. `release()` is
      // called from a `finally`, and a `finally` does not run on SIGINT —
      // Ctrl-C during a slow HTTP call is an ordinary way to end an operator
      // script, and it would otherwise leave a **never-expiring bearer token on
      // a tenant this run does not own**, with nothing sweeping it. Five
      // minutes is far longer than the single request this token exists for and
      // far shorter than anyone could notice; the row is normally deleted
      // seconds later, well before `CredentialExpirySweepService` would look at
      // it. `db-credential-mcp-session.source.ts` already refuses a credential
      // past `expiresAt`, so this is enforcement rather than annotation.
      expiresAt: new Date(Date.now() + BORROWED_CREDENTIAL_TTL_MS),
    }),
  );

  return {
    organizationId,
    agentId: agent.id,
    token,
    release: async () => {
      // Scoped criteria, per `docs/architecture.md` §"Multi-Organization Scoping":
      // a bare primary key is refused by `OrganizationScopedRepository`.
      await credentials.delete({ organizationId, id: credential.id }).catch(() => undefined);
    },
  };
}

/**
 * Mints an org + agent + first credential in one call, matching
 * `AgentCredentialsService.create()`'s token recipe exactly so the token
 * authenticates through `DbCredentialMcpSessionSource` under
 * `AUTH_SESSION_SOURCE=both` (which the devnet `.env` must set).
 *
 * Two departures from the naive "insert three rows" reading of `create()`,
 * both found by actually running this against the live devnet API rather
 * than assumed from the entity shapes:
 *
 * 1. **Org + agent go through `AgentRepository.createWithOrganization`**,
 *    not two independent `.save()` calls. That method already exists
 *    (the first-login path) and does exactly this insert pair inside
 *    one transaction — its own docstring is the reason not to duplicate it
 *    by hand: "a crash between two separate inserts would leave one of
 *    those two states behind permanently."
 *
 * 2. **The agent is minted with a linked (placeholder) wallet**, not the
 *    `primaryAccountId: null` a first Privy login leaves behind.
 *    `DbCredentialMcpSessionSource.resolve()` throws `AUTH_WALLET_NOT_LINKED`
 *    (424) for *any* authenticated call — not just wallet-specific routes —
 *    when `agents.primary_account_id` is null (verified live: a token minted
 *    without this step 424s on `GET /api/v1/agents`; with it, 200). A script
 *    identity that cannot complete a single authenticated request is not a
 *    usable identity, so this mints a syntactically valid but **fabricated**
 *    devnet CAIP-10 account via `AgentRepository.linkPrimaryAccount` —
 *    not a real keypair (that is `acceptance-keys.ts`, entirely
 *    separate), just enough for the session source's own gate to pass.
 *    Nothing in the acceptance suite reads this address back and
 *    expects it to match a funded signer's address.
 */
export async function mintScriptIdentity(
  app: INestApplicationContext,
  label: string,
  accountAddress?: string,
): Promise<ScriptIdentity> {
  const agents = app.get(AgentRepository);
  const credentials = app.get(AgentCredentialRepository);

  const agent = await agents.createWithOrganization({
    privyUserId: `did:devnet-script:${label}-${randomBytes(8).toString('hex')}`,
    email: null,
    organizationName: `devnet-acceptance-${label}`,
    createdVia: 'DEVNET_SCRIPT',
    label: `devnet-acceptance-${label}`,
  });

  const chainId = CHAIN_IDS.SOLANA_DEVNET;
  // A fabricated address is fine for an identity that never touches the chain,
  // and it is NOT fine for a buyer: since per-buyer escrows, `POST /deposits` derives the
  // escrow PDA from this very account (`["escrow", buyer]`) and a 20-byte hex
  // string is not a base58 pubkey, so the deposit fails with
  // `PAYMENT_ESCROW_NOT_OPEN` naming a base58 decode error. Callers that own a
  // real keypair pass its address; the rest keep the fabricated one.
  const accountId = toAccountId(chainId, accountAddress ?? randomBytes(20).toString('hex'));
  // Unlike the login path (`agent-provisioning.service.ts`), which treats a
  // failed link as non-fatal and lets the session fall back to
  // AUTH_WALLET_NOT_LINKED later, a failed link here should abort the mint,
  // not degrade silently — this identity's only purpose is authenticating.
  await agents.linkPrimaryAccount(agent.id, accountId, chainId);

  const token = `${AGENT_CREDENTIAL_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  await credentials.save(
    credentials.create({
      organizationId: agent.organizationId,
      agentId: agent.id,
      name: `devnet-acceptance-${label}`,
      prefix: token.slice(0, AGENT_CREDENTIAL_STORED_PREFIX_LENGTH),
      tokenHash: digestToken(token),
      scopes: [],
      expiresAt: null,
    }),
  );

  return { organizationId: agent.organizationId, agentId: agent.id, token, accountId };
}

/**
 * A **person** session for the provider routes, from a config-file record.
 *
 * Every provider write — registration, stake authority, payout address,
 * endpoint, bindings, stake intents, slash acknowledge and dispute — sits
 * behind `HumanSessionGuard`, which refuses the `AGENT` session a token from
 * {@link mintScriptIdentity} resolves to (review A-1, N-2). The suite cannot
 * mint a Privy login, so the person is a record in the API server's
 * `MCP_CREDENTIALS_FILE` marked `"kind": "human"`, and `envVar` names its
 * token. The API must run with `AUTH_SESSION_SOURCE=both` so it reads that
 * file beside the database credentials.
 *
 * The record's organization and agent rows are created here when they do not
 * exist yet, with the record's own ids, so the session names a real tenant.
 * An organization that is **already a provider** is refused before anything
 * is funded: steps 1–4 register and stake from scratch, so each full run needs
 * a fresh record (a new organization id in the file, and an API restart to
 * load it).
 *
 * The token is read from the environment and never logged.
 */
export async function adoptConfigPersonIdentity(
  app: INestApplicationContext,
  envVar: string,
  label: string,
): Promise<ScriptIdentity> {
  const token = process.env[envVar];
  if (!token) {
    throw new Error(
      `${envVar} is not set. Provider routes accept only a person session, so this script ` +
        `needs a token from the API server's MCP_CREDENTIALS_FILE whose record is marked ` +
        `"kind": "human" and names an organization that is not a provider yet ` +
        `(AUTH_SESSION_SOURCE=both on the server).`,
    );
  }

  // The API server's own loader, so this refuses exactly what the server refuses.
  const record = loadMcpCredentials(process.env.MCP_CREDENTIALS_FILE)[token];
  if (!record) {
    throw new Error(
      `${envVar} is not a token in MCP_CREDENTIALS_FILE (${process.env.MCP_CREDENTIALS_FILE ?? 'unset'})`,
    );
  }
  if (record.kind !== 'human') {
    throw new Error(
      `${envVar} names credential ${record.credentialId}, which is not marked "kind": "human" ` +
        `and so resolves as an agent; provider routes refuse it`,
    );
  }

  const dataSource = app.get<DataSource>(getDataSourceToken('postgres'));
  const registered: unknown[] = await dataSource.query(
    'SELECT 1 FROM providers WHERE organization_id = $1',
    [record.organizationId],
  );
  if (registered.length > 0) {
    throw new Error(
      `organization ${record.organizationId} (credential ${record.credentialId}) is already a ` +
        `provider. This run registers and stakes from scratch: add a fresh "kind": "human" ` +
        `record with a new organization id, restart the API server, and point ${envVar} at it.`,
    );
  }

  await dataSource.query(
    `INSERT INTO organizations (id, name, status, created_via)
     VALUES ($1, $2, 'ACTIVE', 'DEVNET_SCRIPT')
     ON CONFLICT (id) DO NOTHING`,
    [record.organizationId, `devnet-acceptance-${label}`],
  );
  await dataSource.query(
    `INSERT INTO agents
       (id, organization_id, privy_user_id, label, status, primary_account_id, chain_id)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.agentId,
      record.organizationId,
      `did:devnet-script:${label}-${randomBytes(8).toString('hex')}`,
      `devnet-acceptance-${label}`,
      record.agentAccount,
      record.chainId,
    ],
  );
  const owner: Array<{ organization_id: string }> = await dataSource.query(
    'SELECT organization_id FROM agents WHERE id = $1',
    [record.agentId],
  );
  if (owner[0]?.organization_id !== record.organizationId) {
    throw new Error(
      `agent ${record.agentId} of credential ${record.credentialId} belongs to another ` +
        `organization than the record says (${record.organizationId})`,
    );
  }

  return {
    organizationId: record.organizationId,
    agentId: record.agentId,
    token,
    accountId: record.agentAccount,
  };
}
