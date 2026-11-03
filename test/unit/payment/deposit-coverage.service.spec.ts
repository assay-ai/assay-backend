import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { escrowLedgerClaim } from '@modules/ledger/domain/escrow-ledger-claim';
import { DepositCoverageService } from '@modules/payment/services/deposit-coverage.service';
import { MoneyUtil } from '@shared/utils/money.util';

const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const ACCOUNT =
  `${CHAIN_IDS.ROBINHOOD_TESTNET}:0x66d7CA4cD09C65197B2f3239c1fe79631747dd00` as AccountId;
const usdg = (amount: bigint) => MoneyUtil.of(amount, USDG, 6);

function build(options: {
  chain: bigint | null;
  available?: bigint;
  held?: bigint;
  pending?: bigint;
  heldOnChain?: bigint;
  readError?: Error;
}) {
  const read = options.readError
    ? jest.fn().mockRejectedValue(options.readError)
    : jest.fn().mockResolvedValue(options.chain === null ? null : { balance: usdg(options.chain) });
  const getBalance = jest.fn().mockResolvedValue({
    available: usdg(options.available ?? 0n),
    held: usdg(options.held ?? 0n),
    pending: usdg(options.pending ?? 0n),
  });
  const sumHeldOnChainByAccounts = jest
    .fn()
    .mockResolvedValue(new Map([[ACCOUNT, options.heldOnChain ?? 0n]]));
  const service = new DepositCoverageService(
    { read } as never,
    { getBalance } as never,
    { sumHeldOnChainByAccounts } as never,
  );
  return { service, read, getBalance };
}

describe('escrowLedgerClaim', () => {
  it('is available + held + pending, less what the escrow already moved into its hold', () => {
    expect(escrowLedgerClaim({ available: 10n, held: 7n, pending: 5n }, 3n)).toBe(19n);
  });
});

describe('DepositCoverageService', () => {
  it('covers a credit the escrow holds on top of everything the ledger already counts', async () => {
    const { service } = build({
      chain: 30n,
      available: 10n,
      held: 7n,
      pending: 5n,
      heldOnChain: 2n,
    });
    // claim = 10 + (7 - 2) + 5 = 20; 20 + 10 <= 30
    await expect(service.check('org', ACCOUNT, USDG, 10n)).resolves.toEqual({
      chain: 30n,
      claim: 20n,
      covered: true,
    });
  });

  // deposit -> withdraw -> claim: the money left, the ledger never had it.
  it('refuses a credit the escrow no longer holds', async () => {
    const { service } = build({ chain: 0n });
    await expect(service.check('org', ACCOUNT, USDG, 1_000_000n)).resolves.toMatchObject({
      covered: false,
    });
  });

  it('counts pending credits against the escrow too', async () => {
    const { service } = build({ chain: 10n, pending: 10n });
    await expect(service.check('org', ACCOUNT, USDG, 1n)).resolves.toMatchObject({
      covered: false,
    });
    await expect(service.check('org', ACCOUNT, USDG, 0n)).resolves.toMatchObject({
      covered: true,
    });
  });

  it('reads a missing escrow as zero, never as unknown', async () => {
    const { service } = build({ chain: null });
    await expect(service.check('org', ACCOUNT, USDG, 1n)).resolves.toEqual({
      chain: 0n,
      claim: 0n,
      covered: false,
    });
  });

  it('throws when the escrow cannot be read: unknown is never enough', async () => {
    const { service } = build({ chain: 0n, readError: new Error('rpc down') });
    await expect(service.check('org', ACCOUNT, USDG, 1n)).rejects.toThrow('rpc down');
  });
});
