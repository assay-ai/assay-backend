import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import {
  buildSignInMessage,
  isEvmAddress,
  newSignInNonce,
  parseSignInMessage,
  verifySignInSignature,
} from '@modules/chains/evm/sign-in-with-ethereum';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';

import { OperatorDto } from '../dto/operator-console.dto';
import { OperatorErrors } from '../errors/operator.errors';
import { OperatorAuthThrottle, ipKey, walletKey } from '../services/operator-auth-throttle.service';
import { OperatorService } from '../services/operator.service';
import {
  OPERATOR_CHALLENGE_TTL_SECONDS,
  OPERATOR_SIGN_IN_CONFIG,
  OPERATOR_SIGN_IN_STATEMENT,
  OperatorSignInConfig,
} from './operator-sign-in.config';
import { OperatorSessionStore } from './operator-session.store';

const CHALLENGE_PREFIX = 'operator:sign-in:nonce:';

/** Clock tolerance on `Issued At`, for a browser whose clock runs a little fast. */
const ISSUED_AT_SKEW_MS = 60_000;

export interface OperatorChallenge {
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface OperatorSignIn {
  readonly token: string;
  readonly expiresAt: Date;
  readonly operator: OperatorDto;
}

interface StoredChallenge {
  readonly address: string;
  readonly message: string;
}

/**
 * Sign in with a wallet: an EIP-4361 (Sign-In with Ethereum) challenge, signed
 * by the operator's wallet, exchanged for a short-lived session token.
 *
 * ## The challenge
 *
 * `challenge(address)` builds the message (`sign-in-with-ethereum.ts`, viem),
 * naming the configured domain, URI and chain id, a fresh nonce, `Issued At`
 * and an `Expiration Time` five minutes later, and the statement
 * {@link OPERATOR_SIGN_IN_STATEMENT}. It keeps the exact message in Redis under
 * the nonce, for five minutes. A challenge is issued for any well-formed
 * address — whether that wallet is an operator is answered only after it has
 * signed, so the challenge cannot be used to enumerate operators.
 *
 * ## The verification
 *
 * `verify(message, signature)` takes the nonce out of Redis (`GETDEL`, so it
 * is single-use even when the rest fails), requires the message to be
 * **exactly** the one issued for it, re-checks domain, URI, chain, statement
 * and expiry on the parsed fields, and verifies the signature
 * (`verifySignInSignature`). That is an EOA (`personal_sign`) check: smart-contract
 * wallets (ERC-1271 / ERC-6492) are not supported, because verifying them
 * needs a chain read on every sign-in. MetaMask, hardware wallets and the
 * Privy embedded wallet are EOAs.
 *
 * Every failure is the one `OPERATOR_CREDENTIAL_INVALID`, and counts against
 * the client address (`OperatorAuthThrottle`). It counts against the wallet
 * too, but only once the message is exactly the one issued for that wallet:
 * the address in an unchecked message is whatever the caller wrote. A good signature
 * from a wallet that is not an active operator is `OPERATOR_NOT_AUTHORIZED`,
 * and counts too.
 */
@Injectable()
export class OperatorSignInService {
  private readonly logger = new Logger(OperatorSignInService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    @Inject(OPERATOR_SIGN_IN_CONFIG) private readonly config: OperatorSignInConfig,
    private readonly operators: OperatorRepository,
    private readonly directory: OperatorService,
    private readonly sessions: OperatorSessionStore,
    private readonly throttle: OperatorAuthThrottle,
  ) {}

  async challenge(address: string, ip: string): Promise<OperatorChallenge> {
    await this.throttle.assertNotBlocked(ipKey(ip));
    if (!isEvmAddress(address)) {
      throw OperatorErrors.walletInvalid({ address });
    }
    this.assertConfigured();
    // Per client address only. A per-wallet count would let anyone stop a
    // named operator from getting a challenge, the lockout the wallet failure
    // count is careful not to allow.
    await this.throttle.countChallenge(ipKey(ip));

    const nonce = newSignInNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + OPERATOR_CHALLENGE_TTL_SECONDS * 1000);
    const message = buildSignInMessage({
      address,
      chainId: this.config.chainId,
      domain: this.config.domain,
      uri: this.config.uri,
      statement: OPERATOR_SIGN_IN_STATEMENT,
      nonce,
      issuedAt,
      expirationTime: expiresAt,
    });

    const stored: StoredChallenge = { address: address.toLowerCase(), message };
    await this.redis.set(
      CHALLENGE_PREFIX + nonce,
      JSON.stringify(stored),
      'EX',
      OPERATOR_CHALLENGE_TTL_SECONDS,
    );
    return { message, nonce, expiresAt };
  }

  async verify(message: string, signature: string, ip: string): Promise<OperatorSignIn> {
    await this.throttle.assertNotBlocked(ipKey(ip));
    this.assertConfigured();

    const fields = parseSignInMessage(message);
    const address = typeof fields.address === 'string' ? fields.address.toLowerCase() : null;
    if (address) await this.throttle.assertNotBlocked(walletKey(address));

    // The message is unsigned until proven otherwise, so the wallet it names
    // is counted only once it is the message issued for that wallet. Before
    // that, a made-up message naming somebody's address would lock them out.
    let issuedToWallet = false;
    const fail = async (reason: string): Promise<never> => {
      this.logger.debug(`operator sign-in refused: ${reason}`);
      await this.throttle.recordFailure(ipKey(ip));
      if (address && issuedToWallet) await this.throttle.recordFailure(walletKey(address));
      throw OperatorErrors.credentialInvalid();
    };

    if (!address || !fields.nonce) return fail('not a sign-in message');

    // Single-use: taken out before anything else is checked.
    const raw = await this.redis.getdel(CHALLENGE_PREFIX + fields.nonce);
    const stored = raw ? (JSON.parse(raw) as StoredChallenge) : null;
    if (!stored) return fail('unknown, used or expired nonce');
    if (stored.message !== message || stored.address !== address) {
      return fail('message differs from the challenge');
    }
    issuedToWallet = true;

    // The message is the one issued, so these hold unless the configuration
    // changed in between — checked anyway, because they are the property.
    const now = Date.now();
    if (fields.domain !== this.config.domain) return fail('wrong domain');
    if (fields.uri !== this.config.uri) return fail('wrong uri');
    if (fields.chainId !== this.config.chainId) return fail('wrong chain');
    if (fields.statement !== OPERATOR_SIGN_IN_STATEMENT) return fail('wrong statement');
    if (!fields.expirationTime || fields.expirationTime.getTime() <= now) {
      return fail('expired');
    }
    if (!fields.issuedAt || fields.issuedAt.getTime() > now + ISSUED_AT_SKEW_MS) {
      return fail('issued in the future');
    }

    if (!(await verifySignInSignature(address, message, signature))) {
      return fail('signature does not verify');
    }

    const operator = await this.operators.findByWallet(address);
    if (!operator || operator.status !== 'ACTIVE') {
      await this.throttle.recordFailure(ipKey(ip));
      await this.throttle.recordFailure(walletKey(address));
      throw OperatorErrors.notAuthorized();
    }

    const { token, expiresAt } = await this.sessions.issue(
      operator.id,
      this.config.sessionTtlSeconds,
    );
    await this.operators.update({ id: operator.id }, { lastSeenAt: new Date() });
    return { token, expiresAt, operator: this.directory.toDto(operator) };
  }

  /** Revokes the presented session. Idempotent; an unknown token is not an error. */
  async logout(token: string | null): Promise<void> {
    if (token) await this.sessions.revoke(token);
  }

  private assertConfigured(): void {
    if (!this.config.domain || !this.config.uri) {
      // Fail closed: a sign-in that names no domain would be valid anywhere.
      this.logger.warn('OPERATOR_SIGN_IN_DOMAIN / OPERATOR_SIGN_IN_URI are not set');
      throw OperatorErrors.credentialInvalid();
    }
  }
}
