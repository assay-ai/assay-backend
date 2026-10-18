import { ProviderBindingCredentialsController } from '@modules/provider/controllers/provider-binding-credentials.controller';
import { ProviderErrorCode, ProviderErrors } from '@modules/provider/errors/provider.errors';
import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { AuditLogWriter } from '@shared/audit';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const BINDING = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const SESSION = { organizationId: ORG, credentialId: 'cred-1' } as McpSession;
const SECRET = 'sk_live_super_secret_value_1234';

function build(
  options: {
    endpoint?: string;
    publishedEndpoint?: string | null;
    mappingHeaders?: Record<string, unknown>;
    status?: string;
  } = {},
) {
  const row = {
    id: BINDING,
    organizationId: ORG,
    status: options.status ?? 'DRAFT',
    endpoint: options.endpoint ?? 'https://api.a.test/v1',
    requestMapping: { method: 'GET', headers: options.mappingHeaders },
  };
  const editor = {
    loadEditable: jest.fn(async (organizationId: string, id: string) => {
      if (organizationId !== ORG || id !== BINDING)
        throw ProviderErrors.bindingNotFound({ bindingId: id });
      return row;
    }),
    publishedEndpoint: jest.fn(async () => options.publishedEndpoint ?? null),
  };
  const stored = {
    origin: 'https://api.a.test',
    headers: [{ name: 'X-Provider-Key', hint: '1234' }],
    updatedAt: new Date(),
  };
  const vault = {
    list: jest.fn(async () => [stored]),
    put: jest.fn(async () => stored),
    remove: jest.fn(async () => undefined),
  };
  const audit = { recordAfterCommit: jest.fn(async () => undefined) };
  const controller = new ProviderBindingCredentialsController(
    editor as unknown as BindingEditorService,
    vault as unknown as CredentialVaultService,
    audit as unknown as AuditLogWriter,
  );
  return { controller, editor, vault, audit };
}

const body = (origin: string, value = SECRET) => ({
  origin,
  headers: [{ name: 'X-Provider-Key', value }],
});

describe('ProviderBindingCredentialsController', () => {
  it('PUT with a foreign origin is a 400 and stores nothing', async () => {
    const { controller, vault } = build();
    await expectErrorCodeAsync(
      () => controller.put(SESSION, { id: BINDING }, body('https://evil.test')),
      ProviderErrorCode.PROVIDER_CREDENTIAL_ORIGIN_MISMATCH,
    );
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('PUT accepts the draft endpoint origin and returns hints without values', async () => {
    const { controller, vault } = build();
    const result = await controller.put(SESSION, { id: BINDING }, body('https://api.a.test'));
    expect(vault.put).toHaveBeenCalledWith(
      ORG,
      BINDING,
      'https://api.a.test',
      [{ name: 'X-Provider-Key', value: SECRET }],
      'cred-1',
    );
    expect(result.headers[0].hint).toBe('1234');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('PUT accepts the published endpoint origin when the draft moved elsewhere', async () => {
    const { controller, vault } = build({
      endpoint: 'https://api.new.test/v1',
      publishedEndpoint: 'https://api.old.test:8443/v1',
    });
    await controller.put(SESSION, { id: BINDING }, body('https://api.old.test:8443'));
    await controller.put(SESSION, { id: BINDING }, body('https://api.new.test'));
    expect(vault.put).toHaveBeenCalledTimes(2);
    await expectErrorCodeAsync(
      () => controller.put(SESSION, { id: BINDING }, body('https://api.old.test')),
      ProviderErrorCode.PROVIDER_CREDENTIAL_ORIGIN_MISMATCH,
    );
  });

  it('PUT with invalid headers is a 400 carrying names only, never the value', async () => {
    const { controller, vault } = build();
    const bad = { origin: 'https://api.a.test', headers: [{ name: 'Host', value: SECRET }] };
    let thrown: unknown;
    try {
      await controller.put(SESSION, { id: BINDING }, bad);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { errorCode?: string }).errorCode).toBe(
      ProviderErrorCode.PROVIDER_INVALID_CREDENTIAL_HEADERS,
    );
    expect(JSON.stringify(thrown)).not.toContain(SECRET);
    expect(String((thrown as Error).message)).not.toContain(SECRET);
    expect(vault.put).not.toHaveBeenCalled();
  });

  it("PUT counts the draft mapping's constant headers against the 8 KiB cap", async () => {
    const { controller, vault } = build({
      mappingHeaders: { 'X-Big': { $const: 'b'.repeat(4000) } },
    });
    let thrown: unknown;
    try {
      await controller.put(SESSION, { id: BINDING }, body('https://api.a.test', 'k'.repeat(4000)));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { errorCode?: string }).errorCode).toBe(
      ProviderErrorCode.PROVIDER_INVALID_CREDENTIAL_HEADERS,
    );
    expect(String((thrown as Error).message)).toContain('Headers too large');
    expect(String((thrown as Error).message)).not.toContain('kkkk');
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('PUT with an empty value is a 400', async () => {
    const { controller, vault } = build();
    await expectErrorCodeAsync(
      () => controller.put(SESSION, { id: BINDING }, body('https://api.a.test', '')),
      ProviderErrorCode.PROVIDER_INVALID_CREDENTIAL_HEADERS,
    );
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('GET never includes a value', async () => {
    const { controller } = build();
    const result = await controller.list(SESSION, { id: BINDING });
    expect(JSON.stringify(result)).not.toContain('value');
  });

  it('DELETE removes the origin through the vault', async () => {
    const { controller, vault } = build();
    await controller.remove(SESSION, { id: BINDING }, { origin: 'https://api.a.test' });
    expect(vault.remove).toHaveBeenCalledWith(ORG, BINDING, 'https://api.a.test');
  });

  it('audits put and remove with origin and header names, never values', async () => {
    const { controller, audit } = build();
    await controller.put(SESSION, { id: BINDING }, body('https://api.a.test'));
    await controller.remove(SESSION, { id: BINDING }, { origin: 'https://api.a.test' });
    expect(audit.recordAfterCommit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: ORG,
        actor: { type: 'user', id: 'cred-1' },
        action: 'binding_credentials.set',
        resourceId: BINDING,
        after: { origin: 'https://api.a.test', header_names: ['X-Provider-Key'] },
      }),
    );
    expect(audit.recordAfterCommit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'binding_credentials.removed',
        before: { origin: 'https://api.a.test', header_names: ['X-Provider-Key'] },
      }),
    );
    expect(JSON.stringify(audit.recordAfterCommit.mock.calls)).not.toContain(SECRET);
  });

  it('DELETE of an origin with no set removes nothing and audits nothing', async () => {
    const { controller, audit } = build();
    await controller.remove(SESSION, { id: BINDING }, { origin: 'https://nothing.test' });
    expect(audit.recordAfterCommit).not.toHaveBeenCalled();
  });

  describe('DELETE of the live origin', () => {
    const live = {
      status: 'ACTIVE',
      endpoint: 'https://api.a.test/v1',
      publishedEndpoint: 'https://api.a.test/v1',
    };
    it('is a 409 while the binding is ACTIVE and the origin is the published one', async () => {
      const { controller, vault } = build(live);
      await expectErrorCodeAsync(
        () => controller.remove(SESSION, { id: BINDING }, { origin: 'https://api.a.test' }),
        ProviderErrorCode.PROVIDER_CREDENTIAL_ORIGIN_LIVE,
      );
      expect(vault.remove).not.toHaveBeenCalled();
    });
    it('is allowed for another origin of an ACTIVE binding', async () => {
      const { controller, vault } = build({ ...live, endpoint: 'https://api.new.test/v1' });
      await controller.remove(SESSION, { id: BINDING }, { origin: 'https://api.new.test' });
      expect(vault.remove).toHaveBeenCalled();
    });
    it.each(['DRAFT', 'PAUSED'])('is allowed while the binding is %s', async (status) => {
      const { controller, vault } = build({ ...live, status });
      await controller.remove(SESSION, { id: BINDING }, { origin: 'https://api.a.test' });
      expect(vault.remove).toHaveBeenCalled();
    });
  });

  it("another organization's binding is a 404 on every route, before any vault call", async () => {
    const { controller, vault } = build();
    const foreign = { organizationId: OTHER_ORG, credentialId: 'cred-9' } as McpSession;
    const code = ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND;
    await expectErrorCodeAsync(() => controller.list(foreign, { id: BINDING }), code);
    await expectErrorCodeAsync(
      () => controller.put(foreign, { id: BINDING }, body('https://api.a.test')),
      code,
    );
    await expectErrorCodeAsync(
      () => controller.remove(foreign, { id: BINDING }, { origin: 'https://api.a.test' }),
      code,
    );
    expect(vault.list).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    expect(vault.remove).not.toHaveBeenCalled();
  });
});
