import { randomUUID } from 'node:crypto';

import { OperatorEntity } from '@database/postgres/entities/operator.entity';

import {
  OperatorCliRepository,
  parseFlags,
  runOperatorCli,
} from '../../../scripts/operator/lib/operator-cli';
import { buildOperator } from './helpers/fake-operator-repository';

const WALLET = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';

class MemoryOperators implements OperatorCliRepository {
  readonly rows: OperatorEntity[] = [];
  async findByWallet(address: string) {
    return this.rows.find((row) => row.walletAddress === address.toLowerCase()) ?? null;
  }
  async findBySubject(subject: string) {
    return this.rows.find((row) => row.subject === subject) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async listAll() {
    return [...this.rows];
  }
  create(values: Partial<OperatorEntity>) {
    return buildOperator({ id: randomUUID(), ...values });
  }
  async save(entity: OperatorEntity) {
    if (!this.rows.includes(entity)) this.rows.push(entity);
    return entity;
  }
}

async function run(repo: MemoryOperators, line: string): Promise<string[]> {
  const [command, ...argv] = line.split(' ');
  const out: string[] = [];
  await runOperatorCli(repo, command, argv, (text) => out.push(text));
  return out;
}

describe('yarn operator:add | list | remove', () => {
  it('adds an operator by wallet, lower-cased, with a limit of 0 unless one is given', async () => {
    const repo = new MemoryOperators();

    const out = await run(repo, `add --wallet ${WALLET} --subject dan@ --roles adjl,SRE`);

    expect(out[0]).toMatch(/^added: /);
    expect(repo.rows[0]).toMatchObject({
      walletAddress: WALLET.toLowerCase(),
      subject: 'dan@',
      roles: ['ADJL', 'SRE'],
      authorityLimitMinor: '0',
      status: 'ACTIVE',
    });
  });

  it('takes --limit in minor units, or "unbounded"', async () => {
    const repo = new MemoryOperators();
    await run(repo, `add --wallet ${WALLET} --subject dan@ --roles OPS_ADMIN --limit unbounded`);
    expect(repo.rows[0].authorityLimitMinor).toBeNull();

    await expect(
      run(repo, `add --wallet 0x${'1'.repeat(40)} --subject sam@ --roles ADJ --limit 1.5`),
    ).rejects.toThrow('--limit');
  });

  it('refuses an unknown role, a bad wallet, and a wallet already in use', async () => {
    const repo = new MemoryOperators();
    await expect(run(repo, `add --wallet ${WALLET} --subject dan@ --roles BOSS`)).rejects.toThrow(
      'unknown role',
    );
    await expect(run(repo, `add --wallet 0x123 --subject dan@ --roles ADJ`)).rejects.toThrow(
      '--wallet',
    );
    await run(repo, `add --wallet ${WALLET} --subject dan@ --roles ADJ`);
    await expect(run(repo, `add --wallet ${WALLET} --subject sam@ --roles ADJ`)).rejects.toThrow(
      'already operator',
    );
  });

  it('links a wallet to a row provisioned before wallet sign-in', async () => {
    const repo = new MemoryOperators();
    repo.rows.push(buildOperator({ id: randomUUID(), subject: 'ops-adjl', walletAddress: null }));

    const out = await run(repo, `add --wallet ${WALLET} --subject ops-adjl --roles ADJL`);

    expect(out[0]).toMatch(/^linked: /);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].walletAddress).toBe(WALLET.toLowerCase());
  });

  it('lists, removes, and restores a removed operator on the same row', async () => {
    const repo = new MemoryOperators();
    await run(repo, `add --wallet ${WALLET} --subject dan@ --roles ADJ`);

    expect((await run(repo, 'list'))[0]).toContain('dan@');
    expect((await run(repo, `remove --wallet ${WALLET}`))[0]).toMatch(/REMOVED$/);
    expect(repo.rows[0]).toMatchObject({ status: 'REMOVED' });
    expect(repo.rows[0].removedAt).toBeInstanceOf(Date);

    const out = await run(repo, `add --wallet ${WALLET} --subject dan@ --roles SRE`);
    expect(out[0]).toMatch(/^restored: /);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ status: 'ACTIVE', roles: ['SRE'], removedAt: null });
  });

  it('parses --flag value and --flag=value, and refuses a flag with no value', () => {
    expect(parseFlags(['--wallet', '0x1', '--roles=ADJ'])).toEqual({ wallet: '0x1', roles: 'ADJ' });
    expect(() => parseFlags(['--wallet'])).toThrow('needs a value');
  });
});
