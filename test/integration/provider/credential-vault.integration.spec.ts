import { randomBytes, randomUUID } from 'node:crypto';

import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { VaultKeks } from '@modules/provider/credentials/credential-vault.keys';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { VaultKekCheckRepository } from '@database/postgres/repositories/vault-kek-check.repository';
import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';
import { BindingCredentialEntity } from '@database/postgres/entities/binding-credential.entity';
import { MoneyUtil } from '@shared/utils/money.util';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';

import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

const kek = { keyId: 'k1', key: randomBytes(32) };
const keks: VaultKeks = { active: kek, byId: new Map([[kek.keyId, kek]]) };
const SECRET = 'Bearer sk-example-1234567890abcdef';
const A = 'https://a.test';
const B = 'https://b.test';

let context: BindingEditorTestContext;
let repository: BindingCredentialRepository;
let vault: CredentialVaultService;
let organizationId: string;
let bindingId: string;

function body(): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: 'http://provider.example.com/api',
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    priceAmount: '50000',
    assetId: USDC_ASSET,
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 30_000,
  } as SaveToolBindingBodyDto;
}

beforeAll(async () => {
  context = await createBindingEditorTestContext({} as unknown as EgressBindingInvoker);
  repository = new BindingCredentialRepository(context.dataSource);
  vault = new CredentialVaultService(repository, keks);
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await context.reset();
  await context.registerProvider();
  organizationId = context.organizationId;
  context.stakes.set(organizationId, MoneyUtil.of('100000000', USDC_ASSET, USDC_DECIMALS));
  bindingId = (await context.editor.create(organizationId, 'cred-it', body())).id;
});

const headers = [{ name: 'Authorization', value: SECRET }];

describe('credential vault', () => {
  it('lists names and hints without any value', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    const listed = await vault.list(organizationId, bindingId);
    expect(listed).toHaveLength(1);
    expect(listed[0].headers).toEqual([{ name: 'Authorization', hint: 'cdef' }]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(JSON.stringify(listed)).not.toContain('sk-example');
  });

  it('serves values for exactly the stored origin', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    expect(await vault.headersFor(organizationId, bindingId, A)).toEqual(headers);
    expect(await vault.headersFor(organizationId, bindingId, B)).toEqual([]);
  });

  it('does not serve another organization', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    expect(await vault.headersFor(randomUUID(), bindingId, A)).toEqual([]);
    expect(await vault.list(randomUUID(), bindingId)).toEqual([]);
  });

  it('stores no plaintext bytes', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    const [row] = await context.dataSource.query(
      `SELECT ciphertext, wrapped_dek FROM binding_credentials WHERE binding_id = $1`,
      [bindingId],
    );
    expect(row.ciphertext.includes(Buffer.from('sk-example'))).toBe(false);
    expect(row.ciphertext.length).toBeGreaterThan(16);
  });

  it('replaces the set on a second put', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    const next = [{ name: 'X-Api-Version', value: 'v2' }];
    await vault.put(organizationId, bindingId, A, next, 'it');
    expect(await vault.headersFor(organizationId, bindingId, A)).toEqual(next);
    expect(await vault.list(organizationId, bindingId)).toHaveLength(1);
  });

  describe('boot key check', () => {
    it('writes the value on first use, accepts it again and rejects reused ids', async () => {
      const checks = new VaultKekCheckRepository(context.dataSource);
      const id = `it-${randomUUID().slice(0, 8)}`;
      const first = { keyId: id, key: randomBytes(32) };
      const boot = (k: typeof first) =>
        new CredentialVaultService(
          repository,
          { active: k, byId: new Map([[k.keyId, k]]) },
          checks,
        ).onModuleInit();
      await boot(first);
      expect(await checks.findKcv(id)).toHaveLength(16);
      await expect(boot(first)).resolves.toBeUndefined();
      await expect(boot({ keyId: id, key: randomBytes(32) })).rejects.toThrow(`"${id}"`);
    });
  });

  it('concurrent puts for one origin all succeed and leave exactly one set', async () => {
    const puts = Array.from({ length: 8 }, (_, i) =>
      vault.put(
        organizationId,
        bindingId,
        A,
        [{ name: 'Authorization', value: `${SECRET}-${i}` }],
        `it-${i}`,
      ),
    );
    const results = await Promise.allSettled(puts);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const listed = await vault.list(organizationId, bindingId);
    expect(listed).toHaveLength(1);
    // Last writer wins, and what is stored opens to one of the values written.
    const [stored] = await vault.headersFor(organizationId, bindingId, A);
    expect(stored.value).toMatch(new RegExp(`^${SECRET}-[0-7]$`));
  });

  it("does not overwrite another organization's row at the same key", async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    await expect(
      vault.put(
        randomUUID(),
        bindingId,
        A,
        [{ name: 'Authorization', value: 'x'.repeat(20) }],
        'x',
      ),
    ).rejects.toThrow('held by another organization');
    expect(await vault.headersFor(organizationId, bindingId, A)).toEqual(headers);
  });

  it('removes a set', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    await vault.remove(organizationId, bindingId, A);
    expect(await vault.list(organizationId, bindingId)).toEqual([]);
  });

  it('cascades when the binding is deleted', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    await context.dataSource.query(`DELETE FROM tool_bindings WHERE id = $1`, [bindingId]);
    expect(
      await context.dataSource.getRepository(BindingCredentialEntity).countBy({ bindingId }),
    ).toBe(0);
  });

  it('prunes origins that are not kept', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    await vault.put(organizationId, bindingId, B, headers, 'it');
    const pruned = await context.dataSource.transaction((manager) =>
      vault.pruneExcept(manager, organizationId, bindingId, [A]),
    );
    expect(pruned).toEqual([{ origin: B, headerNames: headers.map((h) => h.name) }]);
    expect((await vault.list(organizationId, bindingId)).map((s) => s.origin)).toEqual([A]);
    await context.dataSource.transaction((manager) =>
      vault.pruneExcept(manager, organizationId, bindingId, []),
    );
    expect(await vault.list(organizationId, bindingId)).toEqual([]);
  });

  it('fails closed when the row exists but its key is not loaded', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    const keyless = new CredentialVaultService(repository, { active: null, byId: new Map() });
    await expect(keyless.headersFor(organizationId, bindingId, A)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE,
    });
    await expect(keyless.put(organizationId, bindingId, B, headers, 'it')).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_CREDENTIAL_VAULT_NOT_CONFIGURED,
    });
  });

  it('refuses a row moved to another origin (AAD binding)', async () => {
    await vault.put(organizationId, bindingId, A, headers, 'it');
    await context.dataSource.query(
      `UPDATE binding_credentials SET origin = $2 WHERE binding_id = $1`,
      [bindingId, B],
    );
    await expect(vault.headersFor(organizationId, bindingId, B)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE,
    });
  });
});
