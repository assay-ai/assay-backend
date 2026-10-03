import { Injectable, Logger } from '@nestjs/common';

import { McpErrors } from '@modules/mcp/errors/mcp.errors';

import { LinkWalletResponseDto } from '../dto/link-wallet.dto';
import { AuthErrors } from '../errors/auth.errors';
import { AgentProvisioningService, WALLET_REFRESH_COOLDOWN_MS } from './agent-provisioning.service';
import { PrivyTokenVerifier } from './privy-token.verifier';

const ACTIVE = 'ACTIVE';

/**
 * "My wallet exists now — look again."
 *
 * ## The race this closes
 *
 * Privy issues the access token **before** it records the wallet. Measured on
 * a real signup: the user and an embedded EVM wallet exist at `t`, the Solana
 * account is recorded at `t+2s`, and the browser's first API call lands
 * between them. So the login path looks the identity up, truthfully finds no
 * Solana wallet, and writes `primary_account_id = NULL` — after which
 * `WALLET_LOOKUP_COOLDOWN_MS` (60s) blocks its own retry and every request
 * that minute answers `AUTH_WALLET_NOT_LINKED`, to an account that was
 * provisioned perfectly.
 *
 * The browser is the only party that knows when the wallet appeared. This is
 * how it says so.
 *
 * ## What the caller is trusted with, which is nothing
 *
 * The request has no body. It cannot name an address, a chain, an agent or an
 * organization — it only causes the same lookup the login path does, against
 * the same Privy user record, keyed by the DID in the token. A caller who
 * lies gains a lookup of their own identity. That is the whole attack surface,
 * and it is why this is not `PATCH /agents/me`.
 *
 * ## Why it cannot sit behind `SessionAuthGuard`
 *
 * That guard builds an `McpSession`, and building one is precisely what fails
 * with `AUTH_WALLET_NOT_LINKED` — the condition this route exists to clear.
 * So it verifies the token itself, through the same `PrivyTokenVerifier`, and
 * stops one step short of a session.
 *
 * The two refusals below are the same ones `PrivyMcpSessionSource` raises,
 * repeated rather than shared because they are cheap and because a suspended
 * caller must get a *terminal* answer here: a client polling this route needs
 * to know the difference between "not yet" and "never", or it polls forever.
 */
@Injectable()
export class WalletLinkService {
  private readonly logger = new Logger(WalletLinkService.name);

  constructor(
    private readonly verifier: PrivyTokenVerifier,
    private readonly provisioning: AgentProvisioningService,
  ) {}

  async link(bearerToken: string | null): Promise<LinkWalletResponseDto> {
    if (!bearerToken) {
      throw McpErrors.credentialInvalid();
    }

    const claims = await this.verifier.verify(bearerToken);
    if (!claims) {
      throw McpErrors.credentialInvalid();
    }

    const { agent, organizationStatus } = await this.provisioning.resolve(claims, {
      lookupCooldownMs: WALLET_REFRESH_COOLDOWN_MS,
    });

    if (organizationStatus !== ACTIVE) {
      throw AuthErrors.organizationSuspended();
    }

    if (agent.status !== ACTIVE) {
      throw AuthErrors.agentSuspended();
    }

    const linked = Boolean(agent.primaryAccountId && agent.chainId);
    if (!linked) {
      // The `null` path of the login lookup logs nothing, which is what made
      // the first-minute 424 hard to tell apart from a misconfiguration. This
      // route is the one place that knows a human is waiting on the answer.
      this.logger.log(`No Solana wallet linked to ${claims.subject} yet; the client may ask again`);
    }

    return {
      linked,
      account: agent.primaryAccountId ?? null,
      chainId: agent.chainId ?? null,
    };
  }
}
