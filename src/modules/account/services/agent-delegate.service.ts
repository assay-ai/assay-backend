import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { sameAccountSpelling } from '@modules/chains/evm/eip55';
import { AccountId } from '@modules/chains/ports/caip.types';
import { DelegateBindingChallenge } from '@modules/chains/ports/delegate-binding.types';
import { EscrowDelegationStatus } from '@modules/settlement/ports/escrow-delegation.port';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import {
  McpCallerKind,
  McpSession,
  storedCredentialIdOf,
} from '@modules/mcp/ports/mcp-session.port';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import {
  AgentDelegateBindingDto,
  AgentDelegateStatusDto,
  DelegateChallengeResponseDto,
  PaidCallsDto,
  PaidCallsStatus,
} from '../dto/agent-delegate.dto';
import { AccountErrors } from '../errors/account.errors';

/** How long an agent has to sign the challenge it asked for. */
export const DELEGATE_CHALLENGE_TTL_SECONDS = 300;

/**
 * ONE live challenge per credential: a new request overwrites the last, so a
 * holder of the agent token looping on the route holds one Redis key, not one
 * per request (review S3-8).
 */
const challengeKey = (credentialId: string) => `agent-delegate-challenge:${credentialId}`;

/** One live credential per delegate key, platform-wide (migration 1759600000002). */
export const DELEGATE_LIVE_CONSTRAINT = 'uq_agent_credentials_delegate_live';

interface StoredChallenge extends DelegateBindingChallenge {
  readonly organizationId: string;
  readonly challengeId: string;
}

/**
 * Binds an agent credential to the DELEGATE key it signs rail-B vouchers with
 * (agent payment delegation).
 *
 * The agent proves possession: it asks for a single-use challenge naming the
 * key, signs it WITH THAT KEY, and presents the signature; only then is the key
 * written onto its own credential row. From then on the MCP session knows which
 * delegate its vouchers come from, PAYMENT_REQUIRED names it, and a delegate
 * signature is accepted from this credential and no other.
 *
 * The binding grants nothing on chain. Spending needs the PAYER's on-chain
 * authorisation of the key (`/escrow/delegates`, a human act); a bound key the
 * payer never authorised signs vouchers the chain — and this backend — refuse.
 *
 * A key is bound to ONE live credential platform-wide: binding a key another
 * live credential holds is refused (`ACCOUNT_DELEGATE_ALREADY_BOUND`), so what
 * a key spends is one agent's and revoking that credential ends it.
 *
 * Challenges live in Redis with a TTL, one per credential (a new one replaces
 * the last), and are consumed with `GETDEL`, so one is good for one attempt; a
 * Redis flush only forces the agent to ask again.
 */
@Injectable()
export class AgentDelegateService {
  private readonly logger = new Logger(AgentDelegateService.name);

  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly chains: ChainAdapterRegistry,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly delegations: EscrowDelegationService,
  ) {}

  /**
   * The binding, the agent's label, and `paidCalls`: where the bound key
   * stands on chain (spec §7.10 item 1, R-PAY-3). Read through the payer's
   * standing delegations, filtered to this credential's own key, so a
   * credential sees its own delegate and no other. No key bound, no chain read.
   *
   * A failed chain read does not fail the request: the stored binding (which
   * the app needs to identify its credential) is returned with `paidCalls`
   * null and `paidCallsUnknown` true. Nothing decides on `paidCalls`.
   */
  async current(session: McpSession): Promise<AgentDelegateStatusDto> {
    this.assertAgent(session);
    const row = await this.credentials.findOneBy({
      organizationId: session.organizationId,
      id: session.credentialId,
    });
    const delegate = (row?.delegateAccount as AccountId | null | undefined) ?? null;
    let paidCalls: PaidCallsDto | null = null;
    let paidCallsUnknown = false;
    if (delegate) {
      try {
        paidCalls = await this.paidCalls(session.agentAccount, delegate);
      } catch (error) {
        paidCallsUnknown = true;
        this.logger.warn(
          `paidCalls: chain read failed, answering without it — ${(error as Error)?.message ?? error}`,
        );
      }
    }
    return {
      credentialId: session.credentialId,
      agentLabel: session.label ?? null,
      delegate,
      boundAt: row?.delegateBoundAt ? row.delegateBoundAt.toISOString() : null,
      paidCalls,
      paidCallsUnknown,
    };
  }

  private async paidCalls(payer: AccountId, delegate: AccountId): Promise<PaidCallsDto> {
    const standing = (await this.delegations.list(payer)).find((d) =>
      sameAccountSpelling(d.delegate, delegate),
    );
    if (!standing) {
      return {
        status: PaidCallsStatus.NONE,
        maxVoucherAmount: null,
        maxPerWindow: null,
        spentInWindow: null,
        validUntil: null,
      };
    }
    return {
      status:
        standing.status === EscrowDelegationStatus.ACTIVE
          ? PaidCallsStatus.ACTIVE
          : PaidCallsStatus.EXPIRED,
      maxVoucherAmount: standing.maxVoucherAmount.toString(),
      maxPerWindow: standing.maxPerWindow.toString(),
      spentInWindow: standing.spentInWindow.toString(),
      validUntil: new Date(Number(standing.validUntil) * 1000).toISOString(),
    };
  }

  async challenge(session: McpSession, delegate: string): Promise<DelegateChallengeResponseDto> {
    this.assertAgent(session);
    const adapter = this.chains.resolve(session.chainId);
    if (typeof adapter.delegateBindingTypedData !== 'function') {
      throw AccountErrors.delegateBindingUnsupported({ chainId: session.chainId });
    }

    const challenge: DelegateBindingChallenge = {
      credentialId: session.credentialId,
      // Normalised (EIP-55) by the adapter, so the bound value is one string.
      delegate: adapter.toAccountId(session.chainId, delegate),
      nonce: randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + DELEGATE_CHALLENGE_TTL_SECONDS,
    };
    const challengeId = randomUUID();
    const stored: StoredChallenge = {
      ...challenge,
      organizationId: session.organizationId,
      challengeId,
    };
    await this.redis.set(
      challengeKey(session.credentialId),
      JSON.stringify(stored),
      'EX',
      DELEGATE_CHALLENGE_TTL_SECONDS,
    );

    return {
      challengeId,
      delegate: challenge.delegate,
      expiresAt: new Date(challenge.expiresAt * 1000).toISOString(),
      typedData: { ...adapter.delegateBindingTypedData(challenge) },
    };
  }

  async bind(
    session: McpSession,
    challengeId: string,
    signature: string,
  ): Promise<AgentDelegateBindingDto> {
    this.assertAgent(session);

    // Consumed before it is checked: a challenge is good for one attempt.
    const raw = await this.redis.getdel(challengeKey(session.credentialId));
    if (!raw) throw AccountErrors.delegateChallengeInvalid();
    const stored = JSON.parse(raw) as StoredChallenge;
    if (
      stored.challengeId !== challengeId ||
      stored.credentialId !== session.credentialId ||
      stored.organizationId !== session.organizationId ||
      stored.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      throw AccountErrors.delegateChallengeInvalid();
    }

    const adapter = this.chains.resolve(session.chainId);
    if (
      typeof adapter.verifyDelegateBindingSignature !== 'function' ||
      !adapter.verifyDelegateBindingSignature(stored, signature)
    ) {
      throw AccountErrors.delegateSignatureInvalid({ delegate: stored.delegate });
    }

    // One key, one live credential (D1-S03). Checked only AFTER the proof of
    // possession, so the answer "bound elsewhere" is given to the key's holder
    // alone and cannot be used to probe which keys are in use. An EXPIRED holder
    // can authenticate nobody, so its binding is released rather than allowed
    // to hold the key hostage; a live one refuses. The unique index behind this
    // decides a race between two binds of the same key.
    await this.credentials.releaseDelegateFromExpired(stored.delegate, session.credentialId);
    const holders = await this.credentials.findOtherDelegateHolders(
      stored.delegate,
      session.credentialId,
    );
    if (holders.length > 0) {
      throw AccountErrors.delegateAlreadyBound({ delegate: stored.delegate });
    }

    const boundAt = new Date();
    try {
      await this.credentials.update(
        { organizationId: session.organizationId, id: session.credentialId },
        { delegateAccount: stored.delegate as AccountId, delegateBoundAt: boundAt },
      );
    } catch (error) {
      const violation = error as {
        code?: string;
        constraint?: string;
        driverError?: { code?: string; constraint?: string };
      };
      const code = violation?.code ?? violation?.driverError?.code;
      const constraint = violation?.constraint ?? violation?.driverError?.constraint;
      if (code === UNIQUE_VIOLATION_CODE && constraint === DELEGATE_LIVE_CONSTRAINT) {
        throw AccountErrors.delegateAlreadyBound({ delegate: stored.delegate });
      }
      throw error;
    }
    return {
      credentialId: session.credentialId,
      agentLabel: session.label ?? null,
      delegate: stored.delegate,
      boundAt: boundAt.toISOString(),
    };
  }

  private assertAgent(session: McpSession): void {
    // A config-file machine token is AGENT too, but no `agent_credentials`
    // row backs it, so there is nothing to bind the key to (review N-1).
    if (session.callerKind !== McpCallerKind.AGENT || !storedCredentialIdOf(session)) {
      throw AccountErrors.delegateBindingAgentOnly();
    }
    // Only API keys and `assay-mcp` grants may bind a payment key (spec
    // §6.3.13, H2, R-OA-22). `=== true`, so a session that lacks the field is
    // refused too. Defence in depth: the API app already refuses other grants.
    if (session.paymentsAllowed !== true) {
      throw AccountErrors.delegateClientNotAllowed();
    }
  }
}
