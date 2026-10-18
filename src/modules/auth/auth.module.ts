import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { OAUTH_SESSION_CONFIG, loadOAuthSessionConfig } from '@modules/oauth/config/oauth.config';

import { PRIVY_AUTH_CONFIG, PrivyAuthConfig } from './domain/privy-auth.config';
import { AgentProvisioningService } from './services/agent-provisioning.service';
import { CredentialSessionResolver } from './services/credential-session.resolver';
import { DbCredentialMcpSessionSource } from './services/db-credential-mcp-session.source';
import { OAuthAccessTokenMcpSessionSource } from './services/oauth-access-token-mcp-session.source';
import { PrivyJwksCache } from './services/privy-jwks.cache';
import { PrivyMcpSessionSource } from './services/privy-mcp-session.source';
import { PrivyTokenVerifier } from './services/privy-token.verifier';
import { PrivyUserDirectory } from './services/privy-user.directory';

/**
 * Real authentication — a Privy access token, verified locally, and an
 * `agent_credentials` bearer token, looked up directly.
 *
 * Exports `PrivyMcpSessionSource`, `DbCredentialMcpSessionSource` and
 * `OAuthAccessTokenMcpSessionSource`, implementations of **`McpModule`'s**
 * `McpSessionPort`. The dependency runs
 * one way only: this module imports a port (a bare TypeScript interface file)
 * and never `McpModule` itself, which is what lets `McpModule` import *this*
 * one to choose between the sources without a cycle.
 *
 * `AgentRepository`, `AgentCredentialRepository`, `OrganizationRepository`,
 * `OAuthAccessTokenRepository` and `OAuthClientRepository` arrive from the
 * `@Global` `PostgresModule`; `EgressHttpClient` from the
 * `@Global` `NetworkModule` — the one place in `src/` allowed to open a
 * socket, and therefore the only way the JWKS is fetched.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PRIVY_AUTH_CONFIG,
      useFactory: (config: ConfigService): PrivyAuthConfig => {
        const privy = config.get<PrivyAuthConfig>('auth.privy');

        if (!privy?.appId) {
          // Reached when `AUTH_SESSION_SOURCE` is `config` (the default) and
          // nothing Privy-shaped is configured — the normal state of every
          // test and local stack, so it is not an error. It is also reached if
          // `authConfig` was never loaded into a bootstrap's `ConfigModule`,
          // which is a wiring mistake; the empty app id makes
          // `PrivyTokenVerifier` refuse every token rather than let one
          // through against a vacuous audience check.
          Logger.log('Privy is not configured; Privy access tokens will be refused', 'AuthModule');
        }

        return {
          appId: privy?.appId ?? '',
          appSecret: privy?.appSecret ?? null,
          apiBaseUrl: privy?.apiBaseUrl ?? 'https://auth.privy.io',
          issuer: privy?.issuer ?? 'privy.io',
          jwksUrl: privy?.jwksUrl ?? '',
          jwksTtlMs: privy?.jwksTtlMs ?? 600_000,
          jwksStaleGraceMs: privy?.jwksStaleGraceMs ?? 3_600_000,
          jwksMinRefreshMs: privy?.jwksMinRefreshMs ?? 60_000,
          clockSkewMs: privy?.clockSkewMs ?? 60_000,
          defaultChainId: privy?.defaultChainId ?? '',
          userLookupEnabled: privy?.userLookupEnabled ?? false,
        };
      },
      inject: [ConfigService],
    },
    PrivyJwksCache,
    PrivyTokenVerifier,
    PrivyUserDirectory,
    AgentProvisioningService,
    PrivyMcpSessionSource,
    CredentialSessionResolver,
    DbCredentialMcpSessionSource,
    // Only the audience and the payment clients, never `OAUTH_CONFIG`: this
    // module loads wherever `McpModule` does, the scheduler included, and
    // `OAUTH_CONFIG` demands the OAuth secrets.
    { provide: OAUTH_SESSION_CONFIG, useFactory: () => loadOAuthSessionConfig() },
    OAuthAccessTokenMcpSessionSource,
  ],
  exports: [
    PrivyMcpSessionSource,
    // The OAuth access-token source resolves through the same resolver, so an
    // OAuth grant and an API key for one agent yield the same session.
    CredentialSessionResolver,
    DbCredentialMcpSessionSource,
    OAuthAccessTokenMcpSessionSource,
    PrivyTokenVerifier,
    // `AuthApiModule`'s `WalletLinkService` re-runs the login path's wallet
    // lookup on demand, so it needs the same provisioning service the session
    // source uses — a second instance would carry a second cooldown map and
    // the two would not bound each other.
    AgentProvisioningService,
    PRIVY_AUTH_CONFIG,
  ],
})
export class AuthModule {}
