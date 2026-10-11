import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId } from '@modules/chains/ports/caip.types';
import { DelegateBindingChallenge } from '@modules/chains/ports/delegate-binding.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { AgentDelegateBindingDto, DelegateChallengeResponseDto } from '../dto/agent-delegate.dto';
import { AccountErrors } from '../errors/account.errors';

/** How long an agent has to sign the challenge it asked for. */
export const DELEGATE_CHALLENGE_TTL_SECONDS = 300;

/**
 * ONE live challenge per credential: a new request overwrites the last, so a
 * holder of the agent token looping on the route holds one Redis key, not one
 * per request (review S3-8).
 */
const challengeKey = (credentialId: string) => `agent-delegate-challenge:${credentialId}`;

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
 * Challenges live in Redis with a TTL, one per credential (a new one replaces
 * the last), and are consumed with `GETDEL`, so one is good for one attempt; a
 * Redis flush only forces the agent to ask again.
 */
@Injectable()
export class AgentDelegateService {
  constructor(
    private readonly credentials: AgentCredentialRepository,
    private readonly chains: ChainAdapterRegistry,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
  ) {}

  async current(session: McpSession): Promise<AgentDelegateBindingDto> {
    this.assertAgent(session);
    const row = await this.credentials.findOneBy({
      organizationId: session.organizationId,
      id: session.credentialId,
    });
    return {
      credentialId: session.credentialId,
      delegate: row?.delegateAccount ?? null,
      boundAt: row?.delegateBoundAt ? row.delegateBoundAt.toISOString() : null,
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

    const boundAt = new Date();
    await this.credentials.update(
      { organizationId: session.organizationId, id: session.credentialId },
      { delegateAccount: stored.delegate as AccountId, delegateBoundAt: boundAt },
    );
    return {
      credentialId: session.credentialId,
      delegate: stored.delegate,
      boundAt: boundAt.toISOString(),
    };
  }

  private assertAgent(session: McpSession): void {
    if (session.callerKind !== McpCallerKind.AGENT) {
      throw AccountErrors.delegateBindingAgentOnly();
    }
  }
}
