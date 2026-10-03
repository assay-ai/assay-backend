import { ConfigService } from '@nestjs/config';

import { VerificationErrors } from '../errors/verification.errors';
import { DEFAULT_SIGNING_RATE_LIMITS, SigningRateLimits } from './domain/signing-rate-limit';
import { SignerBackend } from './ports/signer.port';
import {
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_REGISTRY_CACHE_MS,
  VERIFIER_SIGNER_BACKEND_ENV,
} from './signing.constants';

export interface VerifierSigningConfig {
  readonly backend: SignerBackend;
  readonly rateLimits: SigningRateLimits;
  /** How long an on-chain registry read is trusted. The revoke-to-effect bound. */
  readonly registryCacheMs: number;
  /** How long before on-chain expiry to start warning. */
  readonly expiryWarningMs: number;
}

/**
 * Resolves the signing configuration, and refuses two things outright.
 *
 * **An unset backend in production.** Everywhere else `env` is the default,
 * because a developer should not have to configure custody to run tests. In
 * production the default is nothing at all: the choice of where the key that
 * can drain every provider's stake is kept must be a decision somebody made and
 * wrote down, not a value that was inherited from a file. This is the one place
 * in the codebase where "it worked locally" is the wrong outcome.
 *
 * **A backend with no implementation.** `kms`, `turnkey`, `vault` and `privy`
 * are values of `SignerBackend` and none of them has a class yet. Setting one
 * fails the boot with a message naming what *is* supported, rather than
 * resolving to nothing and failing later at the first signature — which is to
 * say, during an incident, on the path that issues penalties.
 */
export function verifierSigningConfigFactory(
  configService: ConfigService,
  implemented: readonly SignerBackend[],
): VerifierSigningConfig {
  const configured = configService.get<string>(VERIFIER_SIGNER_BACKEND_ENV)?.trim();
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  if (!configured && isProduction) {
    throw VerificationErrors.signerBackendUnsupported({
      backend: '(unset)',
      supported: implemented.join(', '),
    });
  }

  const backend = (configured ?? SignerBackend.ENV) as SignerBackend;
  if (!implemented.includes(backend)) {
    throw VerificationErrors.signerBackendUnsupported({
      backend,
      supported: implemented.join(', '),
    });
  }

  return {
    backend,
    rateLimits: {
      windowSeconds: positiveNumber(
        configService.get<string>('VERIFIER_SIGNING_RATE_WINDOW_SECONDS'),
        DEFAULT_SIGNING_RATE_LIMITS.windowSeconds,
      ),
      perKey: positiveNumber(
        configService.get<string>('VERIFIER_SIGNING_RATE_PER_KEY'),
        DEFAULT_SIGNING_RATE_LIMITS.perKey,
      ),
      perRequester: positiveNumber(
        configService.get<string>('VERIFIER_SIGNING_RATE_PER_REQUESTER'),
        DEFAULT_SIGNING_RATE_LIMITS.perRequester,
      ),
      warnRatio: positiveNumber(
        configService.get<string>('VERIFIER_SIGNING_RATE_WARN_RATIO'),
        DEFAULT_SIGNING_RATE_LIMITS.warnRatio,
      ),
    },
    registryCacheMs: positiveNumber(
      configService.get<string>('VERIFIER_REGISTRY_CACHE_MS'),
      DEFAULT_REGISTRY_CACHE_MS,
    ),
    expiryWarningMs: positiveNumber(
      configService.get<string>('VERIFIER_KEY_EXPIRY_WARNING_MS'),
      DEFAULT_EXPIRY_WARNING_MS,
    ),
  };
}

/**
 * `Number('')` is `0` and `Number('abc')` is `NaN`, and a rate limit of either
 * is a limit that refuses everything or compares against `NaN` and refuses
 * nothing. Both are worse than the default, so both fall back to it.
 */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
