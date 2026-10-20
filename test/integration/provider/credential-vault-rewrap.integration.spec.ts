import { randomBytes } from 'node:crypto';

import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';
import { VaultKeks } from '@modules/provider/credentials/credential-vault.keys';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { BindingAuthMode, PricingMode } from '@modules/tool/ports/tool.types';
import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';
import { MoneyUtil } from '@shared/utils/money.util';
import { EgressBindingInvoker } from '@modules/tool/services/egress-binding.invoker';

import { rewrapAllDeks } from '../../../scripts/vault/rewrap-deks';
import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

const k1 = { keyId: 'k1', key: randomBytes(32) };
const k2 = { keyId: 'k2', key: randomBytes(32) };
const only = (...ks: (typeof k1)[]): VaultKeks => ({
  active: ks[0],
  byId: new Map(ks.map((k) => [k.keyId, k])),
});

const ORIGIN = 'https://a.test';
const headers = [{ name: 'Authorization', value: 'Bearer sk-example-1234567890abcdef' }];

let context: BindingEditorTestContext;
let repository: BindingCredentialRepository;

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
    authMode: BindingAuthMode.NONE,
  } as SaveToolBindingBodyDto;
}

async function sealedBinding(name: string): Promise<{ organizationId: string; bindingId: string }> {
  await context.reset();
  await context.dataSource.query('DELETE FROM binding_credentials');
  await context.dataSource.query('DELETE FROM vault_kek_checks');
  await context.registerProvider();
  const organizationId = context.organizationId;
  context.stakes.set(organizationId, MoneyUtil.of('100000000', USDC_ASSET, USDC_DECIMALS));
  const bindingId = (await context.editor.create(organizationId, name, body())).id;
  await new CredentialVaultService(repository, only(k1)).put(
    organizationId,
    bindingId,
    ORIGIN,
    headers,
    'it',
  );
  return { organizationId, bindingId };
}

beforeAll(async () => {
  context = await createBindingEditorTestContext({} as unknown as EgressBindingInvoker);
  repository = new BindingCredentialRepository(context.dataSource);
});

afterAll(async () => {
  await context.close();
});

describe('credential vault KEK rewrap', () => {
  it('moves the DEK to the new KEK without touching the ciphertext', async () => {
    const { organizationId, bindingId } = await sealedBinding('rewrap-it');
    const [before] = await context.dataSource.query(
      `SELECT ciphertext, iv, wrapped_dek FROM binding_credentials WHERE binding_id = $1`,
      [bindingId],
    );

    const result = await rewrapAllDeks(context.dataSource, only(k2, k1), 1);
    expect(result).toEqual({ rewrapped: 1, alreadyActive: 0, failed: 0 });

    const [after] = await context.dataSource.query(
      `SELECT kek_id, ciphertext, iv, wrapped_dek FROM binding_credentials WHERE binding_id = $1`,
      [bindingId],
    );
    expect(after.kek_id).toBe('k2');
    expect(after.ciphertext.equals(before.ciphertext)).toBe(true);
    expect(after.iv.equals(before.iv)).toBe(true);
    expect(after.wrapped_dek.equals(before.wrapped_dek)).toBe(false);

    // Only the new key is loaded now.
    const onlyK2 = new CredentialVaultService(repository, only(k2));
    expect(await onlyK2.headersFor(organizationId, bindingId, ORIGIN)).toEqual(headers);

    // Re-running is a no-op.
    expect(await rewrapAllDeks(context.dataSource, only(k2, k1))).toEqual({
      rewrapped: 0,
      alreadyActive: 1,
      failed: 0,
    });
  });

  it('counts rows whose KEK is not loaded as failed and leaves them unchanged', async () => {
    const { bindingId } = await sealedBinding('rewrap-it-2');
    expect(await rewrapAllDeks(context.dataSource, only(k2))).toEqual({
      rewrapped: 0,
      alreadyActive: 0,
      failed: 1,
    });
    const [row] = await context.dataSource.query(
      `SELECT kek_id FROM binding_credentials WHERE binding_id = $1`,
      [bindingId],
    );
    expect(row.kek_id).toBe('k1');
  });

  it('aborts before any write when a loaded key does not match its stored check value', async () => {
    const { bindingId } = await sealedBinding('rewrap-it-kcv');
    // Record the real k1 and k2, as a boot would.
    await rewrapAllDeks(context.dataSource, only(k1));
    const wrongK1 = { keyId: 'k1', key: randomBytes(32) };

    await expect(rewrapAllDeks(context.dataSource, only(k2, wrongK1))).rejects.toThrow(
      'Vault key "k1" does not match the key-check value stored for it',
    );
    const [row] = await context.dataSource.query(
      `SELECT kek_id FROM binding_credentials WHERE binding_id = $1`,
      [bindingId],
    );
    expect(row.kek_id).toBe('k1');
  });
});
