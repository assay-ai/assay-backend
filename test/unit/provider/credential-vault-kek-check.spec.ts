import { randomBytes } from 'node:crypto';

import { kekCheckValue, Kek } from '@modules/provider/credentials/credential-vault.crypto';
import { CredentialVaultService } from '@modules/provider/credentials/credential-vault.service';

const kek = (keyId: string): Kek => ({ keyId, key: randomBytes(32) });

function build(keks: Kek[], stored: Map<string, Buffer> = new Map()) {
  const checks = {
    findKcv: jest.fn(async (id: string) => stored.get(id) ?? null),
    insertIfAbsent: jest.fn(async (id: string, kcv: Buffer) => {
      if (!stored.has(id)) stored.set(id, kcv);
    }),
  };
  const vault = new CredentialVaultService(
    {} as never,
    { active: keks[0] ?? null, byId: new Map(keks.map((k) => [k.keyId, k])) },
    checks as never,
  );
  return { vault, stored, checks };
}

describe('kekCheckValue', () => {
  it('is 16 bytes, stable per key and different across keys', () => {
    const a = kek('a');
    expect(kekCheckValue(a)).toHaveLength(16);
    expect(kekCheckValue(a).equals(kekCheckValue(a))).toBe(true);
    expect(kekCheckValue(a).equals(kekCheckValue(kek('a')))).toBe(false);
    expect(kekCheckValue(a).toString('hex')).not.toContain(a.key.toString('hex'));
  });
});

describe('CredentialVaultService.verifyKeks', () => {
  it('writes the value on first use, then accepts the same key', async () => {
    const k = kek('k1');
    const { vault, stored } = build([k]);
    await vault.onModuleInit();
    expect(stored.get('k1')?.equals(kekCheckValue(k))).toBe(true);
    await expect(vault.verifyKeks()).resolves.toBeUndefined();
  });

  it('fails the boot naming the kid, never the key, when the bytes changed', async () => {
    const original = kek('k1');
    const swapped: Kek = { keyId: 'k1', key: randomBytes(32) };
    const { vault } = build([swapped], new Map([['k1', kekCheckValue(original)]]));
    const error = await vault.verifyKeks().catch((e: Error) => e);
    expect((error as Error).message).toContain('"k1"');
    expect((error as Error).message).not.toContain(swapped.key.toString('hex'));
    expect((error as Error).message).not.toContain(original.key.toString('hex'));
  });

  it('checks every loaded key, not only the active one', async () => {
    const good = kek('new');
    const old = kek('old');
    const { vault } = build([good, old], new Map([['old', kekCheckValue(kek('old'))]]));
    await expect(vault.verifyKeks()).rejects.toThrow('"old"');
  });

  it('does nothing without keys or without a check repository', async () => {
    await expect(build([]).vault.verifyKeks()).resolves.toBeUndefined();
    const bare = new CredentialVaultService({} as never, { active: null, byId: new Map() });
    await expect(bare.onModuleInit()).resolves.toBeUndefined();
  });
});
