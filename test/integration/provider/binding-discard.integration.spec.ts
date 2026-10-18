import { randomBytes, randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  EVIDENCE,
  ProviderToolBindingsService,
} from '@modules/provider/services/provider-tool-bindings.service';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { AuditLogWriter } from '@shared/audit';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { USDC_ASSET } from '../helpers/test-database';

/**
 * `DELETE /providers/me/tool-bindings/:id` against every migration on disk.
 *
 * The refusal list ({@link EVIDENCE}) is raw SQL over table names, so it is
 * only proven by a schema that has all of them: a table renamed or a column
 * dropped fails here rather than in a provider's console.
 */
const ACTOR = { type: 'user' as const, id: 'cred-discard-test' };
const CHAIN = USDC_ASSET.split('/')[0];

let dataSource: DataSource;
let service: ProviderToolBindingsService;
let vault: CredentialVaultService;
/** One catalogue tool: every test uses a fresh organization, so one binding per tool is never a clash. */
const TOOL_ID = randomUUID();

beforeAll(async () => {
  dataSource = await freshMigratedDatabase('binding_discard_test');
  await dataSource.query(
    `INSERT INTO tools (id, name, kind, category, visibility, status)
     VALUES ($1, 'discard_test_tool', 'STANDARD', 'data', 'LISTED', 'ACTIVE')`,
    [TOOL_ID],
  );
  const kek = { keyId: 'discard-kek', key: randomBytes(32) };
  vault = new CredentialVaultService(new BindingCredentialRepository(dataSource), {
    active: kek,
    byId: new Map([[kek.keyId, kek]]),
  });
  service = new ProviderToolBindingsService(
    new ToolBindingRepository(dataSource),
    {} as ToolCataloguePort,
    new ConfigService(),
    new BindingVersionRepository(dataSource),
    dataSource,
    vault,
    new AuditLogWriter(dataSource),
  );
});

afterAll(async () => {
  await dataSource?.destroy();
});

async function draft(organizationId: string, toolId = TOOL_ID): Promise<string> {
  const [row] = (await dataSource.query(
    `INSERT INTO tool_bindings
       (organization_id, tool_id, endpoint, request_mapping, response_mapping, pricing_mode,
        price_amount, asset_id, sla_failure_rate, timeout_ms, settlement_chains)
     VALUES ($1, $2, 'https://api.example.com/v1', '{}', '{}', 'PAID', 10000, $3, 0.02, 8000, $4)
     RETURNING id`,
    [organizationId, toolId, USDC_ASSET, [CHAIN]],
  )) as Array<{ id: string }>;
  return row.id;
}

async function exists(bindingId: string): Promise<boolean> {
  const [row] = (await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM tool_bindings WHERE id = $1) AS e`,
    [bindingId],
  )) as Array<{ e: boolean }>;
  return row.e;
}

describe('discarding a draft', () => {
  it('deletes the draft, its credential sets through the vault, and writes one audit entry', async () => {
    const organizationId = randomUUID();
    const bindingId = await draft(organizationId);
    await vault.put(
      organizationId,
      bindingId,
      'https://api.example.com',
      [{ name: 'X-Api-Key', value: 'not-a-real-key' }],
      ACTOR.id,
    );

    await service.discardDraft(organizationId, ACTOR, bindingId);

    expect(await exists(bindingId)).toBe(false);
    expect(await vault.list(organizationId, bindingId)).toEqual([]);
    const audit = (await dataSource.query(
      `SELECT action, actor_id, resource_id, before FROM audit_log_entries
        WHERE organization_id = $1 AND resource_id = $2`,
      [organizationId, bindingId],
    )) as Array<{
      action: string;
      actor_id: string;
      resource_id: string;
      before: Record<string, unknown>;
    }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('tool_binding.discarded');
    expect(audit[0].actor_id).toBe(ACTOR.id);
    // Header names only: the value never reaches the log.
    expect(audit[0].before.credential_sets).toEqual([
      { origin: 'https://api.example.com', header_names: ['X-Api-Key'] },
    ]);
    expect(JSON.stringify(audit[0].before)).not.toContain('not-a-real-key');
  });

  it("is a 404 for another organization's binding, and leaves it alone", async () => {
    const owner = randomUUID();
    const bindingId = await draft(owner);

    await expect(service.discardDraft(randomUUID(), ACTOR, bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    });
    expect(await exists(bindingId)).toBe(true);
  });

  it('refuses a binding that was published, even after it went back to draft status', async () => {
    const organizationId = randomUUID();
    const bindingId = await draft(organizationId);
    await dataSource.query(
      `UPDATE tool_bindings SET published_version = 1, published_at = now() WHERE id = $1`,
      [bindingId],
    );

    await expect(service.discardDraft(organizationId, ACTOR, bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_DISCARDABLE,
    });
    expect(await exists(bindingId)).toBe(true);
  });

  it('refuses a draft that any traffic row already names, and writes no audit entry', async () => {
    const organizationId = randomUUID();
    const bindingId = await draft(organizationId);
    await dataSource.query(
      `INSERT INTO binding_stats (binding_id, provider_id, refreshed_at) VALUES ($1, $2, now())`,
      [bindingId, organizationId],
    );

    await expect(service.discardDraft(organizationId, ACTOR, bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_DISCARDABLE,
    });
    expect(await exists(bindingId)).toBe(true);
    const [audit] = (await dataSource.query(
      `SELECT count(*)::int AS n FROM audit_log_entries WHERE resource_id = $1`,
      [bindingId],
    )) as Array<{ n: number }>;
    expect(audit.n).toBe(0);
  });

  it('names only tables that exist, each with a binding_id column', async () => {
    const rows = (await dataSource.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'binding_id' AND table_name = ANY($1)`,
      [EVIDENCE.map((entry) => entry.table)],
    )) as Array<{ table_name: string }>;
    expect(rows.map((row) => row.table_name).sort()).toEqual(
      [...new Set(EVIDENCE.map((entry) => entry.table))].sort(),
    );
  });
});
