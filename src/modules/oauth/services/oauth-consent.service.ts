import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import {
  AgentCredentialEntity,
  CredentialIssuedVia,
} from '@database/postgres/entities/agent-credential.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';
import { SpendPolicyEntity } from '@database/postgres/entities/spend-policy.entity';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import { SpendPolicyRepository } from '@database/postgres/repositories/spend-policy.repository';
import { AccountErrors } from '@modules/account/errors/account.errors';
import { AssetId } from '@modules/chains/ports/caip.types';
import { FREE_QUOTA_CONFIG, FreeQuotaConfig } from '@modules/free-tier/config/free-quota.config';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AccessMode, readAllowedToolsets } from '@modules/toolset/domain/access';
import { auditActorOf } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { OAUTH_CONFIG, OAuthConfig } from '../config/oauth.config';
import {
  OAUTH_MAX_LIVE_GRANTS_PER_AGENT,
  OAUTH_PENDING_REQUEST_TTL_SECONDS,
} from '../constants/oauth.constants';
import { sanitise } from '../domain/client-name';
import {
  OAUTH_CREDENTIAL_NAME_MAX,
  OAuthConsentAgentDto,
  OAuthConsentReplacesDto,
  OAuthConsentRequestDto,
  OAuthRedirectDto,
} from '../dto/oauth-consent.dto';
import { OAuthErrors } from '../errors/oauth.errors';
import { OAuthClientRegistry, ResolvedClient } from './oauth-client.registry';
import { OAuthMetrics } from './oauth-metrics.service';
import { DecideResult, OAuthRequestStore } from './oauth-request.store';

/** `assay_device` is display-only and at most 32 characters (§6.3.4). */
const DEVICE_LABEL_MAX = 32;
const DEFAULT_DEVICE = 'this computer';

/**
 * The consent API (spec §6.3.5): what the consent page shows about a pending
 * authorization request, and the person's answer to it.
 *
 * Only a person reaches it (`HumanSessionGuard`, R-OA-24): an agent key or an
 * OAuth access token cannot approve an app, so an app cannot approve itself.
 *
 * - **First reader wins.** The first organization to read a request owns it;
 *   any other gets `OAUTH_REQUEST_NOT_FOUND`, the same answer as an unknown or
 *   expired one, so it learns nothing.
 * - **Decided once.** Approve or deny writes a tombstone; a second answer is
 *   `OAUTH_REQUEST_ALREADY_DECIDED`.
 * - **No code here.** Approval only records the decision. The code is minted
 *   by `{MCP}/oauth/authorize/continue`, and only in the browser that started
 *   the request, which holds its cookie (R-OA-8, T8). The page navigates there
 *   with `redirectTo`.
 *
 * The request id is a bearer secret until it is taken: it is never logged or
 * put in an error (R-OA-27).
 */
@Injectable()
export class OAuthConsentService {
  constructor(
    private readonly requests: OAuthRequestStore,
    private readonly registry: OAuthClientRegistry,
    private readonly agents: AgentRepository,
    private readonly organizations: OrganizationRepository,
    private readonly credentials: AgentCredentialRepository,
    private readonly policies: SpendPolicyRepository,
    private readonly metrics: OAuthMetrics,
    @Inject(FREE_QUOTA_CONFIG)
    private readonly freeQuota: Pick<FreeQuotaConfig, 'platformAgentDailyLimit'>,
    @Inject(OAUTH_CONFIG) private readonly config: Pick<OAuthConfig, 'issuer'>,
  ) {}

  /** `GET {API}/oauth/requests/{rid}`: binds the request to the reader's organization. */
  async read(session: McpSession, rid: string): Promise<OAuthConsentRequestDto> {
    const organizationId = session.organizationId;
    const bound = await this.requests.bind(rid, organizationId);
    if (bound.status === 'already_decided') throw OAuthErrors.requestAlreadyDecided();
    if (bound.status !== 'ok') {
      await this.metrics.incConsent('not_found');
      throw OAuthErrors.requestNotFound();
    }
    const request = bound.request;

    const client = await this.registry.findById(request.oauthClientId);
    if (!client) throw OAuthErrors.requestNotFound();
    const display = this.registry.displayFor(client, request.redirectUri);
    const builtin = client.kind === OAuthClientKind.BUILTIN;

    const [agents, replaced] = await Promise.all([
      this.agentsOf(organizationId),
      this.replaceable(organizationId, client, request.replaces),
    ]);

    const createdAt = new Date(request.createdAt);
    const dto: OAuthConsentRequestDto = {
      requestId: rid,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + OAUTH_PENDING_REQUEST_TTL_SECONDS * 1000,
      ).toISOString(),
      client: {
        name: display.name,
        kind: client.kind,
        registrableDomain: display.registrableDomain,
        host: display.host,
        verified: display.verified === true,
        builtin,
        // Fail closed: only an explicit `true` makes a payment client (§6.3.13).
        paymentClient: this.registry.isPaymentClient(client) === true,
      },
      returnTo: { kind: display.returnTo.kind, display: display.returnTo.display },
      scope: request.scope.split(' ').filter((scope) => scope !== ''),
      agents,
      // A dead grant is shown too (spec F5 step 2: after an idle expiry the exchange still
      // copies its tool limits); `live` says whether it also frees a place under the cap.
      ...(replaced ? { replaces: replacesDto(replaced) } : {}),
      suggestedName: builtin
        ? `Assay app on ${sanitise(request.device, DEVICE_LABEL_MAX) ?? DEFAULT_DEVICE}`
        : `${display.name} · ${createdAt.toISOString().slice(0, 10)}`,
    };
    await this.metrics.incConsent('shown');
    return dto;
  }

  /** `POST {API}/oauth/requests/{rid}/approve`. */
  async approve(
    session: McpSession,
    rid: string,
    body: { agentId: string; name: string },
  ): Promise<OAuthRedirectDto> {
    const organizationId = session.organizationId;
    // Binds an unread request to this organization, or refuses another's.
    const bound = await this.requests.bind(rid, organizationId);
    if (bound.status === 'already_decided') throw OAuthErrors.requestAlreadyDecided();
    if (bound.status !== 'ok') throw OAuthErrors.requestNotFound();
    const request = bound.request;

    const name = sanitise(body.name, OAUTH_CREDENTIAL_NAME_MAX);
    if (!name) throw OAuthErrors.credentialNameInvalid();

    const agent = await this.agents.findOne({ where: { id: body.agentId, organizationId } });
    if (!agent) throw AccountErrors.agentNotFound({ agentId: body.agentId });
    const organization = await this.organizations.findById(organizationId);
    if (!isActive(agent, organization?.status)) throw OAuthErrors.agentNotActive();

    const client = await this.registry.findById(request.oauthClientId);
    if (!client) throw OAuthErrors.requestNotFound();
    // `assay_replaces` holds only for a grant of this organization, this
    // built-in client and the chosen agent; anything else is dropped silently.
    const replaced = await this.replaceable(organizationId, client, request.replaces);
    const replaces = replaced && replaced.agentId === agent.id ? replaced : null;

    // The cap is checked again, under the per-agent lock, when the code is
    // exchanged (OAuthGrantWriter); this check is what the person sees. A live
    // grant this one replaces is revoked by the exchange, so it does not count.
    const live = await this.credentials.countLiveOAuthForAgent(organizationId, agent.id);
    const replacesLive = replaces !== null && isLive(replaces);
    if (live - (replacesLive ? 1 : 0) >= OAUTH_MAX_LIVE_GRANTS_PER_AGENT) {
      throw OAuthErrors.grantLimitReached({ limit: OAUTH_MAX_LIVE_GRANTS_PER_AGENT });
    }

    const decided = await this.requests.decide(rid, organizationId, {
      agentId: agent.id,
      name,
      approvedBy: auditActorOf(session).id,
      replaces: replaces?.id ?? null,
    });
    this.raiseUnlessDecided(decided);
    await this.metrics.incConsent('approved');
    return { redirectTo: this.continueUrl(rid) };
  }

  /** `POST {API}/oauth/requests/{rid}/deny`. */
  async deny(session: McpSession, rid: string): Promise<OAuthRedirectDto> {
    this.raiseUnlessDecided(await this.requests.decide(rid, session.organizationId, 'deny'));
    await this.metrics.incConsent('denied');
    return { redirectTo: this.continueUrl(rid) };
  }

  private raiseUnlessDecided(result: DecideResult): void {
    if (result === 'already_decided') throw OAuthErrors.requestAlreadyDecided();
    if (result !== 'ok') throw OAuthErrors.requestNotFound();
  }

  private continueUrl(rid: string): string {
    return `${this.config.issuer}/oauth/authorize/continue?request=${encodeURIComponent(rid)}`;
  }

  /**
   * The organization's agents, as the picker shows them: every one of them,
   * in four queries whatever their number.
   */
  private async agentsOf(organizationId: string): Promise<OAuthConsentAgentDto[]> {
    const [agents, organization, policies, live] = await Promise.all([
      this.agents.find({ where: { organizationId }, order: { createdAt: 'ASC', id: 'ASC' } }),
      this.organizations.findById(organizationId),
      // Every live version in the organization: the default and each agent's override.
      this.policies.find({ where: { organizationId, supersededAt: IsNull() } }),
      this.credentials.countLiveOAuthByAgent(organizationId),
    ]);
    const orgDefault = policies.find((policy) => policy.agentId === null) ?? null;
    const overrides = new Map(
      policies.flatMap((policy) => (policy.agentId ? [[policy.agentId, policy] as const] : [])),
    );
    return agents.map((agent): OAuthConsentAgentDto => {
      // The agent's own policy, else the organization default: the limits a call meets.
      const policy = overrides.get(agent.id) ?? orgDefault;
      return {
        id: agent.id,
        label: agent.label,
        active: isActive(agent, organization?.status),
        limits: {
          perCall: moneyOrNull(policy?.perCallMax, policy),
          perDay: moneyOrNull(policy?.dailyCap, policy),
          freeCallsPerDay: this.freeQuota.platformAgentDailyLimit,
        },
        access: accessOf(policy),
        liveOAuthCredentials: live.get(agent.id) ?? 0,
      };
    });
  }

  /**
   * The grant `assay_replaces` names, when the request may replace it: the
   * built-in client only, and an OAuth grant of this organization and this
   * client. The agent is matched by the caller. `null` otherwise.
   */
  private async replaceable(
    organizationId: string,
    client: ResolvedClient,
    credentialId: string | null,
  ): Promise<AgentCredentialEntity | null> {
    if (!credentialId || client.kind !== OAuthClientKind.BUILTIN) return null;
    if (!UUID_RE.test(credentialId)) return null;
    const row = await this.credentials.findOne({
      where: {
        organizationId,
        id: credentialId,
        oauthClientId: client.id,
        issuedVia: CredentialIssuedVia.OAUTH,
      },
    });
    return row ?? null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R-OA-32: the agent and its organization are ACTIVE, and it has a linked wallet. */
function isActive(agent: AgentEntity, organizationStatus: string | undefined): boolean {
  return (
    agent.status === 'ACTIVE' &&
    organizationStatus === 'ACTIVE' &&
    agent.primaryAccountId !== null &&
    agent.chainId !== null
  );
}

function isLive(credential: AgentCredentialEntity): boolean {
  return (
    credential.revokedAt === null &&
    (credential.expiresAt === null || credential.expiresAt.getTime() > Date.now())
  );
}

function replacesDto(credential: AgentCredentialEntity): OAuthConsentReplacesDto {
  return {
    id: credential.id,
    name: credential.name,
    agentId: credential.agentId,
    narrowed:
      credential.accessMode !== null ||
      credential.allowedToolsets !== null ||
      credential.allowedToolIds !== null,
    live: isLive(credential),
  };
}

function moneyOrNull(
  amount: string | null | undefined,
  policy: SpendPolicyEntity | null,
): MoneyDto | null {
  if (amount === null || amount === undefined || !policy) return null;
  const money = MoneyUtil.of(amount, policy.assetId as AssetId, policy.decimals);
  return { amount: money.amount, asset: money.asset, decimals: money.decimals };
}

/** The agent's tool access, in a line (§6.5: "All tools"). */
function accessOf(policy: SpendPolicyEntity | null): OAuthConsentAgentDto['access'] {
  if ((policy?.accessMode as AccessMode | undefined) !== AccessMode.RESTRICTED) {
    return { mode: AccessMode.ALL, summary: 'All tools' };
  }
  const toolsets = readAllowedToolsets(policy?.allowedToolsets).length;
  const tools = policy?.allowedToolIds?.length ?? 0;
  const parts = [
    ...(toolsets > 0 ? [plural(toolsets, 'tool set')] : []),
    ...(tools > 0 ? [plural(tools, 'tool')] : []),
  ];
  return {
    mode: AccessMode.RESTRICTED,
    summary: parts.length > 0 ? parts.join(' and ') : 'No tools',
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
