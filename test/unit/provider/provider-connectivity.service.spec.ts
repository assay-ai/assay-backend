/**
 * `ProviderConnectivityService` — the connectivity check.
 *
 * Two different fidelities on purpose:
 *
 * - The address/scheme guard (`BLOCKED` cases) runs the **real**
 *   `resolveEgressTarget` — no mock — because the whole point of these tests
 *   is proving the egress guard actually refuses the packet, the same discipline
 *   `egress-http.client.spec.ts` uses for the client itself.
 * - The dial itself (`REACHABLE` / `UNREACHABLE` from a transport failure) is
 *   exercised against a mocked `EgressHttpClient` — the client's own socket
 *   behaviour (redirects, timeouts, body caps…) is already exhaustively
 *   covered by `egress-http.client.spec.ts`; this file only has to prove that
 *   *this* service maps a response or a thrown `EgressError` onto the right
 *   `ConnectivityOutcome` and the right row.
 *
 * DNS is always faked (`EGRESS_DNS_LOOKUP`, injected exactly like
 * `EgressHttpClient` accepts it) so the suite never depends on real network —
 * see that constant's doc comment in `egress-http.client.ts`.
 */
import { ProviderConnectivityCheckEntity } from '@database/postgres/entities/provider-connectivity-check.entity';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ProviderConnectivityCheckRepository } from '@database/postgres/repositories/provider-connectivity-check.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';

import {
  BlockedAddressReason,
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
} from '@shared/network/egress';

import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ConnectivityOutcome } from '@modules/provider/ports/provider-registration.types';
import { ProviderConnectivityService } from '@modules/provider/services/provider-connectivity.service';
import { ProviderEgressLimiter } from '@modules/provider/services/provider-egress-limiter.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-11111111-1111-4111-8111-111111111111';

// A public-looking literal IP (example.com's, reused from
// `egress-http.client.spec.ts` — real, public, and it will never route
// anywhere this suite dials because the client is mocked).
const PUBLIC_ENDPOINT = 'https://93.184.216.34/health';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeProviderRepository {
  readonly rows = new Map<string, Partial<ProviderEntity>>();

  seed(organizationId: string, endpoint: string | null): void {
    this.rows.set(organizationId, { organizationId, endpoint });
  }

  async findOneBy(where: { organizationId: string }): Promise<ProviderEntity | null> {
    const row = this.rows.get(where.organizationId);
    return row ? (row as ProviderEntity) : null;
  }

  // `affected` is optional, not `number`, on purpose — it mirrors TypeORM's
  // `UpdateResult`, where some drivers report no row count at all. A fake that
  // narrowed it to `number` would make the `affected: undefined` case below
  // untypeable, which is precisely the case that used to slip through.
  async update(
    criteria: { organizationId: string },
    patch: Partial<ProviderEntity>,
  ): Promise<{ affected?: number }> {
    const row = this.rows.get(criteria.organizationId);
    if (!row) return { affected: 0 };
    Object.assign(row, patch);
    return { affected: 1 };
  }

  asRepository(): ProviderRepository {
    return this as unknown as ProviderRepository;
  }
}

let rowSeq = 0;

class FakeConnectivityCheckRepository {
  readonly rows: ProviderConnectivityCheckEntity[] = [];

  create(partial: Partial<ProviderConnectivityCheckEntity>): ProviderConnectivityCheckEntity {
    return { ...partial } as ProviderConnectivityCheckEntity;
  }

  async save(entity: ProviderConnectivityCheckEntity): Promise<ProviderConnectivityCheckEntity> {
    rowSeq += 1;
    const row: ProviderConnectivityCheckEntity = {
      ...entity,
      id: `check-${rowSeq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    } as ProviderConnectivityCheckEntity;
    this.rows.push(row);
    return row;
  }

  asRepository(): ProviderConnectivityCheckRepository {
    return this as unknown as ProviderConnectivityCheckRepository;
  }
}

/** DNS never touches the real network — only `dns-failure.provider.test` is unmapped. */
const ZONE: Readonly<Record<string, { address: string; family: 4 | 6 }>> = {
  'edge.provider.test': { address: '93.184.216.34', family: 4 },
  'postgres.internal': { address: '10.20.3.4', family: 4 },
};

const fakeLookup = jest.fn(async (hostname: string) => {
  if (ZONE[hostname]) return [ZONE[hostname]];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

interface FakeHttpClient {
  request: jest.Mock;
}

function buildHarness(options: { relayConfigured?: boolean } = {}) {
  const providers = new FakeProviderRepository();
  const checks = new FakeConnectivityCheckRepository();
  const http: FakeHttpClient = { request: jest.fn() };

  const service = new ProviderConnectivityService(
    providers.asRepository(),
    checks.asRepository(),
    http as unknown as EgressHttpClient,
    new ProviderEgressLimiter(),
    fakeLookup,
    options.relayConfigured ? { url: new URL('https://egress.test'), token: 'a'.repeat(64) } : null,
  );

  return { providers, checks, http, service };
}

beforeEach(() => {
  fakeLookup.mockClear();
  rowSeq = 0;
});

// ---------------------------------------------------------------------------
// REACHABLE
// ---------------------------------------------------------------------------

describe('a live endpoint that answers', () => {
  it('200 → REACHABLE, and PUT saves it onto the provider row', async () => {
    const { service, providers, checks, http } = buildHarness();
    providers.seed(ORG, null);
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      bytes: 2,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });

    const result = await service.declareEndpoint(ORG, PUBLIC_ENDPOINT);

    expect(result.outcome).toBe(ConnectivityOutcome.REACHABLE);
    expect(result.statusCode).toBe(200);
    expect(providers.rows.get(ORG)?.endpoint).toBe(PUBLIC_ENDPOINT);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0].outcome).toBe(ConnectivityOutcome.REACHABLE);
  });

  it('asks for the egress relay', async () => {
    const { service, providers, http } = buildHarness();
    providers.seed(ORG, null);
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      bytes: 2,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });
    await service.declareEndpoint(ORG, PUBLIC_ENDPOINT);
    expect(http.request.mock.calls[0][0].policy.relay).toBe(true);
  });

  it('refuses a port the relay cannot reach when the relay is configured', async () => {
    const { service, providers, http } = buildHarness({ relayConfigured: true });
    providers.seed(ORG, null);
    await expectErrorCodeAsync(
      () => service.declareEndpoint(ORG, 'https://p.test:3000/x'),
      ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
    );
    expect(http.request).not.toHaveBeenCalled();
    expect(providers.rows.get(ORG)?.endpoint).toBeNull();
  });

  it.each(['http://p.test/x', 'https://203.0.113.9/x'])(
    'refuses %s at declaration when the relay is configured',
    async (endpoint) => {
      const { service, providers, http } = buildHarness({ relayConfigured: true });
      providers.seed(ORG, null);
      await expectErrorCodeAsync(
        () => service.declareEndpoint(ORG, endpoint),
        ProviderErrorCode.PROVIDER_ENDPOINT_NOT_RELAYABLE,
      );
      expect(http.request).not.toHaveBeenCalled();
      expect(providers.rows.get(ORG)?.endpoint).toBeNull();
    },
  );

  it('takes its slot from the connectivity pool, not the tester pool (N-3)', async () => {
    const { service, providers, http } = buildHarness();
    providers.seed(ORG, null);
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      bytes: 2,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });
    const run = jest.spyOn(ProviderEgressLimiter.prototype, 'run');

    await service.check(ORG, PUBLIC_ENDPOINT);

    expect(run).toHaveBeenCalledWith(ORG, expect.any(Function), 'connectivity');
    run.mockRestore();
  });

  it('401 → still REACHABLE — auth is not this check’s business', async () => {
    const { service, http } = buildHarness();
    http.request.mockResolvedValue({
      status: 401,
      headers: {},
      body: '{"error":"unauthorized"}',
      bytes: 24,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });

    const result = await service.check(ORG, PUBLIC_ENDPOINT);

    expect(result.outcome).toBe(ConnectivityOutcome.REACHABLE);
    expect(result.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// UNREACHABLE
// ---------------------------------------------------------------------------

describe('a dead endpoint', () => {
  it('DNS failure → UNREACHABLE, and PUT does not save it', async () => {
    const { service, providers, checks } = buildHarness();
    providers.seed(ORG, 'https://old-working-endpoint.example/api');

    await expectErrorCodeAsync(
      () => service.declareEndpoint(ORG, 'https://dns-failure.provider.test/api'),
      ProviderErrorCode.PROVIDER_CONNECTIVITY_CHECK_FAILED,
    );

    // The old endpoint survives — a failed re-declare must not clobber it.
    expect(providers.rows.get(ORG)?.endpoint).toBe('https://old-working-endpoint.example/api');
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0].outcome).toBe(ConnectivityOutcome.UNREACHABLE);
    expect(checks.rows[0].failureKind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('a connection failure past the address check → UNREACHABLE, not saved', async () => {
    const { service, providers, checks, http } = buildHarness();
    providers.seed(ORG, null);
    http.request.mockRejectedValue(
      new EgressError(EgressFailureKind.CONNECTION_FAILED, 'ECONNREFUSED: connection refused', {
        url: PUBLIC_ENDPOINT,
      }),
    );

    const result = await service.check(ORG, PUBLIC_ENDPOINT);

    expect(result.outcome).toBe(ConnectivityOutcome.UNREACHABLE);
    expect(result.failureKind).toBe(EgressFailureKind.CONNECTION_FAILED);
    expect(providers.rows.get(ORG)?.endpoint).toBeNull();
    expect(checks.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BLOCKED — the real guard, not a mock
// ---------------------------------------------------------------------------

describe('a plaintext endpoint', () => {
  it('http:// → BLOCKED with EGRESS_SCHEME_NOT_ALLOWED, before any dial', async () => {
    const { service, checks, http } = buildHarness();

    const result = await service.check(ORG, 'http://api.vesseldata.example/v2/ais');

    expect(result.outcome).toBe(ConnectivityOutcome.BLOCKED);
    expect(result.failureCode).toBe('EGRESS_SCHEME_NOT_ALLOWED');
    expect(http.request).not.toHaveBeenCalled();
    expect(checks.rows[0].outcome).toBe(ConnectivityOutcome.BLOCKED);
  });
});

describe('an endpoint resolving to a blocked address — proving the egress guard blocked it', () => {
  it.each([
    ['https://127.0.0.1/admin', BlockedAddressReason.LOOPBACK],
    ['https://10.0.0.1/internal', BlockedAddressReason.PRIVATE],
    ['https://169.254.169.254/latest/meta-data/', BlockedAddressReason.CLOUD_METADATA],
  ])('%s → BLOCKED with EGRESS_BLOCKED_ADDRESS (%s)', async (endpoint, _reason) => {
    const { service, checks, http } = buildHarness();

    const result = await service.check(ORG, endpoint);

    expect(result.outcome).toBe(ConnectivityOutcome.BLOCKED);
    expect(result.failureCode).toBe('EGRESS_BLOCKED_ADDRESS');
    // Never reached the client — the refusal happened at the pre-flight resolve.
    expect(http.request).not.toHaveBeenCalled();
    expect(checks.rows[0].outcome).toBe(ConnectivityOutcome.BLOCKED);
  });

  // Review P-9: the detail is returned to the caller; it must not name the
  // private address an internal hostname resolves to.
  it('does not reveal the internal address a hostname resolves to', async () => {
    const { service } = buildHarness();

    const result = await service.check(ORG, 'https://postgres.internal/');

    expect(result.failureCode).toBe('EGRESS_BLOCKED_ADDRESS');
    expect(result.detail).not.toContain('10.20.3.4');
    expect(result.detail).not.toContain('10.0.0.0/8');
  });

  it('refuses PUT /providers/me/endpoint the same way — a dead endpoint is not savable', async () => {
    const { service, providers } = buildHarness();
    providers.seed(ORG, null);

    await expectErrorCodeAsync(
      () => service.declareEndpoint(ORG, 'https://169.254.169.254/latest/meta-data/'),
      ProviderErrorCode.PROVIDER_CONNECTIVITY_CHECK_FAILED,
    );

    expect(providers.rows.get(ORG)?.endpoint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No endpoint at all
// ---------------------------------------------------------------------------

describe('checking with no endpoint given', () => {
  it('uses the endpoint already saved on the provider row', async () => {
    const { service, providers, http } = buildHarness();
    providers.seed(ORG, PUBLIC_ENDPOINT);
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      bytes: 2,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });

    const result = await service.check(ORG);

    expect(result.endpoint).toBe(PUBLIC_ENDPOINT);
    expect(result.outcome).toBe(ConnectivityOutcome.REACHABLE);
  });

  it('PROVIDER_ENDPOINT_NOT_DECLARED when nothing was ever saved', async () => {
    const { service, providers } = buildHarness();
    providers.seed(ORG, null);

    await expectErrorCodeAsync(
      () => service.check(ORG),
      ProviderErrorCode.PROVIDER_ENDPOINT_NOT_DECLARED,
    );
  });
});

// ---------------------------------------------------------------------------
// The save itself — a REACHABLE probe is not proof that anything was written
// ---------------------------------------------------------------------------

describe('declaring an endpoint when the UPDATE matches no provider row', () => {
  /** A probe that comes back 200, so the only thing left to fail is the write. */
  function mockReachable(http: FakeHttpClient): void {
    http.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: '{}',
      bytes: 2,
      url: PUBLIC_ENDPOINT,
      redirects: 0,
    });
  }

  it('affected: 0 → PROVIDER_NOT_FOUND, not a healthy-looking 200', async () => {
    const { service, providers, http } = buildHarness();
    mockReachable(http);
    // No `providers.seed(...)` — an org that never ran registration, or whose
    // row was deleted. The probe still succeeds; the write matches nothing.

    await expectErrorCodeAsync(
      () => service.declareEndpoint(ORG, PUBLIC_ENDPOINT),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );

    expect(providers.rows.has(ORG)).toBe(false);
  });

  it('affected: undefined → PROVIDER_NOT_FOUND as well — some drivers report it that way', async () => {
    const { service, providers, http } = buildHarness();
    mockReachable(http);
    providers.seed(ORG, null);
    // A guard written against `=== 0` would read this as a success and brick
    // endpoint saves for every provider on that driver, silently.
    jest.spyOn(providers, 'update').mockResolvedValue({ affected: undefined });

    await expectErrorCodeAsync(
      () => service.declareEndpoint(ORG, PUBLIC_ENDPOINT),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });

  it('affected: 1 → the probe result comes back unchanged', async () => {
    const { service, providers, http } = buildHarness();
    mockReachable(http);
    providers.seed(ORG, null);

    const result = await service.declareEndpoint(ORG, PUBLIC_ENDPOINT);

    expect(result.outcome).toBe(ConnectivityOutcome.REACHABLE);
    expect(result.statusCode).toBe(200);
    expect(result.endpoint).toBe(PUBLIC_ENDPOINT);
    expect(providers.rows.get(ORG)?.endpoint).toBe(PUBLIC_ENDPOINT);
  });
});
