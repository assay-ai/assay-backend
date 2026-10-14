import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';
import {
  MCP_CREDENTIAL_SNAPSHOT,
  McpCredentialSnapshot,
} from '@modules/mcp/services/config-mcp-session.source';

import { AccountId, ChainId } from '@modules/chains/ports/caip.types';

/**
 * Two organizations, one HTTP app.
 *
 * The multi-tenancy claim this platform makes is not "queries carry a tenant
 * predicate" — that is the mechanism. The claim is that **organization A cannot
 * learn anything about organization B**, including whether one of B's ids
 * exists. Proving it needs two real credentials hitting one real app over real
 * HTTP, because every layer between the token and the row is part of what is
 * being claimed: the guard, the session port, the controller, the repository
 * guard, and the exception filter that decides which status the failure leaves
 * as.
 */

export const ORG_A = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
export const ORG_B = 'b7c4e1a0-3f28-4d55-9c61-2a8e5f0d4b39';

export const TOKEN_A = 'test_token_org_a';
export const TOKEN_B = 'test_token_org_b';

const CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId;

export const AGENT_A = 'dcff5fef-5f11-4bc6-8d85-d64e38da6e39';
export const AGENT_B = '9f1d3c72-6b48-4e90-a253-7c0b8d5e2a14';

/**
 * Credentials for both tenants, injected in place of the file-backed snapshot.
 *
 * Overriding `MCP_CREDENTIAL_SNAPSHOT` rather than pointing
 * `MCP_CREDENTIALS_FILE` at a fixture keeps the test independent of a file on
 * disk that the demo scripts also write to — a shared fixture is how a passing
 * suite starts depending on the order someone ran the demos in.
 */
export const TWO_ORG_CREDENTIALS: McpCredentialSnapshot = Object.freeze({
  [TOKEN_A]: {
    credentialId: 'cred-test-org-a',
    organizationId: ORG_A,
    agentId: AGENT_A,
    agentAccount: `${CHAIN_ID}:AgentTestOrgAWalletAddress11111` as AccountId,
    chainId: CHAIN_ID,
    label: 'org A',
    // These stand in for the dashboard login, as the local stack's do.
    kind: 'human',
  },
  [TOKEN_B]: {
    credentialId: 'cred-test-org-b',
    organizationId: ORG_B,
    agentId: AGENT_B,
    agentAccount: `${CHAIN_ID}:AgentTestOrgBWalletAddress22222` as AccountId,
    chainId: CHAIN_ID,
    label: 'org B',
    // These stand in for the dashboard login, as the local stack's do.
    kind: 'human',
  },
});

export interface ApiTestContext {
  app: INestApplication;
  dataSource: DataSource;
  close(): Promise<void>;
}

/**
 * Boots the real API module, wired the way `bootstrapApi` wires it.
 *
 * The global prefix, the versioning, the validation pipe, the transform
 * interceptor and — critically — `AllExceptionsFilter` are all applied here,
 * because the assertion under test is about a **status code**, and the filter
 * is what produces it. A test that skipped the filter would assert against
 * Nest's default error rendering and prove nothing about what a client sees.
 */
export async function createApiTestContext(
  moduleClass: unknown,
  credentials: McpCredentialSnapshot = TWO_ORG_CREDENTIALS,
): Promise<ApiTestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [moduleClass as never],
  })
    .overrideProvider(MCP_CREDENTIAL_SNAPSHOT)
    .useValue(credentials)
    .compile();

  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  await app.init();

  const dataSource = app.get<DataSource>(DataSource, { strict: false });

  return {
    app,
    dataSource,
    async close() {
      await app.close();
    },
  };
}

/** `Authorization` header for a tenant. */
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
