import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { SlashErrorCode } from '@modules/slash/errors/slash.errors';
import { SlashBeneficiaryService } from '@modules/slash/services/slash-beneficiary.service';

/**
 * Which on-chain account a penalty's compensating share is paid into.
 *
 * The answer is **forced, not chosen**, and both forces are asserted here.
 *
 * 1. The reconciler compares `getVaultBalance(asset)` against total ledger
 *    liabilities. Crediting harmed agents raises those liabilities, so unless
 *    the money lands in the vault the next reconciliation run reports a proof
 *    of reserves breach. Hence the vault, and hence
 *    {@link VaultPort.assertVaultControl} is called rather than assumed: it is
 *    what proves the vault ATA's authority really is the derived vault PDA, so
 *    the account `slash` pays into is the account the reconciler reads.
 * 2. The program refuses a judgement whose `beneficiary` is `economics.treasury`
 *    — both ATAs derive to one address and Anchor rejects a duplicate mutable
 *    account (2040) *before the handler runs*, so the failure carries no named
 *    error. The program's own comment says the off-chain issuer must refuse to
 *    sign it rather than discover it on chain. That refusal is this service.
 */

const ASSET = 'solana:dev/token:MintAAA' as AssetId;
const VAULT_OWNER = 'solana:dev:VaultPDA1111' as AccountId;
const VAULT_ATA = 'solana:dev:VaultATA2222' as AccountId;
const TREASURY = 'solana:dev:Treasury3333' as AccountId;

let vault: {
  getVaultOwner: jest.Mock;
  getVaultAccount: jest.Mock;
  assertVaultControl: jest.Mock;
};
let executor: { settlementTreasury: jest.Mock };
let service: SlashBeneficiaryService;

beforeEach(() => {
  vault = {
    getVaultOwner: jest.fn().mockResolvedValue(VAULT_OWNER),
    getVaultAccount: jest.fn().mockResolvedValue(VAULT_ATA),
    assertVaultControl: jest.fn().mockResolvedValue(undefined),
  };
  executor = { settlementTreasury: jest.fn().mockResolvedValue(TREASURY) };
  service = new SlashBeneficiaryService(vault as never, executor as never);
});

describe('SlashBeneficiaryService', () => {
  it('resolves to the settlement vault owner, as CAIP-10', async () => {
    await expect(service.resolve(ASSET)).resolves.toBe(VAULT_OWNER);
  });

  /**
   * Not a formality. If the vault ATA's authority were not the vault PDA, the
   * `slash` instruction would derive a different token account from the same
   * `beneficiary` and pay into an account `getVaultBalance` does not read —
   * money in the right custody, invisible to the reconciler, and the breach
   * would surface as an unexplained shortfall rather than an error here.
   */
  it('proves vault control before handing the address out', async () => {
    await service.resolve(ASSET);

    expect(vault.assertVaultControl).toHaveBeenCalledWith(ASSET);
    expect(executor.settlementTreasury).toHaveBeenCalledWith(ASSET);
  });

  it('propagates a failed control proof rather than returning an address', async () => {
    vault.assertVaultControl.mockRejectedValue(new Error('CHAIN_VAULT_CONTROL_UNVERIFIED'));

    await expect(service.resolve(ASSET)).rejects.toThrow('CHAIN_VAULT_CONTROL_UNVERIFIED');
  });

  it('refuses when the vault owner is the settlement treasury', async () => {
    executor.settlementTreasury.mockResolvedValue(VAULT_OWNER);

    await expect(service.resolve(ASSET)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_BENEFICIARY_IS_TREASURY,
    });
  });

  /**
   * The comparison is on the address, not on the whole CAIP-10 string, because
   * the program compares `Pubkey`s. A treasury named on a different chain id is
   * still the same key to `slash`.
   */
  it('refuses on the address alone, across differing CAIP-10 prefixes', async () => {
    executor.settlementTreasury.mockResolvedValue('solana:other:VaultPDA1111' as AccountId);

    await expect(service.resolve(ASSET)).rejects.toMatchObject({
      errorCode: SlashErrorCode.SLASH_BENEFICIARY_IS_TREASURY,
    });
  });
});

describe('SlashBeneficiaryService on EVM', () => {
  it('refuses to name the escrow contract — a transfer into it credits nobody', async () => {
    const vault = { assertVaultControl: jest.fn(), getVaultOwner: jest.fn() };
    const subject = new SlashBeneficiaryService(vault as never, {} as never);

    const error = await subject
      .resolve('eip155:46630/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3' as never)
      .catch((caught) => caught);

    expect(error.errorCode).toBe('SLASH_BENEFICIARY_UNSUPPORTED');
    expect(vault.assertVaultControl).not.toHaveBeenCalled();
    expect(vault.getVaultOwner).not.toHaveBeenCalled();
  });
});
