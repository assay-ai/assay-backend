import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AgentRepository,
  AgentWithOrganization,
} from '@database/postgres/repositories/agent.repository';
import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';

import { PRIVY_AUTH_CONFIG, PrivyAuthConfig } from '../domain/privy-auth.config';
import { PrivyClaims } from '../domain/privy-claims';
import { AuthErrors } from '../errors/auth.errors';
import { PrivyIdentityFacts, PrivyUserDirectory } from './privy-user.directory';

/** How this organization came to exist, recorded on the row. */
export const CREATED_VIA_PRIVY_SIGNUP = 'PRIVY_SIGNUP';

/** The label of a newly provisioned agent, until the person renames it. */
export const DEFAULT_AGENT_LABEL = 'My agent';

/**
 * At most one wallet lookup per identity per minute.
 *
 * An agent whose wallet is never linked would otherwise pay a Privy round trip
 * on **every** request — and a client retrying in a loop would turn its own
 * failures into a request flood at a third party. In-memory and per-process on
 * purpose: it is a politeness bound, not a correctness one, so it does not
 * justify a Redis dependency on the auth path.
 */
const WALLET_LOOKUP_COOLDOWN_MS = 60_000;

/**
 * The floor for a lookup the **client asked for** — `POST /auth/wallet/link`.
 *
 * A first login is a race that the session path always loses: Privy issues the
 * access token before it records the wallet (measured at 1–2 s for a Phantom
 * SIWS login, longer for an embedded wallet, which is created client-side
 * after the token exists). The session path's own retry then cannot run for a
 * full minute, so a correctly provisioned account answers
 * `AUTH_WALLET_NOT_LINKED` to everything it is asked for that minute.
 *
 * The browser is the one party that knows when the wallet appeared, so it is
 * allowed to say so — and this is the bound on how often it may. It is far
 * shorter than {@link WALLET_LOOKUP_COOLDOWN_MS} because it is paid only when
 * a human has just signed in, and it is not zero because "the client asks" is
 * exactly the shape a retry loop takes.
 */
export const WALLET_REFRESH_COOLDOWN_MS = 3_000;

/** Per-call overrides for {@link AgentProvisioningService.resolve}. */
export interface ResolveOptions {
  /**
   * Floor between two Privy lookups for this identity, in milliseconds.
   * Defaults to {@link WALLET_LOOKUP_COOLDOWN_MS}; `POST /auth/wallet/link`
   * passes {@link WALLET_REFRESH_COOLDOWN_MS}. Nothing else may lower it —
   * the value is a constant at each call site, never a number off the wire.
   */
  readonly lookupCooldownMs?: number;
}

/** Cooldown map size at which the oldest half is dropped. Bounds memory on a large tenant. */
const COOLDOWN_MAP_LIMIT = 10_000;

/**
 * First login creates the tenant.
 *
 * The organization is created automatically at sign-up, attached to the
 * multi-tenant foundation. That foundation is the `organization_id` column on
 * every table and the repository that refuses a query without it — what it never had was a row on the other end, so this is
 * where an organization first becomes a thing that exists rather than an id
 * somebody typed into a credential file.
 *
 * ## The organization is created, never chosen
 *
 * Nothing in the request names a tenant. A signup that let the caller pick its
 * `organizationId` would hand any authenticated stranger every other tenant's
 * balances and receipts — the precise failure `SessionAuthGuard`'s docstring
 * and `OrganizationScopedRepository` exist together to make impossible. One
 * new identity, one new organization, and joining an existing organization is
 * an invitation flow that does not exist yet.
 *
 * ## Concurrent first logins
 *
 * Two requests for the same brand-new DID both see "no agent" and both try to
 * create. The unique index on `privy_user_id` decides; the loser catches
 * `23505`, re-reads, and both requests resolve to the same agent and the same
 * organization. The loser's organization row is rolled back with its
 * transaction, so a lost race leaves no orphan tenant behind.
 */
@Injectable()
export class AgentProvisioningService {
  private readonly logger = new Logger(AgentProvisioningService.name);

  /** `privyUserId → last wallet-lookup attempt`. See {@link WALLET_LOOKUP_COOLDOWN_MS}. */
  private readonly lastWalletLookupAt = new Map<string, number>();

  constructor(
    private readonly agents: AgentRepository,
    private readonly directory: PrivyUserDirectory,
    @Inject(PRIVY_AUTH_CONFIG) private readonly config: PrivyAuthConfig,
  ) {}

  /**
   * The agent behind a verified identity, creating it and its organization on
   * first sight.
   *
   * Called only with claims that have already been proven genuine — this class
   * never sees an unverified token and has no opinion about one.
   */
  async resolve(claims: PrivyClaims, options: ResolveOptions = {}): Promise<AgentWithOrganization> {
    const cooldownMs = options.lookupCooldownMs ?? WALLET_LOOKUP_COOLDOWN_MS;

    const existing = await this.agents.findWithOrganization(claims.subject);
    if (existing) {
      await this.enrich(existing, cooldownMs);
      this.stampLogin(existing.agent.id);
      return existing;
    }

    const facts = await this.lookupIdentity(claims.subject, cooldownMs);
    const created = await this.create(claims, facts?.email ?? null);

    const address = this.addressForConfiguredChain(facts);
    if (address) {
      await this.link(created.agent.id, address, created);
    }

    return created;
  }

  private async create(claims: PrivyClaims, email: string | null): Promise<AgentWithOrganization> {
    try {
      const agent = await this.agents.createWithOrganization({
        privyUserId: claims.subject,
        email,
        organizationName: organizationNameFor(email, claims.subject),
        createdVia: CREATED_VIA_PRIVY_SIGNUP,
        // The person renames it in the dashboard. Not the email: an agent is
        // a program, and the label is shown wherever the agent is named.
        label: DEFAULT_AGENT_LABEL,
      });

      this.logger.log(`Provisioned organization ${agent.organizationId} on first login`);
      return { agent, organizationStatus: 'ACTIVE' };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        this.logger.error(`Provisioning failed: ${describe(error)}`);
        throw AuthErrors.provisioningFailed();
      }

      // Lost the race — the winner's row is committed by now.
      const raced = await this.agents.findWithOrganization(claims.subject);
      if (!raced) {
        throw AuthErrors.provisioningFailed();
      }
      return raced;
    }
  }

  /**
   * A later login for an agent that still has no wallet: try once more.
   *
   * The alternative is that an identity which linked a wallet *after* signing
   * up stays unusable forever, with no path back through this code. Bounded by
   * the cooldown, and skipped entirely once an account is linked.
   */
  private async enrich(resolved: AgentWithOrganization, cooldownMs: number): Promise<void> {
    if (resolved.agent.primaryAccountId) return;

    const facts = await this.lookupIdentity(resolved.agent.privyUserId, cooldownMs);
    const address = this.addressForConfiguredChain(facts);
    if (!address) return;

    await this.link(resolved.agent.id, address, resolved);
  }

  /**
   * The linked wallet **on the namespace of the configured chain**, or `null`.
   *
   * One Privy identity carries a wallet per namespace, and the two are not
   * interchangeable: on the first real login against `eip155:46630` this read
   * the Solana wallet and wrote
   * `eip155:46630:DnTdUmwEBCitxN4tgUfaXrWRSC1JrZgTMD2uPsHC5i73`. That account
   * parses nowhere — every money path refused it with "Address is not valid on
   * this chain" — and nothing between here and the chain would have caught it,
   * because `agents.primary_account_id` is a varchar and the namespace is only
   * checked where it is finally used.
   *
   * `null` when the identity has no wallet on that namespace: an agent with no
   * account is refused by name (`AUTH_WALLET_NOT_LINKED`) and can be linked by
   * a later login, which is recoverable in a way a malformed account is not.
   */
  private addressForConfiguredChain(facts: PrivyIdentityFacts | null): string | null {
    if (!facts) return null;
    const chainId = this.config.defaultChainId ?? '';
    const namespace = chainId.slice(0, chainId.indexOf(':'));
    if (namespace === 'eip155') return facts.evmAddress;
    if (namespace === 'solana') return facts.solanaAddress;
    return null;
  }

  /**
   * Writes the account onto the row **and** onto the object being returned, so
   * the request that discovered the wallet is the first one that can use it
   * rather than the one after it.
   */
  private async link(
    agentId: string,
    address: string,
    resolved: AgentWithOrganization,
  ): Promise<void> {
    const chainId = this.config.defaultChainId;
    if (!chainId) {
      // `PRIVY_DEFAULT_CHAIN_ID` is required whenever Privy is enabled, so
      // this is unreachable in a configured deployment. It is here because the
      // alternative to refusing is writing `":<address>"` into
      // `primary_account_id` — a CAIP-10 identity with no chain, which every
      // downstream parse would reject far from where it was created.
      this.logger.warn('No PRIVY_DEFAULT_CHAIN_ID configured; leaving the wallet unlinked');
      return;
    }

    const accountId = `${chainId}:${address}`;

    try {
      await this.agents.linkPrimaryAccount(agentId, accountId, chainId);
    } catch (error) {
      // A failed link is not a failed login: the session simply refuses the
      // spending paths with `AUTH_WALLET_NOT_LINKED` until the next attempt.
      this.logger.warn(`Could not link wallet for agent ${agentId}: ${describe(error)}`);
      return;
    }

    resolved.agent.primaryAccountId = accountId;
    resolved.agent.chainId = chainId;
  }

  private async lookupIdentity(privyUserId: string, cooldownMs: number) {
    if (!this.config.userLookupEnabled) return null;

    const now = Date.now();
    const last = this.lastWalletLookupAt.get(privyUserId) ?? 0;
    // One map, two thresholds. A refresh that beats the session path's
    // cooldown still *stamps* it, so the two cannot add up to more traffic at
    // Privy than the shorter of them allows — and a stamp only ever withholds
    // a lookup, never grants a login.
    if (now - last < cooldownMs) return null;

    this.rememberLookup(privyUserId, now);
    return this.directory.lookup(privyUserId);
  }

  private rememberLookup(privyUserId: string, at: number): void {
    if (this.lastWalletLookupAt.size >= COOLDOWN_MAP_LIMIT) {
      // Cheapest bound that cannot grow without limit. Dropping entries only
      // ever permits an extra lookup, never an extra login.
      this.lastWalletLookupAt.clear();
    }
    this.lastWalletLookupAt.set(privyUserId, at);
  }

  /**
   * Fire-and-forget: the login stamp is a dashboard nicety and must never fail
   * a request or add latency to one. Same treatment
   * `agent_credentials.last_used_at` gets.
   */
  private stampLogin(agentId: string): void {
    void this.agents.stampLogin(agentId, new Date()).catch((error: unknown) => {
      this.logger.debug(`Could not stamp last_login_at for ${agentId}: ${describe(error)}`);
    });
  }
}

/**
 * A tenant name nobody typed.
 *
 * There is no naming step in a login, so it comes from the identity: the
 * email's local part where there is one, the DID's tail otherwise. It is a
 * label — renaming it changes nothing about authorisation — and it exists so a
 * dashboard has something better than a uuid to show on day one.
 */
export function organizationNameFor(email: string | null, privyUserId: string): string {
  const local = email?.split('@')[0]?.trim();
  if (local) return local.slice(0, 160);

  // The DID's last colon-separated segment, not its last N characters: a DID
  // is `did:privy:<id>`, and slicing the raw string yields names like
  // `agent-:cabc123` with the delimiter still attached.
  const identifier = privyUserId.split(':').pop() ?? privyUserId;
  return `agent-${identifier.slice(0, 12)}`;
}

/**
 * TypeORM copies the driver's fields onto `QueryFailedError`, but not on every
 * driver or every version — `abstract.repository.ts` reads `error.code` for
 * its retryable set, and `driverError.code` is where pg actually puts it. Both
 * are checked so a lost race cannot degrade into `AUTH_PROVISIONING_FAILED`
 * because of where a field landed.
 */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; driverError?: { code?: string } } | null;
  return (
    candidate?.code === UNIQUE_VIOLATION_CODE ||
    candidate?.driverError?.code === UNIQUE_VIOLATION_CODE
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
