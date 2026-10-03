import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { SettlementErrorCode } from '@modules/settlement/errors/settlement.errors';
import { TreasuryVaultService } from '@modules/settlement/services/treasury-vault.service';
import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { VaultPort } from '@modules/chains/ports/vault.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const USDC: AssetId =
  `${CHAIN_IDS.SOLANA_DEVNET}/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` as AssetId;
const VAULT_ACCOUNT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_DEVNET,
  'Vau1t1111111111111111111111111111111111111',
);

function fakeVaultPort(overrides: Partial<VaultPort> = {}): VaultPort {
  return {
    getVaultOwner: jest.fn().mockResolvedValue(VAULT_ACCOUNT),
    getVaultAccount: jest.fn().mockResolvedValue(VAULT_ACCOUNT),
    getVaultBalance: jest.fn().mockResolvedValue(MoneyUtil.of(10_000_000n, USDC, 6)),
    getVaultBalanceAt: jest
      .fn()
      .mockResolvedValue({ balance: MoneyUtil.of(10_000_000n, USDC, 6), slot: 1n }),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeBalances(totals: {
  available: bigint;
  held: bigint;
  pending: bigint;
  organizations: number;
}) {
  return {
    sumLiabilities: jest.fn().mockResolvedValue(totals),
  } as unknown as AccountBalanceRepository;
}

describe('TreasuryVaultService — checkReserves', () => {
  it('returns the surplus when the vault covers every liability', async () => {
    const vault = fakeVaultPort();
    const balances = fakeBalances({
      available: 6_000_000n,
      held: 1_000_000n,
      pending: 500_000n,
      organizations: 3,
    });
    const service = new TreasuryVaultService(vault, balances);

    const result = await service.checkReserves(USDC);

    expect(result.vaultBalance.amount).toBe('10000000');
    expect(result.liabilities.amount).toBe('7500000');
    expect(result.surplus.amount).toBe('2500000');
    expect(result.organizations).toBe(3);
    expect(vault.assertVaultControl).toHaveBeenCalledWith(USDC);
  });

  it('throws a loud, distinct error when liabilities exceed the vault balance', async () => {
    const vault = fakeVaultPort({
      getVaultBalance: jest.fn().mockResolvedValue(MoneyUtil.of(1_000_000n, USDC, 6)),
    });
    const balances = fakeBalances({
      available: 5_000_000n,
      held: 0n,
      pending: 0n,
      organizations: 1,
    });
    const service = new TreasuryVaultService(vault, balances);

    await expectErrorCodeAsync(
      () => service.checkReserves(USDC),
      SettlementErrorCode.SETTLEMENT_RESERVES_BREACH,
    );
  });

  it('proves control before reading anything else', async () => {
    const vault = fakeVaultPort({
      assertVaultControl: jest.fn().mockRejectedValue(new Error('control not proven')),
    });
    const balances = fakeBalances({ available: 0n, held: 0n, pending: 0n, organizations: 0 });
    const service = new TreasuryVaultService(vault, balances);

    await expect(service.checkReserves(USDC)).rejects.toThrow('control not proven');
    expect(vault.getVaultBalance).not.toHaveBeenCalled();
  });
});
