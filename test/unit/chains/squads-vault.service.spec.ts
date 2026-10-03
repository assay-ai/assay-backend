import {
  findAssociatedTokenPda,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { Address, address } from '@solana/kit';

import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  SquadsVaultRpcClient,
  SquadsVaultService,
} from '@modules/chains/solana/squads-vault.service';
import { MoneyUtil } from '@shared/utils/money.util';
import { SQUADS_V4_PROGRAM_ADDRESS } from '@modules/chains/solana/squads-vault.constants';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

// A fixed, well-formed create_key — any valid base58 pubkey does, the vault
// PDA is a pure function of it.
const CREATE_KEY = '11111111111111111111111111111111';
const OTHER_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// From the registry, not a literal. The devnet mint is deployment-specific
// (`SOLANA_DEVNET_USDC_MINT`), so a hard-coded address here asserts a
// *configuration* — and fails the moment the suite runs with a `.env` that sets
// one, which is now every time.
const USDC_DEVNET: AssetId = ASSET_IDS.USDC_SOLANA_DEVNET;
const USDC_MINT = getAssetMetadata(USDC_DEVNET);

function tokenAccountBase64(owner: string, mint: string, amount = 0n): string {
  const bytes = getTokenEncoder().encode({
    mint: mint as Address,
    owner: owner as Address,
    amount,
    delegate: { __option: 'None' },
    state: 1,
    isNative: { __option: 'None' },
    delegatedAmount: 0n,
    closeAuthority: { __option: 'None' },
  });
  return Buffer.from(bytes).toString('base64');
}

/** A minimal in-memory fake of the two RPC calls the service uses. */
class FakeRpc implements SquadsVaultRpcClient {
  accounts = new Map<string, { owner: string; data: string }>();
  balances = new Map<string, { amount: string; decimals: number }>();
  /** What the real RPC reports in `context.slot` alongside every value. */
  slot = 0n;

  set(addr: string, owner: string, data: string): void {
    this.accounts.set(addr, { owner, data });
  }

  getAccountInfo(accountAddress: Address) {
    const found = this.accounts.get(accountAddress as unknown as string);
    return {
      send: async () => ({
        value: found
          ? { owner: found.owner as Address, data: [found.data, 'base64'] as const }
          : null,
      }),
    };
  }

  getTokenAccountBalance(account: Address) {
    const found = this.balances.get(account as unknown as string);
    return {
      send: async () => ({
        context: { slot: this.slot },
        value: found ?? { amount: '0', decimals: 6 },
      }),
    };
  }
}

async function buildService(rpc: FakeRpc, createKey: string | null = CREATE_KEY, vaultIndex = 0) {
  return new SquadsVaultService(rpc, createKey, vaultIndex);
}

describe('SquadsVaultService — PDA derivation', () => {
  it('derives the same vault owner every time for the same config', async () => {
    const service = await buildService(new FakeRpc());
    const first = await service.getVaultOwner(USDC_DEVNET);
    const second = await service.getVaultOwner(USDC_DEVNET);
    expect(first).toBe(second);
    expect(first.startsWith(`${CHAIN_IDS.SOLANA_DEVNET}:`)).toBe(true);
  });

  it('derives the vault ATA as the associated token account of the vault PDA', async () => {
    const service = await buildService(new FakeRpc());
    const owner = await service.getVaultOwner(USDC_DEVNET);
    const account = await service.getVaultAccount(USDC_DEVNET);

    const [expectedAta] = await findAssociatedTokenPda({
      owner: address(owner.split(':').pop() as string),
      mint: address(USDC_MINT.assetId.split(':').pop() as string),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    expect(account).toBe(toAccountId(CHAIN_IDS.SOLANA_DEVNET, expectedAta));
  });

  it('two different vault indexes derive two different vaults', async () => {
    const a = await buildService(new FakeRpc(), CREATE_KEY, 0);
    const b = await buildService(new FakeRpc(), CREATE_KEY, 1);
    expect(await a.getVaultOwner(USDC_DEVNET)).not.toBe(await b.getVaultOwner(USDC_DEVNET));
  });

  it('refuses to derive anything when no create key is configured', async () => {
    const service = await buildService(new FakeRpc(), null);
    await expectErrorCodeAsync(
      () => service.getVaultOwner(USDC_DEVNET),
      ChainErrorCode.CHAIN_VAULT_NOT_CONFIGURED,
    );
  });

  it('refuses an out-of-range vault index at construction', () => {
    expect(() => new SquadsVaultService(new FakeRpc(), CREATE_KEY, 256)).toThrow();
    expect(() => new SquadsVaultService(new FakeRpc(), CREATE_KEY, -1)).toThrow();
  });
});

describe('SquadsVaultService — assertVaultControl', () => {
  async function primedService(): Promise<{ service: SquadsVaultService; rpc: FakeRpc }> {
    const rpc = new FakeRpc();
    const service = await buildService(rpc);
    const multisigPda = await service.getVaultOwner(USDC_DEVNET); // not the real multisig, just to seed cache
    void multisigPda;
    return { service, rpc };
  }

  it('passes when the multisig PDA is Squads-owned and the vault ATA authority matches', async () => {
    const { service, rpc } = await primedService();
    const owner = await service.getVaultOwner(USDC_DEVNET);
    const account = await service.getVaultAccount(USDC_DEVNET);
    // The multisig PDA itself — recompute via the service's own owner call is
    // not available, so derive it the same way the service does by reaching
    // for a fresh instance sharing the same create key.
    const anyService = service as unknown as { deriveMultisigPda(): Promise<string> };
    const multisigPda = await anyService.deriveMultisigPda();

    rpc.set(multisigPda, SQUADS_V4_PROGRAM_ADDRESS, '');
    rpc.set(
      account.split(':').pop() as string,
      TOKEN_PROGRAM_ADDRESS,
      tokenAccountBase64(
        owner.split(':').pop() as string,
        USDC_MINT.assetId.split(':').pop() as string,
      ),
    );

    await expect(service.assertVaultControl(USDC_DEVNET)).resolves.toBeUndefined();
  });

  it('fails loudly when the multisig PDA is not owned by the Squads program', async () => {
    const { service, rpc } = await primedService();
    const anyService = service as unknown as { deriveMultisigPda(): Promise<string> };
    const multisigPda = await anyService.deriveMultisigPda();
    rpc.set(multisigPda, OTHER_PROGRAM, '');

    await expectErrorCodeAsync(
      () => service.assertVaultControl(USDC_DEVNET),
      ChainErrorCode.CHAIN_VAULT_CONTROL_UNVERIFIED,
    );
  });

  it('fails loudly when the multisig PDA does not exist on chain', async () => {
    const { service } = await primedService();
    await expectErrorCodeAsync(
      () => service.assertVaultControl(USDC_DEVNET),
      ChainErrorCode.CHAIN_VAULT_CONTROL_UNVERIFIED,
    );
  });

  it('fails loudly when the vault ATA authority is not the vault PDA', async () => {
    const { service, rpc } = await primedService();
    const account = await service.getVaultAccount(USDC_DEVNET);
    const anyService = service as unknown as { deriveMultisigPda(): Promise<string> };
    const multisigPda = await anyService.deriveMultisigPda();
    rpc.set(multisigPda, SQUADS_V4_PROGRAM_ADDRESS, '');
    // Authority is some unrelated address, not the derived vault PDA.
    rpc.set(
      account.split(':').pop() as string,
      TOKEN_PROGRAM_ADDRESS,
      tokenAccountBase64(CREATE_KEY, USDC_MINT.assetId.split(':').pop() as string),
    );

    await expectErrorCodeAsync(
      () => service.assertVaultControl(USDC_DEVNET),
      ChainErrorCode.CHAIN_VAULT_CONTROL_UNVERIFIED,
    );
  });

  it('fails loudly when the vault ATA mint does not match the asset', async () => {
    const { service, rpc } = await primedService();
    const owner = await service.getVaultOwner(USDC_DEVNET);
    const account = await service.getVaultAccount(USDC_DEVNET);
    const anyService = service as unknown as { deriveMultisigPda(): Promise<string> };
    const multisigPda = await anyService.deriveMultisigPda();
    rpc.set(multisigPda, SQUADS_V4_PROGRAM_ADDRESS, '');
    rpc.set(
      account.split(':').pop() as string,
      TOKEN_PROGRAM_ADDRESS,
      tokenAccountBase64(owner.split(':').pop() as string, OTHER_PROGRAM),
    );

    await expectErrorCodeAsync(
      () => service.assertVaultControl(USDC_DEVNET),
      ChainErrorCode.CHAIN_VAULT_CONTROL_UNVERIFIED,
    );
  });
});

describe('SquadsVaultService — getVaultBalanceAt', () => {
  /**
   * The proof-of-reserves page publishes this reading on a page with no login, so a visitor has to
   * be able to check it against the chain themselves. A balance with no slot
   * cannot be checked: by the time anyone looks, the vault has moved.
   */
  it('reports the slot the balance was read at, not just the balance', async () => {
    const rpc = new FakeRpc();
    rpc.slot = 291_004_112n;
    const service = await buildService(rpc);
    const vaultAccount = await service.getVaultAccount(USDC_DEVNET);
    rpc.balances.set(vaultAccount.split(':').pop() as string, {
      amount: '184220410000',
      decimals: USDC_MINT.decimals,
    });

    const read = await service.getVaultBalanceAt(USDC_DEVNET);

    expect(MoneyUtil.toAtomic(read.balance)).toBe(184_220_410_000n);
    expect(read.slot).toBe(291_004_112n);
  });

  /**
   * One read path, two shapes. Two independent implementations of the same RPC
   * call would drift, and the one nobody publishes would drift silently.
   */
  it('getVaultBalance returns exactly what getVaultBalanceAt reports', async () => {
    const rpc = new FakeRpc();
    rpc.slot = 12n;
    const service = await buildService(rpc);
    const vaultAccount = await service.getVaultAccount(USDC_DEVNET);
    rpc.balances.set(vaultAccount.split(':').pop() as string, {
      amount: '7500000',
      decimals: USDC_MINT.decimals,
    });

    const [plain, at] = await Promise.all([
      service.getVaultBalance(USDC_DEVNET),
      service.getVaultBalanceAt(USDC_DEVNET),
    ]);

    expect(MoneyUtil.toAtomic(plain)).toBe(MoneyUtil.toAtomic(at.balance));
  });

  /** The decimals guard belongs to both, because it is one call underneath. */
  it('still refuses a decimals mismatch when read through getVaultBalanceAt', async () => {
    const rpc = new FakeRpc();
    const service = await buildService(rpc);
    const vaultAccount = await service.getVaultAccount(USDC_DEVNET);
    rpc.balances.set(vaultAccount.split(':').pop() as string, { amount: '1', decimals: 9 });

    await expectErrorCodeAsync(
      () => service.getVaultBalanceAt(USDC_DEVNET),
      ChainErrorCode.CHAIN_ASSET_DECIMALS_MISMATCH,
    );
  });
});
