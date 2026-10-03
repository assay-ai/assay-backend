import { registerAs } from '@nestjs/config';
import { validateConfig } from '@shared/utils/validate-config';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Who is allowed to authenticate, and with what.
 *
 * Two things live in one namespace because they are one decision: which
 * session source is authoritative (`AUTH_SESSION_SOURCE`) and, when that
 * answer includes Privy, everything the Privy verifier needs. Splitting them
 * would let a deployment turn Privy on without configuring it, or configure it
 * without turning it on, and both of those read as "auth is set up" from the
 * outside.
 *
 * ## `AUTH_SESSION_SOURCE` defaults to `config`
 *
 * Not because the file of demo tokens is the right answer, but because it is
 * the *current* answer: every unit test, the demo seed and every local stack
 * resolve their bearer tokens through `MCP_CREDENTIALS_FILE`. A default of
 * `privy` would turn "this goal shipped" into "every existing environment
 * stopped authenticating", which is a migration, not a feature flag. An
 * operator opts in.
 *
 * ## `PRIVY_APP_SECRET` is a credential and lives here
 *
 * Per `docs/architecture.md`: secrets go through `registerAs` +
 * `class-validator` + `validateConfig`, never inlined at a call site and never
 * read from `process.env` in a service. It is used for exactly one thing — the
 * authenticated user lookup that turns a Privy DID into a linked wallet
 * address — and never for token verification, which is local against the JWKS
 * (see `PrivyJwksCache`).
 *
 * ## Why the JWKS knobs are three numbers and not one
 *
 * `PRIVY_JWKS_TTL_MS` is how long a fetched key set is *fresh*.
 * `PRIVY_JWKS_STALE_GRACE_MS` is how much longer it may still be used when a
 * refresh **fails** — serving a key we already verified against during a Privy
 * outage is not failing open, it is refusing to let their availability become
 * ours. `PRIVY_JWKS_MIN_REFRESH_MS` bounds how often an unknown `kid` (the
 * shape a key rotation takes) may force an out-of-band fetch, so a stream of
 * forged tokens carrying random `kid`s cannot be turned into a request
 * amplifier against Privy.
 *
 * Beyond the grace window with no usable key, the verifier refuses every
 * token. That is deliberate and it is the fail-closed half of the rule.
 */
class AuthEnvVariables {
  @IsOptional()
  @IsIn(['config', 'privy', 'db', 'both'])
  AUTH_SESSION_SOURCE?: string;

  /**
   * Required exactly when Privy can authenticate anyone.
   *
   * Deliberately **not** widened to include `db`: the two `@ValidateIf`
   * predicates below already read `=== 'privy' || === 'both'`, and `'db'`
   * matches neither, so a `db`-only deployment (`agent_credentials` tokens,
   * no Privy at all) can leave `PRIVY_APP_ID`/`PRIVY_DEFAULT_CHAIN_ID` unset
   * without touching this file — adding `'db'` to `AUTH_SESSION_SOURCE`'s
   * `@IsIn` above was the only change `db` needed here. `'both'` still names
   * privy explicitly (see `SessionSourceMode.BOTH` — it wires `[config, db,
   * privy]`, not `[config, db]`), so it keeps requiring both. A blank app id
   * would make the audience check vacuous, which is the one claim that stops
   * a perfectly valid token *for another Privy app* from being accepted here.
   */
  @ValidateIf((o) => o.AUTH_SESSION_SOURCE === 'privy' || o.AUTH_SESSION_SOURCE === 'both')
  @IsString({ message: 'PRIVY_APP_ID is required when AUTH_SESSION_SOURCE includes privy' })
  PRIVY_APP_ID?: string;

  @IsOptional()
  @IsString()
  PRIVY_APP_SECRET?: string;

  /**
   * The chain a Privy-authenticated agent's money settles on, CAIP-2. No
   * default on purpose: an inherited guess here is the difference between a
   * devnet balance and a mainnet one.
   */
  @ValidateIf((o) => o.AUTH_SESSION_SOURCE === 'privy' || o.AUTH_SESSION_SOURCE === 'both')
  @IsString({ message: 'PRIVY_DEFAULT_CHAIN_ID (CAIP-2) is required when privy is enabled' })
  PRIVY_DEFAULT_CHAIN_ID?: string;

  @IsOptional()
  @IsString()
  PRIVY_API_BASE_URL?: string;

  @IsOptional()
  @IsString()
  PRIVY_ISSUER?: string;

  /** Overrides the derived `${base}/api/v1/apps/${appId}/jwks.json`. */
  @IsOptional()
  @IsString()
  PRIVY_JWKS_URL?: string;

  @IsOptional()
  @IsNumber()
  PRIVY_JWKS_TTL_MS?: number;

  @IsOptional()
  @IsNumber()
  PRIVY_JWKS_STALE_GRACE_MS?: number;

  @IsOptional()
  @IsNumber()
  PRIVY_JWKS_MIN_REFRESH_MS?: number;

  @IsOptional()
  @IsNumber()
  PRIVY_CLOCK_SKEW_MS?: number;

  @IsOptional()
  @IsBoolean()
  PRIVY_USER_LOOKUP_ENABLED?: boolean;
}

const DEFAULT_API_BASE_URL = 'https://auth.privy.io';

/** Privy signs its access tokens with `iss: "privy.io"`. */
const DEFAULT_ISSUER = 'privy.io';

const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_JWKS_STALE_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_JWKS_MIN_REFRESH_MS = 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;

const authConfig = registerAs('auth', () => {
  validateConfig(process.env, AuthEnvVariables);

  const sessionSource = process.env.AUTH_SESSION_SOURCE || 'config';
  const appId = process.env.PRIVY_APP_ID;
  const apiBaseUrl = (process.env.PRIVY_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  return {
    sessionSource,
    privy: {
      appId,
      appSecret: process.env.PRIVY_APP_SECRET,
      apiBaseUrl,
      issuer: process.env.PRIVY_ISSUER || DEFAULT_ISSUER,
      jwksUrl: process.env.PRIVY_JWKS_URL || `${apiBaseUrl}/api/v1/apps/${appId}/jwks.json`,
      jwksTtlMs: numberOr(process.env.PRIVY_JWKS_TTL_MS, DEFAULT_JWKS_TTL_MS),
      jwksStaleGraceMs: numberOr(
        process.env.PRIVY_JWKS_STALE_GRACE_MS,
        DEFAULT_JWKS_STALE_GRACE_MS,
      ),
      jwksMinRefreshMs: numberOr(
        process.env.PRIVY_JWKS_MIN_REFRESH_MS,
        DEFAULT_JWKS_MIN_REFRESH_MS,
      ),
      clockSkewMs: numberOr(process.env.PRIVY_CLOCK_SKEW_MS, DEFAULT_CLOCK_SKEW_MS),
      defaultChainId: process.env.PRIVY_DEFAULT_CHAIN_ID,
      // Defaults on: an agent whose wallet is never resolved can log in and
      // read nothing it does not already have, which looks like a broken
      // deployment rather than a deliberate one. Turn it off only where the
      // app secret is deliberately absent.
      userLookupEnabled: process.env.PRIVY_USER_LOOKUP_ENABLED !== 'false',
    },
  };
});

function numberOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export { authConfig };
